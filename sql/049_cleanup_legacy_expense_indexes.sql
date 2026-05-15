-- ============================================================
-- 049 — CLEANUP LEGACY EXPENSE INDEXES
--
-- Amac:
--   public.expenses tablosunda 048 öncesinden kalmış iki legacy
--   guard temizlenir. Repo'da kayıt yok; prod'da manuel/eski
--   migration ile eklenmiş.
--
--   - unique_expense_idem   (CONSTRAINT-backed index)
--       UNIQUE (tenant_id, idempotency_key)
--       Sebep: 048'in eklediği expenses_idempotency_unique ile
--       BIREBIR AYNI. Redundant duplicate.
--       Drop mekanizmasi: ALTER TABLE ... DROP CONSTRAINT
--       (PG constraint-backed index'i DROP INDEX ile düşürmez).
--
--   - unique_expense_guard_idx   (standalone UNIQUE INDEX)
--       UNIQUE (tenant_id, date, amount, COALESCE(category_id, '0...'))
--       Sebep: description'i icermeyen agresif content-based
--       guard. Gercek ikinci giderleri (aynı gun/kategori/tutar
--       farklı description) yanlış pozitif olarak engelliyor.
--       Drop mekanizmasi: DROP INDEX (constraint yok).
--
-- Canonical (kalan tek guard):
--   expenses_idempotency_unique UNIQUE (tenant_id, idempotency_key)
--
-- KAPSAM DISI:
--   - Diger tablolarin indexleri
--   - insert_expense / update_expense body'leri (048'de tamamlandi)
--   - Frontend
--   - Baseline fold
--
-- Idempotency:
--   DROP IF EXISTS / DROP CONSTRAINT IF EXISTS; tekrar calistirma guvenli.
--
-- Rollback:
--   Gerekirse Dashboard'da elle yeniden olusturulabilir, ama bu
--   eski yanlış-pozitif davranısı geri getirir. Önerilmez.
-- ============================================================


-- ============================================================
-- PRE-CLEAN — mevcut index seti
-- ============================================================
DO $pre$
DECLARE
    r RECORD;
BEGIN
    RAISE NOTICE '--- public.expenses mevcut index seti (DROP oncesi) ---';
    FOR r IN
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename  = 'expenses'
         ORDER BY indexname
    LOOP
        RAISE NOTICE '  % | %', r.indexname, r.indexdef;
    END LOOP;
END $pre$;


-- ============================================================
-- DROP LEGACY GUARDS
-- ============================================================

-- 1) unique_expense_idem: CONSTRAINT-backed index → DROP CONSTRAINT
ALTER TABLE public.expenses
    DROP CONSTRAINT IF EXISTS unique_expense_idem;

-- 2) unique_expense_guard_idx: standalone unique index → DROP INDEX
DROP INDEX IF EXISTS public.unique_expense_guard_idx;


-- ============================================================
-- VALIDATION
-- ============================================================
DO $val$
DECLARE
    v_canonical_exists BOOLEAN;
    v_legacy_guard     BOOLEAN;
    v_legacy_idem      BOOLEAN;
    r RECORD;
BEGIN
    -- 1) Canonical hala duruyor mu?
    SELECT EXISTS (
        SELECT 1
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename  = 'expenses'
           AND indexname  = 'expenses_idempotency_unique'
    ) INTO v_canonical_exists;

    IF NOT v_canonical_exists THEN
        RAISE EXCEPTION
            'KRITIK: expenses_idempotency_unique YOK! 048 calistirilmamis olabilir. ABORT.';
    END IF;

    -- 2) Legacy guard'lar gerceken silindi mi?
    SELECT EXISTS (
        SELECT 1
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename  = 'expenses'
           AND indexname  = 'unique_expense_guard_idx'
    ) INTO v_legacy_guard;

    SELECT EXISTS (
        SELECT 1
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename  = 'expenses'
           AND indexname  = 'unique_expense_idem'
    ) INTO v_legacy_idem;

    IF v_legacy_guard THEN
        RAISE EXCEPTION 'KRITIK: unique_expense_guard_idx hala duruyor';
    END IF;
    IF v_legacy_idem THEN
        RAISE EXCEPTION 'KRITIK: unique_expense_idem hala duruyor';
    END IF;

    -- 3) Final index seti raporu (DROP sonrasi)
    RAISE NOTICE '--- public.expenses index seti (DROP sonrasi) ---';
    FOR r IN
        SELECT indexname, indexdef
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename  = 'expenses'
         ORDER BY indexname
    LOOP
        RAISE NOTICE '  % | %', r.indexname, r.indexdef;
    END LOOP;

    RAISE NOTICE 'OK: legacy expense indexes cleaned (unique_expense_guard_idx + unique_expense_idem dropped; expenses_idempotency_unique canonical olarak korundu)';
END $val$;
