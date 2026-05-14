-- ============================================================
-- 026 — USERS TENANT LOCK (HARDENED)
-- 023'u ESKITIR. Hard-block: postgres dahil HIC KIMSE
-- tenant_id / role / id degistiremez.
--
-- Bypass mekanizmasi: session-level GUC.
--   SET LOCAL app.bypass_user_lock = 'on';
-- Bu sadece backend / migration script'lerinde explicit acilir.
-- Default: kapali -> her zaman blokla.
--
-- Neden JWT claim degil GUC?
--   - Supabase SQL Editor postgres rolu kullaniyor; JWT claim yok
--   - Eski trigger (023) JWT yoksa "bypass yok" diye dusunmustu
--     ama postgres icin de engellemiyordu (cunku trigger kurulmamis
--     yada yanlis kosul)
--   - GUC tum rollerde tutarli calisir.
-- ============================================================


-- ============================================================
-- 0) DIAGNOSTIC — calistirmadan once mevcut durumu gor
-- ============================================================
-- Bu blok manuel: yorum satirlarini kaldirip elle calistir.
--
-- SELECT tgname, tgtype, tgenabled, tgisinternal
-- FROM pg_trigger
-- WHERE tgrelid = 'public.users'::regclass
--   AND NOT tgisinternal;
--
-- SELECT proname, prosrc
-- FROM pg_proc
-- WHERE proname LIKE '%users_lock%';


-- ============================================================
-- 1) ESKI TRIGGER VE FUNCTION'I TEMIZLE
-- ============================================================
DROP TRIGGER IF EXISTS trg_users_lock_critical_columns ON public.users;
DROP FUNCTION IF EXISTS trg_fn_users_lock_critical_columns();


-- ============================================================
-- 2) HARDENED FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION trg_fn_users_lock_critical_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
-- DELIBERATELY NOT SECURITY DEFINER:
-- BEFORE trigger zaten table-owner privileges ile calisir.
-- Ek olarak kullanici context'inde calismasi denetimi netlestirir.
AS $$
DECLARE
    v_bypass TEXT;
BEGIN
    -- Bypass GUC kontrolu
    BEGIN
        v_bypass := current_setting('app.bypass_user_lock', true);
    EXCEPTION WHEN OTHERS THEN
        v_bypass := NULL;
    END;

    -- Sadece explicit 'on' degeri bypass eder
    IF v_bypass = 'on' THEN
        RETURN NEW;
    END IF;

    -- ========================================================
    -- HARD BLOCK — id, tenant_id, role degisiklikleri
    -- ========================================================
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'users.id degistirilemez (tenant lock)'
            USING ERRCODE = '42501',
                  HINT = 'Bypass icin: SET LOCAL app.bypass_user_lock = ''on''';
    END IF;

    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION 'users.tenant_id degistirilemez (tenant lock)'
            USING ERRCODE = '42501',
                  HINT = 'Bypass icin: SET LOCAL app.bypass_user_lock = ''on''';
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'users.role degistirilemez (tenant lock)'
            USING ERRCODE = '42501',
                  HINT = 'Bypass icin: SET LOCAL app.bypass_user_lock = ''on''';
    END IF;

    RETURN NEW;
END;
$$;


-- ============================================================
-- 3) TRIGGER — BEFORE UPDATE, FOR EACH ROW
--    WHEN clause: sadece kritik kolon degisirse function calissin
--    (mikro-optimizasyon; mantik yine function icinde de var)
-- ============================================================
CREATE TRIGGER trg_users_lock_critical_columns
BEFORE UPDATE OF id, tenant_id, role
ON public.users
FOR EACH ROW
WHEN (
    OLD.id        IS DISTINCT FROM NEW.id
 OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
 OR OLD.role      IS DISTINCT FROM NEW.role
)
EXECUTE FUNCTION trg_fn_users_lock_critical_columns();


-- ============================================================
-- 4) TRIGGER ETKINLIGINI GARANTILE
--    ALWAYS = replication / session_replication_role bypass'i
--    bile engeller.
-- ============================================================
ALTER TABLE public.users
    ENABLE ALWAYS TRIGGER trg_users_lock_critical_columns;


-- ============================================================
-- 5) DOGRULAMA SORGUSU
-- ============================================================
DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_trigger
    WHERE tgrelid = 'public.users'::regclass
      AND tgname = 'trg_users_lock_critical_columns'
      AND NOT tgisinternal
      AND tgenabled IN ('O', 'A');  -- O=origin, A=always

    IF v_count = 0 THEN
        RAISE EXCEPTION 'Trigger kurulamadi! pg_trigger tablosunda gorunmuyor.';
    END IF;

    RAISE NOTICE 'Trigger kuruldu: trg_users_lock_critical_columns (count=%)', v_count;
END $$;


-- ============================================================
-- TEST PROSEDURU
-- ============================================================
--
-- TEST A — Trigger kurulu mu?
-- ------------------------------------------------------------
-- SELECT tgname, tgenabled, tgtype
-- FROM pg_trigger
-- WHERE tgrelid = 'public.users'::regclass
--   AND NOT tgisinternal;
--
-- Beklenen: trg_users_lock_critical_columns satiri,
--           tgenabled = 'A' (always)
--
--
-- TEST B — postgres rolu ile blok (Supabase SQL Editor)
-- ------------------------------------------------------------
-- UPDATE public.users
-- SET tenant_id = '00000000-0000-0000-0000-000000000099'
-- WHERE id = (SELECT id FROM public.users LIMIT 1);
--
-- Beklenen: ERROR  42501  users.tenant_id degistirilemez
--
--
-- TEST C — role degisikligi blok
-- ------------------------------------------------------------
-- UPDATE public.users
-- SET role = 'manager'
-- WHERE id = (SELECT id FROM public.users LIMIT 1);
--
-- Beklenen: ERROR  42501  users.role degistirilemez
--
--
-- TEST D — Diger kolonlar serbest (full_name)
-- ------------------------------------------------------------
-- UPDATE public.users
-- SET full_name = 'Test ' || floor(random()*1000)::text
-- WHERE id = (SELECT id FROM public.users LIMIT 1);
--
-- Beklenen: SUCCESS (kritik olmayan kolonlar serbest)
--
--
-- TEST E — Bypass mekanizmasi calisiyor mu?
-- ------------------------------------------------------------
-- BEGIN;
--   SET LOCAL app.bypass_user_lock = 'on';
--   UPDATE public.users
--   SET role = 'manager'
--   WHERE id = (SELECT id FROM public.users LIMIT 1);
-- ROLLBACK;
--
-- Beklenen: UPDATE basarili (rollback ile geri alindi).
--           Transaction disinda yine bloklu kalir.
--
-- ============================================================
