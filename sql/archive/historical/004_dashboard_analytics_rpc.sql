-- ============================================================
-- 004 — Dashboard Analytics RPC
-- Tüm dashboard aggregation'ı DB seviyesinde yapar.
-- 10+ ayrı sorgu yerine tek RPC call.
--
-- Contract:
--   Sadece (p_start DATE, p_end DATE) alır.
--   tenant_id → auth.uid() üzerinden users tablosundan resolve edilir.
--   Client tenant_id ya da tarih hilesi yapamaz.
--
-- Timezone: Europe/Istanbul (UTC+3, DST yok).
--   today / yesterday / week_start DB tarafında hesaplanır.
-- ============================================================

CREATE OR REPLACE FUNCTION get_dashboard_analytics(
    p_start DATE,
    p_end   DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid UUID;
    v_tenant_id UUID;

    v_today      DATE;
    v_yesterday  DATE;
    v_week_start DATE;

    v_prev_start DATE;
    v_prev_end   DATE;

    v_monthly_revenue       NUMERIC := 0;
    v_monthly_expense       NUMERIC := 0;
    v_monthly_product_cost  NUMERIC := 0;
    v_prev_revenue          NUMERIC := 0;
    v_prev_expense          NUMERIC := 0;
    v_prev_product_cost     NUMERIC := 0;
    v_today_revenue         NUMERIC := 0;
    v_today_expense         NUMERIC := 0;
    v_today_product_cost    NUMERIC := 0;
    v_yesterday_revenue     NUMERIC := 0;
    v_yesterday_expense     NUMERIC := 0;
    v_yesterday_product_cost NUMERIC := 0;

    v_weekly_sales       JSONB;
    v_expense_categories JSONB;
    v_top_products       JSONB;
BEGIN
    -- === AUTH GUARD ===
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

    -- === INPUT VALIDATION ===
    IF p_start IS NULL OR p_end IS NULL THEN
        RAISE EXCEPTION 'p_start ve p_end zorunlu';
    END IF;

    IF p_start > p_end THEN
        RAISE EXCEPTION 'p_start, p_end''den büyük olamaz';
    END IF;

    -- === TIMEZONE-AWARE DATES (Europe/Istanbul) ===
    v_today      := (timezone('Europe/Istanbul', now()))::date;
    v_yesterday  := v_today - 1;
    v_week_start := v_today - 6;

    -- Previous period (aynı uzunlukta, p_start'tan önce)
    v_prev_end   := p_start - 1;
    v_prev_start := v_prev_end - (p_end - p_start);

    -- === SALES AGGREGATION (current + prev + today + yesterday, single scan) ===
    SELECT
        COALESCE(SUM(total) FILTER (WHERE date >= p_start AND date <= p_end), 0),
        COALESCE(SUM(total) FILTER (WHERE date >= v_prev_start AND date <= v_prev_end), 0),
        COALESCE(SUM(total) FILTER (WHERE date = v_today), 0),
        COALESCE(SUM(total) FILTER (WHERE date = v_yesterday), 0)
    INTO v_monthly_revenue, v_prev_revenue, v_today_revenue, v_yesterday_revenue
    FROM sales
    WHERE tenant_id = v_tenant_id
      AND is_deleted = false
      AND date >= LEAST(v_prev_start, v_yesterday)
      AND date <= GREATEST(p_end, v_today);

    -- === EXPENSES AGGREGATION ===
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE date >= p_start AND date <= p_end), 0),
        COALESCE(SUM(amount) FILTER (WHERE date >= v_prev_start AND date <= v_prev_end), 0),
        COALESCE(SUM(amount) FILTER (WHERE date = v_today), 0),
        COALESCE(SUM(amount) FILTER (WHERE date = v_yesterday), 0)
    INTO v_monthly_expense, v_prev_expense, v_today_expense, v_yesterday_expense
    FROM expenses
    WHERE tenant_id = v_tenant_id
      AND date >= LEAST(v_prev_start, v_yesterday)
      AND date <= GREATEST(p_end, v_today);

    -- === PRODUCT COST AGGREGATION ===
    -- INNER JOIN sales → sadece aktif satışlar; sale_id NULL değil
    SELECT
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date >= p_start AND s.date <= p_end), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date >= v_prev_start AND s.date <= v_prev_end), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date = v_today), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date = v_yesterday), 0)
    INTO v_monthly_product_cost, v_prev_product_cost, v_today_product_cost, v_yesterday_product_cost
    FROM product_sales ps
    INNER JOIN sales s ON s.id = ps.sale_id
    WHERE ps.tenant_id = v_tenant_id
      AND s.is_deleted = false
      AND s.date >= LEAST(v_prev_start, v_yesterday)
      AND s.date <= GREATEST(p_end, v_today);

    -- === WEEKLY SALES (son 7 gün) ===
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'date', t.date::TEXT,
        'amount', t.amount
    )), '[]'::jsonb)
    INTO v_weekly_sales
    FROM (
        SELECT date, SUM(total) AS amount
        FROM sales
        WHERE tenant_id = v_tenant_id
          AND is_deleted = false
          AND date >= v_week_start
          AND date <= v_today
        GROUP BY date
        ORDER BY date
    ) t;

    -- === EXPENSE CATEGORIES (current period) ===
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', t.name,
        'color', t.color,
        'amount', t.amount
    )), '[]'::jsonb)
    INTO v_expense_categories
    FROM (
        SELECT
            COALESCE(c.name, 'Diğer')   AS name,
            COALESCE(c.color, '#9CA3AF') AS color,
            SUM(e.amount)                AS amount
        FROM expenses e
        LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.tenant_id = v_tenant_id
          AND e.date >= p_start
          AND e.date <= p_end
        GROUP BY c.name, c.color
        ORDER BY SUM(e.amount) DESC
    ) t;

    -- === TOP 5 PRODUCTS (current period) ===
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'product_id', t.product_id,
        'name', t.name,
        'quantity', t.quantity,
        'revenue', t.revenue,
        'estimated_profit', t.estimated_profit
    )), '[]'::jsonb)
    INTO v_top_products
    FROM (
        SELECT
            ps.product_id,
            COALESCE(p.name, 'Silinmiş Ürün')             AS name,
            SUM(ps.quantity)                              AS quantity,
            SUM(ps.total)                                 AS revenue,
            SUM(ps.total) - SUM(ps.cost * ps.quantity)    AS estimated_profit
        FROM product_sales ps
        INNER JOIN sales s ON s.id = ps.sale_id
        LEFT JOIN products p ON p.id = ps.product_id
        WHERE ps.tenant_id = v_tenant_id
          AND s.is_deleted = false
          AND s.date >= p_start
          AND s.date <= p_end
        GROUP BY ps.product_id, p.name
        ORDER BY SUM(ps.quantity) DESC, SUM(ps.total) DESC
        LIMIT 5
    ) t;

    -- === RETURN ===
    RETURN jsonb_build_object(
        'monthly_revenue',       v_monthly_revenue,
        'monthly_expense',       v_monthly_expense,
        'monthly_product_cost',  v_monthly_product_cost,
        'prev_revenue',          v_prev_revenue,
        'prev_expense',          v_prev_expense,
        'prev_product_cost',     v_prev_product_cost,
        'today_revenue',         v_today_revenue,
        'today_expense',         v_today_expense,
        'today_product_cost',    v_today_product_cost,
        'yesterday_revenue',     v_yesterday_revenue,
        'yesterday_expense',     v_yesterday_expense,
        'yesterday_product_cost', v_yesterday_product_cost,
        'weekly_sales',          v_weekly_sales,
        'expense_categories',    v_expense_categories,
        'top_products',          v_top_products,
        'today',                 v_today::TEXT,
        'yesterday',             v_yesterday::TEXT,
        'week_start',            v_week_start::TEXT
    );
END;
$$;
