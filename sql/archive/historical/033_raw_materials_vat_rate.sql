-- ============================================================
-- 033 — RAW_MATERIALS.vat_rate
--
-- Amac: Hammadde bazinda varsayilan KDV orani.
--   Alis ekraninda hammadde secilince satir KDV'si bu degerle
--   otomatik dolar; kullanici override edebilir.
--
-- Constraint: 0 <= vat_rate <= 100
-- Default: 20 (Turkiye standart KDV)
-- ============================================================

ALTER TABLE public.raw_materials
    ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20;

-- Constraint (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname  = 'raw_materials_vat_rate_check'
          AND conrelid = 'public.raw_materials'::regclass
    ) THEN
        ALTER TABLE public.raw_materials
            ADD CONSTRAINT raw_materials_vat_rate_check
            CHECK (vat_rate >= 0 AND vat_rate <= 100);
    END IF;
END $$;

-- Mevcut tum kayitlar default 20 ile dolar (NOT NULL DEFAULT 20).
-- Eger kullanici daha sonra hammadde duzenleyip degistirirse
-- update normal kanaldan gider.

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
      AND table_name   = 'raw_materials'
      AND column_name  = 'vat_rate';

    SELECT COUNT(*) INTO v_check
    FROM pg_constraint
    WHERE conname  = 'raw_materials_vat_rate_check'
      AND conrelid = 'public.raw_materials'::regclass;

    IF v_col = 0 THEN
        RAISE EXCEPTION 'KRITIK: vat_rate kolonu olusturulamadi!';
    END IF;
    IF v_check = 0 THEN
        RAISE EXCEPTION 'KRITIK: vat_rate check constraint kurulamadi!';
    END IF;

    RAISE NOTICE 'OK: raw_materials.vat_rate kolonu + check constraint aktif.';
END $$;
