-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Add 'cl' unit support
-- Version: 022
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   raw_materials.unit ve purchase_items.unit CHECK constraint'lerini
--   'cl' (santilitre) birimini de kabul edecek şekilde güncellemek.
--
--   019_unit_conversion.sql zaten cl→ml (×10) dönüşümünü destekliyor,
--   ancak CHECK constraint'ler bu birimi reddettiği için cl henüz
--   tablolara yazılamıyor. Bu migration o engeli kaldırır.
--
-- Depends on:
--   - 013_raw_materials.sql
--   - 018_purchase_items.sql
--   - 019_unit_conversion.sql (cl desteği)
--
-- Safe:
--   - Mevcut constraint bulunursa DROP, yoksa atla
--   - Yeni constraint "IF NOT EXISTS" mantığıyla eklenir
--   - Mevcut veriler bozulmaz (sadece izin listesi genişler)
-- ============================================================


-- ============================================================
-- 1) raw_materials.unit CHECK constraint
-- ============================================================
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    -- Eski CHECK constraint'i bul (isim auto-generated olabilir)
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.raw_materials'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%unit%IN%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%base_unit%'
    LIMIT 1;

    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE raw_materials DROP CONSTRAINT %I', v_conname);
    END IF;

    -- Yeni constraint'i ekle (idempotent: yoksa ekle)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname  = 'raw_materials_unit_check'
          AND conrelid = 'public.raw_materials'::regclass
    ) THEN
        ALTER TABLE raw_materials
            ADD CONSTRAINT raw_materials_unit_check
            CHECK (unit IN ('gr', 'kg', 'ml', 'cl', 'lt', 'adet', 'paket'));
    END IF;
END $$;


-- ============================================================
-- 2) purchase_items.unit CHECK constraint
-- ============================================================
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.purchase_items'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%unit%IN%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%base_unit%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%vat_rate%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%quantity%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%unit_cost%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%line_total%'
    LIMIT 1;

    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE purchase_items DROP CONSTRAINT %I', v_conname);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname  = 'purchase_items_unit_check'
          AND conrelid = 'public.purchase_items'::regclass
    ) THEN
        ALTER TABLE purchase_items
            ADD CONSTRAINT purchase_items_unit_check
            CHECK (unit IN ('gr', 'kg', 'ml', 'cl', 'lt', 'adet', 'paket'));
    END IF;
END $$;
