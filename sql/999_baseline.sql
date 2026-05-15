-- ============================================================
-- 999_BASELINE.SQL — Business Check-up Dashboard
-- Consolidated baseline (replaces 001-045 + curated legacy)
-- Target: Supabase (PostgreSQL 15+)
-- Mode: Fresh install / idempotent
--
-- Section order:
--   A  EXTENSIONS
--   B  TABLES (+ product_priority VIEW)
--   C  INDEXES
--   D  FUNCTIONS (core RPC)
--   E  USERS / TENANT FUNCTIONS
--   F  TRIGGERS
--   G  RLS POLICIES
--   H  ANALYTICS / BACKUP / ALERTS
--   I  GRANTS
-- ============================================================


-- ============================================================
-- ============================================================
-- SECTION A — EXTENSIONS
-- ============================================================
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- ============================================================
-- SECTION B — TABLES (final structure, no ALTERs)
-- Order respects FK dependencies.
-- ============================================================
-- ============================================================

-- ------------------------------------------------------------
-- B.1) tenants
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          TEXT NOT NULL,
    slug          TEXT UNIQUE NOT NULL,
    plan          TEXT NOT NULL DEFAULT 'starter'
                  CHECK (plan IN ('starter', 'professional', 'ultimate')),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    trial_ends_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.2) users (auth.users -> tenants)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    full_name   TEXT,
    role        TEXT NOT NULL DEFAULT 'owner'
                CHECK (role IN ('owner', 'manager', 'accountant')),
    pin_hash    TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.3) categories
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('product', 'expense')),
    color       TEXT DEFAULT '#6B7280',
    sort_order  INT  DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.4) products
--   Folded: 002 (is_deleted), 006 (category_name)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    category_id    UUID REFERENCES categories(id) ON DELETE SET NULL,
    category_name  TEXT,
    price          NUMERIC(12,2) NOT NULL DEFAULT 0,
    cost           NUMERIC(12,2) DEFAULT 0,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    is_deleted     BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.5) sales
--   Folded: 002 (is_deleted, drop UNIQUE(tenant_id,date)),
--           004_idempotency (idempotency_key),
--           031 (FULL UNIQUE on idempotency_key)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date            DATE NOT NULL,
    total           NUMERIC(12,2) NOT NULL DEFAULT 0,
    cash            NUMERIC(12,2) DEFAULT 0,
    card            NUMERIC(12,2) DEFAULT 0,
    notes           TEXT,
    idempotency_key TEXT,
    is_deleted      BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sales_idempotency_unique UNIQUE (idempotency_key)
);

-- ------------------------------------------------------------
-- B.6) product_sales
--   Folded: 002 (product_id nullable, FK SET NULL)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_sales (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sale_id     UUID REFERENCES sales(id) ON DELETE CASCADE,
    product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
    date        DATE NOT NULL,
    quantity    INT  NOT NULL DEFAULT 0,
    unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
    total       NUMERIC(12,2) NOT NULL DEFAULT 0,
    cost        NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.7) expenses
--   Folded: 006 (category_name), idempotency_key (insert_expense dependency)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date             DATE NOT NULL,
    amount           NUMERIC(12,2) NOT NULL DEFAULT 0,
    category_id      UUID REFERENCES categories(id) ON DELETE SET NULL,
    category_name    TEXT,
    description      TEXT,
    idempotency_key  TEXT,
    created_by       UUID REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT expenses_idempotency_unique UNIQUE (idempotency_key)
);

-- ------------------------------------------------------------
-- B.8) events
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    type           TEXT CHECK (type IN ('concert', 'dj', 'party', 'sports', 'special', 'other')),
    date           DATE NOT NULL,
    start_time     TIME,
    end_time       TIME,
    venue          TEXT,
    description    TEXT,
    est_cost       NUMERIC(12,2) DEFAULT 0,
    est_revenue    NUMERIC(12,2) DEFAULT 0,
    actual_cost    NUMERIC(12,2),
    actual_revenue NUMERIC(12,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.9) tasks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT,
    assignee     TEXT,
    due_date     DATE,
    priority     TEXT DEFAULT 'medium'
                 CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status       TEXT DEFAULT 'todo'
                 CHECK (status IN ('todo', 'in_progress', 'done')),
    category     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.10) settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      JSONB,
    UNIQUE (tenant_id, key)
);

-- ------------------------------------------------------------
-- B.11) deleted_records (audit)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deleted_records (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id    UUID NOT NULL,
    table_name   TEXT NOT NULL,
    record_id    UUID NOT NULL,
    record_data  JSONB NOT NULL,
    deleted_by   UUID REFERENCES users(id),
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.12) system_logs (010 — rich version overrides 001 minimal)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    user_id     UUID,
    action      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'success',
    message     TEXT,
    metadata    JSONB DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- B.13) rate_limits
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
    tenant_id     UUID NOT NULL,
    user_id       UUID NOT NULL,
    action        TEXT NOT NULL,
    last_call_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, action)
);

-- ------------------------------------------------------------
-- B.14) purchases
--   008 RPC dependency: idempotency_key + UNIQUE constraint
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity        NUMERIC(12,2) NOT NULL,
    total_price     NUMERIC(12,2) NOT NULL
                    CONSTRAINT purchases_total_nonneg CHECK (total_price >= 0),   -- 050
    unit_cost       NUMERIC(12,2) NOT NULL,
    vat_rate        NUMERIC(5,2)  NOT NULL DEFAULT 0
                    CONSTRAINT purchases_vat_range CHECK (vat_rate >= 0 AND vat_rate <= 100), -- 050
    net_total       NUMERIC(12,2) NOT NULL,
    idempotency_key TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT purchases_idempotency_unique UNIQUE (idempotency_key)
);

