-- ============================================================
-- 024 — RLS CONSOLIDATION
-- Amac:
--   1) Cift RLS politika kaynagini tek kaynaga indir.
--   2) Tum policy'ler get_my_tenant_id() STABLE fonksiyonu
--      kullansin (subquery yerine -> planner cache + tutarlilik).
--   3) get_my_tenant_id()'e SET search_path = public ekle
--      (search_path injection korunmasi).
--   4) system_logs uzerinde DELETE/UPDATE'i blokla
--      (audit trail manipulasyonu engelle).
--
-- NOT: Bu dosya 001_initial_schema.sql ve rls_full_security.sql
--      icindeki tum mevcut "tenant_isolation" policy'lerini
--      DROP edip yeniden CREATE eder. Idempotent, guvenli re-run.
-- ============================================================

-- ============================================================
-- 1) HARDENED HELPER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION get_my_tenant_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT tenant_id FROM public.users WHERE id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION get_my_tenant_id() TO authenticated;

-- ============================================================
-- 2) DROP EXISTING POLICIES (safe cleanup)
-- ============================================================
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'tenants', 'categories', 'products', 'sales',
        'product_sales', 'expenses', 'events', 'tasks',
        'settings', 'deleted_records', 'system_logs',
        'purchases', 'users'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', tbl);
        EXECUTE format('DROP POLICY IF EXISTS users_self_only ON public.%I', tbl);
    END LOOP;
END $$;

-- system_logs icin ek policy adlari da temizlensin
DROP POLICY IF EXISTS system_logs_select_own ON public.system_logs;
DROP POLICY IF EXISTS system_logs_no_modify  ON public.system_logs;

-- ============================================================
-- 3) ENABLE + FORCE RLS (idempotent)
-- ============================================================
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'categories', 'products', 'sales', 'product_sales',
        'expenses', 'events', 'tasks', 'settings',
        'deleted_records', 'system_logs', 'purchases', 'users'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', tbl);
    END LOOP;
END $$;

-- tenants ozel — RLS ama policy id uzerinden
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE  ROW LEVEL SECURITY;

-- ============================================================
-- 4) TENANT ISOLATION POLICIES — get_my_tenant_id() ile
-- ============================================================

-- 4a) tenants: kullanici sadece kendi tenant'ini gorsun
CREATE POLICY tenant_isolation ON public.tenants
    FOR ALL
    USING (id = get_my_tenant_id())
    WITH CHECK (id = get_my_tenant_id());

-- 4b) Generic tenant-scoped tablolar
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'categories', 'products', 'sales', 'product_sales',
        'expenses', 'events', 'tasks', 'settings',
        'deleted_records', 'purchases'
    ] LOOP
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON public.%I
            FOR ALL
            USING (tenant_id = get_my_tenant_id())
            WITH CHECK (tenant_id = get_my_tenant_id())
        $f$, tbl);
    END LOOP;
END $$;

-- ============================================================
-- 5) USERS — SELF-ONLY (UPDATE'te tenant_id/role lock 023'te)
-- ============================================================
CREATE POLICY users_self_only ON public.users
    FOR ALL
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- ============================================================
-- 6) SYSTEM_LOGS — SADECE OKUMA, DEGISTIRILEMEZ
-- INSERT: yalnizca SECURITY DEFINER RPC'ler (write_system_log)
--         uzerinden yapilir; client direct INSERT yapamasin.
-- SELECT: kullanici kendi tenant log'larini okuyabilir.
-- UPDATE/DELETE: hicbir kullanici (service_role haric) yapamaz.
-- ============================================================
CREATE POLICY system_logs_select_own ON public.system_logs
    FOR SELECT
    USING (tenant_id = get_my_tenant_id());

-- INSERT/UPDATE/DELETE icin policy YOK -> RLS reddeder.
-- write_system_log() SECURITY DEFINER oldugu icin yine yazabilir.

-- ============================================================
-- TEST
-- ============================================================
-- a) Iki ayri tenant kullanicisi ile login ol; karsi tenant'in
--    products satirini SELECT et -> 0 row donmeli.
-- b) Kullanici manuel: DELETE FROM system_logs WHERE id = '...'
--    -> ERROR (no policy permits).
-- c) EXPLAIN ANALYZE bir products SELECT'i -> get_my_tenant_id()
--    cache'lenmis InitPlan olarak gorunmeli (subquery degil).
-- ============================================================
