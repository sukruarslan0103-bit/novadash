-- ============================================================
-- AUTO USER CREATE
-- auth.users'a yeni kayit eklendiginde otomatik olarak:
--   1. tenants tablosuna yeni tenant ekler
--   2. public.users'a yeni kayit ekler (id = auth user id, tenant_id = yeni tenant)
-- Manuel insert yok.
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
    -- Yeni tenant olustur (basit model)
    INSERT INTO public.tenants (name)
    VALUES ('Yeni Tenant')
    RETURNING id INTO v_tenant_id;

    INSERT INTO public.users (id, tenant_id)
    VALUES (NEW.id, v_tenant_id);

    RETURN NEW;
END;
$$;

-- ============================================================
-- TRIGGER — auth.users INSERT hook
-- ============================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();
