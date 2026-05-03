-- ============================================================
-- 027 — USERS TENANT LOCK (FINAL, BULLETPROOF)
--
-- 023 ve 026 ESKITILDI. Bu dosya minimal, hicbir gereksiz
-- syntax kullanmiyor. Garanti calisir.
--
-- 026 NEDEN CALISMADI (olasi nedenler):
--   1) "BEFORE UPDATE OF id, tenant_id, role" + WHEN clause
--      kombinasyonu Supabase editor'de parse edilmemis olabilir
--   2) Script parca parca calistirilmis olabilir
--   3) ENABLE ALWAYS TRIGGER seperate statement olarak hata vermis
--      ve transaction rollback olmus olabilir
--
-- BU DOSYADA:
--   - "BEFORE UPDATE OF" yok, plain "BEFORE UPDATE"
--   - WHEN clause yok, kontrol function icinde
--   - Her adimdan sonra RAISE NOTICE ile log
--   - Sonda zorunlu dogrulama (exception firlatir)
-- ============================================================


-- ============================================================
-- ADIM 0 — Eski kalintilari temizle (idempotent)
-- ============================================================
DROP TRIGGER IF EXISTS trg_users_lock_critical_columns ON public.users;
DROP FUNCTION IF EXISTS public.trg_fn_users_lock_critical_columns();

DO $$ BEGIN RAISE NOTICE 'Adim 0: Eski trigger/function temizlendi'; END $$;


-- ============================================================
-- ADIM 1 — Function olustur
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_fn_users_lock_critical_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
DECLARE
    v_bypass TEXT;
BEGIN
    -- Bypass GUC kontrolu
    BEGIN
        v_bypass := current_setting('app.bypass_user_lock', true);
    EXCEPTION WHEN OTHERS THEN
        v_bypass := NULL;
    END;

    IF v_bypass = 'on' THEN
        RETURN NEW;
    END IF;

    -- HARD BLOCK
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'users.id degistirilemez (tenant lock)'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION 'users.tenant_id degistirilemez (tenant lock)'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'users.role degistirilemez (tenant lock)'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$func$;

DO $$ BEGIN RAISE NOTICE 'Adim 1: Function olusturuldu'; END $$;


-- ============================================================
-- ADIM 2 — Function gercekten var mi?
-- ============================================================
DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_proc
    WHERE proname = 'trg_fn_users_lock_critical_columns'
      AND pronamespace = 'public'::regnamespace;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'KRITIK: Function olusturulamadi!';
    END IF;

    RAISE NOTICE 'Adim 2: Function dogrulandi (count=%)', v_count;
END $$;


-- ============================================================
-- ADIM 3 — Trigger olustur (PLAIN BEFORE UPDATE)
-- ============================================================
CREATE TRIGGER trg_users_lock_critical_columns
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_users_lock_critical_columns();

DO $$ BEGIN RAISE NOTICE 'Adim 3: Trigger olusturuldu'; END $$;


-- ============================================================
-- ADIM 4 — Trigger'i ALWAYS yap (replication / restore bypass'i bile engelle)
-- ============================================================
ALTER TABLE public.users
    ENABLE ALWAYS TRIGGER trg_users_lock_critical_columns;

DO $$ BEGIN RAISE NOTICE 'Adim 4: Trigger ENABLE ALWAYS yapildi'; END $$;


-- ============================================================
-- ADIM 5 — ZORUNLU DOGRULAMA
--   Trigger gercekten pg_trigger'da gorunuyor mu?
--   tgenabled durumu ne?
-- ============================================================
DO $$
DECLARE
    v_count   INT;
    v_enabled CHAR;
BEGIN
    SELECT COUNT(*), MAX(tgenabled)
    INTO v_count, v_enabled
    FROM pg_trigger
    WHERE tgrelid = 'public.users'::regclass
      AND tgname  = 'trg_users_lock_critical_columns'
      AND NOT tgisinternal;

    IF v_count = 0 THEN
        RAISE EXCEPTION
            'KRITIK: Trigger kurulamadi! pg_trigger tablosunda gorunmuyor. '
            'Manuel kontrol: SELECT tgname FROM pg_trigger '
            'WHERE tgrelid = ''public.users''::regclass;';
    END IF;

    IF v_enabled NOT IN ('O', 'A') THEN
        RAISE EXCEPTION
            'KRITIK: Trigger kurulu ama disabled! tgenabled=%', v_enabled;
    END IF;

    RAISE NOTICE 'Adim 5 BASARILI: Trigger aktif (count=%, enabled=%)',
                 v_count, v_enabled;
END $$;


-- ============================================================
-- TEST — script bitti, simdi manuel test et
-- ============================================================
--
-- TEST A — Listele
-- ----------------------------------------------------
-- SELECT tgname, tgenabled, tgtype
-- FROM pg_trigger
-- WHERE tgrelid = 'public.users'::regclass
--   AND NOT tgisinternal;
--
-- Beklenen: 1 satir, tgname=trg_users_lock_critical_columns,
--           tgenabled='A'
--
--
-- TEST B — tenant_id BLOK
-- ----------------------------------------------------
-- UPDATE public.users
-- SET tenant_id = '00000000-0000-0000-0000-000000000099'
-- WHERE id = (SELECT id FROM public.users LIMIT 1);
--
-- Beklenen: ERROR 42501 users.tenant_id degistirilemez
--
--
-- TEST C — role BLOK
-- ----------------------------------------------------
-- UPDATE public.users
-- SET role = 'manager'
-- WHERE id = (SELECT id FROM public.users LIMIT 1);
--
-- Beklenen: ERROR 42501 users.role degistirilemez
--
--
-- TEST D — full_name SERBEST
-- ----------------------------------------------------
-- UPDATE public.users
-- SET full_name = 'Test'
-- WHERE id = (SELECT id FROM public.users LIMIT 1)
-- RETURNING id, full_name;
--
-- Beklenen: SUCCESS, 1 row
--
--
-- TEST E — Bypass calisiyor mu?
-- ----------------------------------------------------
-- BEGIN;
--   SET LOCAL app.bypass_user_lock = 'on';
--   UPDATE public.users
--   SET role = 'manager'
--   WHERE id = (SELECT id FROM public.users LIMIT 1);
-- ROLLBACK;
--
-- Beklenen: UPDATE basarili, ROLLBACK ile geri alindi
-- ============================================================
