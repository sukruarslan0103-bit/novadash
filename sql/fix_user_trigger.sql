-- ============================================================
-- FIX USER TRIGGER
-- 1. Trigger/function yeniden kurulur (idempotent)
-- 2. Eksik public.users kayitlari backfill edilir
-- ============================================================

-- ============================================================
-- 1. VERIFY / REBUILD FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id uuid;
BEGIN
    INSERT INTO public.tenants (name)
    VALUES ('Yeni Tenant')
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.users (id, tenant_id)
    VALUES (NEW.id, v_tenant_id);

    RETURN NEW;
END;
$$;

-- ============================================================
-- 2. VERIFY / REBUILD TRIGGER (AFTER INSERT on auth.users)
-- ============================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 3. GRANT — supabase auth admin rolunun function'i calistirabilmesi icin
-- ============================================================

GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;

-- ============================================================
-- 4. BACKFILL — eksik public.users kayitlari
--    Her eksik user icin yeni tenant olusturulup baglanir.
-- ============================================================

DO $$
DECLARE
    r RECORD;
    v_tenant_id uuid;
BEGIN
    FOR r IN
        SELECT au.id
        FROM auth.users au
        LEFT JOIN public.users pu ON pu.id = au.id
        WHERE pu.id IS NULL
    LOOP
        INSERT INTO public.tenants (name)
        VALUES ('Yeni Tenant')
        RETURNING id INTO v_tenant_id;

        INSERT INTO public.users (id, tenant_id)
        VALUES (r.id, v_tenant_id);
    END LOOP;
END;
$$;

-- ============================================================
-- 5. VERIFICATION QUERIES (commented — manuel calistir)
-- ============================================================

-- SELECT tgname, tgrelid::regclass, tgenabled, tgtype
-- FROM pg_trigger
-- WHERE tgname = 'on_auth_user_created';

-- SELECT proname, prosrc
-- FROM pg_proc
-- WHERE proname = 'handle_new_user';

-- SELECT COUNT(*) AS missing_users
-- FROM auth.users au
-- LEFT JOIN public.users pu ON pu.id = au.id
-- WHERE pu.id IS NULL;