-- ------------------------------------------------------------
-- B.15) raw_materials
--   Folded: 017 (base_unit + check), 022 (cl unit), 033 (vat_rate)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_materials (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    unit        TEXT NOT NULL DEFAULT 'gr'
                CONSTRAINT raw_materials_unit_check
                CHECK (unit IN ('gr', 'kg', 'ml', 'cl', 'lt', 'adet', 'paket')),
    base_unit   TEXT
                CONSTRAINT raw_materials_base_unit_check
                CHECK (base_unit IS NULL OR base_unit IN ('gr', 'ml', 'adet')),
    cost        NUMERIC(12,4) NOT NULL DEFAULT 0
                CHECK (cost >= 0),
    vat_rate    NUMERIC(5,2)  NOT NULL DEFAULT 20
                CONSTRAINT raw_materials_vat_rate_check
                CHECK (vat_rate >= 0 AND vat_rate <= 100),
    is_active   BOOLEAN NOT NULL DEFAULT true,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.16) product_recipes
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- B.17) purchase_invoice_seq (used by 037 batch insert)
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS purchase_invoice_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- ------------------------------------------------------------
-- B.18) purchase_items
--   Folded: 022 (cl unit), 034 (discount_rate),
--           NEW (invoice_no, invoice_date, general_discount_amount,
--                general_discount_type — referenced by 037)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    purchase_id              UUID REFERENCES purchases(id) ON DELETE SET NULL,
    raw_material_id          UUID NOT NULL REFERENCES raw_materials(id) ON DELETE RESTRICT,

    quantity                 NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
    unit                     TEXT NOT NULL
                             CONSTRAINT purchase_items_unit_check
                             CHECK (unit IN ('gr', 'kg', 'ml', 'cl', 'lt', 'adet', 'paket')),

    unit_cost                NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
    line_total               NUMERIC(14,4) NOT NULL CHECK (line_total >= 0),

    base_quantity            NUMERIC(18,6),
    base_unit_cost           NUMERIC(18,6),

    vat_rate                 NUMERIC(5,2) NOT NULL DEFAULT 20  -- FAZ 1.4 / 050: Türkiye standard KDV
                             CHECK (vat_rate >= 0 AND vat_rate <= 100),

    discount_rate            NUMERIC(5,2) NOT NULL DEFAULT 0
                             CONSTRAINT purchase_items_discount_rate_check
                             CHECK (discount_rate >= 0 AND discount_rate <= 100),

    invoice_no               BIGINT,
    invoice_date             DATE,
    general_discount_amount  NUMERIC(14,4) NOT NULL DEFAULT 0,
    general_discount_type    TEXT NOT NULL DEFAULT 'amount'
                             CHECK (general_discount_type IN ('amount', 'percent')),

    note                     TEXT,

    is_deleted               BOOLEAN NOT NULL DEFAULT false,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.19) alert_states
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_states (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    alert_key   TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open', 'dismissed', 'resolved')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- B.20) product_priority (VIEW — alerts_master dependency)
--   products tablosundan turetilir; status/action/priority
--   maliyete gore dinamik hesaplanir.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW product_priority AS
SELECT
    id,
    name,
    tenant_id,
    CASE
        WHEN cost IS NULL OR cost = 0::numeric                       THEN 'COST_MISSING'::text
        WHEN cost > price                                            THEN 'SUSPICIOUS_COST'::text
        WHEN ((price - cost) / NULLIF(price, 0::numeric)) < 0.5      THEN 'PRICE_LOW'::text
        ELSE NULL::text
    END AS status,
    CASE
        WHEN cost IS NULL OR cost = 0::numeric                       THEN 'add_cost'::text
        WHEN cost > price                                            THEN 'check'::text
        WHEN ((price - cost) / NULLIF(price, 0::numeric)) < 0.5      THEN 'update_price'::text
        ELSE NULL::text
    END AS action,
    CASE
        WHEN cost IS NULL OR cost = 0::numeric                       THEN 100
        WHEN cost > price                                            THEN 90
        WHEN ((price - cost) / NULLIF(price, 0::numeric)) < 0.5      THEN 70
        ELSE 0
    END AS priority
FROM products p
WHERE is_deleted = false;


-- ============================================================
-- B.99 — FAZ 1.4 / 050 CANONICAL FINANCE INVARIANTS (CHECK)
--   docs/FINANCE.md v1.0 kural 1, 5, 8, 14. Idempotent ALTER bloklari.
--   purchase_items zaten inline CHECK'lere sahip (B section); burada
--   sales / product_sales / expenses / purchases icin eklenir.
-- ============================================================

ALTER TABLE public.sales
    DROP CONSTRAINT IF EXISTS sales_total_nonneg;
ALTER TABLE public.sales
    ADD  CONSTRAINT sales_total_nonneg CHECK (total >= 0);

ALTER TABLE public.product_sales
    DROP CONSTRAINT IF EXISTS product_sales_amounts_nonneg;
ALTER TABLE public.product_sales
    ADD  CONSTRAINT product_sales_amounts_nonneg
    CHECK (total >= 0 AND unit_price >= 0 AND cost >= 0 AND quantity >= 0);

ALTER TABLE public.expenses
    DROP CONSTRAINT IF EXISTS expenses_amount_nonneg;
ALTER TABLE public.expenses
    ADD  CONSTRAINT expenses_amount_nonneg CHECK (amount >= 0);

-- Not: purchases_total_nonneg ve purchases_vat_range B.14 icinde
-- inline CHECK olarak tanimlandi (CREATE TABLE bloku).


-- ============================================================
-- ============================================================
-- SECTION C — INDEXES
-- ============================================================
-- ============================================================

-- C.1 users
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- C.2 categories
CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories(tenant_id);

-- C.3 products
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_active
    ON products(tenant_id) WHERE is_deleted = false;

-- C.4 sales
CREATE INDEX IF NOT EXISTS idx_sales_tenant_date
    ON sales(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_active
    ON sales(tenant_id, date DESC) WHERE is_deleted = false;

-- C.5 product_sales
CREATE INDEX IF NOT EXISTS idx_product_sales_tenant_date
    ON product_sales(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_product_sales_sale_id
    ON product_sales(sale_id);

-- C.6 expenses
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_date
    ON expenses(tenant_id, date DESC);

-- C.7 events
CREATE INDEX IF NOT EXISTS idx_events_tenant_date
    ON events(tenant_id, date DESC);

-- C.8 tasks
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status
    ON tasks(tenant_id, status);

-- C.9 deleted_records
CREATE INDEX IF NOT EXISTS idx_deleted_records_tenant
    ON deleted_records(tenant_id);

-- C.10 system_logs
CREATE INDEX IF NOT EXISTS idx_system_logs_tenant  ON system_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_action  ON system_logs(action);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);

-- C.11 purchases
CREATE INDEX IF NOT EXISTS idx_purchases_tenant      ON purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchases_product     ON purchases(product_id);
CREATE INDEX IF NOT EXISTS idx_purchases_tenant_date ON purchases(tenant_id, created_at DESC);

-- C.12 raw_materials
CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant
    ON raw_materials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant_active
    ON raw_materials(tenant_id, is_active) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant_name
    ON raw_materials(tenant_id, name) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_raw_materials_tenant_base_unit
    ON raw_materials(tenant_id, base_unit) WHERE is_deleted = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_materials_tenant_name_active
    ON raw_materials(tenant_id, lower(name)) WHERE is_deleted = false;

-- C.13 product_recipes
CREATE INDEX IF NOT EXISTS idx_product_recipes_tenant
    ON product_recipes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_product_recipes_tenant_product
    ON product_recipes(tenant_id, product_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_product_recipes_tenant_raw_material
    ON product_recipes(tenant_id, raw_material_id) WHERE is_deleted = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_recipes_product_rawmat_active
    ON product_recipes(tenant_id, product_id, raw_material_id) WHERE is_deleted = false;

-- C.14 purchase_items
CREATE INDEX IF NOT EXISTS idx_purchase_items_tenant
    ON purchase_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_tenant_rawmat
    ON purchase_items(tenant_id, raw_material_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
    ON purchase_items(purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_items_tenant_date
    ON purchase_items(tenant_id, created_at DESC) WHERE is_deleted = false;

-- C.15 alert_states
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_states_tenant_key
    ON alert_states(tenant_id, alert_key);
CREATE INDEX IF NOT EXISTS idx_alert_states_tenant_state
    ON alert_states(tenant_id, state);


-- ============================================================
-- ============================================================
-- SECTION D — FUNCTIONS (CORE RPC)
-- ============================================================
-- ============================================================


-- ------------------------------------------------------------
-- D.1 — LOGGING HELPERS (010)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION write_system_log(
    p_tenant_id UUID,
    p_user_id   UUID,
    p_action    TEXT,
    p_status    TEXT,
    p_message   TEXT  DEFAULT NULL,
    p_metadata  JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO system_logs (tenant_id, user_id, action, status, message, metadata)
    VALUES (p_tenant_id, p_user_id, p_action, p_status, p_message, p_metadata);
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$$;

CREATE OR REPLACE FUNCTION log_client_event(
    p_action   TEXT,
    p_status   TEXT,
    p_message  TEXT  DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_uid UUID;
    v_tid UUID;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN RETURN; END IF;

    SELECT tenant_id INTO v_tid FROM users WHERE id = v_uid;
    IF v_tid IS NULL THEN RETURN; END IF;

    INSERT INTO system_logs (tenant_id, user_id, action, status, message, metadata)
    VALUES (v_tid, v_uid, p_action, p_status, p_message, p_metadata);
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$$;


-- ------------------------------------------------------------
-- D.2 — RATE LIMIT (011)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_rate_limit(
    p_tenant_id UUID,
    p_user_id   UUID,
    p_action    TEXT,
    p_cooldown  INTERVAL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_last TIMESTAMPTZ;
BEGIN
    SELECT last_call_at INTO v_last
    FROM rate_limits
    WHERE tenant_id = p_tenant_id
      AND user_id = p_user_id
      AND action = p_action;

    IF v_last IS NOT NULL AND (now() - v_last) < p_cooldown THEN
        RAISE EXCEPTION 'Rate limit: % saniye bekleyin',
            CEIL(EXTRACT(EPOCH FROM (p_cooldown - (now() - v_last))));
    END IF;

    INSERT INTO rate_limits (tenant_id, user_id, action, last_call_at)
    VALUES (p_tenant_id, p_user_id, p_action, now())
    ON CONFLICT (tenant_id, user_id, action)
    DO UPDATE SET last_call_at = now();
END;
$$;


-- ------------------------------------------------------------
-- D.3 — SOFT DELETE GENERIC (009)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION soft_delete_record(
    p_table TEXT,
    p_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_record    JSONB;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found';
    END IF;

    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'delete', interval '1 second');

    IF p_table NOT IN ('products', 'sales', 'product_sales', 'expenses', 'categories', 'purchases') THEN
        RAISE EXCEPTION 'Invalid table: %', p_table;
    END IF;

    IF p_id IS NULL THEN
        RAISE EXCEPTION 'Record ID required';
    END IF;

    EXECUTE format(
        'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND t.tenant_id = $2',
        p_table
    ) INTO v_record USING p_id, v_tenant_id;

    IF v_record IS NULL THEN
        RAISE EXCEPTION 'Record not found';
    END IF;

    INSERT INTO deleted_records (tenant_id, table_name, record_id, record_data, deleted_by)
    VALUES (v_tenant_id, p_table, p_id, v_record, v_auth_uid);

    EXECUTE format(
        'DELETE FROM %I WHERE id = $1 AND tenant_id = $2',
        p_table
    ) USING p_id, v_tenant_id;

    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'delete', 'success',
        'Kayit silindi: ' || p_table,
        jsonb_build_object('table', p_table, 'record_id', p_id)
    );

    RETURN jsonb_build_object('success', true, 'table', p_table, 'record_id', p_id);

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'delete', 'fail', SQLERRM,
        jsonb_build_object('table', p_table, 'record_id', p_id)
    );
    RAISE EXCEPTION 'SOFT_DELETE_FAILED: %', SQLERRM;
END;
$$;


-- ------------------------------------------------------------
-- D.4 — UNIT CONVERSION (019)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_unit_base_type(p_unit TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_unit IN ('gr', 'kg')       THEN 'mass'
        WHEN p_unit IN ('ml', 'cl', 'lt') THEN 'volume'
        WHEN p_unit IN ('adet', 'paket')  THEN 'count'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION convert_to_base_unit(
    p_quantity  NUMERIC,
    p_from_unit TEXT,
    p_base_unit TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_from_type TEXT;
    v_base_type TEXT;
BEGIN
    IF p_quantity IS NULL THEN
        RAISE EXCEPTION 'quantity NULL olamaz' USING ERRCODE = '22004';
    END IF;
    IF p_from_unit IS NULL OR p_base_unit IS NULL THEN
        RAISE EXCEPTION 'unit/base_unit NULL olamaz' USING ERRCODE = '22004';
    END IF;

    v_from_type := get_unit_base_type(p_from_unit);
    v_base_type := get_unit_base_type(p_base_unit);

    IF v_from_type IS NULL THEN
        RAISE EXCEPTION 'Bilinmeyen birim: %', p_from_unit USING ERRCODE = '22023';
    END IF;
    IF v_base_type IS NULL THEN
        RAISE EXCEPTION 'Bilinmeyen base_unit: %', p_base_unit USING ERRCODE = '22023';
    END IF;

    IF v_from_type <> v_base_type THEN
        RAISE EXCEPTION 'Uyumsuz birim: % (%) -> % (%)',
            p_from_unit, v_from_type, p_base_unit, v_base_type
            USING ERRCODE = '22023';
    END IF;

    IF v_from_type = 'mass' THEN
        IF p_from_unit = 'gr' AND p_base_unit = 'gr' THEN RETURN p_quantity;
        ELSIF p_from_unit = 'kg' AND p_base_unit = 'gr' THEN RETURN p_quantity * 1000;
        END IF;
    END IF;

    IF v_from_type = 'volume' THEN
        IF p_from_unit = 'ml' AND p_base_unit = 'ml' THEN RETURN p_quantity;
        ELSIF p_from_unit = 'cl' AND p_base_unit = 'ml' THEN RETURN p_quantity * 10;
        ELSIF p_from_unit = 'lt' AND p_base_unit = 'ml' THEN RETURN p_quantity * 1000;
        END IF;
    END IF;

    IF v_from_type = 'count' THEN
        IF p_from_unit = 'adet' AND p_base_unit = 'adet' THEN RETURN p_quantity;
        ELSIF p_from_unit = 'paket' AND p_base_unit = 'adet' THEN
            RAISE EXCEPTION 'paket -> adet donusumu bu surumde desteklenmiyor (package_size gerekli)'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    RAISE EXCEPTION 'Desteklenmeyen donusum: % -> %', p_from_unit, p_base_unit
        USING ERRCODE = '22023';
END;
$$;


-- ------------------------------------------------------------
-- D.5 — COST ENGINES (015 + 035)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION calculate_raw_material_wac(p_raw_material_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_last_cost NUMERIC;
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM raw_materials
    WHERE id = p_raw_material_id
      AND is_deleted = false;

    IF v_tenant_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT pi.base_unit_cost
    INTO v_last_cost
    FROM purchase_items pi
    WHERE pi.raw_material_id = p_raw_material_id
      AND pi.tenant_id = v_tenant_id
      AND pi.is_deleted = false
      AND pi.base_unit_cost IS NOT NULL
      AND pi.base_unit_cost > 0
    ORDER BY pi.created_at DESC
    LIMIT 1;

    IF v_last_cost IS NULL OR v_last_cost <= 0 THEN
        RETURN 0;
    END IF;

    RETURN v_last_cost::NUMERIC;
END;
$$;

CREATE OR REPLACE FUNCTION calculate_product_cost(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT COALESCE(SUM(pr.quantity * rm.cost), 0)::NUMERIC
    FROM product_recipes pr
    JOIN raw_materials   rm ON rm.id = pr.raw_material_id
    WHERE pr.product_id = p_product_id
      AND pr.is_deleted = false
      AND rm.is_deleted = false;
$$;

CREATE OR REPLACE FUNCTION sync_product_cost(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
    v_has_recipe BOOLEAN;
    v_new_cost   NUMERIC;
BEGIN
    IF p_product_id IS NULL THEN
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM product_recipes
        WHERE product_id = p_product_id AND is_deleted = false
    ) INTO v_has_recipe;

    IF NOT v_has_recipe THEN
        RETURN;
    END IF;

    v_new_cost := calculate_product_cost(p_product_id);

    UPDATE products
    SET cost = v_new_cost, updated_at = now()
    WHERE id = p_product_id
      AND COALESCE(cost, 0) IS DISTINCT FROM v_new_cost;
END;
$$;


-- ------------------------------------------------------------
-- D.6 — PURCHASE ATOMIC (008)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_purchase_and_update_product_cost(
    p_product_id      UUID,
    p_quantity        NUMERIC,
    p_total           NUMERIC,
    p_vat             NUMERIC,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth_uid    UUID;
    v_tenant_id   UUID;
    v_net_total   NUMERIC;
    v_unit_cost   NUMERIC;
    v_purchase_id UUID;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found';
    END IF;

    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'purchase', interval '2 seconds');

    IF p_product_id IS NULL THEN RAISE EXCEPTION 'product_id required'; END IF;
    IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
    IF p_total IS NULL OR p_total <= 0 THEN RAISE EXCEPTION 'Invalid total'; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM products WHERE id = p_product_id AND tenant_id = v_tenant_id
    ) THEN
        RAISE EXCEPTION 'Product not found';
    END IF;

    IF p_idempotency_key IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM purchases
            WHERE idempotency_key = p_idempotency_key AND tenant_id = v_tenant_id
        ) THEN
            RETURN jsonb_build_object(
                'success', true, 'duplicate', true, 'message', 'Already recorded'
            );
        END IF;
    END IF;

    v_net_total := p_total + (p_total * COALESCE(p_vat, 0) / 100);
    v_unit_cost := v_net_total / p_quantity;

    INSERT INTO purchases (
        tenant_id, product_id, quantity, total_price,
        vat_rate, net_total, unit_cost, idempotency_key
    ) VALUES (
        v_tenant_id, p_product_id, p_quantity, p_total,
        COALESCE(p_vat, 0), v_net_total, v_unit_cost, p_idempotency_key
    )
    RETURNING id INTO v_purchase_id;

    UPDATE products
    SET cost = v_unit_cost, updated_at = now()
    WHERE id = p_product_id AND tenant_id = v_tenant_id;

    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'purchase', 'success',
        'Alis kaydedildi',
        jsonb_build_object(
            'purchase_id', v_purchase_id, 'product_id', p_product_id,
            'quantity', p_quantity, 'unit_cost', v_unit_cost, 'net_total', v_net_total
        )
    );

    RETURN jsonb_build_object(
        'success', true, 'duplicate', false,
        'purchase_id', v_purchase_id, 'unit_cost', v_unit_cost, 'net_total', v_net_total
    );

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'purchase', 'fail', SQLERRM, '{}'::jsonb
    );
    RAISE EXCEPTION 'PURCHASE_FAILED: %', SQLERRM;
END;
$$;


-- ------------------------------------------------------------
-- D.7 — SALES WRITE RPCs (004_idempotency + 044 + 046 + 047 + 050)
--   046: DB-side authoritative cost snapshot.
--        product_sales.cost server-side products.cost lookup'ından
--        yazılır; frontend cost yok sayılır (silent ignore).
--        Product yok / tenant mismatch / is_deleted=true: RAISE.
--   047: SECURITY DEFINER + search_path standardı.
--        Tenant resolve auth.uid() -> users.tenant_id (DB-side).
--        Legacy p_tenant_id param backward-compat DEFAULT NULL;
--        verilirse cross-check, mismatch -> RAISE.
--        Server-side idempotency_key fallback (formül aynı).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_sales_atomic(
    p_tenant_id UUID  DEFAULT NULL,
    p_sales     JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid      UUID;
    v_tenant_id     UUID;

    v_sale          JSONB;
    v_product       JSONB;
    v_sale_id       UUID;
    v_ikey          TEXT;
    v_results       JSONB := '[]'::jsonb;
    v_sale_record   JSONB;
    v_is_new        BOOLEAN;

    -- 046: server-side cost snapshot
    v_product_id    UUID;
    v_snapshot_cost NUMERIC;
BEGIN
    -- 047: AUTH
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id
      INTO v_tenant_id
      FROM users u
     WHERE u.id = v_auth_uid
       AND u.is_active = true;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found or user disabled'
            USING ERRCODE = '42501';
    END IF;

    -- 047: legacy p_tenant_id cross-check
    IF p_tenant_id IS NOT NULL
       AND p_tenant_id IS DISTINCT FROM v_tenant_id THEN
        RAISE EXCEPTION 'Tenant mismatch'
            USING ERRCODE = '42501';
    END IF;

    IF p_sales IS NULL OR jsonb_array_length(p_sales) = 0 THEN
        RAISE EXCEPTION 'p_sales: at least one sale is required';
    END IF;

    FOR v_sale IN SELECT * FROM jsonb_array_elements(p_sales)
    LOOP
        -- 047: server-side idempotency_key fallback (formül korunur)
        v_ikey := COALESCE(
            v_sale->>'idempotency_key',
            md5(
                v_tenant_id::text                                   || '|' ||
                COALESCE(v_sale->>'date', '')                       || '|' ||
                COALESCE((v_sale->>'total')::numeric, 0)::text      || '|' ||
                COALESCE((v_sale->>'cash')::numeric, 0)::text       || '|' ||
                COALESCE((v_sale->>'card')::numeric, 0)::text       || '|' ||
                COALESCE(v_sale->>'notes', '')
            )
        );

        v_sale_id := NULL;
        v_is_new  := FALSE;

        IF v_ikey IS NOT NULL THEN
            SELECT id INTO v_sale_id
              FROM sales
             WHERE idempotency_key = v_ikey
               AND tenant_id       = v_tenant_id
               AND is_deleted      = false
             LIMIT 1;
        END IF;

        IF v_sale_id IS NULL THEN
            INSERT INTO sales (
                tenant_id, date, total, cash, card,
                notes, created_by, idempotency_key
            )
            VALUES (
                v_tenant_id,
                (v_sale->>'date')::DATE,
                COALESCE((v_sale->>'total')::NUMERIC, 0),
                COALESCE((v_sale->>'cash')::NUMERIC, 0),
                COALESCE((v_sale->>'card')::NUMERIC, 0),
                v_sale->>'notes',
                v_auth_uid,
                v_ikey
            )
            RETURNING id INTO v_sale_id;
            v_is_new := TRUE;
        END IF;

        IF v_sale_id IS NULL THEN CONTINUE; END IF;

        IF v_is_new THEN
            IF v_sale->'products' IS NOT NULL
               AND jsonb_array_length(v_sale->'products') > 0 THEN
                FOR v_product IN SELECT * FROM jsonb_array_elements(v_sale->'products')
                LOOP
                    v_product_id := (v_product->>'product_id')::UUID;

                    IF v_product_id IS NULL THEN
                        RAISE EXCEPTION 'product_id is required for sale line';
                    END IF;

                    -- 046: AUTHORITATIVE COST LOOKUP (047: v_tenant_id)
                    -- DEFINER altinda RLS bypass; manuel tenant guard zorunlu.
                    SELECT p.cost
                      INTO v_snapshot_cost
                      FROM products p
                     WHERE p.id        = v_product_id
                       AND p.tenant_id = v_tenant_id
                       AND COALESCE(p.is_deleted, false) = false;

                    IF NOT FOUND THEN
                        RAISE EXCEPTION
                            'Product not found, deleted, or tenant mismatch: %',
                            v_product_id
                            USING ERRCODE = '42501';
                    END IF;

                    INSERT INTO product_sales (
                        tenant_id, sale_id, product_id, date,
                        quantity, unit_price, total, cost
                    )
                    VALUES (
                        v_tenant_id, v_sale_id,
                        v_product_id,
                        (v_sale->>'date')::DATE,
                        COALESCE((v_product->>'quantity')::INT, 0),
                        COALESCE((v_product->>'unit_price')::NUMERIC, 0),
                        COALESCE((v_product->>'total')::NUMERIC, 0),
                        COALESCE(v_snapshot_cost, 0)   -- server-side snapshot
                    );
                END LOOP;
            END IF;
        END IF;

        IF v_is_new THEN
            SELECT jsonb_build_object(
                'id', s.id, 'tenant_id', s.tenant_id, 'date', s.date,
                'total', s.total, 'cash', s.cash, 'card', s.card, 'notes', s.notes,
                'created_by', s.created_by, 'created_at', s.created_at,
                'is_deleted', s.is_deleted,
                'product_sales', COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'id', ps.id, 'sale_id', ps.sale_id, 'product_id', ps.product_id,
                        'date', ps.date, 'quantity', ps.quantity,
                        'unit_price', ps.unit_price, 'total', ps.total, 'cost', ps.cost
                    )) FROM product_sales ps WHERE ps.sale_id = s.id),
                    '[]'::jsonb
                )
            ) INTO v_sale_record
            FROM sales s WHERE s.id = v_sale_id;

            v_results := v_results || v_sale_record;
        END IF;
    END LOOP;

    RETURN v_results;
END;
$$;

DROP FUNCTION IF EXISTS public.create_sale_empty(JSONB);
CREATE OR REPLACE FUNCTION public.create_sale_empty(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_new_id    UUID;
    v_idem_key  TEXT;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM public.users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'p_payload object olmali';
    END IF;

    IF p_payload->>'date' IS NULL THEN
        RAISE EXCEPTION 'date zorunlu';
    END IF;

    v_idem_key := COALESCE(
        p_payload->>'idempotency_key',
        md5(
            v_tenant_id::text || '|' ||
            (p_payload->>'date') || '|' ||
            COALESCE((p_payload->>'total')::numeric, 0)::text || '|' ||
            COALESCE((p_payload->>'cash')::numeric, 0)::text  || '|' ||
            COALESCE((p_payload->>'card')::numeric, 0)::text  || '|' ||
            COALESCE(p_payload->>'notes', '')
        )
    );

    BEGIN
        INSERT INTO public.sales (
            tenant_id, date, total, cash, card, notes,
            is_deleted, idempotency_key, created_by
        ) VALUES (
            v_tenant_id,
            (p_payload->>'date')::DATE,
            COALESCE((p_payload->>'total')::numeric, 0),
            COALESCE((p_payload->>'cash')::numeric, 0),
            COALESCE((p_payload->>'card')::numeric, 0),
            p_payload->>'notes',
            false, v_idem_key, v_auth_uid
        )
        RETURNING id INTO v_new_id;

        RETURN jsonb_build_object(
            'success', true, 'id', v_new_id, 'duplicate', false,
            'idempotency_key', v_idem_key
        );

    EXCEPTION WHEN unique_violation THEN
        SELECT id INTO v_new_id FROM public.sales
        WHERE tenant_id = v_tenant_id AND idempotency_key = v_idem_key
        LIMIT 1;

        RETURN jsonb_build_object(
            'success', true, 'id', v_new_id, 'duplicate', true,
            'idempotency_key', v_idem_key, 'message', 'Ayni satis zaten kayitli'
        );
    END;
END;
$$;

DROP FUNCTION IF EXISTS public.update_sale(UUID, JSONB);
CREATE OR REPLACE FUNCTION public.update_sale(p_id UUID, p_updates JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_exists    BOOLEAN;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM public.users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_id IS NULL THEN RAISE EXCEPTION 'p_id zorunlu'; END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.sales WHERE id = p_id AND tenant_id = v_tenant_id
    ) INTO v_exists;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'Sale not found or access denied' USING ERRCODE = '42501';
    END IF;

    UPDATE public.sales
    SET
        date  = COALESCE((p_updates->>'date')::DATE,    date),
        total = COALESCE((p_updates->>'total')::numeric, total),
        cash  = COALESCE((p_updates->>'cash')::numeric,  cash),
        card  = COALESCE((p_updates->>'card')::numeric,  card),
        notes = COALESCE(p_updates->>'notes',            notes),
        updated_at = now()
    WHERE id = p_id AND tenant_id = v_tenant_id;

    RETURN jsonb_build_object('success', true, 'id', p_id);
END;
$$;

DROP FUNCTION IF EXISTS public.soft_delete_sale(UUID);
CREATE OR REPLACE FUNCTION public.soft_delete_sale(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_id IS NULL THEN RAISE EXCEPTION 'p_id zorunlu'; END IF;
    RETURN public.soft_delete_record('sales', p_id);
END;
$$;


-- ------------------------------------------------------------
-- D.7.5 — get_sales_paginated (read RPC)
--   Tarih araligi + pagination + cost/profit aggregation.
--   Tenant: get_my_tenant_id() ile resolve.
--   Soft-deleted satislar hariç.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_sales_paginated(
    p_start  DATE,
    p_end    DATE,
    p_limit  INT,
    p_offset INT
)
RETURNS TABLE (
    id          UUID,
    date        DATE,
    total       NUMERIC,
    cash        NUMERIC,
    card        NUMERIC,
    cost        NUMERIC,
    profit      NUMERIC,
    created_at  TIMESTAMPTZ,
    total_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        s.date,
        s.total,
        s.cash,
        s.card,
        COALESCE(SUM(ps.cost), 0)               AS cost,
        s.total - COALESCE(SUM(ps.cost), 0)     AS profit,
        s.created_at,
        COUNT(*) OVER()::INT                    AS total_count
    FROM sales s
    LEFT JOIN product_sales ps ON ps.sale_id = s.id
    WHERE s.tenant_id  = get_my_tenant_id()
      AND s.is_deleted = false
      AND s.date BETWEEN p_start AND p_end
    GROUP BY s.id
    ORDER BY s.date DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;


-- ------------------------------------------------------------
-- D.8 — EXPENSE WRITE RPCs (045 + insert_expense + 050)
--
-- insert_expense:
--   tenant_id server-side resolve (auth.uid -> users.tenant_id)
--   Client tenant spoofing yapamaz.
--   ON CONFLICT (idempotency_key) -> amount update (re-submit safe)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION insert_expense(
    p_date            DATE,
    p_amount          NUMERIC,
    p_category_id     UUID,
    p_category_name   TEXT,
    p_description     TEXT,
    p_idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_id        UUID;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_date IS NULL THEN
        RAISE EXCEPTION 'date zorunlu';
    END IF;

    INSERT INTO expenses (
        tenant_id, date, amount, category_id, category_name,
        description, idempotency_key, created_by
    ) VALUES (
        v_tenant_id,
        p_date,
        COALESCE(p_amount, 0),
        p_category_id,
        p_category_name,
        p_description,
        p_idempotency_key,
        v_auth_uid
    )
    ON CONFLICT (idempotency_key) DO UPDATE
        SET amount = EXCLUDED.amount
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;


CREATE OR REPLACE FUNCTION update_expense(
    p_id      UUID,
    p_updates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth_uid     UUID;
    v_tenant_id    UUID;
    v_existing     expenses%ROWTYPE;
    v_new_date     DATE;
    v_new_amount   NUMERIC(12,2);
    v_new_desc     TEXT;
    v_new_cat_id   UUID;
    v_new_cat_name TEXT;
    v_result       JSONB;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_id IS NULL THEN RAISE EXCEPTION 'Expense ID required'; END IF;
    IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' THEN
        RAISE EXCEPTION 'Updates payload required';
    END IF;

    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'update_expense', interval '1 second');

    SELECT * INTO v_existing
    FROM expenses
    WHERE id = p_id AND tenant_id = v_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

    IF p_updates ? 'date' THEN
        v_new_date := NULLIF(p_updates->>'date','')::DATE;
    ELSE
        v_new_date := v_existing.date;
    END IF;

    IF p_updates ? 'amount' THEN
        v_new_amount := COALESCE((p_updates->>'amount')::NUMERIC, 0);
    ELSE
        v_new_amount := v_existing.amount;
    END IF;

    IF p_updates ? 'description' THEN
        v_new_desc := COALESCE(p_updates->>'description', '');
    ELSE
        v_new_desc := v_existing.description;
    END IF;

    IF p_updates ? 'category_id' THEN
        v_new_cat_id := NULLIF(p_updates->>'category_id','')::UUID;
    ELSE
        v_new_cat_id := v_existing.category_id;
    END IF;

    IF p_updates ? 'category_name' THEN
        v_new_cat_name := NULLIF(p_updates->>'category_name','');
    ELSE
        v_new_cat_name := v_existing.category_name;
    END IF;

    IF v_new_date IS NULL THEN RAISE EXCEPTION 'date cannot be null'; END IF;

    UPDATE expenses
       SET date          = v_new_date,
           amount        = v_new_amount,
           description   = v_new_desc,
           category_id   = v_new_cat_id,
           category_name = v_new_cat_name,
           updated_at    = now()
     WHERE id = p_id AND tenant_id = v_tenant_id
    RETURNING to_jsonb(expenses.*) INTO v_result;

    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'update_expense', 'success',
        'Gider guncellendi',
        jsonb_build_object('expense_id', p_id)
    );

    RETURN jsonb_build_object('success', true, 'data', v_result);

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'update_expense', 'fail', SQLERRM,
        jsonb_build_object('expense_id', p_id)
    );
    RAISE EXCEPTION 'UPDATE_EXPENSE_FAILED: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION soft_delete_expense(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_id IS NULL THEN RAISE EXCEPTION 'Expense ID required'; END IF;
    RETURN soft_delete_record('expenses', p_id);
END;
$$;


-- ------------------------------------------------------------
-- D.9 — PURCHASE ITEMS BATCH (037)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION insert_purchase_items_batch(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid    UUID;
    v_tenant_id   UUID;
    v_item        JSONB;
    v_invoice_id  TEXT;
    v_invoice_no  BIGINT;
    v_count       INT := 0;
    v_idx         INT := 0;
    v_ids         UUID[] := ARRAY[]::UUID[];
    v_new_id      UUID;
    v_note_json   JSONB;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'p_items JSONB array olmali';
    END IF;

    IF jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'p_items bos olamaz';
    END IF;

    BEGIN
        v_note_json := (p_items->0->>'note')::JSONB;
        v_invoice_id := v_note_json->>'invoice_id';
    EXCEPTION WHEN OTHERS THEN
        v_invoice_id := NULL;
    END;

    IF v_invoice_id IS NOT NULL AND v_invoice_id <> '' THEN
        SELECT invoice_no
        INTO v_invoice_no
        FROM purchase_items
        WHERE tenant_id = v_tenant_id
          AND is_deleted = false
          AND invoice_no IS NOT NULL
          AND (note::JSONB->>'invoice_id') = v_invoice_id
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;

    IF v_invoice_no IS NULL THEN
        v_invoice_no := nextval('purchase_invoice_seq');
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_idx := v_idx + 1;

        IF v_item->>'raw_material_id' IS NULL OR v_item->>'raw_material_id' = '' THEN
            RAISE EXCEPTION 'Item %: raw_material_id zorunlu', v_idx;
        END IF;

        IF (v_item->>'quantity') IS NULL
           OR NOT ((v_item->>'quantity')::TEXT ~ '^-?[0-9]+(\.[0-9]+)?$')
           OR (v_item->>'quantity')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'Item %: quantity > 0 olmali', v_idx;
        END IF;

        IF (v_item->>'base_quantity') IS NULL
           OR (v_item->>'base_quantity')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'Item %: base_quantity > 0 olmali (WAC verisi)', v_idx;
        END IF;

        IF (v_item->>'base_unit_cost') IS NULL
           OR (v_item->>'base_unit_cost')::NUMERIC < 0 THEN
            RAISE EXCEPTION 'Item %: base_unit_cost >= 0 olmali (WAC verisi)', v_idx;
        END IF;

        INSERT INTO purchase_items (
            tenant_id, raw_material_id, quantity, unit, unit_cost, line_total,
            vat_rate, discount_rate, base_quantity, base_unit_cost,
            general_discount_amount, general_discount_type,
            note, invoice_date, invoice_no
        ) VALUES (
            v_tenant_id,
            (v_item->>'raw_material_id')::UUID,
            (v_item->>'quantity')::NUMERIC,
            v_item->>'unit',
            COALESCE((v_item->>'unit_cost')::NUMERIC, 0),
            COALESCE((v_item->>'line_total')::NUMERIC, 0),
            COALESCE((v_item->>'vat_rate')::NUMERIC, 0),
            COALESCE((v_item->>'discount_rate')::NUMERIC, 0),
            (v_item->>'base_quantity')::NUMERIC,
            (v_item->>'base_unit_cost')::NUMERIC,
            COALESCE((v_item->>'general_discount_amount')::NUMERIC, 0),
            COALESCE(v_item->>'general_discount_type', 'amount'),
            v_item->>'note',
            NULLIF(v_item->>'invoice_date', '')::DATE,
            v_invoice_no
        )
        RETURNING id INTO v_new_id;

        v_ids := v_ids || v_new_id;
        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'count', v_count,
        'invoice_no', v_invoice_no,
        'inserted_ids', to_jsonb(v_ids)
    );
END;
$$;


-- ============================================================
-- ============================================================
-- SECTION E — USERS / TENANT FUNCTIONS (helpers)
-- ============================================================
-- ============================================================


-- E.1 — get_my_tenant_id (024)
CREATE OR REPLACE FUNCTION get_my_tenant_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT tenant_id FROM public.users WHERE id = auth.uid()
$$;


-- E.2 — set_tenant_id (tenant_auto_assign)
CREATE OR REPLACE FUNCTION set_tenant_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id uuid;
BEGIN
    IF NEW.tenant_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM public.users
    WHERE id = auth.uid();

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    NEW.tenant_id := v_tenant_id;

    RETURN NEW;
END;
$$;


-- ============================================================
-- E.3 — handle_new_user (FINAL FIX — slug + email + RLS bypass)
--
-- Bu blok self-contained:
--   1) Eski trigger'i drop (function dependency'si kalkar)
--   2) Eski function'i drop
--   3) Yeni function (slug + email + SET row_security = off)
--   4) Owner = postgres (BYPASSRLS garantisi)
--   5) Grants (Supabase auth pipeline)
--   6) Trigger yeniden bind
--
-- Fresh install:
--   - signup -> auth.users INSERT -> trigger fire ->
--     tenants + users otomatik olusur, RLS bloklamaz.
-- ============================================================

