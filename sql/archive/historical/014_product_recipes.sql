-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Product Recipes
-- Version: 014
-- Target: Supabase (PostgreSQL 15+)
-- Scope: CREATE TABLE + INDEX + RLS (NO triggers, NO RPC)
-- Depends on: 001_initial_schema.sql (products), 013_raw_materials.sql
-- Safe: IF NOT EXISTS everywhere, no DROP, no ALTER on existing tables
-- ============================================================

-- ========================
-- TABLE: product_recipes
-- ========================
-- Bir ürünün reçetesindeki her satır = 1 ham madde + miktar.
-- Ürün maliyeti = Σ (quantity × raw_material.cost)   (uygulama/servis katmanında hesaplanır)
CREATE TABLE IF NOT EXISTS product_recipes (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    raw_material_id  UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,
    quantity         NUMERIC(12,4) NOT NULL DEFAULT 0
                     CHECK (quantity >= 0),
    is_deleted       BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- INDEXES
-- ========================
CREATE INDEX IF NOT EXISTS idx_product_recipes_tenant
    ON product_recipes(tenant_id);

CREATE INDEX IF NOT EXISTS idx_product_recipes_tenant_product
    ON product_recipes(tenant_id, product_id)
    WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_product_recipes_tenant_raw_material
    ON product_recipes(tenant_id, raw_material_id)
    WHERE is_deleted = false;

-- Aynı ürün içinde aynı ham madde iki kez bulunmasın (aktif kayıtlar için).
-- Partial unique: soft-delete edilen kayıt aynı çifti tekrar eklemeye engel olmaz.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_recipes_product_rawmat_active
    ON product_recipes(tenant_id, product_id, raw_material_id)
    WHERE is_deleted = false;

-- ========================
-- ROW LEVEL SECURITY
-- ========================
ALTER TABLE product_recipes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'product_recipes'
          AND policyname = 'tenant_isolation'
    ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON product_recipes
                 FOR ALL
                 USING (tenant_id = get_my_tenant_id())
                 WITH CHECK (tenant_id = get_my_tenant_id())';
    END IF;
END $$;
