-- ============================================================
-- 007 — Monthly Expense Summary RPC (SECURED)
-- tenant_id → auth.uid() uzerinden users tablosundan resolve edilir
-- Client p_tenant_id artik gonderemez.
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
    v_auth_uid UUID;
    v_tenant_id UUID;
    v_total_months INT;
    v_rows JSONB;
    v_offset INT;
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
        SELECT DISTINCT TO_CHAR(date, 'YYYY-MM')
        FROM expenses WHERE tenant_id = v_tenant_id
    ) t;

    v_offset := (p_page - 1) * p_page_size;

    WITH months AS (
        SELECT
            TO_CHAR(date, 'YYYY-MM') AS month_key,
            SUM(amount) AS total_amount,
            COUNT(*) AS record_count
        FROM expenses
        WHERE tenant_id = v_tenant_id
        GROUP BY TO_CHAR(date, 'YYYY-MM')
        ORDER BY month_key DESC
        LIMIT p_page_size OFFSET v_offset
    ),
    daily AS (
        SELECT
            TO_CHAR(e.date, 'YYYY-MM') AS month_key,
            e.date,
            SUM(e.amount) AS day_total,
            COUNT(*) AS day_count
        FROM expenses e
        INNER JOIN months m ON TO_CHAR(e.date, 'YYYY-MM') = m.month_key
        WHERE e.tenant_id = v_tenant_id
        GROUP BY TO_CHAR(e.date, 'YYYY-MM'), e.date
    )
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'monthKey', m.month_key,
            'totalAmount', m.total_amount,
            'recordCount', m.record_count,
            'dailyTotals', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'date', d.date::text,
                        'totalAmount', d.day_total,
                        'recordCount', d.day_count
                    ) ORDER BY d.date
                )
                FROM daily d WHERE d.month_key = m.month_key
            ), '[]'::jsonb)
        ) ORDER BY m.month_key DESC
    ), '[]'::jsonb)
    INTO v_rows
    FROM months m;

    RETURN jsonb_build_object(
        'rows', v_rows,
        'totalMonths', v_total_months,
        'page', p_page,
        'pageSize', p_page_size,
        'totalPages', GREATEST(1, CEIL(v_total_months::numeric / p_page_size))
    );
END;
$$;
