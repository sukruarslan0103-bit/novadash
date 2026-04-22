-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — raw_materials.base_unit
-- Version: 017
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   Ham madde için "hesaplama birimi" (base_unit) kavramı.
--   unit  = kullanıcıya gösterilen birim (kg, lt, paket ...)
--   base_unit = hesaplamada kullanılan normalize birim (gr, ml, adet)
--
-- Maliyet (raw_materials.cost) → base_unit başına ₺ olarak saklanır.
-- Reçete (product_recipes.quantity) → base_unit cinsinden yazılır.
--
-- Depends on: 013_raw_materials.sql
--
-- Safe:
--   - ADD COLUMN IF NOT EXISTS (idempotent)
--   - Sadece mantıksal backfill UPDATE; mevcut veriler bozulmaz
--   - Hiçbir tablo DROP edilmez
-- ============================================================

-- ========================
-- 1) base_unit kolonu
-- ========================
ALTER TABLE raw_materials
    ADD COLUMN IF NOT EXISTS base_unit TEXT;

-- ========================
-- 2) CHECK constraint (ayrı, idempotent)
--    Sadece normalize birimler base_unit olabilir.
-- ========================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'raw_materials_base_unit_check'
          AND conrelid = 'raw_materials'::regclass
    ) THEN
        ALTER TABLE raw_materials
            ADD CONSTRAINT raw_materials_base_unit_check
            CHECK (base_unit IS NULL OR base_unit IN ('gr', 'ml', 'adet'));
    END IF;
END $$;

-- ========================
-- 3) Mevcut kayıtlar için backfill
--    unit → base_unit eşlemesi:
--      gr, kg       → gr
--      ml, lt       → ml
--      adet, paket  → adet
-- ========================
UPDATE raw_materials
SET base_unit = CASE
        WHEN unit IN ('gr', 'kg')      THEN 'gr'
        WHEN unit IN ('ml', 'lt')      THEN 'ml'
        WHEN unit IN ('adet', 'paket') THEN 'adet'
        ELSE NULL
    END
WHERE base_unit IS NULL;

-- ========================
-- 4) Index (base_unit'e göre sorgular için — ileride WAC hesabında kullanılır)
-- ========================
CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant_base_unit
    ON raw_materials(tenant_id, base_unit)
    WHERE is_deleted = false;

-- ============================================================
-- NOT:
--   base_unit NOT NULL yapılmadı. Migration'ın güvenli re-run
--   özelliği için nullable kalır. Uygulama katmanı yeni ham
--   madde oluştururken base_unit'i set etmelidir.
--   Gelecekte veri temizlendikten sonra ayrı bir migration ile
--   NOT NULL'a çekilebilir.
-- ============================================================
