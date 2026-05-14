-- ============================================================
-- SYSTEM LOGS — Kritik islem kayitlari
-- ============================================================

CREATE TABLE IF NOT EXISTS system_logs (
    id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    user_id    UUID,
    action     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'success',
    message    TEXT,
    metadata   JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_tenant ON system_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_system_logs_action ON system_logs(action);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);

ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_system_logs"
ON system_logs FOR ALL
USING (tenant_id = (
    SELECT tenant_id FROM users WHERE id = auth.uid()
));

-- ============================================================
-- LOG HELPER — RPC icinden cagirilir
-- ============================================================

CREATE OR REPLACE FUNCTION write_system_log(
    p_tenant_id UUID,
    p_user_id   UUID,
    p_action    TEXT,
    p_status    TEXT,
    p_message   TEXT DEFAULT NULL,
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
    -- Log yazimi asla ana islemi bozmasin
    NULL;
END;
$$;

-- ============================================================
-- FRONTEND LOG — kullanici tarafindan cagirilir
-- ============================================================

CREATE OR REPLACE FUNCTION log_client_event(
    p_action  TEXT,
    p_status  TEXT,
    p_message TEXT DEFAULT NULL,
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

GRANT EXECUTE ON FUNCTION log_client_event(TEXT, TEXT, TEXT, JSONB) TO authenticated;