-- 1) Eski trigger'i drop et
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 2) Eski function'i drop et (artik bagimliligi yok)
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 3) Yeni function
CREATE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off       -- KRITIK: FORCE RLS bypass
AS $$
DECLARE
    v_tenant_id uuid;
    v_slug      text;
    v_email     text;
BEGIN
    -- Idempotency: zaten varsa skip
    IF EXISTS (SELECT 1 FROM public.users WHERE id = NEW.id) THEN
        RETURN NEW;
    END IF;

    -- Email: auth.users'dan al, yoksa placeholder (NOT NULL constraint)
    v_email := COALESCE(NULLIF(NEW.email, ''), NEW.id::text || '@placeholder.local');

    -- Slug: cakisma riski olmasin diye uuid bazli (UNIQUE NOT NULL)
    v_slug  := 'tenant-' || replace(gen_random_uuid()::text, '-', '');

    -- 1) TENANT
    INSERT INTO public.tenants (name, slug)
    VALUES ('Yeni Tenant', v_slug)
    RETURNING id INTO v_tenant_id;

    -- 2) USERS
    INSERT INTO public.users (id, tenant_id, email)
    VALUES (NEW.id, v_tenant_id, v_email);

    RETURN NEW;

EXCEPTION WHEN OTHERS THEN
    -- KRITIK: auth.users INSERT'i ASLA bozulmasin.
    -- Hata olursa system_logs'a yaz (varsa), trigger sessiz devam etsin.
    BEGIN
        PERFORM public.write_system_log(
            '00000000-0000-0000-0000-000000000000'::uuid,
            NEW.id, 'handle_new_user', 'fail', SQLERRM,
            jsonb_build_object('auth_user_id', NEW.id, 'email', NEW.email)
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NEW;
END;
$$;

-- 4) Owner = postgres (BYPASSRLS + table owner garantisi)
ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- 5) Grants (Supabase auth pipeline)
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;

