-- ============================================================
-- 064 — COST HELPER LOCKDOWN (internal-only functions)
--
-- Amac:
--   Internal cost-chain helper fonksiyonlari su an anon/authenticated
--   rollerine EXECUTE acik. Bunlar frontend tarafindan HIC cagrilmiyor
--   (services/ + views/ + utils/ taramasi = 0 hit); yalnizca SECURITY
--   DEFINER trigger/fonksiyon zinciri ve admin maintenance scriptleri
--   kullaniyor. Dogrudan PostgREST cagrisi su DUSUK-severity yuzeyleri
--   aciyordu:
--     - calculate_*  : baska tenant'in tek bir turev maliyet sayisini
--                      okuma (UUID bilmeyi gerektirir)
--     - sync_*       : baska tenant'in cost satirini (kendi deterministik
--                      degerine) yeniden hesaplatma write-surface'i
--
-- Cozum:
--   Sadece bu 4 fonksiyondan anon + authenticated EXECUTE'unu kaldir.
--
-- NEDEN GUVENLI (zincir bozulmaz):
--   Caller'larin hepsi SECURITY DEFINER, owner = postgres:
--     - trg_fn_purchase_items_cost_sync
--     - trg_fn_product_recipes_cost_sync
--     - trg_fn_raw_materials_cost_sync
--     - sync_product_cost / sync_raw_material_cost
--   SECURITY DEFINER fonksiyon icinden cagrilan ic fonksiyonun EXECUTE
--   yetkisi CAGIRAN son kullaniciya (authenticated) DEGIL, etkin
--   kullaniciya (postgres) karsi kontrol edilir. postgres owner EXECUTE'u
--   korur → trigger zinciri ve cost sync calismaya DEVAM EDER.
--
-- KAPSAM DISI (DOKUNULMUYOR):
--   - Fonksiyon govdeleri
--   - Trigger tanimlari
--   - RPC'ler
--   - RLS policy'leri
--   - Diger grant/hardening
--
-- Idempotent:
--   REVOKE, sahip olunmayan privilege icin no-op (hata vermez) → re-run safe.
--
-- Rollback (gerekirse, <5sn, veri etkisi sifir):
--   GRANT EXECUTE ON FUNCTION public.calculate_product_cost(UUID)     TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.calculate_raw_material_wac(UUID) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.sync_product_cost(UUID)          TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.sync_raw_material_cost(UUID)     TO authenticated;
-- ============================================================


-- ============================================================
-- PRE-FLIGHT (salt-okuma — davranis degistirmez)
--   Caller zincirinin SECURITY DEFINER oldugunu dogrula. Degilse revoke
--   zinciri kirabilir → uyari ver (ama yine de devam etme, abort et).
-- ============================================================
DO $pre$
DECLARE
    v_bad TEXT;
BEGIN
    SELECT string_agg(p.proname, ', ')
      INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
           'trg_fn_purchase_items_cost_sync',
           'trg_fn_product_recipes_cost_sync',
           'trg_fn_raw_materials_cost_sync',
           'sync_product_cost',
           'sync_raw_material_cost'
       )
       AND p.prosecdef = false;   -- SECURITY INVOKER ise tehlikeli

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION '[064] ABORT: su caller(lar) SECURITY DEFINER degil → revoke zinciri kirabilir: %', v_bad;
    END IF;

    RAISE NOTICE '[064] PRE-FLIGHT OK: caller zinciri SECURITY DEFINER.';
END;
$pre$;


-- ============================================================
-- REVOKE — internal cost helper'lari dis rollere kapat
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.calculate_product_cost(UUID)     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_raw_material_wac(UUID) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_product_cost(UUID)          FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_raw_material_cost(UUID)     FROM anon, authenticated;


-- ============================================================
-- POST-VERIFY (salt-okuma)
--   anon/authenticated artik EXECUTE'a sahip OLMAMALI.
-- ============================================================
DO $post$
DECLARE
    v_leak TEXT := '';
    fn TEXT;
    fns TEXT[] := ARRAY[
        'public.calculate_product_cost(uuid)',
        'public.calculate_raw_material_wac(uuid)',
        'public.sync_product_cost(uuid)',
        'public.sync_raw_material_cost(uuid)'
    ];
BEGIN
    FOREACH fn IN ARRAY fns LOOP
        IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
            v_leak := v_leak || ' authenticated→' || fn;
        END IF;
        IF has_function_privilege('anon', fn, 'EXECUTE') THEN
            v_leak := v_leak || ' anon→' || fn;
        END IF;
    END LOOP;

    IF v_leak <> '' THEN
        RAISE EXCEPTION '[064] FAIL: EXECUTE hala acik:%', v_leak;
    END IF;

    RAISE NOTICE '[064] OK: calculate_*/sync_* dis rollere kapatildi (anon + authenticated EXECUTE yok).';
END;
$post$;
