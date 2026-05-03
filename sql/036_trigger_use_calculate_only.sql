-- ============================================================
-- 036 — TRIGGER MALIYET HESABI: TEK KAYNAK
--
-- Sorun: Trigger fonksiyonu sync_raw_material_cost cagiriyordu;
--   sync_raw_material_cost icinde GUARD'lar (has_purchase, NULL,
--   <= 0) maliyeti yazmayi engelliyordu. Sonuc: yeni mantik
--   (calculate_raw_material_wac = son alis fiyati) etki etmiyor,
--   raw_materials.cost guncellenmeden kaliyordu.
--
-- Cozum: Trigger fonksiyonu artik DOGRUDAN
--   UPDATE raw_materials SET cost = calculate_raw_material_wac(id)
--   yapacak. Ekstra hesap, ekstra guard YOK.
--
-- Tenant guvenligi: raw_materials.id PRIMARY KEY -> tek satir.
--   Defansif amacli AND tenant_id = raw_materials.tenant_id
--   eslestirmesine gerek yok (id zaten esiz). raw_material_id
--   purchase_items uzerinden zaten tenant-scoped.
-- ============================================================


-- ============================================================
-- 1) TRIGGER FUNCTION — sadece UPDATE
-- ============================================================
CREATE OR REPLACE FUNCTION trg_fn_purchase_items_cost_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rm_id  UUID;
    v_old_id UUID;
BEGIN
    -- Hangi raw_material(ler) etkilendi?
    IF TG_OP = 'INSERT' THEN
        v_rm_id  := NEW.raw_material_id;
        v_old_id := NULL;
    ELSIF TG_OP = 'UPDATE' THEN
        v_rm_id  := NEW.raw_material_id;
        v_old_id := OLD.raw_material_id;
    ELSIF TG_OP = 'DELETE' THEN
        v_rm_id  := OLD.raw_material_id;
        v_old_id := NULL;
    END IF;

    -- 1) Aktif/yeni raw_material'i senkronize et (TEK SATIR UPDATE)
    IF v_rm_id IS NOT NULL THEN
        UPDATE raw_materials
        SET cost       = calculate_raw_material_wac(v_rm_id),
            updated_at = now()
        WHERE id = v_rm_id;
    END IF;

    -- 2) UPDATE'te raw_material_id degistiyse eski raw_material'i da senkronize et
    IF TG_OP = 'UPDATE'
       AND v_old_id IS NOT NULL
       AND v_old_id IS DISTINCT FROM v_rm_id THEN
        UPDATE raw_materials
        SET cost       = calculate_raw_material_wac(v_old_id),
            updated_at = now()
        WHERE id = v_old_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;


-- ============================================================
-- 2) sync_raw_material_cost — ayni mantiga indirgendi
--    (Eski guard'lar silindi. Hala 015 trigger'i veya elle cagri
--     yapan yer olabilir; davranis tutarli olsun diye yeniden yazildi.)
-- ============================================================
CREATE OR REPLACE FUNCTION sync_raw_material_cost(p_raw_material_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE raw_materials
    SET cost       = calculate_raw_material_wac(p_raw_material_id),
        updated_at = now()
    WHERE id = p_raw_material_id;
END;
$$;

GRANT EXECUTE ON FUNCTION sync_raw_material_cost(UUID) TO authenticated;


-- ============================================================
-- 3) TRIGGER'lari yeniden bind et (idempotent)
-- ============================================================
DROP TRIGGER IF EXISTS trg_purchase_items_cost_sync     ON purchase_items;
DROP TRIGGER IF EXISTS trg_purchase_items_cost_sync_upd ON purchase_items;

CREATE TRIGGER trg_purchase_items_cost_sync
AFTER INSERT OR DELETE ON purchase_items
FOR EACH ROW
EXECUTE FUNCTION trg_fn_purchase_items_cost_sync();

CREATE TRIGGER trg_purchase_items_cost_sync_upd
AFTER UPDATE ON purchase_items
FOR EACH ROW
WHEN (
       OLD.quantity        IS DISTINCT FROM NEW.quantity
    OR OLD.unit            IS DISTINCT FROM NEW.unit
    OR OLD.unit_cost       IS DISTINCT FROM NEW.unit_cost
    OR OLD.line_total      IS DISTINCT FROM NEW.line_total
    OR OLD.base_unit_cost  IS DISTINCT FROM NEW.base_unit_cost
    OR OLD.base_quantity   IS DISTINCT FROM NEW.base_quantity
    OR OLD.raw_material_id IS DISTINCT FROM NEW.raw_material_id
    OR OLD.is_deleted      IS DISTINCT FROM NEW.is_deleted
    OR OLD.created_at      IS DISTINCT FROM NEW.created_at
)
EXECUTE FUNCTION trg_fn_purchase_items_cost_sync();


-- ============================================================
-- 4) MEVCUT raw_materials.cost'lari yenile
--    (Eski WAC degerleri varsa son alis fiyatina cek.)
-- ============================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT raw_material_id
        FROM purchase_items
        WHERE is_deleted = false
          AND raw_material_id IS NOT NULL
    LOOP
        UPDATE raw_materials
        SET cost       = calculate_raw_material_wac(r.raw_material_id),
            updated_at = now()
        WHERE id = r.raw_material_id;
    END LOOP;

    RAISE NOTICE 'OK: trigger fonksiyonu sadelestirildi + tum raw_materials.cost yenilendi.';
END $$;


-- ============================================================
-- TEST
-- ============================================================
-- 1) Yeni alis gir (purchase_items insert).
-- 2) raw_materials.cost o satirin base_unit_cost'una esit olmali.
-- 3) ESKI bir alis kaydini SIL (is_deleted = true UPDATE).
-- 4) raw_materials.cost bir onceki en yeni satirin base_unit_cost'una
--    duser. Hic alis kalmazsa 0 yazar (calculate_raw_material_wac
--    NULL/0 doner -> UPDATE 0 olarak yazar).
-- ============================================================
