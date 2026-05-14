-- ============================================================
-- RATE LIMIT — RPC spam koruması
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limits (
    tenant_id    UUID NOT NULL,
    user_id      UUID NOT NULL,
    action       TEXT NOT NULL,
    last_call_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, action)
);

-- ============================================================
-- CHECK + UPDATE — tek fonksiyon
-- Cooldown dolmadiysa EXCEPTION, dolduysa timestamp guncelle
-- ============================================================

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
