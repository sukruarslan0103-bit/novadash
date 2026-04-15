-- ============================================================
-- 004 — Dashboard Analytics RPC
-- Tüm dashboard aggregation'ı DB seviyesinde yapar.
-- 10+ ayrı sorgu yerine tek RPC call.
-- ============================================================

CREATE OR REPLACE FUNCTION get_dashboard_analytics(
    p_tenant_id UUID,
    p_current_start DATE,
    p_current_end DATE,
    p_prev_start DATE,
    p_prev_end DATE,
    p_today DATE,
    p_yesterday DATE,
    p_week_start DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_monthly_revenue NUMERIC := 0;
    v_monthly_expense NUMERIC := 0;
    v_monthly_product_cost NUMERIC := 0;
    v_prev_revenue NUMERIC := 0;
    v_prev_expense NUMERIC := 0;
    v_prev_product_cost NUMERIC := 0;
    v_today_revenue NUMERIC := 0;
    v_today_expense NUMERIC := 0;
    v_today_product_cost NUMERIC := 0;
    v_yesterday_revenue NUMERIC := 0;
    v_yesterday_expense NUMERIC := 0;
    v_yesterday_product_cost NUMERIC := 0;
    v_weekly_sales JSONB;
    v_expense_categories JSONB;
    v_top_products JSONB;
    v_tasks_today_count INT := 0;
    v_all_tasks JSONB;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id is required';
    END IF;

    -- === SALES AGGREGATION (all periods, single table scan) ===
    SELECT
        COALESCE(SUM(total) FILTER (WHERE date >= p_current_start AND date <= p_current_end), 0),
        COALESCE(SUM(total) FILTER (WHERE date >= p_prev_start AND date <= p_prev_end), 0),
        COALESCE(SUM(total) FILTER (WHERE date = p_today), 0),
        COALESCE(SUM(total) FILTER (WHERE date = p_yesterday), 0)
    INTO v_monthly_revenue, v_prev_revenue, v_today_revenue, v_yesterday_revenue
    FROM sales
    WHERE tenant_id = p_tenant_id
      AND is_deleted = false
      AND date >= p_prev_start
      AND date <= p_current_end;

    -- === EXPENSES AGGREGATION (all periods, single table scan) ===
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE date >= p_current_start AND date <= p_current_end), 0),
        COALESCE(SUM(amount) FILTER (WHERE date >= p_prev_start AND date <= p_prev_end), 0),
        COALESCE(SUM(amount) FILTER (WHERE date = p_today), 0),
        COALESCE(SUM(amount) FILTER (WHERE date = p_yesterday), 0)
    INTO v_monthly_expense, v_prev_expense, v_today_expense, v_yesterday_expense
    FROM expenses
    WHERE tenant_id = p_tenant_id
      AND date >= p_prev_start
      AND date <= p_current_end;

    -- === PRODUCT COST AGGREGATION (all periods, single scan) ===
    -- INNER JOIN sales → only non-deleted sales counted
    -- INNER JOIN guarantees sale_id IS NOT NULL
    SELECT
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date >= p_current_start AND s.date <= p_current_end), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date >= p_prev_start AND s.date <= p_prev_end), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date = p_today), 0),
        COALESCE(SUM(ps.cost * ps.quantity) FILTER (WHERE s.date = p_yesterday), 0)
    INTO v_monthly_product_cost, v_prev_product_cost, v_today_product_cost, v_yesterday_product_cost
    FROM product_sales ps
    INNER JOIN sales s ON s.id = ps.sale_id
    WHERE ps.tenant_id = p_tenant_id
      AND s.is_deleted = false
      AND s.date >= p_prev_start
      AND s.date <= p_current_end;

    -- === WEEKLY SALES (grouped by date) ===
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'date', t.date::TEXT,
        'amount', t.amount
    )), '[]'::jsonb)
    INTO v_weekly_sales
    FROM (
        SELECT date, SUM(total) as amount
        FROM sales
        WHERE tenant_id = p_tenant_id
          AND is_deleted = false
          AND date >= p_week_start
          AND date <= p_today
        GROUP BY date
        ORDER BY date
    ) t;

    -- === EXPENSE CATEGORIES (current month, grouped) ===
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'name', t.name,
        'color', t.color,
        'amount', t.amount
    )), '[]'::jsonb)
    INTO v_expense_categories
    FROM (
        SELECT
            COALESCE(c.name, 'Diğer') as name,
            COALESCE(c.color, '#9CA3AF') as color,
            SUM(e.amount) as amount
        FROM expenses e
        LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.tenant_id = p_tenant_id
          AND e.date >= p_current_start
          AND e.date <= p_current_end
        GROUP BY c.name, c.color
        ORDER BY SUM(e.amount) DESC
    ) t;

    -- === TOP 5 PRODUCTS (current month, by quantity then revenue) ===
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
            COALESCE(p.name, 'Silinmiş Ürün') as name,
            SUM(ps.quantity) as quantity,
            SUM(ps.total) as revenue,
            SUM(ps.total) - SUM(ps.cost * ps.quantity) as estimated_profit
        FROM product_sales ps
        INNER JOIN sales s ON s.id = ps.sale_id
        LEFT JOIN products p ON p.id = ps.product_id
        WHERE ps.tenant_id = p_tenant_id
          AND s.is_deleted = false
          AND s.date >= p_current_start
          AND s.date <= p_current_end
        GROUP BY ps.product_id, p.name
        ORDER BY SUM(ps.quantity) DESC, SUM(ps.total) DESC
        LIMIT 5
    ) t;

    -- === TASKS ===
    SELECT COUNT(*)
    INTO v_tasks_today_count
    FROM tasks
    WHERE tenant_id = p_tenant_id
      AND due_date = p_today;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', id,
        'due_date', due_date::TEXT,
        'status', status,
        'priority', priority,
        'title', title
    )), '[]'::jsonb)
    INTO v_all_tasks
    FROM tasks
    WHERE tenant_id = p_tenant_id;

    -- === RETURN ===
    RETURN jsonb_build_object(
        'monthly_revenue', v_monthly_revenue,
        'monthly_expense', v_monthly_expense,
        'monthly_product_cost', v_monthly_product_cost,
        'prev_revenue', v_prev_revenue,
        'prev_expense', v_prev_expense,
        'prev_product_cost', v_prev_product_cost,
        'today_revenue', v_today_revenue,
        'today_expense', v_today_expense,
        'today_product_cost', v_today_product_cost,
        'yesterday_revenue', v_yesterday_revenue,
        'yesterday_expense', v_yesterday_expense,
        'yesterday_product_cost', v_yesterday_product_cost,
        'weekly_sales', v_weekly_sales,
        'expense_categories', v_expense_categories,
        'top_products', v_top_products,
        'tasks_today_count', v_tasks_today_count,
        'all_tasks', v_all_tasks
    );
END;
$$;