-- 6) Trigger yeniden bind (auth.users AFTER INSERT)
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();


-- E.4 — trg_fn_users_lock_critical_columns (027 final)
--   Mevcut function'i DROP ETME (trigger bagimliligi var -> 2BP01 hatasi).
--   Sadece YOKSA olustur. Var olan body korunur.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'trg_fn_users_lock_critical_columns'
          AND pronamespace = 'public'::regnamespace
    ) THEN
        EXECUTE $create$
        CREATE FUNCTION public.trg_fn_users_lock_critical_columns()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $func$
        DECLARE
            v_bypass TEXT;
        BEGIN
            BEGIN
                v_bypass := current_setting('app.bypass_user_lock', true);
            EXCEPTION WHEN OTHERS THEN
                v_bypass := NULL;
            END;

            IF v_bypass = 'on' THEN
                RETURN NEW;
            END IF;

            IF NEW.id IS DISTINCT FROM OLD.id THEN
                RAISE EXCEPTION 'users.id degistirilemez (tenant lock)'
                    USING ERRCODE = '42501';
            END IF;

            IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
                RAISE EXCEPTION 'users.tenant_id degistirilemez (tenant lock)'
                    USING ERRCODE = '42501';
            END IF;

            IF NEW.role IS DISTINCT FROM OLD.role THEN
                RAISE EXCEPTION 'users.role degistirilemez (tenant lock)'
                    USING ERRCODE = '42501';
            END IF;

            RETURN NEW;
        END;
        $func$;
        $create$;
    END IF;
END
$$;


-- ============================================================
-- ============================================================
-- SECTION F — TRIGGERS (+ trigger functions)
-- ============================================================
-- ============================================================


-- F.1 — set_tenant_id BEFORE INSERT (11 tablo)
DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.categories;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.categories
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.products;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.products
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.sales;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.product_sales;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.product_sales
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.expenses;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.expenses
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.events;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.events
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.tasks;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.tasks
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.purchases;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.purchases
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.purchase_items;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.purchase_items
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.raw_materials;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.raw_materials
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON public.product_recipes;
CREATE TRIGGER set_tenant_id_before_insert BEFORE INSERT ON public.product_recipes
FOR EACH ROW EXECUTE FUNCTION set_tenant_id();


-- F.2 — handle_new_user trigger
--   ⚠ Trigger E.3 bloğunda kuruluyor (self-contained: drop+create+owner+grant+trigger).
--   Burada tekrar tanımlamiyoruz — duplicate olmasin diye. Sadece referans.


-- F.3 — users lock (BEFORE UPDATE, ENABLE ALWAYS)
DROP TRIGGER IF EXISTS trg_users_lock_critical_columns ON public.users;
CREATE TRIGGER trg_users_lock_critical_columns
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_users_lock_critical_columns();

ALTER TABLE public.users
    ENABLE ALWAYS TRIGGER trg_users_lock_critical_columns;


-- F.4 — purchase_items BEFORE INSERT/UPDATE: fill_base (021 + 051 VAT+discount aware)
--   051 (FAZ 1.4): base_unit_cost artik KDV DAHIL + iskonto SONRASI olarak
--   yazilir. docs/FINANCE.md kural 11+12.
--     v_net      = COALESCE(line_total,
--                           quantity * unit_cost * (1 - discount_rate/100))
--     v_with_vat = v_net * (1 + vat_rate/100)
--     base_unit_cost = v_with_vat / base_quantity
CREATE OR REPLACE FUNCTION trg_fn_purchase_items_fill_base()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_base_unit  TEXT;
    v_qty_base   NUMERIC;
    v_net        NUMERIC;     -- KDV HARIC, iskonto SONRASI
    v_with_vat   NUMERIC;     -- KDV DAHIL, iskonto sonrasi
    v_discount   NUMERIC;
    v_vat        NUMERIC;
BEGIN
    IF NEW.raw_material_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT base_unit INTO v_base_unit
      FROM raw_materials
     WHERE id = NEW.raw_material_id;

    IF v_base_unit IS NULL THEN
        NEW.base_quantity  := NULL;
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END IF;

    IF NEW.quantity IS NULL OR NEW.quantity <= 0 OR NEW.unit IS NULL THEN
        RETURN NEW;
    END IF;

    BEGIN
        v_qty_base := convert_to_base_unit(NEW.quantity, NEW.unit, v_base_unit);
    EXCEPTION WHEN OTHERS THEN
        NEW.base_quantity  := NULL;
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END;

    NEW.base_quantity := v_qty_base;

    -- 051 canonical hesap (docs/FINANCE.md kural 11+12)
    v_discount := COALESCE(NEW.discount_rate, 0);
    v_vat      := COALESCE(NEW.vat_rate,      0);

    IF NEW.line_total IS NOT NULL AND NEW.line_total >= 0 THEN
        v_net := NEW.line_total;                                   -- kural 11: zaten iskonto sonrasi
    ELSIF NEW.unit_cost IS NOT NULL AND NEW.unit_cost >= 0 THEN
        v_net := NEW.quantity * NEW.unit_cost * (1 - v_discount / 100);  -- fallback
    ELSE
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END IF;

    v_with_vat := v_net * (1 + v_vat / 100);

    IF v_qty_base IS NOT NULL AND v_qty_base > 0 THEN
        NEW.base_unit_cost := v_with_vat / v_qty_base;
    ELSE
        NEW.base_unit_cost := NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_items_fill_base ON public.purchase_items;
CREATE TRIGGER trg_purchase_items_fill_base
BEFORE INSERT OR UPDATE ON public.purchase_items
FOR EACH ROW
EXECUTE FUNCTION trg_fn_purchase_items_fill_base();


-- F.5 — purchase_items AFTER: cost_sync (036 final)
CREATE OR REPLACE FUNCTION sync_raw_material_cost(p_raw_material_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE raw_materials
    SET cost       = calculate_raw_material_wac(p_raw_material_id),
        updated_at = now()
    WHERE id = p_raw_material_id;
END;
$$;

CREATE OR REPLACE FUNCTION trg_fn_purchase_items_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rm_id  UUID;
    v_old_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_rm_id  := NEW.raw_material_id;
        v_old_id := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
        v_rm_id  := NEW.raw_material_id;
        v_old_id := OLD.raw_material_id;
    ELSIF TG_OP = 'DELETE' THEN
        v_rm_id  := OLD.raw_material_id;
        v_old_id := NULL;
    END IF;

    IF v_rm_id IS NOT NULL THEN
        UPDATE raw_materials
        SET cost       = calculate_raw_material_wac(v_rm_id),
            updated_at = now()
        WHERE id = v_rm_id;
    END IF;

    IF TG_OP = 'UPDATE'
       AND v_old_id IS NOT NULL
       AND v_old_id IS DISTINCT FROM v_rm_id THEN
        UPDATE raw_materials
        SET cost       = calculate_raw_material_wac(v_old_id),
            updated_at = now()
        WHERE id = v_old_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_items_cost_sync     ON public.purchase_items;
DROP TRIGGER IF EXISTS trg_purchase_items_cost_sync_upd ON public.purchase_items;

CREATE TRIGGER trg_purchase_items_cost_sync
AFTER INSERT OR DELETE ON public.purchase_items
FOR EACH ROW
EXECUTE FUNCTION trg_fn_purchase_items_cost_sync();

CREATE TRIGGER trg_purchase_items_cost_sync_upd
AFTER UPDATE ON public.purchase_items
FOR EACH ROW
WHEN (
       OLD.quantity        IS DISTINCT FROM NEW.quantity
    OR OLD.unit            IS DISTINCT FROM NEW.unit
    OR OLD.unit_cost       IS DISTINCT FROM NEW.unit_cost
    OR OLD.line_total      IS DISTINCT FROM NEW.line_total
    OR OLD.base_unit_cost  IS DISTINCT FROM NEW.base_unit_cost
    OR OLD.base_quantity   IS DISTINCT FROM NEW.base_quantity
    OR OLD.raw_material_id IS DISTINCT FROM NEW.raw_material_id
    OR OLD.is_deleted      IS DISTINCT FROM NEW.is_deleted
    OR OLD.created_at      IS DISTINCT FROM NEW.created_at
)
EXECUTE FUNCTION trg_fn_purchase_items_cost_sync();


-- F.6 — Recipe cost sync (015)
CREATE OR REPLACE FUNCTION trg_fn_product_recipes_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM sync_product_cost(NEW.product_id);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM sync_product_cost(NEW.product_id);
        IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
            PERFORM sync_product_cost(OLD.product_id);
        END IF;
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        PERFORM sync_product_cost(OLD.product_id);
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_fn_raw_materials_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT product_id
        FROM product_recipes
        WHERE raw_material_id = NEW.id
          AND is_deleted = false
    LOOP
        PERFORM sync_product_cost(r.product_id);
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_recipes_cost_sync ON public.product_recipes;
CREATE TRIGGER trg_product_recipes_cost_sync
AFTER INSERT OR UPDATE OR DELETE ON public.product_recipes
FOR EACH ROW
EXECUTE FUNCTION trg_fn_product_recipes_cost_sync();

DROP TRIGGER IF EXISTS trg_raw_materials_cost_sync ON public.raw_materials;
CREATE TRIGGER trg_raw_materials_cost_sync
AFTER UPDATE ON public.raw_materials
FOR EACH ROW
WHEN (
    OLD.cost       IS DISTINCT FROM NEW.cost
 OR OLD.is_deleted IS DISTINCT FROM NEW.is_deleted
)
EXECUTE FUNCTION trg_fn_raw_materials_cost_sync();


-- ============================================================
-- F.7 — raw_materials.base_unit AUTO-FILL (BEFORE INSERT/UPDATE)
--
--   Frontend base_unit gondermezse unit'ten otomatik resolve eder.
--   Boylece base_unit asla NULL kalmaz; cost cascade chain'i
--   (purchase_items -> raw_materials.cost -> products.cost) hep
--   calisir.
--
--   Eslestirme:
--     gr, kg       -> gr
--     ml, cl, lt   -> ml
--     adet, paket  -> adet
--     diger        -> NULL (CHECK constraint zaten kullaniciyi uyarir)
-- ============================================================

CREATE OR REPLACE FUNCTION trg_fn_raw_materials_fill_base_unit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.base_unit IS NULL OR NEW.base_unit = '' THEN
        NEW.base_unit := CASE
            WHEN NEW.unit IN ('gr', 'kg')       THEN 'gr'
            WHEN NEW.unit IN ('ml', 'cl', 'lt') THEN 'ml'
            WHEN NEW.unit IN ('adet', 'paket')  THEN 'adet'
            ELSE NULL
        END;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_raw_materials_fill_base_unit ON public.raw_materials;
CREATE TRIGGER trg_raw_materials_fill_base_unit
BEFORE INSERT OR UPDATE ON public.raw_materials
FOR EACH ROW
EXECUTE FUNCTION trg_fn_raw_materials_fill_base_unit();

GRANT EXECUTE ON FUNCTION trg_fn_raw_materials_fill_base_unit() TO authenticated;


-- ============================================================
-- F.8 — BACKFILL: eski raw_materials.base_unit boslarini doldur
--   Idempotent: base_unit dolu olanlari atlar.
--   Ardindan purchase_items'leri tetikleyip
--   base_quantity / base_unit_cost'larin hesaplanmasini saglar.
-- ============================================================

DO $$
DECLARE
    v_updated_rm INT;
BEGIN
    UPDATE raw_materials
    SET base_unit = CASE
        WHEN unit IN ('gr', 'kg')       THEN 'gr'
        WHEN unit IN ('ml', 'cl', 'lt') THEN 'ml'
        WHEN unit IN ('adet', 'paket')  THEN 'adet'
        ELSE base_unit
    END,
    updated_at = now()
    WHERE base_unit IS NULL;

    GET DIAGNOSTICS v_updated_rm = ROW_COUNT;
    RAISE NOTICE 'F.8 backfill: % raw_materials base_unit dolduruldu', v_updated_rm;

    -- purchase_items BEFORE trigger'i tetikle (base_quantity / base_unit_cost recompute)
    UPDATE purchase_items
    SET updated_at = now()
    WHERE is_deleted = false AND (base_quantity IS NULL OR base_unit_cost IS NULL);

    -- Tum raw_materials.cost'lari yeniden hesapla (defansif)
    PERFORM (
        SELECT 1 FROM (
            SELECT id FROM raw_materials WHERE is_deleted = false
        ) rm
    );
END $$;


-- ============================================================
-- ============================================================
-- SECTION G — RLS POLICIES (multi-tenant isolation)
-- ============================================================
-- ============================================================


-- G.1 — Eski policy artiklarini temizle (idempotent)
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'tenants', 'users', 'categories', 'products', 'sales',
        'product_sales', 'expenses', 'events', 'tasks',
        'settings', 'deleted_records', 'system_logs',
        'purchases', 'purchase_items', 'raw_materials',
        'product_recipes', 'alert_states'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS users_self_only ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS purchases_tenant_isolation ON public.%I', tbl);
    END LOOP;
END $$;

DROP POLICY IF EXISTS system_logs_select_own  ON public.system_logs;
DROP POLICY IF EXISTS system_logs_no_modify   ON public.system_logs;
DROP POLICY IF EXISTS tenant_isolation_system_logs ON public.system_logs;


-- G.2 — RLS ENABLE + FORCE
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'tenants', 'users', 'categories', 'products', 'sales',
        'product_sales', 'expenses', 'events', 'tasks',
        'settings', 'deleted_records', 'system_logs',
        'purchases', 'purchase_items', 'raw_materials',
        'product_recipes', 'alert_states'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', tbl);
    END LOOP;
END $$;


-- G.3 — tenants
CREATE POLICY tenant_isolation ON public.tenants
    FOR ALL
    USING (id = get_my_tenant_id())
    WITH CHECK (id = get_my_tenant_id());


-- G.4 — users (kendi satiri)
CREATE POLICY users_self_only ON public.users
    FOR ALL
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());


