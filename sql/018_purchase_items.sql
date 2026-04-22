-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — purchase_items
-- Version: 018
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   Ham madde alış kalemleri. Her satır 1 alım işlemini temsil eder.
--   purchase_id opsiyoneldir (bir fatura başlığına bağlanabilir veya
--   stand-alone kaydedilebilir — mevcut purchases tablosu ürün bazlı
--   kaldığı için bu sürümde stand-alone kullanım tercih edilir).
--
-- Maliyet akışı:
--   purchase_items INSERT
--     → trigger (021'de) sync_raw_material_cost()
--       → raw_materials.cost güncelle (WAC)
--         → trigger (015) products.cost güncelle (reçete)
--
-- Depends on:
--   - 001_initial_schema.sql (tenants, helpers)
--   - 013_raw_materials.sql
--   - 005_purchases_table.sql (purchase_id FK — nullable)
--   - tenant_auto_assign.sql (set_tenant_id fonksiyonu)
--
-- Safe: IF NOT EXISTS, DROP TRIGGER IF EXISTS, idempotent re-run
-- ============================================================

-- ========================
-- TABLE: purchase_items
-- ========================
CREATE TABLE IF NOT EXISTS purchase_items (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    purchase_id      UUID REFERENCES purchases(id) ON DELETE SET NULL,
    raw_material_id  UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,

    -- Kullanıcı girdisi (alış birimi — kg, lt, paket vs.)
    quantity         NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
    unit             TEXT NOT NULL
                     CHECK (unit IN ('gr', 'kg', 'ml', 'lt', 'adet', 'paket')),

    -- Maliyet (alış birimi başına)
    unit_cost        NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
    line_total       NUMERIC(14,4) NOT NULL CHECK (line_total >= 0),

    -- Normalize edilmiş değerler (trigger/uygulama tarafından doldurulur)
    -- Bu kolonlar varsa WAC hesabı çok daha hızlı olur (tekrar dönüşüm gerekmez).
    base_quantity    NUMERIC(18,6),
    base_unit_cost   NUMERIC(18,6),

    vat_rate         NUMERIC(5,2) NOT NULL DEFAULT 0
                     CHECK (vat_rate >= 0 AND vat_rate <= 100),

    note             TEXT,

    is_deleted       BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- INDEXES
-- ========================
CREATE INDEX IF NOT EXISTS idx_purchase_items_tenant
    ON purchase_items(tenant_id);

CREATE INDEX IF NOT EXISTS idx_purchase_items_tenant_rawmat
    ON purchase_items(tenant_id, raw_material_id, created_at DESC)
    WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
    ON purchase_items(purchase_id)
    WHERE purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_items_tenant_date
    ON purchase_items(tenant_id, created_at DESC)
    WHERE is_deleted = false;

-- ========================
-- ROW LEVEL SECURITY
-- ========================
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'purchase_items'
          AND policyname = 'tenant_isolation'
    ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON purchase_items
                 FOR ALL
                 USING (tenant_id = get_my_tenant_id())
                 WITH CHECK (tenant_id = get_my_tenant_id())';
    END IF;
END $$;

-- ========================
-- TENANT AUTO-ASSIGN
--   set_tenant_id fonksiyonu tenant_auto_assign.sql içinde tanımlı.
-- ========================
DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON purchase_items;

CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON purchase_items
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();
