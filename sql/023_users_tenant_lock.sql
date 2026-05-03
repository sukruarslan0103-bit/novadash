-- ============================================================
-- 023 — USERS TENANT LOCK
-- Amac: Kullanici kendi satirinda tenant_id ve role'u
--       DEGISTIREMEZ. Sadece service_role degistirebilir.
--
-- Neden: users RLS policy'si "id = auth.uid()" izin veriyor.
--        Bu kullaniciya kendi tenant_id'sini guncelleme yetkisi
--        de tanir. Sonuc: kullanici kendini baska tenant'a
--        tasiyabilir -> CROSS-TENANT VERI SIZINTISI.
--
-- Cozum: BEFORE UPDATE trigger ile kritik kolonlari kilitle.
-- ============================================================

CREATE OR REPLACE FUNCTION trg_fn_users_lock_critical_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
BEGIN
    -- service_role bypass — backend / admin operasyonlari serbest
    BEGIN
        v_role := current_setting('request.jwt.claim.role', true);
    EXCEPTION WHEN OTHERS THEN
        v_role := NULL;
    END;

    IF v_role = 'service_role' THEN
        RETURN NEW;
    END IF;

    -- tenant_id degisikligi YASAK
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION 'tenant_id degistirilemez'
            USING ERRCODE = '42501';
    END IF;

    -- role degisikligi YASAK (kullanici kendini owner yapamasin)
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'role degistirilemez'
            USING ERRCODE = '42501';
    END IF;

    -- id degisikligi YASAK (paranoia)
    IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'id degistirilemez'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_lock_critical_columns ON public.users;

CREATE TRIGGER trg_users_lock_critical_columns
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION trg_fn_users_lock_critical_columns();

-- ============================================================
-- TEST
-- ============================================================
-- Normal kullanici olarak login ol, sonra:
--   UPDATE users SET tenant_id = '<baska-tenant-uuid>' WHERE id = auth.uid();
-- Beklenen: ERROR  42501  tenant_id degistirilemez
--
-- service_role ile (backend) ayni UPDATE -> calisir.
-- ============================================================
