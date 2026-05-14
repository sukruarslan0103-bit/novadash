-- ============================================================
-- 039 — get_dashboard_with_alerts: alerts_master SELECT FIX
--
-- Sorun: alerts_master view'inda 'date' kolonu YOK (alerts hesaplama
--   anlik yapilir). RPC icindeki tarih filtresi her zaman 0 row donuyor.
--
-- Cozum: alerts_master SELECT'inden tarih filtresini kaldir, yalnizca
--   tenant_id ile filtrele. RLS zaten tenant scope'unu garanti eder.
-- ============================================================

-- ============================================================
-- 1) ONCE MEVCUT FONKSIYON BODY'SINI AL (referans icin)
-- ============================================================
-- SELECT pg_get_functiondef(oid)
-- FROM pg_proc
-- WHERE proname = 'get_dashboard_with_alerts'
--   AND pronamespace = 'public'::regnamespace;
--
-- Mevcut RPC'nin TAMAMINI buraya kopyalamadik cunku body'sini
-- gormedik. Asagida YALNIZCA alerts_master kismini hedefli sekilde
-- nasil yazilmasi gerektigini gosteriyoruz.
-- ============================================================


-- ============================================================
-- 2) RPC ICINDE OLMASI GEREKEN DOGRU BLOK
-- ============================================================
--
--   DECLARE
--       v_alerts_master JSONB;
--       v_tenant_id     UUID;
--       ...
--   BEGIN
--       v_tenant_id := get_my_tenant_id();
--       ...
--
--       -- DOGRU SELECT — sadece tenant filter, tarih YOK
--       SELECT COALESCE(jsonb_agg(row_to_json(am)), '[]'::jsonb)
--         INTO v_alerts_master
--       FROM public.alerts_master am
--       WHERE am.tenant_id = v_tenant_id;
--
--       ...
--
--       RETURN jsonb_build_object(
--           'monthly_revenue',  v_monthly_revenue,
--           ...
--           'alerts_master',    v_alerts_master
--       );
--   END;
--
-- ============================================================


-- ============================================================
-- 3) HIZLI MANUEL TEST — RPC'yi calistirmadan view dogru mu
-- ============================================================

-- A) View tek basina (postgres olarak):
SELECT * FROM public.alerts_master LIMIT 5;

-- B) Senin tenant icin:
SELECT *
FROM public.alerts_master
WHERE tenant_id = (SELECT id FROM public.users WHERE id = auth.uid());

-- C) jsonb formatinda — RPC ne donmesi gerekiyorsa:
SELECT COALESCE(jsonb_agg(row_to_json(am)), '[]'::jsonb) AS alerts_master_json
FROM public.alerts_master am
WHERE am.tenant_id = (SELECT id FROM public.users WHERE id = auth.uid());

-- A, B, C uctunde de satir donerse → view OK, RPC body bug.
-- Hicbiri donmezse → view tarafinda problem (RLS / data).


-- ============================================================
-- 4) RPC DUZELTMESI ICIN GEREKEN ADIMLAR
-- ============================================================
-- 1. Sorgu (1) ile mevcut RPC body'sini al
-- 2. v_alerts_master ile ilgili SELECT'i bul
-- 3. WHERE clause'undan tarih filtrelerini KALDIR:
--      ❌ AND am.date BETWEEN p_start AND p_end
--      ❌ AND am.created_at >= p_start
--    Sadece bunu birak:
--      ✅ WHERE am.tenant_id = v_tenant_id
-- 4. RPC'yi CREATE OR REPLACE FUNCTION ile yeniden tanimla
-- 5. Test:
--      SELECT (get_dashboard_with_alerts('2025-01-01','2025-12-31'))->'alerts_master';
-- ============================================================
