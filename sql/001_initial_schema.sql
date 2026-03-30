-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Initial Schema
-- Version: 1.0
-- Target: Supabase (PostgreSQL 15+)
-- ============================================================

-- ========================
-- EXTENSIONS
-- ========================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ========================
-- TENANTS
-- ========================
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'professional', 'ultimate')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    trial_ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- USERS
-- ========================
CREATE TABLE users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'manager', 'accountant')),
    pin_hash TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- CATEGORIES
-- ========================
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('product', 'expense')),
    color TEXT DEFAULT '#6B7280',
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- PRODUCTS
-- ========================
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    price NUMERIC(12,2) NOT NULL DEFAULT 0,
    cost NUMERIC(12,2) DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- SALES (Daily Summary)
-- ========================
CREATE TABLE sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total NUMERIC(12,2) NOT NULL DEFAULT 0,
    cash NUMERIC(12,2) DEFAULT 0,
    card NUMERIC(12,2) DEFAULT 0,
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_deleted BOOLEAN NOT NULL DEFAULT false
);

-- ========================
-- PRODUCT SALES (Detail)
-- ========================
CREATE TABLE product_sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sale_id UUID REFERENCES sales(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,
    date DATE NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    total NUMERIC(12,2) NOT NULL DEFAULT 0,
    cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- EXPENSES
-- ========================
CREATE TABLE expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- EVENTS (Faz 5 — skeleton)
-- ========================
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT CHECK (type IN ('concert', 'dj', 'party', 'sports', 'special', 'other')),
    date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    venue TEXT,
    description TEXT,
    est_cost NUMERIC(12,2) DEFAULT 0,
    est_revenue NUMERIC(12,2) DEFAULT 0,
    actual_cost NUMERIC(12,2),
    actual_revenue NUMERIC(12,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- TASKS (Faz 6 — skeleton)
-- ========================
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    assignee TEXT,
    due_date DATE,
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status TEXT DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
    category TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- SETTINGS
-- ========================
CREATE TABLE settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value JSONB,
    UNIQUE(tenant_id, key)
);

-- ========================
-- DELETED RECORDS (Audit)
-- ========================
CREATE TABLE deleted_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    table_name TEXT NOT NULL,
    record_id UUID NOT NULL,
    record_data JSONB NOT NULL,
    deleted_by UUID REFERENCES users(id),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- SYSTEM LOGS
-- ========================
CREATE TABLE system_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL,
    user_id UUID,
    action TEXT NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ========================
-- INDEXES (Performance)
-- ========================
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_sales_tenant_date ON sales(tenant_id, date DESC);
CREATE INDEX idx_expenses_tenant_date ON expenses(tenant_id, date DESC);
CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_product_sales_tenant_date ON product_sales(tenant_id, date DESC);
CREATE INDEX idx_categories_tenant ON categories(tenant_id);
CREATE INDEX idx_events_tenant_date ON events(tenant_id, date DESC);
CREATE INDEX idx_tasks_tenant_status ON tasks(tenant_id, status);
CREATE INDEX idx_deleted_records_tenant ON deleted_records(tenant_id);
CREATE INDEX idx_system_logs_tenant ON system_logs(tenant_id, created_at DESC);

-- ========================
-- ROW LEVEL SECURITY
-- ========================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- ========================
-- RLS POLICIES
-- ========================

-- Helper: get current user's tenant_id
CREATE OR REPLACE FUNCTION get_my_tenant_id()
RETURNS UUID AS $$
    SELECT tenant_id FROM users WHERE id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Tenants: users see only their own tenant
CREATE POLICY tenant_isolation ON tenants
    FOR ALL USING (id = get_my_tenant_id());

-- Generic tenant isolation for all data tables
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'users', 'categories', 'products', 'sales',
        'product_sales', 'expenses', 'events', 'tasks',
        'settings', 'deleted_records', 'system_logs'
    ] LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I FOR ALL USING (tenant_id = get_my_tenant_id())',
            tbl
        );
    END LOOP;
END $$;

-- ========================
-- VIEWS (Dashboard Performance)
-- ========================
CREATE OR REPLACE VIEW v_monthly_summary AS
SELECT
    s.tenant_id,
    DATE_TRUNC('month', s.date)::DATE AS month,
    SUM(s.total) AS revenue,
    COALESCE(e.total_expenses, 0) AS expenses,
    SUM(s.total) - COALESCE(e.total_expenses, 0) AS profit
FROM sales s
LEFT JOIN (
    SELECT tenant_id, DATE_TRUNC('month', date)::DATE AS month, SUM(amount) AS total_expenses
    FROM expenses GROUP BY tenant_id, DATE_TRUNC('month', date)::DATE
) e ON e.tenant_id = s.tenant_id AND e.month = DATE_TRUNC('month', s.date)::DATE
WHERE s.is_deleted = false
GROUP BY s.tenant_id, DATE_TRUNC('month', s.date)::DATE, e.total_expenses;
