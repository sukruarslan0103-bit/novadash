-- ============================================================
-- TENANT AUTO-ASSIGN — BEFORE INSERT TRIGGER
-- tenant_id client tarafindan gonderilmez.
-- auth.uid() -> users.tenant_id uzerinden otomatik doldurulur.
-- ============================================================

CREATE OR REPLACE FUNCTION set_tenant_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id uuid;
BEGIN
    -- Eger zaten doluysa dokunma
    IF NEW.tenant_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Auth kontrol
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    -- Tenant cozumle
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
-- TRIGGERS — tenant_id iceren tum tablolar
-- ============================================================

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON categories;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON categories
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON products;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON products
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON sales;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON sales
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON product_sales;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON product_sales
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON expenses;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON expenses
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON events;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON tasks;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON tasks
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON settings;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON settings
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON deleted_records;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON deleted_records
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON system_logs;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON system_logs
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();

DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON purchases;
CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON purchases
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();
