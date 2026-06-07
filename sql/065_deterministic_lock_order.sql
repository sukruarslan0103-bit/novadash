-- ============================================================
-- 065 — DETERMINISTIC LOCK ORDER (purchase cascade deadlock fix)
--
-- Problem (root-cause audit):
--   purchase_items INSERT → AFTER trigger UPDATE raw_materials.cost
--   → AFTER UPDATE trigger → sync_product_cost → UPDATE products.cost.
--   Bu cascade'de raw_materials + products ROW LOCK'lari COMMIT'e kadar
--   tutuluyor. Kilit alma sirasi iki KONTROLSUZ girdiyle belirleniyordu:
--     (1) insert_purchase_items_batch p_items dizi sirasi (sort YOK)
--     (2) trg_fn_raw_materials_cost_sync product_recipes loop (ORDER BY YOK)
--   Iki es zamanlı alis cakisan rm/product satirlarina TERS sirayla kilit
--   aldiginda → circular wait → "deadlock detected".
--
-- Cozum (minimal, deterministik global kilit sirasi):
--   (1) insert_purchase_items_batch: p_items'i raw_material_id'ye gore
--       SIRALI isle → tum transaction'lar raw_materials satirlarini AYNI
--       sirada kilitler.
--   (2) trg_fn_raw_materials_cost_sync: product loop'una ORDER BY product_id
--       → tum transaction'lar products satirlarini AYNI sirada kilitler.
--   Sonuc: her txn (raw_materials artan → products artan) sirasini izler →
--   circular wait IMKANSIZ → deadlock yapisal olarak elenir.
--
-- KAPSAM DISI (DOKUNULMUYOR):
--   - Is mantigi / maliyet formulu / KDV / discount hesabi (govde birebir ayni,
--     yalnizca ISLEM SIRASI sabitlendi; sonuc degerleri DEGISMEZ)
--   - Trigger bind'leri (CREATE OR REPLACE FUNCTION binding'i korur; trigger
--     yeniden olusturulmaz)
--   - RLS / grant / restore / export / frontend
--   - 064 (REVOKE EXECUTE) ile ilgisi YOK; bu migration lock sirasini
--     duzeltir, yetki degil.
--
-- Davranis denkligi:
--   - inserted_ids / count / invoice_no order-bagimsiz tuketiliyor (frontend
--     keepIds SET'ine push) → reorder davranisi bozmaz.
--   - v_idx yalnizca hata mesaji sayaci (cosmetic).
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DO bloklari, re-run safe.
--
-- Rollback:
--   999_baseline.sql:1628-1746 (insert_purchase_items_batch) ve
--   999_baseline.sql:2208-2228 (trg_fn_raw_materials_cost_sync) orijinal
--   govdelerini tek CREATE OR REPLACE ile tekrar RUN.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT (salt-okuma)
-- ============================================================
DO $pre$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'insert_purchase_items_batch'
    ) THEN
        RAISE EXCEPTION '[065] ABORT: insert_purchase_items_batch YOK';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'trg_fn_raw_materials_cost_sync'
    ) THEN
        RAISE EXCEPTION '[065] ABORT: trg_fn_raw_materials_cost_sync YOK (zincir kirik)';
    END IF;

    RAISE NOTICE '[065] PRE-FLIGHT OK';
END;
$pre$;