-- G.5 — Generic tenant-scoped tablolar
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'categories', 'products', 'sales', 'product_sales',
        'expenses', 'events', 'tasks', 'settings',
        'deleted_records', 'purchases', 'purchase_items',
        'raw_materials', 'product_recipes', 'alert_states'
    ] LOOP
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON public.%I
            FOR ALL
            USING (tenant_id = get_my_tenant_id())
            WITH CHECK (tenant_id = get_my_tenant_id())
        $f$, tbl);
    END LOOP;
END $$;


-- G.6 — system_logs SELECT-only
CREATE POLICY system_logs_select_own ON public.system_logs
    FOR SELECT
    USING (tenant_id = get_my_tenant_id());


-- ============================================================
-- ============================================================
-- SECTION H — ANALYTICS / BACKUP / ALERTS
-- ============================================================
-- ============================================================


-- H.1 — get_dashboard_analytics (004)
CREATE OR REPLACE FUNCTION get_dashboard_analytics(
    p_start DATE,
    p_end   DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid UUID;
    v_tenant_id UUID;

    v_today      DATE;
    v_yesterday  DATE;
    v_week_start DATE;

    v_prev_start DATE;
    v_prev_end   DATE;

    v_monthly_revenue        NUMERIC := 0;
    v_monthly_expense        NUMERIC := 0;
    v_monthly_product_cost   NUMERIC := 0;
    v_prev_revenue           NUMERIC := 0;
    v_prev_expense           NUMERIC := 0;
    v_prev_product_cost      NUMERIC := 0;
    v_today_revenue          NUMERIC := 0;
    v_today_expense          NUMERIC := 0;
    v_today_product_cost     NUMERIC := 0;
    v_yesterday_revenue      NUMERIC := 0;
    v_yesterday_expense      NUMERIC := 0;
    v_yesterday_product_cost NUMERIC := 0;

    v_weekly_sales       JSONB;
    v_expense_categories JSONB;
    v_top_products       JSONB;
    v_tasks_today_count  INT := 0;
    v_all_tasks          JSONB;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_start IS NULL OR p_end IS NULL THEN
        RAISE EXCEPTION 'p_start ve p_end zorunlu';
    END IF;

    IF p_start > p_end THEN
        RAISE EXCEPTION 'p_start, p_end den buyuk olamaz';
    END IF;

    v_today      := (timezone('Europe/Istanbul', now()))::date;
    v_yesterday  := v_today - 1;
    v_week_start := v_today - 6;
    v_prev_end   := p_start - 1;
    v_prev_start := v_prev_end - (p_end - p_start);

    SELECT
        COALESCE(SUM(total) FILTER (WHERE date >= p_start AND date <= p_end), 0),
        COALESCE(SUM(total) FILTER (WHERE date >= v_prev_start AND date <= v_prev_end), 0),
        COALESCE(SUM(total) FILTER (WHERE date = v_today), 0),
        COALESCE(SUM(total) FILTER (WHERE date = v_yesterday), 0)
    INTO v_monthly_revenue, v_prev_revenue, v_today_revenue, v_yesterday_revenue
    FROM sales
    WHERE tenant_id = v_tenant_id
      AND is_deleted = false
      AND date >= LEAST(v_prev_start, v_yesterday)
      AND date <= GREATEST(p_end, v_today);

    SELECT
        COALESCE(SUM(amount) FILTER (WHERE date >= p_start AND date <= p_end), 0),
        COALESCE(SUM(amount) FILTER (WHERE date >= v_prev_start AND date <= v_prev_end), 0),
        COALESCE(SUM(amount) FILTER (WHERE date = v_today), 0),
        COALESCE(SUM(amount) FILTER (WHERE date = v_yesterday), 0)
    INTO v_monthly_expense, v_prev_expense, v_today_expense, v_yesterday_expense
    FROM expenses
    WHERE tenant_id = v_tenant_id
      AND date >= LEAST(v_prev_start, v_yesterday)
      AND date <= GREATEST(p_end, v_today);

    SELECT
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date >= p_start AND s.date <= p_end), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date >= v_prev_start AND s.date <= v_prev_end), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date = v_today), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date = v_yesterday), 0)
    INTO v_monthly_product_cost, v_prev_product_cost, v_today_product_cost, v_yesterday_product_cost
    FROM product_sales ps
    INNER JOIN sales s ON s.id = ps.sale_id
    WHERE ps.tenant_id = v_tenant_id
      AND s.is_deleted = false
      AND s.date >= LEAST(v_prev_start, v_yesterday)
      AND s.date <= GREATEST(p_end, v_today);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'date', t.date::TEXT,
        'amount', t.amount
    )), '[]'::jsonb)
    INTO v_weekly_sales
    FROM (
        SELECT date, SUM(total) AS amount
        FROM sales
        WHERE tenant_id = v_tenant_id
          AND is_deleted = false
          AND date >= v_week_start
          AND date <= v_today
        GROUP BY date
        ORDER BY date
    ) t;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', t.name,
        'color', t.color,
        'amount', t.amount
    )), '[]'::jsonb)
    INTO v_expense_categories
    FROM (
        SELECT
            COALESCE(c.name, 'Diger')   AS name,
            COALESCE(c.color, '#9CA3AF') AS color,
            SUM(e.amount)                AS amount
        FROM expenses e
        LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.tenant_id = v_tenant_id
          AND e.date >= p_start
          AND e.date <= p_end
        GROUP BY c.name, c.color
        ORDER BY SUM(e.amount) DESC
    ) t;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'product_id', t.product_id,
        'name', t.name,
        'quantity', t.quantity,
        'revenue', t.revenue,
        'estimated_profit', t.estimated_profit
    )), '[]'::jsonb)
    INTO v_top_products
    FROM (
        SELECT
            ps.product_id,
            COALESCE(p.name, 'Silinmis Urun')             AS name,
            SUM(ps.quantity)                              AS quantity,
            SUM(ps.total)                                 AS revenue,
            SUM(ps.total) - SUM(ps.cost * ps.quantity)    AS estimated_profit
        FROM product_sales ps
        INNER JOIN sales s ON s.id = ps.sale_id
        LEFT JOIN products p ON p.id = ps.product_id
        WHERE ps.tenant_id = v_tenant_id
          AND s.is_deleted = false
          AND s.date >= p_start
          AND s.date <= p_end
        GROUP BY ps.product_id, p.name
        ORDER BY SUM(ps.quantity) DESC, SUM(ps.total) DESC
        LIMIT 5
    ) t;

    SELECT COUNT(*) INTO v_tasks_today_count
    FROM tasks
    WHERE tenant_id = v_tenant_id AND due_date = v_today;

    SELECT COALESCE(jsonb_agg(row_data ORDER BY (row_data->>'due_date') DESC NULLS LAST), '[]'::jsonb)
    INTO v_all_tasks
    FROM (
        SELECT jsonb_build_object(
            'id', id,
            'due_date', due_date::TEXT,
            'status', status,
            'priority', priority,
            'title', title
        ) AS row_data
        FROM tasks
        WHERE tenant_id = v_tenant_id
        ORDER BY due_date DESC NULLS LAST
        LIMIT 100
    ) t;

    RETURN jsonb_build_object(
        'monthly_revenue',        v_monthly_revenue,
        'monthly_expense',        v_monthly_expense,
        'monthly_product_cost',   v_monthly_product_cost,
        'prev_revenue',           v_prev_revenue,
        'prev_expense',           v_prev_expense,
        'prev_product_cost',      v_prev_product_cost,
        'today_revenue',          v_today_revenue,
        'today_expense',          v_today_expense,
        'today_product_cost',     v_today_product_cost,
        'yesterday_revenue',      v_yesterday_revenue,
        'yesterday_expense',      v_yesterday_expense,
        'yesterday_product_cost', v_yesterday_product_cost,
        'weekly_sales',           v_weekly_sales,
        'expense_categories',     v_expense_categories,
        'top_products',           v_top_products,
        'tasks_today_count',      v_tasks_today_count,
        'all_tasks',              v_all_tasks,
        'today',                  v_today::TEXT,
        'yesterday',              v_yesterday::TEXT,
        'week_start',             v_week_start::TEXT
    );
END;
$$;


-- H.2 — get_monthly_expense_summary (updated_expense_summary)
CREATE OR REPLACE FUNCTION get_monthly_expense_summary(
    p_page      INT DEFAULT 1,
    p_page_size INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid     UUID;
    v_tenant_id    UUID;
    v_total_months INT;
    v_rows         JSONB;
    v_offset       INT;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    SELECT COUNT(*) INTO v_total_months
    FROM (
        SELECT DISTINCT TO_CHAR(date, 'YYYY-MM')
        FROM expenses WHERE tenant_id = v_tenant_id
    ) t;

    v_offset := (p_page - 1) * p_page_size;

    WITH months AS (
        SELECT
            TO_CHAR(date, 'YYYY-MM') AS month_key,
            SUM(amount) AS total_amount,
            COUNT(*)    AS record_count
        FROM expenses
        WHERE tenant_id = v_tenant_id
        GROUP BY TO_CHAR(date, 'YYYY-MM')
        ORDER BY month_key DESC
        LIMIT p_page_size OFFSET v_offset
    ),
    daily AS (
        SELECT
            TO_CHAR(e.date, 'YYYY-MM') AS month_key,
            e.date,
            SUM(e.amount) AS day_total,
            COUNT(*)      AS day_count
        FROM expenses e
        INNER JOIN months m ON TO_CHAR(e.date, 'YYYY-MM') = m.month_key
        WHERE e.tenant_id = v_tenant_id
        GROUP BY TO_CHAR(e.date, 'YYYY-MM'), e.date
    )
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'monthKey',    m.month_key,
            'totalAmount', m.total_amount,
            'recordCount', m.record_count,
            'dailyTotals', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'date',        d.date::text,
                        'totalAmount', d.day_total,
                        'recordCount', d.day_count
                    ) ORDER BY d.date
                )
                FROM daily d WHERE d.month_key = m.month_key
            ), '[]'::jsonb)
        ) ORDER BY m.month_key DESC
    ), '[]'::jsonb)
    INTO v_rows
    FROM months m;

    RETURN jsonb_build_object(
        'rows',        v_rows,
        'totalMonths', v_total_months,
        'page',        p_page,
        'pageSize',    p_page_size,
        'totalPages',  GREATEST(1, CEIL(v_total_months::numeric / p_page_size))
    );
END;
$$;


