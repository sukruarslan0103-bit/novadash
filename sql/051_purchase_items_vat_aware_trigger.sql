-- ============================================================
-- 051 — purchase_items VAT + DISCOUNT-AWARE TRIGGER
--
-- Amac:
--   trg_fn_purchase_items_fill_base trigger'i artik
--   base_unit_cost'u KDV DAHIL (ve iskonto sonrasi) hesaplayacak.
--   docs/FINANCE.md v1.0 kural 12 ile birebir.
--
-- Hesap formulu (canonical):
--   v_net      := COALESCE(line_total,
--                          quantity * unit_cost * (1 - discount_rate/100))
--                 ← line_total zaten iskonto sonrasi (kural 11);
--                   fallback'ta manuel uygulanir
--   v_with_vat := v_net * (1 + vat_rate/100)
--   base_unit_cost := v_with_vat / base_quantity
--
-- KAPSAM DISI:
--   - Gecmis purchase_items satirlarinin base_unit_cost UPDATE'i (052'de).
--   - raw_materials.cost / products.cost recalculation (052'de cascade).
--   - product_sales.cost (IMMUTABLE, FAZ 1.1).
--
-- Davranis:
--   - Yeni INSERT/UPDATE: trigger yeni formul ile yazar.
--   - Gecmis kayitlar dokunulmaz (no UPDATE; trigger BEFORE).
--   - Trigger zinciri korunur:
--       purchase_items INSERT/UPDATE
--         → trg_purchase_items_fill_base (BEFORE — bu fonksiyon)
--         → trg_purchase_items_cost_sync (AFTER)
--         → raw_materials.cost guncellenir
--         → trg_raw_materials_cost_sync (AFTER UPDATE)
--         → sync_product_cost
--         → products.cost guncellenir
--
-- Idempotent:
--   CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE TRIGGER
--
-- Rollback:
--   Baseline'in 051 oncesi F.4 body'sini (line_total / base_quantity)
--   tek CREATE OR REPLACE ile yeniden RUN.
-- ============================================================


-- ============================================================
-- PRE-VALIDATION
-- ============================================================
DO $pre$
DECLARE
    v_fn_present     BOOLEAN;
    v_trg_present    BOOLEAN;
    v_table_present  BOOLEAN;
BEGIN
    -- trg_fn_purchase_items_fill_base var mi?
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'trg_fn_purchase_items_fill_base'
    ) INTO v_fn_present;

    IF NOT v_fn_present THEN
        RAISE EXCEPTION
            'PRE-VALIDATION FAIL: trg_fn_purchase_items_fill_base function YOK. '
            '021/051 baseline tarafindan kurulmus olmali.';
    END IF;

    -- trg_purchase_items_fill_base trigger var mi?
    SELECT EXISTS (
        SELECT 1 FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'purchase_items'
          AND t.tgname  = 'trg_purchase_items_fill_base'
          AND NOT t.tgisinternal
    ) INTO v_trg_present;

    IF NOT v_trg_present THEN
        RAISE EXCEPTION
            'PRE-VALIDATION FAIL: trg_purchase_items_fill_base trigger YOK.';
    END IF;

    -- purchase_items tablosunda discount_rate kolonu var mi? (034 fold)
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'purchase_items'
          AND column_name  = 'discount_rate'
    ) INTO v_table_present;

    IF NOT v_table_present THEN
        RAISE EXCEPTION
            'PRE-VALIDATION FAIL: purchase_items.discount_rate kolonu YOK. '
            '034 baseline fold tarafindan kurulmus olmali.';
    END IF;

    RAISE NOTICE 'PRE-VALIDATION OK: function + trigger + discount_rate column present';
END $pre$;


-- ============================================================
-- TRIGGER BODY REPLACE — VAT + discount aware
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_fn_purchase_items_fill_base()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_base_unit  TEXT;
    v_qty_base   NUMERIC;
    v_net        NUMERIC;     -- KDV HARIC, iskonto SONRASI
    v_with_vat   NUMERIC;     -- KDV DAHIL, iskonto sonrasi
    v_discount   NUMERIC;
    v_vat        NUMERIC;
BEGIN
    -- Guard 1: raw_material_id zorunlu
    IF NEW.raw_material_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Guard 2: hammaddenin base_unit'i tanimli olmali
    SELECT base_unit INTO v_base_unit
      FROM raw_materials
     WHERE id = NEW.raw_material_id;

    IF v_base_unit IS NULL THEN
        NEW.base_quantity  := NULL;
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END IF;

    -- Guard 3: quantity + unit zorunlu
    IF NEW.quantity IS NULL OR NEW.quantity <= 0 OR NEW.unit IS NULL THEN
        RETURN NEW;
    END IF;

    -- Unit conversion: kullanici birimi -> base_unit
    BEGIN
        v_qty_base := convert_to_base_unit(NEW.quantity, NEW.unit, v_base_unit);
    EXCEPTION WHEN OTHERS THEN
        NEW.base_quantity  := NULL;
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END;

    NEW.base_quantity := v_qty_base;

    -- 051 CANONICAL HESAP — docs/FINANCE.md kural 11 + 12 ile birebir.
    --
    -- v_net (KDV HARIC, iskonto SONRASI):
    --   line_total varsa kullan (kural 11: zaten iskonto sonrasi).
    --   yoksa quantity * unit_cost * (1 - discount/100) fallback.
    --
    -- v_with_vat (KDV DAHIL, iskonto sonrasi):
    --   v_net * (1 + vat/100)
    --
    -- base_unit_cost (KDV DAHIL base_unit basina maliyet — kural 12):
    --   v_with_vat / base_quantity
    v_discount := COALESCE(NEW.discount_rate, 0);
    v_vat      := COALESCE(NEW.vat_rate,      0);

    IF NEW.line_total IS NOT NULL AND NEW.line_total >= 0 THEN
        v_net := NEW.line_total;
    ELSIF NEW.unit_cost IS NOT NULL AND NEW.unit_cost >= 0 THEN
        v_net := NEW.quantity * NEW.unit_cost * (1 - v_discount / 100);
    ELSE
        NEW.base_unit_cost := NULL;
        RETURN NEW;
    END IF;

    v_with_vat := v_net * (1 + v_vat / 100);

    IF v_qty_base IS NOT NULL AND v_qty_base > 0 THEN
        NEW.base_unit_cost := v_with_vat / v_qty_base;
    ELSE
        NEW.base_unit_cost := NULL;
    END IF;

    RETURN NEW;
