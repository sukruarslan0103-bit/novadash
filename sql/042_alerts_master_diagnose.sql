-- ============================================================
-- 042 — alerts_master per-branch diagnose + force test alert
-- ============================================================

-- Senin tenant_id
\set my_tenant `SELECT id FROM public.users WHERE id = auth.uid()`

-- Yedek: tenant_id'yi al ve degisken olarak kullan
WITH me AS (SELECT tenant_id AS tid FROM public.users WHERE id = auth.uid())

-- ============================================================
-- BRANCH 1: product_priority — bu tenant'ta status'lu urun var mi?
-- ============================================================
SELECT 'BRANCH_1_PRODUCT_PRIORITY' AS branch,
       count(*) AS row_count,
       array_agg(DISTINCT p.status) AS statuses
FROM public.product_priority p, me
WHERE p.tenant_id = me.tid
  AND p.status IS NOT NULL;

-- ============================================================
-- BRANCH 2: EXPENSE_SPIKE — bugun > 1.3 × 7-gun ort?
-- ============================================================
WITH me AS (SELECT tenant_id AS tid FROM public.users WHERE id = auth.uid())
SELECT 'BRANCH_2_EXPENSE_SPIKE' AS branch,
       sum(CASE WHEN e.date = CURRENT_DATE THEN e.amount ELSE 0 END) AS today,
       avg(e.amount) AS avg7,
       (sum(CASE WHEN e.date = CURRENT_DATE THEN e.amount ELSE 0 END) > avg(e.amount) * 1.3)
           AS triggers
FROM public.expenses e, me
WHERE e.tenant_id = me.tid
  AND e.date >= CURRENT_DATE - 7;

-- ============================================================
-- BRANCH 3: LOSS — all-time sales − expenses < 0?
-- ============================================================
WITH me AS (SELECT tenant_id AS tid FROM public.users WHERE id = auth.uid()),
     s AS (SELECT sum(total)  AS sales_total
           FROM public.sales,    me WHERE sales.tenant_id    = me.tid),
     e AS (SELECT sum(amount) AS expense_total
           FROM public.expenses, me WHERE expenses.tenant_id = me.tid)
SELECT 'BRANCH_3_LOSS' AS branch,
       s.sales_total,
       e.expense_total,
       (COALESCE(s.sales_total, 0) - COALESCE(e.expense_total, 0)) AS net,
       (COALESCE(s.sales_total, 0) - COALESCE(e.expense_total, 0) < 0) AS triggers,
       (s.sales_total IS NULL) AS sales_empty,
       (e.expense_total IS NULL) AS expense_empty
FROM s, e;

-- ============================================================
-- alerts_master DOGRUDAN — bu tenant icin ne donuyor?
-- ============================================================
WITH me AS (SELECT tenant_id AS tid FROM public.users WHERE id = auth.uid())
SELECT * FROM public.alerts_master, me WHERE alerts_master.tenant_id = me.tid;