-- H.3 — get_product_performance_summary (updated_product_performance)
CREATE OR REPLACE FUNCTION get_product_performance_summary(
    p_start DATE DEFAULT NULL,
    p_end   DATE DEFAULT NULL
)
RETURNS TABLE (
    product_id        UUID,
    name              TEXT,
    price             NUMERIC,
    cost              NUMERIC,
    category_id       UUID,
    is_active         BOOLEAN,
    quantity          NUMERIC,
    revenue           NUMERIC,
    estimated_profit  NUMERIC,
    row_count         BIGINT,
    last_sale_date    TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        ps.product_id,
        COALESCE(p.name, 'Silinmis Urun')::TEXT                       AS name,
        COALESCE(p.price, 0)::NUMERIC                                 AS price,
        COALESCE(p.cost, 0)::NUMERIC                                  AS cost,
        p.category_id,
        COALESCE(p.is_active, TRUE)                                   AS is_active,
        SUM(ps.quantity)::NUMERIC                                     AS quantity,
        SUM(ps.total)::NUMERIC                                        AS revenue,
        (SUM(ps.total) - SUM(ps.cost * ps.quantity))::NUMERIC         AS estimated_profit,
        COUNT(*)::BIGINT                                              AS row_count,
        MAX(ps.date)::TEXT                                            AS last_sale_date
    FROM product_sales ps
    INNER JOIN sales s ON s.id = ps.sale_id
    LEFT JOIN products p ON p.id = ps.product_id
    WHERE ps.tenant_id = v_tenant_id
      AND s.is_deleted = FALSE
      AND (p_start IS NULL OR ps.date >= p_start)
      AND (p_end   IS NULL OR ps.date <= p_end)
    GROUP BY ps.product_id, p.name, p.price, p.cost, p.category_id, p.is_active
    ORDER BY SUM(ps.quantity) DESC, SUM(ps.total) DESC;
END;
$$;


-- H.4 — set_alert_state (038)
CREATE OR REPLACE FUNCTION set_alert_state(
    p_alert_key TEXT,
    p_state     TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant UUID;
BEGIN
    v_tenant := get_my_tenant_id();
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    IF p_alert_key IS NULL OR length(p_alert_key) = 0 THEN
        RAISE EXCEPTION 'alert_key zorunlu';
    END IF;

    IF p_state NOT IN ('open','dismissed','resolved') THEN
        RAISE EXCEPTION 'state gecersiz: %', p_state;
    END IF;

    INSERT INTO alert_states (tenant_id, alert_key, state, updated_at)
    VALUES (v_tenant, p_alert_key, p_state, now())
    ON CONFLICT (tenant_id, alert_key)
    DO UPDATE SET state = EXCLUDED.state, updated_at = now();
END;
$$;


-- H.5 — alerts_master VIEW
--   3 kaynaktan UNION: product_priority + EXPENSE_SPIKE + LOSS
--   alert_states ile JOIN -> dismissed/resolved haric.
CREATE OR REPLACE VIEW alerts_master AS
SELECT
    base.tenant_id,
    base.name,
    base.status,
    base.action,
    base.priority,
    base.alert_key,
    COALESCE(s.state, 'open'::text) AS state
FROM (
    -- 1) Product priority alerts
    SELECT
        p.tenant_id,
        p.name,
        p.status,
        p.action,
        p.priority,
        md5((p.tenant_id::text || COALESCE(p.id::text, p.name)) || p.status) AS alert_key
    FROM product_priority p
    WHERE p.status IS NOT NULL

    UNION ALL

    -- 2) Expense spike (today > 1.3x 7-day avg)
    SELECT
        t.tenant_id,
        'Gider artisi var'::text,
        'EXPENSE_SPIKE'::text,
        'review_expenses'::text,
        80,
        md5(t.tenant_id::text || 'expense_spike'::text) AS alert_key
    FROM (
        SELECT
            expenses.tenant_id,
            SUM(CASE WHEN expenses.date = CURRENT_DATE THEN expenses.amount ELSE 0::numeric END) AS today,
            AVG(expenses.amount) AS avg7
        FROM expenses
        WHERE expenses.date >= (CURRENT_DATE - 7)
        GROUP BY expenses.tenant_id
    ) t
    WHERE t.today > (t.avg7 * 1.3)

    UNION ALL

    -- 3) Loss (sales - expenses < 0)
    SELECT
        s_1.tenant_id,
        'Isletme zarar ediyor'::text,
        'LOSS'::text,
        'review_finance'::text,
        100,
        md5(s_1.tenant_id::text || 'loss'::text) AS alert_key
    FROM (
        SELECT sales.tenant_id, SUM(sales.total) AS sales_total
        FROM sales GROUP BY sales.tenant_id
    ) s_1
    JOIN (
        SELECT expenses.tenant_id, SUM(expenses.amount) AS expense_total
        FROM expenses GROUP BY expenses.tenant_id
    ) e ON s_1.tenant_id = e.tenant_id
    WHERE (s_1.sales_total - e.expense_total) < 0::numeric
) base
LEFT JOIN alert_states s
    ON s.alert_key = base.alert_key
   AND s.tenant_id = base.tenant_id
WHERE COALESCE(s.state, 'open'::text) <> ALL (ARRAY['dismissed'::text, 'resolved'::text]);


-- H.6 — get_dashboard_with_alerts (041)
CREATE OR REPLACE FUNCTION public.get_dashboard_with_alerts(
    p_start DATE,
    p_end   DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_analytics JSONB;
    v_alerts    JSONB;
    v_user_id   UUID;
    v_tenant_id UUID;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'AUTH USER NULL';
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM public.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'TENANT NOT FOUND';
    END IF;

    v_analytics := public.get_dashboard_analytics(p_start, p_end);

    SELECT COALESCE(jsonb_agg(row_to_json(am)), '[]'::jsonb)
    INTO v_alerts
    FROM public.alerts_master am;

    RETURN COALESCE(v_analytics, '{}'::jsonb)
        || jsonb_build_object('alerts_master', v_alerts);
END;
$$;


-- H.7 — export_all_data (042)
CREATE OR REPLACE FUNCTION public.export_all_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_tenant  UUID;
    v_payload JSONB;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant FROM public.users WHERE id = v_uid;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    SELECT jsonb_build_object(
        'export_version', '1.0',
        'export_date',    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'tenant_id',      v_tenant,
        'data', jsonb_build_object(
            'categories',     COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at)
                                         FROM public.categories c     WHERE c.tenant_id = v_tenant), '[]'::jsonb),
            'raw_materials',  COALESCE((SELECT jsonb_agg(to_jsonb(rm) ORDER BY rm.created_at)
                                         FROM public.raw_materials rm WHERE rm.tenant_id = v_tenant), '[]'::jsonb),
            'products',       COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at)
                                         FROM public.products p       WHERE p.tenant_id = v_tenant), '[]'::jsonb),
            'sales',          COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at)
                                         FROM public.sales s          WHERE s.tenant_id = v_tenant), '[]'::jsonb),
            'product_sales',  COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.created_at)
                                         FROM public.product_sales ps WHERE ps.tenant_id = v_tenant), '[]'::jsonb),
            'purchase_items', COALESCE((SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.created_at)
                                         FROM public.purchase_items pi WHERE pi.tenant_id = v_tenant), '[]'::jsonb),
            'expenses',       COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                                         FROM public.expenses e       WHERE e.tenant_id = v_tenant), '[]'::jsonb),
            'events',         COALESCE((SELECT jsonb_agg(to_jsonb(ev) ORDER BY ev.created_at)
                                         FROM public.events ev        WHERE ev.tenant_id = v_tenant), '[]'::jsonb),
            'tasks',          COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
                                         FROM public.tasks t          WHERE t.tenant_id = v_tenant), '[]'::jsonb),
            'settings',       COALESCE((SELECT jsonb_agg(to_jsonb(st))
                                         FROM public.settings st      WHERE st.tenant_id = v_tenant), '[]'::jsonb)
        )
    ) INTO v_payload;

    RETURN v_payload;
END;
$$;


-- H.8 — restore_full_backup (043 — data wrapper path)
--   v_data := COALESCE(backup->'data', backup)  ← KRITIK
CREATE OR REPLACE FUNCTION restore_full_backup(backup JSONB, tenant UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_auth_uid  UUID;
    v_data      JSONB;

    v_rm        JSONB;
    v_product   JSONB;
    v_sale      JSONB;
    v_ps        JSONB;
    v_pi        JSONB;
    v_expense   JSONB;

    v_old_rm_id      UUID;
    v_new_rm_id      UUID;
    v_old_product_id UUID;
    v_new_product_id UUID;
    v_old_sale_id    UUID;
    v_new_sale_id    UUID;

    v_sale_date    DATE;
    v_backup_notes TEXT;
    v_idem_key     TEXT;

    v_inserted_raw_materials  INT := 0;
    v_inserted_products       INT := 0;
    v_inserted_sales          INT := 0;
    v_inserted_product_sales  INT := 0;
    v_inserted_purchase_items INT := 0;
    v_inserted_expenses       INT := 0;

    v_skipped_raw_materials   INT := 0;
    v_skipped_products        INT := 0;
    v_skipped_sales           INT := 0;
    v_skipped_product_sales   INT := 0;
    v_skipped_purchase_items  INT := 0;
    v_skipped_expenses        INT := 0;

    v_rm_map      JSONB := '{}'::jsonb;
    v_product_map JSONB := '{}'::jsonb;
    v_sale_map    JSONB := '{}'::jsonb;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id FROM users u WHERE u.id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found for user';
    END IF;

    IF tenant IS NOT NULL AND tenant <> v_tenant_id THEN
        RAISE EXCEPTION 'Unauthorized: tenant mismatch';
    END IF;

    IF backup IS NULL OR jsonb_typeof(backup) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_BACKUP';
    END IF;

    -- KRITIK
    v_data := COALESCE(backup->'data', backup);

    -- 1) RAW_MATERIALS
    IF jsonb_typeof(v_data->'raw_materials') = 'array' THEN
        FOR v_rm IN SELECT * FROM jsonb_array_elements(v_data->'raw_materials')
        LOOP
            IF v_rm->>'name' IS NULL OR TRIM(v_rm->>'name') = '' THEN
                v_skipped_raw_materials := v_skipped_raw_materials + 1;
                CONTINUE;
            END IF;

            v_old_rm_id := NULLIF(v_rm->>'id','')::uuid;
            v_new_rm_id := NULL;

            SELECT id INTO v_new_rm_id
            FROM raw_materials
            WHERE tenant_id = v_tenant_id AND name = v_rm->>'name'
            LIMIT 1;

            IF v_new_rm_id IS NOT NULL THEN
                v_skipped_raw_materials := v_skipped_raw_materials + 1;
            ELSE
                BEGIN
                    INSERT INTO raw_materials (
                        tenant_id, name, unit, cost, vat_rate,
                        is_active, is_deleted, base_unit
                    ) VALUES (
                        v_tenant_id,
                        v_rm->>'name',
                        COALESCE(v_rm->>'unit', 'gr'),
                        COALESCE((v_rm->>'cost')::numeric, 0),
                        COALESCE((v_rm->>'vat_rate')::numeric, 20),
                        COALESCE((v_rm->>'is_active')::boolean, true),
                        COALESCE((v_rm->>'is_deleted')::boolean, false),
                        v_rm->>'base_unit'
                    )
                    RETURNING id INTO v_new_rm_id;
                    v_inserted_raw_materials := v_inserted_raw_materials + 1;
                EXCEPTION WHEN unique_violation THEN
                    v_skipped_raw_materials := v_skipped_raw_materials + 1;
                    SELECT id INTO v_new_rm_id
                    FROM raw_materials
                    WHERE tenant_id = v_tenant_id AND name = v_rm->>'name'
                    LIMIT 1;
                END;
            END IF;

            IF v_old_rm_id IS NOT NULL AND v_new_rm_id IS NOT NULL THEN
                v_rm_map := v_rm_map || jsonb_build_object(v_old_rm_id::text, v_new_rm_id::text);
            END IF;
        END LOOP;
    END IF;

    -- 2) PRODUCTS
    IF jsonb_typeof(v_data->'products') = 'array' THEN
        FOR v_product IN SELECT * FROM jsonb_array_elements(v_data->'products')
        LOOP
            IF v_product->>'name' IS NULL OR TRIM(v_product->>'name') = '' THEN
                v_skipped_products := v_skipped_products + 1;
                CONTINUE;
            END IF;

            v_old_product_id := NULLIF(v_product->>'id','')::uuid;
            v_new_product_id := NULL;

            SELECT id INTO v_new_product_id
            FROM products
            WHERE tenant_id = v_tenant_id AND name = v_product->>'name'
            LIMIT 1;

            IF v_new_product_id IS NOT NULL THEN
                v_skipped_products := v_skipped_products + 1;
            ELSE
                BEGIN
                    INSERT INTO products (
                        tenant_id, name, price, cost, is_active, is_deleted,
                        category_id, category_name
                    ) VALUES (
                        v_tenant_id,
                        v_product->>'name',
                        COALESCE((v_product->>'price')::numeric, 0),
                        COALESCE((v_product->>'cost')::numeric, 0),
                        COALESCE((v_product->>'is_active')::boolean, true),
                        COALESCE((v_product->>'is_deleted')::boolean, false),
                        NULLIF(v_product->>'category_id','')::uuid,
                        COALESCE(
                            v_product->>'category_name',
                            (SELECT name FROM categories
                             WHERE id = NULLIF(v_product->>'category_id','')::uuid LIMIT 1)
                        )
                    )
                    RETURNING id INTO v_new_product_id;
                    v_inserted_products := v_inserted_products + 1;
                EXCEPTION WHEN unique_violation THEN
                    v_skipped_products := v_skipped_products + 1;
                    SELECT id INTO v_new_product_id
                    FROM products
                    WHERE tenant_id = v_tenant_id AND name = v_product->>'name' LIMIT 1;
                END;
            END IF;

            IF v_old_product_id IS NOT NULL AND v_new_product_id IS NOT NULL THEN
                v_product_map := v_product_map || jsonb_build_object(v_old_product_id::text, v_new_product_id::text);
            END IF;
        END LOOP;
    END IF;

    -- 3) SALES
    IF jsonb_typeof(v_data->'sales') = 'array' THEN
        FOR v_sale IN SELECT * FROM jsonb_array_elements(v_data->'sales')
        LOOP
            IF v_sale->>'date' IS NULL OR v_sale->>'total' IS NULL THEN
                v_skipped_sales := v_skipped_sales + 1;
                CONTINUE;
            END IF;

            v_old_sale_id  := NULLIF(v_sale->>'id','')::uuid;
            v_new_sale_id  := NULL;
            v_sale_date    := (v_sale->>'date')::date;
            v_backup_notes := v_sale->>'notes';

            v_idem_key := md5(
                v_tenant_id::text || '|' ||
                v_sale_date::text  || '|' ||
                COALESCE((v_sale->>'total')::numeric, 0)::text || '|' ||
                COALESCE((v_sale->>'cash')::numeric, 0)::text  || '|' ||
                COALESCE((v_sale->>'card')::numeric, 0)::text  || '|' ||
                COALESCE(v_backup_notes, '')
            );

            INSERT INTO sales (
                tenant_id, date, total, cash, card, notes, is_deleted, idempotency_key
            ) VALUES (
                v_tenant_id, v_sale_date,
                COALESCE((v_sale->>'total')::numeric, 0),
                COALESCE((v_sale->>'cash')::numeric, 0),
                COALESCE((v_sale->>'card')::numeric, 0),
                v_backup_notes, false, v_idem_key
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id INTO v_new_sale_id;

            IF v_new_sale_id IS NULL THEN
                v_skipped_sales := v_skipped_sales + 1;
                SELECT id INTO v_new_sale_id
                FROM sales WHERE tenant_id = v_tenant_id AND idempotency_key = v_idem_key LIMIT 1;
            ELSE
                v_inserted_sales := v_inserted_sales + 1;
            END IF;

            IF v_old_sale_id IS NOT NULL AND v_new_sale_id IS NOT NULL THEN
                v_sale_map := v_sale_map || jsonb_build_object(v_old_sale_id::text, v_new_sale_id::text);
            END IF;
        END LOOP;
    END IF;

    -- 4) PRODUCT_SALES
    IF jsonb_typeof(v_data->'product_sales') = 'array' THEN
        FOR v_ps IN SELECT * FROM jsonb_array_elements(v_data->'product_sales')
        LOOP
            IF v_ps->>'sale_id' IS NULL OR v_ps->>'product_id' IS NULL THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            v_new_sale_id := NULLIF(v_sale_map->>(v_ps->>'sale_id'),'')::uuid;
            IF v_new_sale_id IS NULL THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            v_new_product_id := NULLIF(v_product_map->>(v_ps->>'product_id'),'')::uuid;
            IF v_new_product_id IS NULL THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            IF EXISTS (
                SELECT 1 FROM product_sales
                WHERE sale_id = v_new_sale_id AND product_id = v_new_product_id
            ) THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            SELECT date INTO v_sale_date FROM sales WHERE id = v_new_sale_id;

            BEGIN
                INSERT INTO product_sales (
                    tenant_id, sale_id, product_id, date,
                    quantity, unit_price, total, cost
                ) VALUES (
                    v_tenant_id, v_new_sale_id, v_new_product_id, v_sale_date,
                    COALESCE((v_ps->>'quantity')::int, 0),
                    COALESCE((v_ps->>'unit_price')::numeric, 0),
                    COALESCE((v_ps->>'total')::numeric, 0),
                    COALESCE(
                        (v_ps->>'cost')::numeric,
                        (SELECT cost FROM products WHERE id = v_new_product_id),
                        0
                    )
                );
                v_inserted_product_sales := v_inserted_product_sales + 1;
            EXCEPTION WHEN unique_violation THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
            END;
        END LOOP;
    END IF;

    -- 5) PURCHASE_ITEMS
    IF jsonb_typeof(v_data->'purchase_items') = 'array' THEN
        FOR v_pi IN SELECT * FROM jsonb_array_elements(v_data->'purchase_items')
        LOOP
            IF v_pi->>'raw_material_id' IS NULL THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
                CONTINUE;
            END IF;

            v_new_rm_id := NULLIF(v_rm_map->>(v_pi->>'raw_material_id'),'')::uuid;
            IF v_new_rm_id IS NULL THEN
                SELECT id INTO v_new_rm_id
                FROM raw_materials
                WHERE id = NULLIF(v_pi->>'raw_material_id','')::uuid
                  AND tenant_id = v_tenant_id LIMIT 1;
            END IF;
            IF v_new_rm_id IS NULL THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
                CONTINUE;
            END IF;

            BEGIN
                INSERT INTO purchase_items (
                    tenant_id, raw_material_id,
                    quantity, unit, unit_cost, line_total,
                    vat_rate, discount_rate,
                    base_quantity, base_unit_cost,
                    general_discount_amount, general_discount_type,
                    note, invoice_date, invoice_no,
                    is_deleted, created_at
                ) VALUES (
                    v_tenant_id, v_new_rm_id,
                    COALESCE((v_pi->>'quantity')::numeric, 0),
                    v_pi->>'unit',
                    COALESCE((v_pi->>'unit_cost')::numeric, 0),
                    COALESCE((v_pi->>'line_total')::numeric, 0),
                    COALESCE((v_pi->>'vat_rate')::numeric, 0),
                    COALESCE((v_pi->>'discount_rate')::numeric, 0),
                    NULLIF(v_pi->>'base_quantity','')::numeric,
                    NULLIF(v_pi->>'base_unit_cost','')::numeric,
                    COALESCE((v_pi->>'general_discount_amount')::numeric, 0),
                    COALESCE(v_pi->>'general_discount_type', 'amount'),
                    v_pi->>'note',
                    NULLIF(v_pi->>'invoice_date','')::date,
                    NULLIF(v_pi->>'invoice_no','')::bigint,
                    COALESCE((v_pi->>'is_deleted')::boolean, false),
                    COALESCE((v_pi->>'created_at')::timestamptz, now())
                );
                v_inserted_purchase_items := v_inserted_purchase_items + 1;
            EXCEPTION WHEN unique_violation THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
            END;
        END LOOP;
    END IF;

    -- 6) EXPENSES
    IF jsonb_typeof(v_data->'expenses') = 'array' THEN
        FOR v_expense IN SELECT * FROM jsonb_array_elements(v_data->'expenses')
        LOOP
            IF v_expense->>'date' IS NULL OR v_expense->>'amount' IS NULL THEN
                v_skipped_expenses := v_skipped_expenses + 1;
                CONTINUE;
            END IF;

            IF EXISTS (
                SELECT 1 FROM expenses
                WHERE tenant_id = v_tenant_id
                  AND date = (v_expense->>'date')::date
                  AND amount = COALESCE((v_expense->>'amount')::numeric, 0)
                  AND COALESCE(description, '') = COALESCE(v_expense->>'description', '')
            ) THEN
                v_skipped_expenses := v_skipped_expenses + 1;
                CONTINUE;
            END IF;

            BEGIN
                INSERT INTO expenses (
                    tenant_id, date, amount, description, category_id, category_name
                ) VALUES (
                    v_tenant_id,
                    (v_expense->>'date')::date,
                    COALESCE((v_expense->>'amount')::numeric, 0),
                    v_expense->>'description',
                    NULLIF(v_expense->>'category_id','')::uuid,
                    COALESCE(
                        v_expense->>'category_name',
                        (SELECT name FROM categories
                         WHERE id = NULLIF(v_expense->>'category_id','')::uuid LIMIT 1)
                    )
                );
                v_inserted_expenses := v_inserted_expenses + 1;
            EXCEPTION WHEN unique_violation THEN
                v_skipped_expenses := v_skipped_expenses + 1;
            END;
        END LOOP;
    END IF;

    BEGIN
        PERFORM write_system_log(
            v_tenant_id, v_auth_uid, 'restore', 'success',
            'Restore tamamlandi (full backup, data path)',
            jsonb_build_object(
                'inserted_raw_materials',  v_inserted_raw_materials,
                'inserted_products',       v_inserted_products,
                'inserted_sales',          v_inserted_sales,
                'inserted_product_sales',  v_inserted_product_sales,
                'inserted_purchase_items', v_inserted_purchase_items,
                'inserted_expenses',       v_inserted_expenses,
                'skipped_raw_materials',   v_skipped_raw_materials,
                'skipped_products',        v_skipped_products,
                'skipped_sales',           v_skipped_sales,
                'skipped_product_sales',   v_skipped_product_sales,
                'skipped_purchase_items',  v_skipped_purchase_items,
                'skipped_expenses',        v_skipped_expenses
            )
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'inserted', jsonb_build_object(
            'raw_materials',  v_inserted_raw_materials,
            'products',       v_inserted_products,
            'sales',          v_inserted_sales,
            'product_sales',  v_inserted_product_sales,
            'purchase_items', v_inserted_purchase_items,
            'expenses',       v_inserted_expenses
        ),
        'skipped', jsonb_build_object(
            'raw_materials',  v_skipped_raw_materials,
            'products',       v_skipped_products,
            'sales',          v_skipped_sales,
            'product_sales',  v_skipped_product_sales,
            'purchase_items', v_skipped_purchase_items,
            'expenses',       v_skipped_expenses
        )
    );

