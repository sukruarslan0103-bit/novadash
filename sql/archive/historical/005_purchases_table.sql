-- ============================================================
-- PURCHASES TABLE — Alış kayıtları
-- Migration 005
-- ============================================================

-- ========================
-- PURCHASES
-- ========================
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity NUMERIC(12,2) NOT NULL,
    total_price NUMERIC(12,2) NOT NULL,
    unit_cost NUMERIC(12,2) NOT NULL,
    vat_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    net_total NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- INDEXES
-- ========================
CREATE INDEX IF NOT EXISTS idx_purchases_tenant ON purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_purchases_tenant_date ON purchases(tenant_id, created_at DESC);

-- ========================
-- ROW LEVEL SECURITY
-- ========================
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchases_tenant_isolation ON purchases
    FOR ALL
    USING (tenant_id = get_my_tenant_id())
    WITH CHECK (tenant_id = get_my_tenant_id());

-- ========================
-- AUTO tenant_id TRIGGER
-- ========================
CREATE TRIGGER set_tenant_id_purchases
    BEFORE INSERT ON purchases
    FOR EACH ROW
    EXECUTE FUNCTION set_tenant_id();
