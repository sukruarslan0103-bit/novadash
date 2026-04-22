-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Raw Material Weighted Avg Cost
-- Version: 020
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   Bir ham maddenin AĞIRLIKLI ORTALAMA maliyetini (WAC)
--   base_unit başına ₺ olarak döndürür.
--
-- Formül:
--   WAC = SUM(base_quantity_i * base_unit_cost_i) / SUM(base_quantity_i)
--       = SUM(line_total_i) / SUM(base_quantity_i)
--
--   (Aynı şeydir; line_total_i = base_quantity_i * base_unit_cost_i)
--
-- Kapsam:
--   - Sadece aktif (is_deleted = false) purchase_items satırları dahil
--   - Stok takibi yok → gerçek WAC-2 değil; tüm geçmiş alışlar ağırlıklı
--   - Hiç alış yoksa 0 döner (sync fonksiyonu bu durumda raw_materials.cost'a
--     dokunmaz → manuel cost korunur).
--
-- Depends on:
--   - 017 (base_unit)
--   - 018 (purchase_items)
--   - 019 (convert_to_base_unit) — fallback için
--
-- Safe: CREATE OR REPLACE, idempotent
-- ============================================================

-- ============================================================
-- 1) calculate_raw_material_wac(raw_material_id)
--    Ağırlıklı ortalama base_unit başına ₺
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_raw_material_wac(p_raw_material_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_base_unit    TEXT;
    v_total_cost   NUMERIC := 0;
    v_total_qty    NUMERIC := 0;
    r              RECORD;
    v_qty_in_base  NUMERIC;
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN 0;
    END IF;

    -- Ham maddenin base_unit'ini al
    SELECT base_unit INTO v_base_unit
    FROM raw_materials
    WHERE id = p_raw_material_id
      AND is_deleted = false;

    IF v_base_unit IS NULL THEN
        -- base_unit yoksa WAC hesabı güvenli değil → 0 dön (sync dokunmayacak)
        RETURN 0;
    END IF;

    -- Aktif purchase_items üzerinde döngü
    FOR r IN
        SELECT quantity, unit, unit_cost, line_total, base_quantity
        FROM purchase_items
        WHERE raw_material_id = p_raw_material_id
          AND is_deleted = false
    LOOP
        -- base_quantity pre-computed ise onu kullan; yoksa dönüşüm yap (fallback)
        IF r.base_quantity IS NOT NULL AND r.base_quantity > 0 THEN
            v_qty_in_base := r.base_quantity;
        ELSE
            BEGIN
                v_qty_in_base := convert_to_base_unit(r.quantity, r.unit, v_base_unit);
            EXCEPTION WHEN OTHERS THEN
                -- Uyumsuz birim varsa bu satırı atla (raporda hata olarak işaretlemek
                -- gerekirse üst katman sistem_logs'a yazabilir).
                CONTINUE;
            END;
        END IF;

        IF v_qty_in_base IS NULL OR v_qty_in_base <= 0 THEN
            CONTINUE;
        END IF;

        v_total_cost := v_total_cost + COALESCE(r.line_total, 0);
        v_total_qty  := v_total_qty  + v_qty_in_base;
    END LOOP;

    IF v_total_qty <= 0 THEN
        RETURN 0;
    END IF;

    RETURN (v_total_cost / v_total_qty)::NUMERIC;
END;
$$;


-- ============================================================
-- 2) sync_raw_material_cost(raw_material_id)
--    WAC'ı hesaplar ve raw_materials.cost'u günceller.
--
--    GUARD:
--      - Hiç aktif purchase_items yoksa DOKUNMAZ (manuel cost korunur).
--      - Cost zaten aynıysa UPDATE atmaz (015 cascade'ini boşa tetiklemez).
-- ============================================================
CREATE OR REPLACE FUNCTION sync_raw_material_cost(p_raw_material_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
    v_has_purchase BOOLEAN;
    v_new_cost     NUMERIC;
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN;
    END IF;

    -- Bu ham madde için aktif alış satırı var mı?
    SELECT EXISTS (
        SELECT 1
        FROM purchase_items
        WHERE raw_material_id = p_raw_material_id
          AND is_deleted = false
    ) INTO v_has_purchase;

    -- Alış yoksa manuel cost'a dokunma.
    IF NOT v_has_purchase THEN
        RETURN;
    END IF;

    v_new_cost := calculate_raw_material_wac(p_raw_material_id);

    -- Hesap sıfır döndüyse (tüm satırlar uyumsuz birim vb.) dokunma.
    IF v_new_cost IS NULL OR v_new_cost <= 0 THEN
        RETURN;
    END IF;

    UPDATE raw_materials
    SET cost       = v_new_cost,
        updated_at = now()
    WHERE id = p_raw_material_id
      AND COALESCE(cost, 0) IS DISTINCT FROM v_new_cost;
    -- Not: Bu UPDATE cost değişirse 015 trigger'ını tetikleyecek →
    --      bu ham maddeyi kullanan tüm ürünlerin products.cost'u yenilenir.
END;
$$;


-- ============================================================
-- GRANTS
-- ============================================================
GRANT EXECUTE ON FUNCTION calculate_raw_material_wac(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION sync_raw_material_cost(UUID)     TO authenticated;