EXCEPTION WHEN OTHERS THEN
    BEGIN
        PERFORM write_system_log(
            COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
            v_auth_uid, 'restore', 'fail', SQLERRM, '{}'::jsonb
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE EXCEPTION 'RESTORE_FAILED: %', SQLERRM;
END;
$$;


-- ============================================================
-- H.9 — MAINTENANCE FUNCTIONS (052)
--   ADMIN MAINTENANCE — NOT FOR CLIENT-FACING RPC USAGE.
--   PRE-052 base_unit_cost satirlarini canonical FAZ 1.4 formul ile
--   yeniden hesaplar. Dogal cascade trigger zinciri otomatik calisir.
--   product_sales.cost IMMUTABLE — 3 katman dogrulama (count + sum + MD5).
--   p_dry_run TRUE -> analiz; FALSE -> UPDATE + cascade.
--   p_tenant_id NULL -> tum tenantlar; dolu -> tek tenant.
--   Safety threshold: would_change > 50000 -> RAISE.
--   Idempotent: WHERE old IS DISTINCT FROM new.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rebackfill_purchase_items_base_cost(
    p_tenant_id UUID    DEFAULT NULL,
    p_dry_run   BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_scope       BIGINT;
    v_would_change      BIGINT;
    v_unchanged         BIGINT;
    v_null_result       BIGINT;
    v_bad_base_qty      BIGINT;
    v_sample            JSONB;

    v_updated_pi        BIGINT;

    v_ps_count_before   BIGINT;
    v_ps_count_after    BIGINT;
    v_ps_sum_before     NUMERIC;
    v_ps_sum_after      NUMERIC;
    v_ps_cs_before      TEXT;
    v_ps_cs_after       TEXT;

    v_rm_cs_before      TEXT;
    v_rm_cs_after       TEXT;
    v_prod_cs_before    TEXT;
    v_prod_cs_after     TEXT;
    v_rm_changed        INT;
    v_prod_changed      INT;

    v_safety_max        BIGINT := 50000;

    v_started_at        TIMESTAMPTZ := clock_timestamp();
    v_elapsed_ms        INT;
BEGIN
    RAISE NOTICE '[052] mode=% tenant=% (NULL = global)',
        CASE WHEN p_dry_run THEN 'DRY-RUN' ELSE 'LIVE' END,
        COALESCE(p_tenant_id::text, '<all>');

    WITH calc AS (
        SELECT
            pi.id,
            pi.tenant_id,
            pi.raw_material_id,
            pi.base_unit_cost AS old_value,
            (
                CASE
                    WHEN pi.line_total IS NOT NULL AND pi.line_total >= 0
                        THEN pi.line_total
                    WHEN pi.unit_cost IS NOT NULL AND pi.unit_cost >= 0
                        THEN pi.quantity * pi.unit_cost
                             * (1 - COALESCE(pi.discount_rate, 0) / 100.0)
                    ELSE NULL
                END
                * (1 + COALESCE(pi.vat_rate, 0) / 100.0)
                / NULLIF(pi.base_quantity, 0)
            ) AS new_value
        FROM public.purchase_items pi
        WHERE pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id)
    )
    SELECT
        count(*),
        count(*) FILTER (
            WHERE old_value IS DISTINCT FROM new_value AND new_value IS NOT NULL
        ),
        count(*) FILTER (
            WHERE old_value IS NOT DISTINCT FROM new_value
        ),
        count(*) FILTER (
            WHERE new_value IS NULL
        )
    INTO v_total_scope, v_would_change, v_unchanged, v_null_result
    FROM calc;

    WITH calc AS (
        SELECT
            pi.id,
            pi.tenant_id,
            pi.raw_material_id,
            pi.quantity, pi.unit_cost, pi.line_total,
            pi.vat_rate, pi.discount_rate, pi.base_quantity,
            pi.base_unit_cost AS old_value,
            (
                CASE
                    WHEN pi.line_total IS NOT NULL AND pi.line_total >= 0
                        THEN pi.line_total
                    WHEN pi.unit_cost IS NOT NULL AND pi.unit_cost >= 0
                        THEN pi.quantity * pi.unit_cost
                             * (1 - COALESCE(pi.discount_rate, 0) / 100.0)
                    ELSE NULL
                END
                * (1 + COALESCE(pi.vat_rate, 0) / 100.0)
                / NULLIF(pi.base_quantity, 0)
            ) AS new_value
        FROM public.purchase_items pi
        WHERE pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id)
    )
    SELECT jsonb_agg(row_to_json(s)) INTO v_sample
      FROM (
          SELECT
              id, tenant_id, raw_material_id,
              quantity, unit_cost, line_total,
              vat_rate, discount_rate, base_quantity,
              ROUND(old_value::numeric, 6) AS old_value,
              ROUND(new_value::numeric, 6) AS new_value,
              CASE WHEN old_value IS NULL OR old_value = 0
                   THEN NULL
                   ELSE ROUND(((new_value - old_value) / old_value * 100)::numeric, 2)
              END AS delta_pct
          FROM calc
          WHERE old_value IS DISTINCT FROM new_value
            AND new_value IS NOT NULL
          ORDER BY raw_material_id
          LIMIT 5
      ) s;

    SELECT count(*) INTO v_bad_base_qty
      FROM public.purchase_items pi
     WHERE pi.is_deleted = false
       AND pi.base_quantity IS NOT NULL
       AND pi.base_quantity <= 0
       AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id);

    RAISE NOTICE '[052] scope=% would_change=% unchanged=% null_result=% bad_base_qty=%',
        v_total_scope, v_would_change, v_unchanged, v_null_result, v_bad_base_qty;

    IF p_dry_run THEN
        v_elapsed_ms := EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at))::int * 1000;
        RETURN jsonb_build_object(
            'mode',              'dry_run',
            'tenant_scope',      COALESCE(p_tenant_id::text, 'all'),
            'started_at',        v_started_at,
            'elapsed_ms',        v_elapsed_ms,
            'total_scope',       v_total_scope,
            'would_change',      v_would_change,
            'unchanged',         v_unchanged,
            'null_result',       v_null_result,
            'bad_base_quantity', v_bad_base_qty,
            'sample',            COALESCE(v_sample, '[]'::jsonb),
            'note',              'Re-run with p_dry_run := FALSE to apply.'
        );
    END IF;

    IF v_would_change > v_safety_max THEN
        RAISE EXCEPTION
            'SAFETY THRESHOLD: would_change=% > max=%. Manuel review gerekli.',
            v_would_change, v_safety_max;
    END IF;

    -- BEFORE snapshot
    SELECT
        count(*),
        COALESCE(sum(cost), 0),
        md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_ps_count_before, v_ps_sum_before, v_ps_cs_before
      FROM public.product_sales
     WHERE (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_rm_cs_before
      FROM public.raw_materials
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_prod_cs_before
      FROM public.products
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    -- UPDATE — dogal cascade
    WITH calc AS (
        SELECT
            pi.id,
            (
                CASE
                    WHEN pi.line_total IS NOT NULL AND pi.line_total >= 0
                        THEN pi.line_total
                    WHEN pi.unit_cost IS NOT NULL AND pi.unit_cost >= 0
                        THEN pi.quantity * pi.unit_cost
                             * (1 - COALESCE(pi.discount_rate, 0) / 100.0)
                    ELSE NULL
                END
                * (1 + COALESCE(pi.vat_rate, 0) / 100.0)
                / NULLIF(pi.base_quantity, 0)
            ) AS new_value
        FROM public.purchase_items pi
        WHERE pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id)
    )
    UPDATE public.purchase_items pi
       SET base_unit_cost = calc.new_value
      FROM calc
     WHERE pi.id = calc.id
       AND calc.new_value IS NOT NULL
       AND pi.base_unit_cost IS DISTINCT FROM calc.new_value;

    GET DIAGNOSTICS v_updated_pi = ROW_COUNT;

    -- AFTER snapshot
    SELECT
        count(*),
        COALESCE(sum(cost), 0),
        md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_ps_count_after, v_ps_sum_after, v_ps_cs_after
      FROM public.product_sales
     WHERE (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_rm_cs_after
      FROM public.raw_materials
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_prod_cs_after
      FROM public.products
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    -- IMMUTABILITY CHECK — uc katman
    IF v_ps_count_after <> v_ps_count_before THEN
        RAISE EXCEPTION
            'KRITIK IMMUTABILITY IHLALI: product_sales count degisti (before=%, after=%)',
            v_ps_count_before, v_ps_count_after;
    END IF;
    IF v_ps_sum_after IS DISTINCT FROM v_ps_sum_before THEN
        RAISE EXCEPTION
            'KRITIK IMMUTABILITY IHLALI: product_sales SUM(cost) degisti (before=%, after=%)',
            v_ps_sum_before, v_ps_sum_after;
    END IF;
    IF v_ps_cs_after <> v_ps_cs_before THEN
        RAISE EXCEPTION
            'KRITIK IMMUTABILITY IHLALI: product_sales ordered MD5 degisti';
    END IF;

    v_rm_changed   := CASE WHEN v_rm_cs_before   <> v_rm_cs_after   THEN 1 ELSE 0 END;
    v_prod_changed := CASE WHEN v_prod_cs_before <> v_prod_cs_after THEN 1 ELSE 0 END;

    v_elapsed_ms := EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at))::int * 1000;

    RETURN jsonb_build_object(
        'mode',                       'live',
        'tenant_scope',               COALESCE(p_tenant_id::text, 'all'),
        'started_at',                 v_started_at,
        'elapsed_ms',                 v_elapsed_ms,
        'total_scope',                v_total_scope,
        'would_change',               v_would_change,
        'bad_base_quantity',          v_bad_base_qty,
        'updated_purchase_items',     v_updated_pi,
        'raw_materials_cs_changed',   v_rm_changed,
        'products_cs_changed',        v_prod_changed,
        'product_sales_immutable',    TRUE,
        'product_sales_count',        v_ps_count_after,
        'product_sales_sum',          v_ps_sum_after,
        'sample',                     COALESCE(v_sample, '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) FROM authenticated;


-- ============================================================
-- ============================================================
-- SECTION X — CANONICAL COMMENTS (050)
--   docs/FINANCE.md v1.0 semantic freeze.
--   19 COMMENT ON COLUMN + 9 COMMENT ON FUNCTION (8 finance + 1 maintenance).
--   Idempotent (PG COMMENT overwrite-safe).
-- ============================================================
-- ============================================================

-- X.1 — COMMENT ON COLUMN (canonical column semantics)
COMMENT ON COLUMN public.sales.total IS
    'KDV DAHIL gross satis tutari (TRY). Invariant: cash+card=total (UI hazirlaninca enforce edilecek).';
COMMENT ON COLUMN public.sales.cash IS
    'KDV DAHIL nakit tahsilat.';
COMMENT ON COLUMN public.sales.card IS
    'KDV DAHIL kart tahsilat.';

COMMENT ON COLUMN public.product_sales.unit_price IS
    'KDV DAHIL satir birim satis fiyati.';
COMMENT ON COLUMN public.product_sales.total IS
    'KDV DAHIL satir toplami (quantity * unit_price).';
COMMENT ON COLUMN public.product_sales.cost IS
    'KDV DAHIL satis ani IMMUTABLE maliyet snapshot (FAZ 1.1). '
    'Bir kez yazildiktan sonra hicbir trigger/RPC/restore update etmez.';

COMMENT ON COLUMN public.expenses.amount IS
    'KDV DAHIL gider tutari (kasadan cikan para). '
    'Vergi disi (kira gibi) giderler de ayni kolonda.';

COMMENT ON COLUMN public.purchases.total_price IS
    'KDV HARIC alis tutari (legacy Akis A; faturada yazan). '
    'Deprecated: yeni faturalar purchase_items uzerinden gelmeli.';
COMMENT ON COLUMN public.purchases.net_total IS
    'KDV DAHIL toplam = total_price * (1 + vat_rate/100).';
COMMENT ON COLUMN public.purchases.unit_cost IS
    'KDV DAHIL birim maliyet = net_total / quantity. products.cost icin source.';
COMMENT ON COLUMN public.purchases.vat_rate IS
    'KDV orani (%). 0-100.';

COMMENT ON COLUMN public.purchase_items.unit_cost IS
    'KDV HARIC alis birim fiyati (faturada yazan).';
COMMENT ON COLUMN public.purchase_items.line_total IS
    'KDV HARIC satir toplami (iskonto sonrasi, vergi oncesi). '
    'Formul: quantity * unit_cost * (1 - discount_rate/100).';
COMMENT ON COLUMN public.purchase_items.vat_rate IS
    'Satir KDV orani (%). Default 20. 0-100.';
COMMENT ON COLUMN public.purchase_items.discount_rate IS
    'Satir iskonto orani (%). line_total ve base_unit_cost hesabina dahil. 0-100.';
COMMENT ON COLUMN public.purchase_items.base_unit_cost IS
    'KDV DAHIL base_unit basina maliyet. '
    'trg_fn_purchase_items_fill_base tarafindan yazilir (FAZ 1.4 / 051 VAT-aware). '
    'Formul: COALESCE(line_total, quantity*unit_cost*(1-discount/100)) '
    '* (1 + vat/100) / base_quantity.';

COMMENT ON COLUMN public.raw_materials.cost IS
    'KDV DAHIL son alis maliyeti (base_unit basina). '
    'Trigger zinciri ile guncellenir (calculate_raw_material_wac).';

COMMENT ON COLUMN public.products.price IS
    'KDV DAHIL menu satis fiyati.';
COMMENT ON COLUMN public.products.cost IS
    'KDV DAHIL urun maliyeti. Recipe motoru (calculate_product_cost) veya '
    'legacy create_purchase_and_update_product_cost RPC yazar. Iki yol da KDV DAHIL.';

-- X.2 — COMMENT ON FUNCTION (compute engine semantics)
COMMENT ON FUNCTION public.calculate_product_cost(UUID) IS
    'Returns KDV DAHIL recipe cost. Formul: SUM(product_recipes.quantity * '
    'raw_materials.cost) WHERE both NOT is_deleted. raw_materials.cost zaten '
    'KDV DAHIL (FAZ 1.4 sonrasi). Canonical finance semantics: docs/FINANCE.md.';

COMMENT ON FUNCTION public.calculate_raw_material_wac(UUID) IS
    'Returns KDV DAHIL last purchase price (base_unit basina). '
    'Despite "wac" name, this is LAST PRICE model (035). Reads from '
    'purchase_items.base_unit_cost ORDER BY created_at DESC. '
    'base_unit_cost trigger tarafindan KDV DAHIL yazilir (FAZ 1.4 sonrasi).';

COMMENT ON FUNCTION public.sync_product_cost(UUID) IS
    'Updates products.cost = calculate_product_cost(product_id) only if '
    'product has at least one active recipe. Recipe yoksa products.cost '
    'manuel kalir (UI ya da legacy purchase RPC tarafindan yazilir). '
    'Canonical: KDV DAHIL.';

COMMENT ON FUNCTION public.create_purchase_and_update_product_cost(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT) IS
    'LEGACY Akis A purchase RPC. p_total KDV HARIC, p_vat oran. '
    'Hesap: net_total = p_total * (1 + p_vat/100), unit_cost = net_total/qty. '
    'Sonuc KDV DAHIL unit_cost products.cost icin direkt yazilir. '
    'DEPRECATED: yeni faturalar purchase_items (Akis B) uzerinden. '
    'FAZ 2 ile kaldirilacak.';

COMMENT ON FUNCTION public.create_sales_atomic(UUID, JSONB) IS
    'Canonical sales write RPC. SECURITY DEFINER. Tenant resolve auth.uid. '
    'product_sales.cost server-side products.cost snapshot (FAZ 1.1 — '
    'immutable). Idempotency: composite UNIQUE (tenant_id, idempotency_key). '
    'Canonical finance: KDV DAHIL.';

COMMENT ON FUNCTION public.insert_expense(DATE, NUMERIC, UUID, TEXT, TEXT, TEXT) IS
    'Canonical expense write RPC. SECURITY DEFINER. Tenant resolve auth.uid. '
    'p_amount KDV DAHIL gross tutar. ON CONFLICT (tenant_id, idempotency_key) '
    'DO NOTHING. Canonical finance: KDV DAHIL.';

COMMENT ON FUNCTION public.get_dashboard_analytics(DATE, DATE) IS
    'Dashboard aggregate RPC. profit = SUM(sales.total) - SUM(product_sales.cost) '
    '- SUM(expenses.amount). Uc bilesen de KDV DAHIL gross. '
    'Returned profit = gross margin (vergi-oncesi muhasebe karina denk DEGIL).';

COMMENT ON FUNCTION public.get_sales_paginated(DATE, DATE, INT, INT) IS
    'Paginated sales read RPC. Returned cost = SUM(product_sales.cost) — '
    'satis ani KDV DAHIL snapshot. profit = s.total - cost (gross margin).';

COMMENT ON FUNCTION public.trg_fn_purchase_items_fill_base() IS
    'BEFORE INSERT/UPDATE on purchase_items. '
    'Yazar: base_quantity (unit conversion) + base_unit_cost (KDV DAHIL, iskonto sonrasi). '
    'Formul: v_net = COALESCE(line_total, quantity*unit_cost*(1-discount/100)); '
    'base_unit_cost = v_net * (1+vat/100) / base_quantity. '
    'Canonical finance: docs/FINANCE.md kural 11+12 (FAZ 1.4 / 051).';

COMMENT ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) IS
    'ADMIN MAINTENANCE one-shot rebackfill of purchase_items.base_unit_cost '
    'using canonical FAZ 1.4 formula (docs/FINANCE.md kural 11+12). '
    'Tenant scope: p_tenant_id NULL = all tenants, dolu = sadece o tenant. '
    'p_dry_run=TRUE (default): analysis only. '
    'p_dry_run=FALSE: UPDATE + natural cascade (raw_materials, products). '
    'LIVE safety: would_change > 50000 -> RAISE. '
    'product_sales.cost IMMUTABLE — count + SUM + ordered MD5 ile dogrulanir. '
    'Idempotent (WHERE old IS DISTINCT FROM new).';


-- ============================================================
-- ============================================================
-- SECTION I — GRANTS (final layer)
-- ============================================================
-- ============================================================


-- I.1 — REVOKE PUBLIC
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;


-- I.2 — SCHEMA USAGE
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;


-- I.3 — TABLE GRANTS (RLS-gated)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_sales    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.events           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deleted_records  TO authenticated;
GRANT SELECT                          ON public.system_logs     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchases        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_items   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.raw_materials    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_recipes  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_states     TO authenticated;

-- VIEWS
GRANT SELECT ON public.product_priority TO authenticated;
GRANT SELECT ON public.alerts_master    TO authenticated;

-- INTERNAL ONLY (no direct grant): public.rate_limits


-- I.4 — SEQUENCE GRANTS
GRANT USAGE, SELECT ON SEQUENCE public.purchase_invoice_seq TO authenticated;


-- I.5 — FUNCTION GRANTS — CORE RPCs
GRANT EXECUTE ON FUNCTION public.write_system_log(UUID, UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_client_event(TEXT, TEXT, TEXT, JSONB)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(UUID, UUID, TEXT, INTERVAL)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_record(TEXT, UUID)                        TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_unit_base_type(TEXT)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_to_base_unit(NUMERIC, TEXT, TEXT)             TO authenticated;

GRANT EXECUTE ON FUNCTION public.calculate_raw_material_wac(UUID)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_product_cost(UUID)                          TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_product_cost(UUID)                               TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_raw_material_cost(UUID)                          TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_purchase_and_update_product_cost(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_sales_atomic(UUID, JSONB)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sale_empty(JSONB)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_sale(UUID, JSONB)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_sale(UUID)                                TO authenticated;

GRANT EXECUTE ON FUNCTION public.insert_expense(DATE, NUMERIC, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_expense(UUID, JSONB)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.soft_delete_expense(UUID)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sales_paginated(DATE, DATE, INT, INT)             TO authenticated;

GRANT EXECUTE ON FUNCTION public.insert_purchase_items_batch(JSONB)                    TO authenticated;


-- I.6 — FUNCTION GRANTS — TENANT / USER HELPERS
GRANT EXECUTE ON FUNCTION public.get_my_tenant_id() TO authenticated;

-- handle_new_user GRANT'ları E.3 bloğunda yapılıyor (self-contained).
-- Burada tekrar tanımlanmıyor.


-- I.7 — FUNCTION GRANTS — ANALYTICS / BACKUP / ALERTS
GRANT EXECUTE ON FUNCTION public.get_dashboard_analytics(DATE, DATE)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_expense_summary(INT, INT)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_performance_summary(DATE, DATE)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_alert_state(TEXT, TEXT)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_with_alerts(DATE, DATE)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.export_all_data()                                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_full_backup(JSONB, UUID)                      TO authenticated;


-- I.8 — DEFAULT PRIVILEGES
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;


-- ============================================================
-- 999_BASELINE.SQL — END
-- ============================================================
