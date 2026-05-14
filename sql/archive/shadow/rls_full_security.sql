-- ============================================================
-- RLS FULL SECURITY — STRICT TENANT ISOLATION
-- Tum tenant-scoped tablolara RLS uygulanir.
-- tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid())
-- users tablosu: sadece self-row erisimi.
-- ============================================================

-- ============================================================
-- 1. ENABLE RLS
-- ============================================================

ALTER TABLE public.categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_sales    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users            ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.categories       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.products         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sales            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_sales    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenses         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.events           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tasks            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.settings         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_records  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purchases        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users            FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 2. DROP EXISTING POLICIES (safe cleanup)
-- ============================================================

DROP POLICY IF EXISTS tenant_isolation ON public.categories;
DROP POLICY IF EXISTS tenant_isolation ON public.products;
DROP POLICY IF EXISTS tenant_isolation ON public.sales;
DROP POLICY IF EXISTS tenant_isolation ON public.product_sales;
DROP POLICY IF EXISTS tenant_isolation ON public.expenses;
DROP POLICY IF EXISTS tenant_isolation ON public.events;
DROP POLICY IF EXISTS tenant_isolation ON public.tasks;
DROP POLICY IF EXISTS tenant_isolation ON public.settings;
DROP POLICY IF EXISTS tenant_isolation ON public.deleted_records;
DROP POLICY IF EXISTS tenant_isolation ON public.system_logs;
DROP POLICY IF EXISTS tenant_isolation ON public.purchases;
DROP POLICY IF EXISTS users_self_only ON public.users;

-- ============================================================
-- 3. TENANT ISOLATION POLICIES
-- ============================================================

CREATE POLICY tenant_isolation ON public.categories
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.products
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.sales
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.product_sales
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.expenses
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.events
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.tasks
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.settings
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.deleted_records
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.system_logs
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

CREATE POLICY tenant_isolation ON public.purchases
    FOR ALL
    USING (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    )
    WITH CHECK (
        tenant_id = (
            SELECT tenant_id
            FROM public.users
            WHERE id = auth.uid()
        )
    );

-- ============================================================
-- 4. USERS TABLE — SELF-ONLY POLICY
-- ============================================================

CREATE POLICY users_self_only ON public.users
    FOR ALL
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());
