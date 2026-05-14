-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — purchase_items → raw_materials.cost
-- Version: 021
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   purchase_items tablosunda INSERT / UPDATE / DELETE olduğunda,
--   ilgili raw_material için WAC'ı yeniden hesaplayıp
--   raw_materials.cost alanına yazmak.
--
--   raw_materials.cost değişince → migration 015'teki
--   trg_raw_materials_cost_sync otomatik devreye girer →
--   bu ham maddeyi kullanan tüm ürünlerin products.cost'u yenilenir.
--
-- Ek davranış:
--   BEFORE INSERT/UPDATE üzerinde base_quantity ve base_unit_cost
--   alanlarını otomatik doldurur (convert_to_base_unit üzerinden).
--   Bu sayede WAC hesabı tekrar dönüşüm yapmak zorunda kalmaz.
--
-- Depends on:
--   - 017 (base_unit)
--   - 018 (purchase_items)
--   - 019 (convert_to_base_unit)
--   - 020 (sync_raw_material_cost)
--
-- Güvenlik garantileri:
--   - product_sales tablosuna ASLA dokunulmaz
--   - raw_materials.cost yalnızca aktif alışı olan maddeler için güncellenir
--   - Manuel cost girişi: alış yapılana kadar korunur
--   - Recursive loop yok: purchase_items → raw_materials → products (tek yön)
-- ============================================================


-- ============================================================
-- 1) BEFORE trigger: base_quantity / base_unit_cost auto-fill
-- ============================================================
CREATE OR REPLACE FUNCTION trg_fn_purchase_items_fill_base()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_base_unit TEXT;
    v_qty_base  NUMERIC;
BEGIN
    IF NEW.raw_material_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT base_unit INTO v_base_unit
    FROM raw_materials
    WHERE id = NEW.raw_material_id;

    -- base_unit yoksa normalize alanları temizle ve devam et
    IF v_base_unit IS NULL THEN
        NEW.base_quantity  := NULL;
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END IF;

    -- quantity / unit dolu olmalı
    IF NEW.quantity IS NULL OR NEW.quantity <= 0 OR NEW.unit IS NULL THEN
        RETURN NEW;
    END IF;

    BEGIN
        v_qty_base := convert_to_base_unit(NEW.quantity, NEW.unit, v_base_unit);
    EXCEPTION WHEN OTHERS THEN
        -- Uyumsuz birim → normalize alanları boşalt (WAC fallback devreye girer
        -- veya satırı atlar). RAISE etmiyoruz çünkü base_unit sonradan
        -- düzeltilebilir; user-facing validation RPC/UI katmanında yapılır.
        NEW.base_quantity  := NULL;
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END;

    NEW.base_quantity  := v_qty_base;

    IF v_qty_base IS NOT NULL AND v_qty_base > 0 AND NEW.line_total IS NOT NULL THEN
        NEW.base_unit_cost := NEW.line_total / v_qty_base;
    ELSE
        NEW.base_unit_cost := NULL;
    END IF;

    RETURN NEW;
END;
$$;


-- ============================================================
-- 2) AFTER trigger: sync_raw_material_cost
--    INSERT / UPDATE / DELETE — her satır için.
--    UPDATE'te raw_material_id değişirse hem eski hem yeni senkronize edilir.
-- ============================================================
CREATE OR REPLACE FUNCTION trg_fn_purchase_items_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM sync_raw_material_cost(NEW.raw_material_id);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM sync_raw_material_cost(NEW.raw_material_id);
        IF NEW.raw_material_id IS DISTINCT FROM OLD.raw_material_id THEN
            PERFORM sync_raw_material_cost(OLD.raw_material_id);
        END IF;
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        PERFORM sync_raw_material_cost(OLD.raw_material_id);
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$;


-- ============================================================
-- 3) TRIGGERS (drop-if-exists + create)
-- ============================================================

-- 3a) BEFORE INSERT / UPDATE → base_* alanlarını doldur
DROP TRIGGER IF EXISTS trg_purchase_items_fill_base ON purchase_items;

CREATE TRIGGER trg_purchase_items_fill_base
BEFORE INSERT OR UPDATE ON purchase_items
FOR EACH ROW
EXECUTE FUNCTION trg_fn_purchase_items_fill_base();


-- 3b) AFTER INSERT / UPDATE / DELETE → raw_materials.cost senkronize et
--     WHEN filtresi:
--       UPDATE için sadece maliyete etki edecek alanlar değiştiğinde çalış.
--       (quantity, unit, unit_cost, line_total, raw_material_id, is_deleted)
DROP TRIGGER IF EXISTS trg_purchase_items_cost_sync ON purchase_items;

CREATE TRIGGER trg_purchase_items_cost_sync
AFTER INSERT OR DELETE ON purchase_items
FOR EACH ROW
EXECUTE FUNCTION trg_fn_purchase_items_cost_sync();

-- UPDATE için ayrı WHEN clause'lu trigger
DROP TRIGGER IF EXISTS trg_purchase_items_cost_sync_upd ON purchase_items;

CREATE TRIGGER trg_purchase_items_cost_sync_upd
AFTER UPDATE ON purchase_items
FOR EACH ROW
WHEN (
       OLD.quantity        IS DISTINCT FROM NEW.quantity
    OR OLD.unit            IS DISTINCT FROM NEW.unit
    OR OLD.unit_cost       IS DISTINCT FROM NEW.unit_cost
    OR OLD.line_total      IS DISTINCT FROM NEW.line_total
    OR OLD.raw_material_id IS DISTINCT FROM NEW.raw_material_id
    OR OLD.is_deleted      IS DISTINCT FROM NEW.is_deleted
)
EXECUTE FUNCTION trg_fn_purchase_items_cost_sync();
