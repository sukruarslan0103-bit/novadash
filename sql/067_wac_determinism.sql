-- ============================================================
-- 067 — WAC DETERMINISM (calculate_raw_material_wac tiebreaker)
--
-- Root cause:
--   purchase_items.created_at DEFAULT now() → tek transaction (tek fatura)
--   icindeki tum satirlar AYNI created_at alir. calculate_raw_material_wac
--   "son alis"i secerken `ORDER BY created_at DESC LIMIT 1` kullaniyordu;
--   tie durumunda hangi satirin secilecegi BELIRSIZ (fiziksel/heap sirasi) →
--   ayni hammadde bir faturada birden fazla satirda gecince WAC "flip"
--   edebiliyordu.
--
-- Fix:
--   ORDER BY pi.created_at DESC  →  ORDER BY pi.created_at DESC, pi.id DESC
--   Stabil ikincil anahtar (id) ekler → ayni veri icin HER ZAMAN ayni satir
--   secilir. Secim DETERMINISTIK olur.
--
-- KAPSAM: SADECE calculate_raw_material_wac. Govde 999_baseline.sql:777-818
--   ile birebir ayni; TEK degisiklik ORDER BY satiri.
--
-- KAPSAM DISI (DOKUNULMUYOR):
--   - insert_purchase_items_batch
--   - trigger'lar (trg_fn_purchase_items_cost_sync / *_raw_materials / *_recipes)
--   - sync_raw_material_cost / sync_product_cost / calculate_product_cost
--   - lock order (deadlock fix) — AYRI konu
--   - KDV/discount formulu
--   - frontend
--
-- Idempotent: CREATE OR REPLACE FUNCTION, re-run safe.
--
-- Rollback: 999_baseline.sql:777-818 orijinal body'sini (ORDER BY created_at
--   DESC, id DESC olmadan) tek CREATE OR REPLACE ile RUN.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT (salt-okuma)
-- ============================================================
DO $pre$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'calculate_raw_material_wac'
    ) THEN
        RAISE EXCEPTION '[067] ABORT: calculate_raw_material_wac YOK';
    END IF;
    RAISE NOTICE '[067] PRE-FLIGHT OK';
END;
$pre$;


-- ============================================================
-- calculate_raw_material_wac — BASELINE body + deterministik tiebreaker
--   TEK degisiklik: ORDER BY pi.created_at DESC, pi.id DESC
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

    SELECT tenant_id INTO v_tenant_id
    FROM raw_materials
    WHERE id = p_raw_material_id
      AND is_deleted = false;

    IF v_tenant_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT pi.base_unit_cost
    INTO v_last_cost
    FROM purchase_items pi
    WHERE pi.raw_material_id = p_raw_material_id
      AND pi.tenant_id = v_tenant_id
      AND pi.is_deleted = false
      AND pi.base_unit_cost IS NOT NULL
      AND pi.base_unit_cost > 0
    ORDER BY pi.created_at DESC, pi.id DESC   -- 067: deterministik tiebreaker
    LIMIT 1;

    IF v_last_cost IS NULL OR v_last_cost <= 0 THEN
        RETURN 0;
    END IF;

    RETURN v_last_cost::NUMERIC;
END;
$$;


-- ============================================================
-- POST-VALIDATION (salt-okuma)
-- ============================================================
DO $post$
DECLARE
    v_src     TEXT;
    v_secdef  BOOLEAN;
    v_config  TEXT;
BEGIN
    SELECT pg_get_functiondef(p.oid), p.prosecdef,
           (SELECT string_agg(cfg, ', ') FROM unnest(coalesce(p.proconfig,'{}')) AS cfg)
      INTO v_src, v_secdef, v_config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'calculate_raw_material_wac';

    IF v_src NOT LIKE '%ORDER BY pi.created_at DESC, pi.id DESC%' THEN
        RAISE EXCEPTION '[067] FAIL: deterministik tiebreaker (created_at DESC, id DESC) eklenmemis';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[067] FAIL: SECURITY DEFINER kaybolmus';
    END IF;
    IF v_config IS NULL OR v_config NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION '[067] FAIL: search_path SET edilmemis';
    END IF;

    RAISE NOTICE '[067] OK: calculate_raw_material_wac deterministik (created_at DESC, id DESC). Govdenin geri kalani baseline ile ayni.';
END;
$post$;
