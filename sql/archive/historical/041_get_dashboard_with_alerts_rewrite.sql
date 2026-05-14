-- ============================================================
-- 041 — get_dashboard_with_alerts FULL REWRITE (debug mode)
--
-- Filtresiz alerts_master cek -> DB'de gercekten veri var mi
-- frontend'e ulasiyor mu net gorulecek. Tenant filter SONRA
-- geri eklenir.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_with_alerts(
    p_start date,
    p_end   date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_analytics jsonb;
    v_alerts    jsonb;
    v_user_id   uuid;
    v_tenant_id uuid;
BEGIN
    -- USER
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'AUTH USER NULL';
    END IF;

    -- TENANT (KESIN)
    SELECT tenant_id INTO v_tenant_id
    FROM public.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'TENANT NOT FOUND';
    END IF;

    -- ANALYTICS
    v_analytics := public.get_dashboard_analytics(p_start, p_end);

    -- DEBUG MODE: alerts_master FILTRESIZ
    SELECT COALESCE(jsonb_agg(row_to_json(am)), '[]'::jsonb)
    INTO v_alerts
    FROM public.alerts_master am;

    RAISE NOTICE 'alerts_count=%', jsonb_array_length(v_alerts);

    RETURN COALESCE(v_analytics, '{}'::jsonb)
        || jsonb_build_object(
            'alerts_master', v_alerts
        );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_with_alerts(date, date) TO authenticated;


-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT count(*) INTO v_count
    FROM pg_proc
    WHERE proname = 'get_dashboard_with_alerts'
      AND pronamespace = 'public'::regnamespace;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'KRITIK: RPC olusturulamadi';
    END IF;

    RAISE NOTICE 'OK: get_dashboard_with_alerts (debug mode) aktif';
END $$;
