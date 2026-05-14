-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Unit Conversion
-- Version: 019
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   Alış birimi (kg, lt, cl, paket ...) → base_unit (gr, ml, adet)
--   dönüşümü. WAC hesabı ve reçete normalizasyonu için kullanılır.
--
-- Kapsam:
--   - gr  ↔ gr     : 1
--   - kg  → gr     : ×1000
--   - ml  ↔ ml     : 1
--   - cl  → ml     : ×10
--   - lt  → ml     : ×1000
--   - adet ↔ adet  : 1
--   - paket → adet : DESTEKLENMİYOR bu sürümde (ham maddede package_size yok).
--     Kullanıcı paket alırsa alış UI'ı adet'e çevirmeli, ya da ileride
--     raw_materials.package_size eklenerek desteklenecek.
--
-- Strateji:
--   - İki yardımcı fonksiyon:
--       1) get_unit_base_type(unit TEXT)       → 'mass' | 'volume' | 'count' | NULL
--       2) convert_to_base_unit(qty, unit, base_unit)  → NUMERIC
--   - Uyumsuz birimler (ör: gr → ml) RAISE EXCEPTION.
--
-- Depends on: 017_raw_materials_base_unit.sql (kavramsal)
--
-- Safe: CREATE OR REPLACE, idempotent
-- ============================================================

-- ============================================================
-- 1) Birimin hangi gruba ait olduğunu döndürür
-- ============================================================
CREATE OR REPLACE FUNCTION get_unit_base_type(p_unit TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_unit IN ('gr', 'kg')       THEN 'mass'
        WHEN p_unit IN ('ml', 'cl', 'lt') THEN 'volume'
        WHEN p_unit IN ('adet', 'paket')  THEN 'count'
        ELSE NULL
    END;
$$;

-- ============================================================
-- 2) Bir miktarı alış biriminden base_unit'e çevirir
--    Örnek:
--      convert_to_base_unit(5, 'kg', 'gr')     → 5000
--      convert_to_base_unit(0.5, 'lt', 'ml')   → 500
--      convert_to_base_unit(7, 'cl', 'ml')     → 70
--      convert_to_base_unit(3, 'adet', 'adet') → 3
--      convert_to_base_unit(3, 'gr', 'ml')     → RAISE (uyumsuz)
--      convert_to_base_unit(3, 'paket', 'adet')→ RAISE (bu sürümde desteklenmiyor)
-- ============================================================
CREATE OR REPLACE FUNCTION convert_to_base_unit(
    p_quantity  NUMERIC,
    p_from_unit TEXT,
    p_base_unit TEXT
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_from_type TEXT;
    v_base_type TEXT;
BEGIN
    IF p_quantity IS NULL THEN
        RAISE EXCEPTION 'quantity NULL olamaz' USING ERRCODE = '22004';
    END IF;
    IF p_from_unit IS NULL OR p_base_unit IS NULL THEN
        RAISE EXCEPTION 'unit/base_unit NULL olamaz' USING ERRCODE = '22004';
    END IF;

    v_from_type := get_unit_base_type(p_from_unit);
    v_base_type := get_unit_base_type(p_base_unit);

    IF v_from_type IS NULL THEN
        RAISE EXCEPTION 'Bilinmeyen birim: %', p_from_unit USING ERRCODE = '22023';
    END IF;
    IF v_base_type IS NULL THEN
        RAISE EXCEPTION 'Bilinmeyen base_unit: %', p_base_unit USING ERRCODE = '22023';
    END IF;

    -- Birim grupları uyumsuzsa → hata (gr <-> ml çevrilemez).
    IF v_from_type <> v_base_type THEN
        RAISE EXCEPTION 'Uyumsuz birim: % (%) -> % (%)',
            p_from_unit, v_from_type, p_base_unit, v_base_type
            USING ERRCODE = '22023';
    END IF;

    -- MASS
    IF v_from_type = 'mass' THEN
        IF p_from_unit = 'gr' AND p_base_unit = 'gr' THEN
            RETURN p_quantity;
        ELSIF p_from_unit = 'kg' AND p_base_unit = 'gr' THEN
            RETURN p_quantity * 1000;
        END IF;
    END IF;

    -- VOLUME
    IF v_from_type = 'volume' THEN
        IF p_from_unit = 'ml' AND p_base_unit = 'ml' THEN
            RETURN p_quantity;
        ELSIF p_from_unit = 'cl' AND p_base_unit = 'ml' THEN
            RETURN p_quantity * 10;
        ELSIF p_from_unit = 'lt' AND p_base_unit = 'ml' THEN
            RETURN p_quantity * 1000;
        END IF;
    END IF;

    -- COUNT
    IF v_from_type = 'count' THEN
        IF p_from_unit = 'adet' AND p_base_unit = 'adet' THEN
            RETURN p_quantity;
        ELSIF p_from_unit = 'paket' AND p_base_unit = 'adet' THEN
            -- Paket → adet: package_size gerektirir. Bu sürümde desteklenmiyor.
            RAISE EXCEPTION 'paket -> adet dönüşümü bu sürümde desteklenmiyor (package_size gerekli)'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    RAISE EXCEPTION 'Desteklenmeyen dönüşüm: % -> %', p_from_unit, p_base_unit
        USING ERRCODE = '22023';
END;
$$;

-- ============================================================
-- GRANTS
-- ============================================================
GRANT EXECUTE ON FUNCTION get_unit_base_type(TEXT)                TO authenticated;
GRANT EXECUTE ON FUNCTION convert_to_base_unit(NUMERIC, TEXT, TEXT) TO authenticated;
