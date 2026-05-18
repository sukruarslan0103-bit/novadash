-- ============================================================
-- 055 — OBSERVABILITY VIEWS (Faz 0 Adim 2)
--
-- Amac:
--   Backend-side RPC latency / slow query gorunurlugu.
--   Frontend tarafinda window.__rpcStats client-side toplaniyor;
--   bu migration ayni gorunurlugu DB tarafindan sunar.
--
-- pg_stat_statements:
--   Supabase Cloud projelerinde varsayilan aktiftir. Self-hosted
--   ortamlar icin asagidaki CREATE EXTENSION fallback.
--
-- View'lar:
--   v_slow_rpc          — Postgres tarafinda RPC mean/max execution
--                         time (sunucuda gercekten ne kadar surdugu)
--   v_client_slow_rpc   — frontend wrapper'in system_logs'a yazdigi
--                         yavaş RPC olaylari (client-side toplam:
--                         RTT + serialize + sunucu)
--
-- Profiling akisi:
--   client p50 - db mean_ms = network/serialize maliyeti
--   db mean_ms > 200ms      = sunucu tarafi sorun (query/index)
--   client p50 > db mean*2  = network ya da response payload sorun
--
-- Idempotency:
--   CREATE EXTENSION IF NOT EXISTS + CREATE OR REPLACE VIEW
--   migration tekrar calistirilabilir.
--
-- Yetki:
--   View'lar default olarak owner=postgres. authenticated role
--   v_slow_rpc'yi okuyabilmek icin GRANT SELECT — opsiyonel.
--   Su an SECURITY DEFINER set degil; SQL Editor uzerinden
--   manuel inceleme icin yeterli.
-- ============================================================

-- pg_stat_statements — Supabase Cloud'da zaten aktif; safety net
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;


-- ============================================================
-- v_slow_rpc — Postgres RPC execution time
-- ============================================================
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
  'Periodik kontrol: SELECT * FROM v_slow_rpc; '
  'mean_ms > 200 -> RPC inceleme adayi.';


-- ============================================================
-- v_client_slow_rpc — Frontend wrapper'in DB'ye yazdigi yavaş RPC'ler
-- ============================================================
-- system_logs.action = 'rpc_slow' kayitlari; client wrapper
-- (js/observability.js) >500ms RPC'leri log_client_event ile yaziyor.
-- Client tarafi RTT + serialize + sunucu suresini kapsar.
--
-- KOLON-BAGIMSIZ: RPC name + duration + error metadata JSONB'sinden
-- okunur. system_logs schema varyasyonu (message kolonu yok/var) bu
-- view'i etkilemez.
CREATE OR REPLACE VIEW v_client_slow_rpc AS
SELECT
    created_at,
    tenant_id,
    user_id,
    action,
    status,
    metadata->>'rpc_name'                                   AS rpc_name,
    (metadata->>'duration_ms')::int                         AS client_duration_ms,
    metadata->>'error'                                      AS error,
    metadata                                                AS metadata_full
FROM system_logs
WHERE action    = 'rpc_slow'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC
LIMIT 500;

COMMENT ON VIEW v_client_slow_rpc IS
  '055: Frontend RPC wrapper''in DB''ye yazdigi yavaş RPC olaylari (>500ms). '
  '24 saatlik pencere. client_duration_ms = RTT + serialize + sunucu. '
  'v_slow_rpc.mean_ms ile karsilastirildiginda network maliyeti cikar.';


-- ============================================================
-- POST-DEPLOY VALIDATION
-- ============================================================
DO $$
DECLARE
    v_pgss_ok    BOOLEAN;
    v_slow_ok    BOOLEAN;
    v_clislow_ok BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
    ) INTO v_pgss_ok;

    SELECT EXISTS (
        SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_slow_rpc'
    ) INTO v_slow_ok;

    SELECT EXISTS (
        SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_client_slow_rpc'
    ) INTO v_clislow_ok;

    IF NOT v_pgss_ok THEN
        RAISE WARNING '[055] pg_stat_statements extension yok — Supabase Cloud''da bu beklenmiyor';
    END IF;

    IF NOT v_slow_ok THEN
        RAISE EXCEPTION '[055] FAIL: v_slow_rpc view olusmadi';
    END IF;

    IF NOT v_clislow_ok THEN
        RAISE EXCEPTION '[055] FAIL: v_client_slow_rpc view olusmadi';
    END IF;

    RAISE NOTICE '[055] OK: observability views aktif | pg_stat_statements=% | v_slow_rpc=% | v_client_slow_rpc=%',
        v_pgss_ok, v_slow_ok, v_clislow_ok;
END;
$$;
