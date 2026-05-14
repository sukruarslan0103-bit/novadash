-- ============================================================
-- 040 — get_dashboard_with_alerts: tenant resolve FIX
--
-- Sorun: v_tenant_id := get_my_tenant_id();
--   RPC SECURITY DEFINER + auth.uid() context'i bazi durumlarda
--   get_my_tenant_id()'i NULL dondurur. Bu durumda
--   alerts_master WHERE am.tenant_id = NULL -> 0 row.
--
-- Cozum: auth.uid() -> users tablosundan dogrudan tenant_id cek.
--   Defansif + acik. RLS bypass etmez (SELECT auth.uid() kontrolu).
-- ============================================================


-- ============================================================
-- ADIM 1 — TANI: get_my_tenant_id RPC contextinde NULL mi?
-- ============================================================
-- SQL Editor'da postgres rolu ile calistirma — RPC contextini taklit etmek icin
-- service_role token ile cagri yap. Veya basit test:

SELECT
    auth.uid()                       AS uid,
    get_my_tenant_id()                AS via_function,
    (SELECT tenant_id FROM public.users WHERE id = auth.uid()) AS via_lookup;

-- via_function NULL ama via_lookup dolu ise -> get_my_tenant_id() bozuk.
-- ikisi de NULL ise -> auth context yok (postgres rolunde calisiyorsun, normal).


-- ============================================================
-- ADIM 2 — RPC body icindeki tenant resolve degistir
-- ============================================================
-- Mevcut RPC body'sini al:
--   SELECT pg_get_functiondef(oid) FROM pg_proc
--   WHERE proname = 'get_dashboard_with_alerts'
--     AND pronamespace = 'public'::regnamespace;
--
-- Body icinde su satiri BUL:
--
--   v_tenant_id := get_my_tenant_id();
--
-- BUNUNLA DEGISTIR:
--
--   SELECT tenant_id INTO v_tenant_id
--   FROM public.users
--   WHERE id = auth.uid();
--
--   IF v_tenant_id IS NULL THEN
--       RAISE EXCEPTION 'Tenant not found for user %', auth.uid()
--           USING ERRCODE = '42501';
--   END IF;
--
--   RAISE NOTICE 'get_dashboard_with_alerts: tenant=%', v_tenant_id;
--
-- alerts_master SELECT'i de DOGRULA:
--
--   SELECT COALESCE(jsonb_agg(row_to_json(am)), '[]'::jsonb)
--     INTO v_alerts_master
--   FROM public.alerts_master am
--   WHERE am.tenant_id = v_tenant_id;
--
--   RAISE NOTICE 'alerts_master count: %', jsonb_array_length(v_alerts_master);


-- ============================================================
-- ADIM 3 — Manuel test (RPC'yi cagirip alerts_master kontrol)
-- ============================================================
-- Frontend gibi cagri:
SELECT (get_dashboard_with_alerts(CURRENT_DATE - 30, CURRENT_DATE))->'alerts_master'
        AS alerts_from_rpc;

-- Beklenen: en az 1 satirlik JSON array.
-- Bos array donerse Adim 1'e geri don, get_my_tenant_id() vs lookup karsilastir.