-- ============================================================
-- 1) insert_purchase_items_batch — p_items raw_material_id'ye gore SIRALI islenir
--    Govde 999:1628-1746 ile BIREBIR AYNI; TEK degisiklik: FOR loop kaynagi
--    artik ORDER BY (value->>'raw_material_id') ile siralanir.
-- ============================================================
CREATE OR REPLACE FUNCTION insert_purchase_items_batch(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid    UUID;
    v_tenant_id   UUID;
    v_item        JSONB;
    v_invoice_id  TEXT;
    v_invoice_no  BIGINT;
    v_count       INT := 0;
    v_idx         INT := 0;
    v_ids         UUID[] := ARRAY[]::UUID[];
    v_new_id      UUID;
    v_note_json   JSONB;
BEGIN
    -- 065-lock-order: deterministic raw_material lock order (asagidaki FOR loop)
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'p_items JSONB array olmali';
    END IF;

    IF jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'p_items bos olamaz';
    END IF;

    BEGIN
        v_note_json := (p_items->0->>'note')::JSONB;
        v_invoice_id := v_note_json->>'invoice_id';
    EXCEPTION WHEN OTHERS THEN
        v_invoice_id := NULL;
    END;

    IF v_invoice_id IS NOT NULL AND v_invoice_id <> '' THEN
        SELECT invoice_no
        INTO v_invoice_no
        FROM purchase_items
        WHERE tenant_id = v_tenant_id
          AND is_deleted = false
          AND invoice_no IS NOT NULL
          AND (note::JSONB->>'invoice_id') = v_invoice_id
        ORDER BY created_at ASC
        LIMIT 1;
    END IF;

    IF v_invoice_no IS NULL THEN
        v_invoice_no := nextval('purchase_invoice_seq');
    END IF;

    -- 065: DETERMINISTIC RM LOCK ORDER — p_items raw_material_id'ye gore sirali.
    -- Tum transaction'lar raw_materials satirlarini ayni sirada kilitler →
    -- cross-batch ters-sira deadlock'u elenir. INSERT/sonuc semantigi degismez.
    FOR v_item IN
        SELECT value
        FROM jsonb_array_elements(p_items)
        ORDER BY (value->>'raw_material_id')
    LOOP
        v_idx := v_idx + 1;

        IF v_item->>'raw_material_id' IS NULL OR v_item->>'raw_material_id' = '' THEN
            RAISE EXCEPTION 'Item %: raw_material_id zorunlu', v_idx;
        END IF;

        IF (v_item->>'quantity') IS NULL
           OR NOT ((v_item->>'quantity')::TEXT ~ '^-?[0-9]+(\.[0-9]+)?$')
           OR (v_item->>'quantity')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'Item %: quantity > 0 olmali', v_idx;
        END IF;

        IF (v_item->>'base_quantity') IS NULL
           OR (v_item->>'base_quantity')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'Item %: base_quantity > 0 olmali (WAC verisi)', v_idx;
        END IF;

        IF (v_item->>'base_unit_cost') IS NULL
           OR (v_item->>'base_unit_cost')::NUMERIC < 0 THEN
            RAISE EXCEPTION 'Item %: base_unit_cost >= 0 olmali (WAC verisi)', v_idx;
        END IF;

        INSERT INTO purchase_items (
            tenant_id, raw_material_id, quantity, unit, unit_cost, line_total,
            vat_rate, discount_rate, base_quantity, base_unit_cost,
            general_discount_amount, general_discount_type,
            note, invoice_date, invoice_no
        ) VALUES (
            v_tenant_id,
            (v_item->>'raw_material_id')::UUID,
            (v_item->>'quantity')::NUMERIC,
            v_item->>'unit',
            COALESCE((v_item->>'unit_cost')::NUMERIC, 0),
            COALESCE((v_item->>'line_total')::NUMERIC, 0),
            COALESCE((v_item->>'vat_rate')::NUMERIC, 0),
            COALESCE((v_item->>'discount_rate')::NUMERIC, 0),
            (v_item->>'base_quantity')::NUMERIC,
            (v_item->>'base_unit_cost')::NUMERIC,
            COALESCE((v_item->>'general_discount_amount')::NUMERIC, 0),
            COALESCE(v_item->>'general_discount_type', 'amount'),
            v_item->>'note',
            NULLIF(v_item->>'invoice_date', '')::DATE,
            v_invoice_no
        )
        RETURNING id INTO v_new_id;

        v_ids := v_ids || v_new_id;
        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'count', v_count,
        'invoice_no', v_invoice_no,
        'inserted_ids', to_jsonb(v_ids)
    );
END;
$$;


-- ============================================================
-- 2) trg_fn_raw_materials_cost_sync — product loop ORDER BY product_id
--    Govde 999:2208-2228 ile BIREBIR AYNI; TEK degisiklik: ORDER BY product_id.
--    CREATE OR REPLACE FUNCTION trigger binding'i korur (trigger yeniden
--    olusturulmaz).
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
    -- 065-lock-order: deterministic product lock order (ORDER BY product_id)
    FOR r IN
        SELECT DISTINCT product_id
        FROM product_recipes
        WHERE raw_material_id = NEW.id
          AND is_deleted = false
        ORDER BY product_id
    LOOP
        PERFORM sync_product_cost(r.product_id);
    END LOOP;

    RETURN NEW;
END;
$$;


-- ============================================================
-- POST-VALIDATION (salt-okuma)
--   - Iki fonksiyonda da 065 lock-order marker'i / ORDER BY mevcut mu?
--   - SECURITY DEFINER + search_path korundu mu?
--   - raw_materials cost-sync trigger hala bagli mi?
-- ============================================================
DO $post$
DECLARE
    v_batch_src TEXT;
    v_trg_src   TEXT;
    v_secdef    BOOLEAN;
BEGIN
    SELECT pg_get_functiondef(p.oid), p.prosecdef
      INTO v_batch_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'insert_purchase_items_batch';

    IF v_batch_src NOT LIKE '%ORDER BY (value->>''raw_material_id'')%' THEN
        RAISE EXCEPTION '[065] FAIL: insert_purchase_items_batch RM ORDER BY eklenmemis';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[065] FAIL: insert_purchase_items_batch SECURITY DEFINER degil';
    END IF;
    IF v_batch_src NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION '[065] FAIL: insert_purchase_items_batch search_path SET edilmemis';
    END IF;

    SELECT pg_get_functiondef(p.oid), p.prosecdef
      INTO v_trg_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_fn_raw_materials_cost_sync';

    IF v_trg_src NOT LIKE '%ORDER BY product_id%' THEN
        RAISE EXCEPTION '[065] FAIL: trg_fn_raw_materials_cost_sync product ORDER BY eklenmemis';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[065] FAIL: trg_fn_raw_materials_cost_sync SECURITY DEFINER degil';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_raw_materials_cost_sync' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '[065] FAIL: trg_raw_materials_cost_sync trigger bind kayboldu';
    END IF;

    RAISE NOTICE '[065] OK: deterministic lock order aktif (RM asc → product asc); cascade trigger bind korundu.';
END;
$post$;
