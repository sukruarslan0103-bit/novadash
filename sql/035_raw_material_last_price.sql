-- ============================================================
-- 035 — RAW_MATERIAL COST: WAC -> SON ALIS FIYATI
--
-- Amac: raw_materials.cost artik WAC degil, EN SON purchase_items
--       kaydinin base_unit_cost degeri olacak.
--
-- Kural:
--   raw_materials.cost =
--       (SELECT base_unit_cost
--        FROM purchase_items
--        WHERE raw_material_id = p_raw_material_id
--          AND is_deleted = false
--          AND base_unit_cost IS NOT NULL
--        ORDER BY created_at DESC
--        LIMIT 1)
--
-- Notlar:
--   - Tenant: purchase_items.raw_material_id zaten tenant-scoped
--     (RLS + raw_materials FK -> tenant_id). Ekstra filtreye gerek yok,
--     ama defansif amacli raw_materials.tenant_id ile join'leniyor.
--   - Hic alis yoksa -> 0 doner. sync_raw_material_cost guard'i
--     manuel cost'a DOKUNMAZ (mevcut davranis korundu).
--   - base_unit_cost NULL olan satirlar IGNORE edilir (kullanici talebi).
--   - Fonksiyon adi `calculate_raw_material_wac` korundu — trigger
--     ve cagiranlar bozulmasin diye. Davranis degisti, isim ayni.
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_raw_material_wac(p_raw_material_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_last_cost NUMERIC;
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN 0;
    END IF;

    -- Defansif tenant resolve — raw_material gercekten var mi + hangi tenant?
    SELECT tenant_id
    INTO v_tenant_id
    FROM raw_materials
    WHERE id = p_raw_material_id
      AND is_deleted = false;

    IF v_tenant_id IS NULL THEN
        RETURN 0;
    END IF;

    -- En son aktif purchase_items satirinin base_unit_cost'unu al.
    -- Tenant scope: raw_material zaten o tenant'a ait; pi.raw_material_id ile
    -- otomatik kisitlanmis oluyor. Tenant_id eslesmesi defansif amacla eklendi.
    SELECT pi.base_unit_cost
    INTO v_last_cost
    FROM purchase_items pi
    WHERE pi.raw_material_id = p_raw_material_id
      AND pi.tenant_id = v_tenant_id
      AND pi.is_deleted = false
      AND pi.base_unit_cost IS NOT NULL
      AND pi.base_unit_cost > 0
    ORDER BY pi.created_at DESC
    LIMIT 1;

    IF v_last_cost IS NULL OR v_last_cost <= 0 THEN
        RETURN 0;
    END IF;

    RETURN v_last_cost::NUMERIC;
END;
$$;

GRANT EXECUTE ON FUNCTION calculate_raw_material_wac(UUID) TO authenticated;


-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_src TEXT;
BEGIN
    SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc
    WHERE proname = 'calculate_raw_material_wac'
      AND pronamespace = 'public'::regnamespace;

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'KRITIK: calculate_raw_material_wac fonksiyonu bulunamadi!';
    END IF;

    IF v_src NOT ILIKE '%ORDER BY pi.created_at DESC%' THEN
        RAISE EXCEPTION 'KRITIK: Fonksiyon guncellenmedi (ORDER BY DESC yok).';
    END IF;

    RAISE NOTICE 'OK: calculate_raw_material_wac artik SON ALIS FIYATI mantigi kullaniyor.';
END $$;


-- ============================================================
-- TUM MEVCUT raw_materials.cost'lari yeni mantikla yenile
-- (purchase_items'i olan her ham madde icin sync_raw_material_cost cagrilir)
-- ============================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT raw_material_id
        FROM purchase_items
        WHERE is_deleted = false
          AND base_unit_cost IS NOT NULL
          AND raw_material_id IS NOT NULL
    LOOP
        PERFORM sync_raw_material_cost(r.raw_material_id);
    END LOOP;

    RAISE NOTICE 'OK: tum raw_materials.cost degerleri son alis fiyatina cekildi.';
END $$;


-- ============================================================
-- TEST
-- ============================================================
-- 1) Bir hammadde icin son alis fiyati:
--    SELECT calculate_raw_material_wac('<raw_material_uuid>');
--
-- 2) Hammadde guncel cost:
--    SELECT name, cost FROM raw_materials WHERE id = '<uuid>';
--
-- 3) Yeni alis girince (purchase_items insert):
--    -> 021 trigger sync_raw_material_cost cagirir
--    -> sync calculate_raw_material_wac cagirir
--    -> son satirin base_unit_cost'unu doner
--    -> raw_materials.cost guncel kalir.
-- ============================================================
