-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Raw Materials
-- Version: 013
-- Target: Supabase (PostgreSQL 15+)
-- Scope: CREATE TABLE + INDEX + RLS (NO triggers, NO RPC)
-- Safe: IF NOT EXISTS everywhere, no DROP, no ALTER on existing tables
-- ============================================================

-- ========================
-- TABLE: raw_materials
-- ========================
CREATE TABLE IF NOT EXISTS raw_materials (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    unit         TEXT NOT NULL DEFAULT 'gr'
                 CHECK (unit IN ('gr', 'kg', 'ml', 'lt', 'adet', 'paket')),
    cost         NUMERIC(12,4) NOT NULL DEFAULT 0
                 CHECK (cost >= 0),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    is_deleted   BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- INDEXES
-- ========================
CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant
    ON raw_materials(tenant_id);

CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant_active
    ON raw_materials(tenant_id, is_active)
    WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant_name
    ON raw_materials(tenant_id, name)
    WHERE is_deleted = false;

-- Aynı tenant içinde aktif (silinmemiş) ham madde adı benzersiz olsun.
-- Partial unique: soft-delete edilen kayıtlar aynı adı tekrar alabilsin.
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_materials_tenant_name_active
    ON raw_materials(tenant_id, lower(name))
    WHERE is_deleted = false;

-- ========================
-- ROW LEVEL SECURITY
-- ========================
ALTER TABLE raw_materials ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'raw_materials'
          AND policyname = 'tenant_isolation'
    ) THEN
        EXECUTE 'CREATE POLICY tenant_isolation ON raw_materials
                 FOR ALL
                 USING (tenant_id = get_my_tenant_id())
                 WITH CHECK (tenant_id = get_my_tenant_id())';
    END IF;
END $$;
