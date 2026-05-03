-- ============================================================
-- 031 — SALES IDEMPOTENCY KEY: PARTIAL -> FULL UNIQUE
--
-- Sebep: ON CONFLICT (idempotency_key) partial unique index
--        kullanamaz. PostgreSQL ON CONFLICT icin FULL unique
--        constraint / index gerektirir.
--
-- Eski tanim: UNIQUE (idempotency_key) WHERE is_deleted = false
-- Yeni tanim: UNIQUE (idempotency_key)
-- ============================================================


-- ============================================================
-- 1) ESKI PARTIAL INDEX'I KALDIR
--    (hem index olarak hem constraint olarak DROP edilir; biri
--     bulunmazsa diger NOEXIST -> hata yok)
-- ============================================================
ALTER TABLE public.sales
    DROP CONSTRAINT IF EXISTS sales_idempotency_unique;

DROP INDEX IF EXISTS public.sales_idempotency_unique;


-- ============================================================
-- 2) YENI FULL UNIQUE CONSTRAINT
-- ============================================================
ALTER TABLE public.sales
    ADD CONSTRAINT sales_idempotency_unique
    UNIQUE (idempotency_key);


-- ============================================================
-- 3) DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_constraint
    WHERE conrelid = 'public.sales'::regclass
      AND conname  = 'sales_idempotency_unique'
      AND contype  = 'u';

    IF v_count = 0 THEN
        RAISE EXCEPTION 'KRITIK: sales_idempotency_unique constraint kurulamadi!';
    END IF;

    RAISE NOTICE 'OK: sales_idempotency_unique full UNIQUE constraint aktif (count=%)', v_count;
END $$;


-- ============================================================
-- TEST
-- ============================================================
-- 1) Constraint listele:
--    SELECT conname, contype, pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conrelid = 'public.sales'::regclass
--      AND conname = 'sales_idempotency_unique';
--
--    Beklenen: UNIQUE (idempotency_key)  -- WHERE clause YOK
--
-- 2) Frontend'den ayni backup'i ikinci kez yukle:
--    Beklenen: 0 satis | N atlandi, hata YOK.
-- ============================================================
