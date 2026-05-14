-- ============================================================
-- 038 — ALERT STATES (open / dismissed / resolved)
--   alerts_master uyarilarinin per-tenant state yonetimi
-- ============================================================

-- 1) TABLE
CREATE TABLE IF NOT EXISTS alert_states (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    alert_key   text NOT NULL,
    state       text NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','dismissed','resolved')),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_states_tenant_key
    ON alert_states(tenant_id, alert_key);

CREATE INDEX IF NOT EXISTS idx_alert_states_tenant_state
    ON alert_states(tenant_id, state);

-- RLS
ALTER TABLE alert_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON alert_states;
CREATE POLICY tenant_isolation ON alert_states
    FOR ALL
    USING (tenant_id = get_my_tenant_id())
    WITH CHECK (tenant_id = get_my_tenant_id());


-- 2) RPC — set_alert_state
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

GRANT EXECUTE ON FUNCTION set_alert_state(TEXT, TEXT) TO authenticated;


-- ============================================================
-- 3) alerts_master VIEW MODIFICATION — TEMPLATE
-- ------------------------------------------------------------
-- Mevcut alerts_master CREATE OR REPLACE VIEW gövdesine
-- asagidaki 2 ekleme yapilmali (gercek body sende):
--
--   CREATE OR REPLACE VIEW alerts_master AS
--   WITH base AS (
--       <mevcut alerts_master gövdesi — name, status, action, tenant_id ...>
--   )
--   SELECT
--       b.*,
--       md5(b.tenant_id::text || b.name || b.status) AS alert_key,
--       COALESCE(s.state, 'open') AS state
--   FROM base b
--   LEFT JOIN alert_states s
--       ON s.alert_key = md5(b.tenant_id::text || b.name || b.status)
--      AND s.tenant_id = b.tenant_id
--   WHERE COALESCE(s.state, 'open') <> 'dismissed';
--
-- alert_key formulu deterministik: tenant_id + name + status
-- Frontend de aynisini tekrar uretmez; view'dan okur.
-- ============================================================


-- DOGRULAMA
DO $$
DECLARE v_table INT; v_rpc INT;
BEGIN
    SELECT count(*) INTO v_table FROM information_schema.tables
        WHERE table_schema='public' AND table_name='alert_states';
    SELECT count(*) INTO v_rpc FROM pg_proc
        WHERE proname='set_alert_state' AND pronamespace='public'::regnamespace;
    IF v_table=0 OR v_rpc=0 THEN
        RAISE EXCEPTION 'KRITIK: alert_states/set_alert_state olusturulamadi';
    END IF;
    RAISE NOTICE 'OK: alert_states + set_alert_state aktif';
END $$;
