-- ============================================================
-- 007 — Monthly Expense Summary RPC
-- DB tarafında GROUP BY month
-- tenant_id → auth.uid() üzerinden users tablosundan resolve
-- ============================================================

CREATE OR REPLACE FUNCTION get_monthly_expense_summary(
    p_page INT DEFAULT 1,
    p_page_size INT DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid     UUID;
    v_tenant_id    UUID;
    v_total_months INT;
    v_rows         JSONB;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM users
    WHERE id = v_auth_uid;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    SELECT COUNT(*) INTO v_total_months
    FROM (
        SELECT DISTINCT DATE_TRUNC('month', date)
        FROM expenses
        WHERE tenant_id = v_tenant_id
    ) t;

    SELECT COALESCE(jsonb_agg(row_data ORDER BY month_key DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
        SELECT
            DATE_TRUNC('month', date) AS month_key,
            jsonb_build_object(
                'month', DATE_TRUNC('month', date),
                'total', SUM(amount),
                'count', COUNT(*)
            ) AS row_data
        FROM expenses
        WHERE tenant_id = v_tenant_id
        GROUP BY DATE_TRUNC('month', date)
    ) m;

    RETURN jsonb_build_object(
        'data', COALESCE(v_rows, '[]'::jsonb),
        'count', COALESCE(v_total_months, 0)
    );
END;
$$;
