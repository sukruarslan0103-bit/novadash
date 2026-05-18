-- ============================================================
-- 055 — OBSERVABILITY VIEWS (Faz 0 Adim 2)
--
-- Amac:
--   Backend-side RPC latency / slow query gorunurlugu.
--   Sunucuda RPC'lerin gercekten ne kadar surdugu (network haric).
--
-- Frontend tarafi:
--   js/observability.js -> window.RpcObserver.summary()
--   In-memory ring buffer'dan p50/p95/p99 verir. Client toplam:
--   RTT + serialize + sunucu.
--
-- Bu migration sadece SUNUCU tarafi gorunurluk:
--   pg_stat_statements uzerinden hot path RPC'lerin mean/max/stddev
--   execution time'i. system_logs'a hicbir bagimliligi yok.
--
-- NOT: Onceki versiyonda v_client_slow_rpc view'i vardi (system_logs
-- uzerinden frontend slow log'larini gosterirdi). Production'da
-- system_logs schema'si baseline'dan divergent (message/status/metadata
-- kolonlari yok); log_client_event RPC'si sessizce fail ediyor. Bu
-- view kaldirildi — schema sync'i ayri bir is olacak. Client telemetry
-- icin RpcObserver.summary() yeterli.
--
-- Idempotency: CREATE EXTENSION IF NOT EXISTS + CREATE OR REPLACE VIEW
-- ============================================================

-- pg_stat_statements — Supabase Cloud'da zaten aktif; safety net
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;


-- ============================================================
-- v_slow_rpc — Postgres RPC execution time (sunucu tarafi)
-- ============================================================
-- Hot path RPC'ler: services/*.js icinde cagrilan ana RPC isimleri.
-- pg_stat_statements query metnine ILIKE ile matchleniyor.
-- Periodik kontrol: SELECT * FROM v_slow_rpc;
-- mean_ms > 200 -> RPC inceleme adayi.
CREATE OR REPLACE VIEW v_slow_rpc AS
SELECT
    substring(query, 1, 100)                                AS query_preview,
    calls,
    round(mean_exec_time::numeric, 2)                       AS mean_ms,
    round(max_exec_time::numeric, 2)                        AS max_ms,
    round(total_exec_time::numeric, 2)                      AS total_ms,
    round(stddev_exec_time::numeric, 2)                     AS stddev_ms,
    rows
FROM pg_stat_statements
WHERE query ILIKE '%create_sales_atomic%'
   OR query ILIKE '%get_dashboard_analytics%'
   OR query ILIKE '%get_sales_paginated%'
   OR query ILIKE '%get_product_performance_summary%'
   OR query ILIKE '%get_monthly_expense_summary%'
   OR query ILIKE '%insert_expense%'
   OR query ILIKE '%update_expense%'
   OR query ILIKE '%soft_delete_expense%'
   OR query ILIKE '%create_purchase_and_update_product_cost%'
   OR query ILIKE '%restore_full_backup%'
   OR query ILIKE '%update_sale%'
   OR query ILIKE '%soft_delete_sale%'
   OR query ILIKE '%log_client_event%'
   OR query ILIKE '%check_rate_limit%'
ORDER BY mean_exec_time DESC
LIMIT 100;

COMMENT ON VIEW v_slow_rpc IS
  '055: Hot path RPC slow query izleme (pg_stat_statements uzerinden). '
  'mean_ms > 200 -> inceleme adayi. system_logs uzerinde hicbir '
  'bagimliligi yoktur.';


-- ============================================================
-- POST-DEPLOY VALIDATION
-- ============================================================
DO $$
DECLARE
    v_pgss_ok BOOLEAN;
    v_slow_ok BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
    ) INTO v_pgss_ok;

    SELECT EXISTS (
        SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_slow_rpc'
    ) INTO v_slow_ok;

    IF NOT v_pgss_ok THEN
        RAISE WARNING '[055] pg_stat_statements extension yok — Supabase Cloud''da bu beklenmiyor';
    END IF;

    IF NOT v_slow_ok THEN
        RAISE EXCEPTION '[055] FAIL: v_slow_rpc view olusmadi';
    END IF;

    RAISE NOTICE '[055] OK: observability views aktif | pg_stat_statements=% | v_slow_rpc=%',
        v_pgss_ok, v_slow_ok;
END;
$$;
