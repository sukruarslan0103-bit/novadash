-- ============================================================
-- FIX RLS COMPLETE — STRICT TENANT ISOLATION
-- ============================================================

ALTER TABLE public.products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_sales   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users           ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.products        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sales           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_sales   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenses        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.categories      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.events          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tasks           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.settings        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purchases       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.deleted_records FORCE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users           FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
    r RECORD;
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'products','sales','product_sales','expenses','categories',
        'events','tasks','settings','purchases','deleted_records',
        'system_logs','users'
    ]
    LOOP
        FOR r IN
            SELECT polname
            FROM pg_policy
            WHERE polrelid = ('public.' || t)::regclass
        LOOP
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.polname, t);
        END LOOP;
    END LOOP;
END;
$$;

CREATE POLICY tenant_isolation ON public.products
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.sales
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.product_sales
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.expenses
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.categories
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.events
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.tasks
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.settings
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.purchases
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.deleted_records
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY tenant_isolation ON public.system_logs
FOR ALL
USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));

CREATE POLICY users_self_only ON public.users
FOR ALL
USING (id = auth.uid())
WITH CHECK (id = auth.uid());
