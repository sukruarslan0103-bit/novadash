-- ============================================================
-- 034 — PURCHASE_ITEMS.discount_rate
--
-- Amac: Alis faturasi satir bazli iskonto orani (%).
--   Satir hesabi:
--     brut    = quantity * unit_cost (KDV haric NET)
--     iskonto = brut * (discount_rate / 100)
--     net     = brut - iskonto
--     kdv     = net * (vat_rate / 100)
--     toplam  = net + kdv          (line_total icin gross convention)
--
-- Genel iskonto: items'da ayri kolon yok; note JSON icinde
--   { invoice_id, supplier, description, general_discount: { type, value } }
--   olarak saklanir (discount_total_net + discount_type=amount|percent).
-- ============================================================

ALTER TABLE public.purchase_items
    ADD COLUMN IF NOT EXISTS discount_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname  = 'purchase_items_discount_rate_check'
          AND conrelid = 'public.purchase_items'::regclass
    ) THEN
        ALTER TABLE public.purchase_items
            ADD CONSTRAINT purchase_items_discount_rate_check
            CHECK (discount_rate >= 0 AND discount_rate <= 100);
    END IF;
END $$;

-- Mevcut tum kayitlar default 0 ile dolar (NOT NULL DEFAULT 0).

-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_col   INT;
    v_check INT;
BEGIN
    SELECT COUNT(*) INTO v_col
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'purchase_items'
      AND column_name  = 'discount_rate';

    SELECT COUNT(*) INTO v_check
    FROM pg_constraint
    WHERE conname  = 'purchase_items_discount_rate_check'
      AND conrelid = 'public.purchase_items'::regclass;

    IF v_col = 0 THEN
        RAISE EXCEPTION 'KRITIK: discount_rate kolonu olusturulamadi!';
    END IF;
    IF v_check = 0 THEN
        RAISE EXCEPTION 'KRITIK: discount_rate check constraint kurulamadi!';
    END IF;

    RAISE NOTICE 'OK: purchase_items.discount_rate kolonu + check constraint aktif.';
END $$;
