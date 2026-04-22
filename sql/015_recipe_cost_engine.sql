-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Recipe Cost Engine
-- Version: 015
-- Target: Supabase (PostgreSQL 15+)
-- Depends on: 001_initial_schema.sql (products),
--             013_raw_materials.sql,
--             014_product_recipes.sql
--
-- Scope:
--   1) calculate_product_cost(uuid)   — reçete üzerinden maliyet hesabı
--   2) sync_product_cost(uuid)        — products.cost'u yazar (reçetesiz → dokunmaz)
--   3) Trigger: product_recipes INSERT/UPDATE/DELETE → ilgili ürünü senkronize et
--   4) Trigger: raw_materials UPDATE (cost / is_deleted) → kullanan tüm ürünleri senkronize et
--
-- GÜVENLİK GARANTİLERİ:
--   - product_sales tablosuna ASLA yazmaz (snapshot korunur → geçmiş karlılık güvende)
--   - products.cost yalnızca reçetesi olan ürünler için güncellenir (manuel cost korunur)
--   - ham madde silinirse (soft-delete) → maliyet hesabından düşer
--   - CREATE OR REPLACE / DROP IF EXISTS → idempotent, güvenli re-run
-- ============================================================


-- ============================================================
-- 1) FUNCTION: calculate_product_cost
--    Tek ürünün reçete maliyetini döndürür.
--    Reçete satırı yoksa 0 döner (sync_product_cost bu durumda yazmaz).
--    Soft-delete edilmiş reçete satırları ve ham maddeler hariç tutulur.
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_product_cost(p_product_id UUID)
RETURNS NUMERIC
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT COALESCE(SUM(pr.quantity * rm.cost), 0)::NUMERIC
    FROM product_recipes pr
    JOIN raw_materials   rm ON rm.id = pr.raw_material_id
    WHERE pr.product_id = p_product_id
      AND pr.is_deleted = false
      AND rm.is_deleted = false;
$$;


-- ============================================================
-- 2) FUNCTION: sync_product_cost
--    products.cost alanını reçeteye göre günceller.
--    GUARD: Reçetesi olmayan ürünlere DOKUNMAZ (manuel cost korunur).
-- ============================================================
CREATE OR REPLACE FUNCTION sync_product_cost(p_product_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
DECLARE
    v_has_recipe BOOLEAN;
    v_new_cost   NUMERIC;
BEGIN
    IF p_product_id IS NULL THEN
        RETURN;
    END IF;

    -- Reçetesi var mı? (aktif satır)
    SELECT EXISTS (
        SELECT 1
        FROM product_recipes
        WHERE product_id = p_product_id
          AND is_deleted = false
    ) INTO v_has_recipe;

    -- Reçetesiz ürün → manuel cost korunur, çık.
    IF NOT v_has_recipe THEN
        RETURN;
    END IF;

    v_new_cost := calculate_product_cost(p_product_id);

    UPDATE products
    SET cost       = v_new_cost,
        updated_at = now()
    WHERE id = p_product_id
      AND COALESCE(cost, 0) IS DISTINCT FROM v_new_cost;
END;
$$;


-- ============================================================
-- 3) TRIGGER FUNCTION: product_recipes → sync
--    AFTER INSERT/UPDATE/DELETE her satır için ilgili ürünü senkronize et.
--    UPDATE'te product_id değişirse hem eski hem yeni ürün senkronize edilir.
-- ============================================================
CREATE OR REPLACE FUNCTION trg_fn_product_recipes_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM sync_product_cost(NEW.product_id);
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM sync_product_cost(NEW.product_id);
        IF NEW.product_id IS DISTINCT FROM OLD.product_id THEN
            PERFORM sync_product_cost(OLD.product_id);
        END IF;
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        PERFORM sync_product_cost(OLD.product_id);
        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$;


-- ============================================================
-- 4) TRIGGER FUNCTION: raw_materials → sync
--    Yalnızca cost veya is_deleted değişince tetiklenir (WHEN clause'da filtreli).
--    Bu ham maddeyi kullanan tüm aktif ürünleri senkronize eder.
-- ============================================================
CREATE OR REPLACE FUNCTION trg_fn_raw_materials_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT product_id
        FROM product_recipes
        WHERE raw_material_id = NEW.id
          AND is_deleted = false
    LOOP
        PERFORM sync_product_cost(r.product_id);
    END LOOP;

    RETURN NEW;
END;
$$;


-- ============================================================
-- 5) TRIGGERS (drop-if-exists + create)
-- ============================================================

-- 5a) product_recipes
DROP TRIGGER IF EXISTS trg_product_recipes_cost_sync ON product_recipes;

CREATE TRIGGER trg_product_recipes_cost_sync
AFTER INSERT OR UPDATE OR DELETE ON product_recipes
FOR EACH ROW
EXECUTE FUNCTION trg_fn_product_recipes_cost_sync();


-- 5b) raw_materials
--     WHEN clause: yalnızca cost veya is_deleted değiştiğinde çalıştır.
--     İsim / unit / is_active değişikliği gereksiz cascade başlatmasın.
DROP TRIGGER IF EXISTS trg_raw_materials_cost_sync ON raw_materials;

CREATE TRIGGER trg_raw_materials_cost_sync
AFTER UPDATE ON raw_materials
FOR EACH ROW
WHEN (
    OLD.cost       IS DISTINCT FROM NEW.cost
 OR OLD.is_deleted IS DISTINCT FROM NEW.is_deleted
)
EXECUTE FUNCTION trg_fn_raw_materials_cost_sync();


-- ============================================================
-- 6) PERMISSIONS
--    Function'lar SECURITY DEFINER — postgres (owner) yetkisiyle çalışır.
--    Authenticated kullanıcılar doğrudan çağırabilsin (opsiyonel, trigger'lar
--    zaten otomatik çağırır; manual recompute gerekirse diye).
-- ============================================================
GRANT EXECUTE ON FUNCTION calculate_product_cost(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION sync_product_cost(UUID)      TO authenticated;
