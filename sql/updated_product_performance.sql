-- ============================================================
-- Product Performance Summary RPC (SECURED)
-- tenant_id → auth.uid() uzerinden users tablosundan resolve edilir.
-- Client p_tenant_id artik gonderemez.
--
-- Response shape (frontend kontrati degismedi):
--   [{ product_id, name, price, cost, category_id, is_active,
--      quantity, revenue, estimated_profit, row_count, last_sale_date }]
-- ============================================================

CREATE OR REPLACE FUNCTION get_product_performance_summary(
    p_start DATE DEFAULT NULL,
    p_end   DATE DEFAULT NULL
)
RETURNS TABLE (
    product_id        UUID,
    name              TEXT,
    price             NUMERIC,
    cost              NUMERIC,
    category_id       UUID,
    is_active         BOOLEAN,
    quantity          NUMERIC,
    revenue           NUMERIC,
    estimated_profit  NUMERIC,
    row_count         BIGINT,
    last_sale_date    TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
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

    RETURN QUERY
    SELECT
        ps.product_id,
        COALESCE(p.name, 'Silinmis Urun')::TEXT                       AS name,
        COALESCE(p.price, 0)::NUMERIC                                 AS price,
        COALESCE(p.cost, 0)::NUMERIC                                  AS cost,
        p.category_id,
        COALESCE(p.is_active, TRUE)                                   AS is_active,
        SUM(ps.quantity)::NUMERIC                                     AS quantity,
        SUM(ps.total)::NUMERIC                                        AS revenue,
        (SUM(ps.total) - SUM(ps.cost * ps.quantity))::NUMERIC         AS estimated_profit,
        COUNT(*)::BIGINT                                              AS row_count,
        MAX(ps.date)::TEXT                                            AS last_sale_date
    FROM product_sales ps
    INNER JOIN sales s ON s.id = ps.sale_id
    LEFT JOIN products p ON p.id = ps.product_id
    WHERE ps.tenant_id = v_tenant_id
      AND s.is_deleted = FALSE
      AND (p_start IS NULL OR ps.date >= p_start)
      AND (p_end   IS NULL OR ps.date <= p_end)
    GROUP BY ps.product_id, p.name, p.price, p.cost, p.category_id, p.is_active
    ORDER BY SUM(ps.quantity) DESC, SUM(ps.total) DESC;
END;
$$;