END;
$$;


-- Trigger zaten F.4'te kurulu; idempotent re-bind:
DROP TRIGGER IF EXISTS trg_purchase_items_fill_base ON public.purchase_items;
CREATE TRIGGER trg_purchase_items_fill_base
BEFORE INSERT OR UPDATE ON public.purchase_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_purchase_items_fill_base();


-- 051: trigger semantic'i fonksiyon yorumuna da yapistir.
COMMENT ON FUNCTION public.trg_fn_purchase_items_fill_base() IS
    'BEFORE INSERT/UPDATE on purchase_items. '
    'Yazar: base_quantity (unit conversion) + base_unit_cost (KDV DAHIL, iskonto sonrasi). '
    'Formul: v_net = COALESCE(line_total, quantity*unit_cost*(1-discount/100)); '
    'base_unit_cost = v_net * (1+vat/100) / base_quantity. '
    'Canonical finance: docs/FINANCE.md kural 11+12 (FAZ 1.4 / 051).';


-- ============================================================
-- POST-VALIDATION
-- ============================================================
DO $val$
DECLARE
    v_secdef       BOOLEAN;
    v_config       TEXT;
    v_trg_present  BOOLEAN;
    v_trg_timing   TEXT;
    v_trg_events   TEXT;
    v_func_comment TEXT;
BEGIN
    RAISE NOTICE 'POST-VALIDATION: starting...';

    -- 1) Function SECURITY DEFINER + search_path
    SELECT p.prosecdef,
           (SELECT string_agg(cfg, ', ') FROM unnest(coalesce(p.proconfig,'{}')) AS cfg)
      INTO v_secdef, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'trg_fn_purchase_items_fill_base';

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'KRITIK: trg_fn_purchase_items_fill_base SECURITY DEFINER degil';
    END IF;
    IF v_config IS NULL OR v_config NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION 'KRITIK: trg_fn_purchase_items_fill_base search_path SET edilmemis';
    END IF;

    -- 2) Trigger bind durumu
    SELECT TRUE,
           CASE t.tgtype & 66
             WHEN 2  THEN 'BEFORE'
             WHEN 64 THEN 'INSTEAD'
             ELSE 'AFTER'
           END,
           (CASE WHEN (t.tgtype & 4) <> 0 THEN 'I' ELSE '' END) ||
           (CASE WHEN (t.tgtype & 16)<> 0 THEN 'U' ELSE '' END) ||
           (CASE WHEN (t.tgtype & 8) <> 0 THEN 'D' ELSE '' END)
      INTO v_trg_present, v_trg_timing, v_trg_events
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'purchase_items'
       AND t.tgname  = 'trg_purchase_items_fill_base'
       AND NOT t.tgisinternal
     LIMIT 1;

    IF NOT v_trg_present THEN
        RAISE EXCEPTION 'KRITIK: trg_purchase_items_fill_base trigger bind edilmedi';
    END IF;
    IF v_trg_timing <> 'BEFORE' THEN
        RAISE EXCEPTION 'KRITIK: trg_purchase_items_fill_base timing=BEFORE olmali, % bulundu', v_trg_timing;
    END IF;
    IF v_trg_events NOT LIKE '%I%' OR v_trg_events NOT LIKE '%U%' THEN
        RAISE EXCEPTION 'KRITIK: trg_purchase_items_fill_base INSERT+UPDATE olmali, % bulundu', v_trg_events;
    END IF;

    -- 3) COMMENT ON FUNCTION mevcut mu?
    SELECT d.description INTO v_func_comment
      FROM pg_description d
      JOIN pg_proc      p ON p.oid = d.objoid
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'trg_fn_purchase_items_fill_base'
       AND d.objsubid = 0
     LIMIT 1;

    IF v_func_comment IS NULL OR v_func_comment NOT LIKE '%kural 11+12%' THEN
        RAISE EXCEPTION 'KRITIK: trg_fn_purchase_items_fill_base COMMENT eksik veya yanlis';
    END IF;

    -- 4) Trigger zincirinin diger halkalari hala duruyor mu? (drift detection)
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'trg_fn_purchase_items_cost_sync'
    ) THEN
        RAISE EXCEPTION 'KRITIK: trg_fn_purchase_items_cost_sync YOK (zincir kirik)';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'sync_product_cost'
    ) THEN
        RAISE EXCEPTION 'KRITIK: sync_product_cost YOK (zincir kirik)';
    END IF;

    RAISE NOTICE 'POST-VALIDATION: function SECURITY DEFINER + search_path OK';
    RAISE NOTICE 'POST-VALIDATION: trigger BEFORE INSERT+UPDATE bind OK';
    RAISE NOTICE 'POST-VALIDATION: COMMENT ON FUNCTION OK';
    RAISE NOTICE 'POST-VALIDATION: cascade chain functions present OK';
    RAISE NOTICE 'OK: 051 purchase_items VAT+discount-aware trigger applied (docs/FINANCE.md kural 11+12)';
END $val$;
