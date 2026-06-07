-- ============================================================
-- 066 — ROLLBACK of 065 (deterministic lock order)
--
-- Amac (ACIL STABILIZASYON — kalici cozum DEGIL):
--   065 sonrasi gozlenen alis duplicate / WAC flip / yanlis maliyet
--   davranisini durdurmak icin 065'in degistirdigi IKI fonksiyonu
--   baseline (999_baseline.sql) govdelerine geri dondur.
--
--   065 etkisi:
--     - insert_purchase_items_batch: FOR loop kaynagina
--       ORDER BY (value->>'raw_material_id') eklenmisti → insert sirasi
--       degisti → calculate_raw_material_wac (ORDER BY created_at DESC,
--       tiebreaker YOK; batch'te created_at ties cunku DEFAULT now())
--       icin ayni-rm-coklu-satir senaryosunda WAC flip.
--     - trg_fn_raw_materials_cost_sync: product loop'una ORDER BY
--       product_id eklenmisti.
--
--   Bu migration TAM olarak o iki ORDER BY'i kaldirir; govdeler baseline
--   ile birebir ayniya doner. Baska HICBIR sey degismez.
--
-- KAPSAM DISI (DOKUNULMUYOR):
--   - 064 cost helper REVOKE (KORUNUYOR — bkz. asagidaki not)
--   - RLS / grant / restore / export / frontend
--   - Maliyet formulu / KDV / discount
--   - YENI idempotency YOK, WAC tiebreaker YOK, deadlock-safe order YOK
--     (bunlar ayri kalici fazda ele alinacak)
--
-- 064 NEDEN KORUNUYOR:
--   064 yalnizca calculate_*/sync_* fonksiyonlarindan anon/authenticated
--   EXECUTE'unu kaldirdi (grant hardening). Duplicate/WAC sorunuyla
--   ILGISI YOK; lock sirasi veya insert davranisini etkilemez. Geri almak
--   gereksiz bir guvenlik regresyonu olurdu. Bu yuzden dokunulmuyor.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, re-run safe.
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
        RAISE EXCEPTION '[066] ABORT: insert_purchase_items_batch YOK';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'trg_fn_raw_materials_cost_sync'
    ) THEN
        RAISE EXCEPTION '[066] ABORT: trg_fn_raw_materials_cost_sync YOK (zincir kirik)';
    END IF;

    RAISE NOTICE '[066] PRE-FLIGHT OK';
END;
$pre$;


-- ============================================================
-- 1) insert_purchase_items_batch — BASELINE govde (999:1628-1746)
--    065'teki ORDER BY (value->>'raw_material_id') KALDIRILDI.
--    FOR loop kaynagi tekrar: SELECT * FROM jsonb_array_elements(p_items)
--    (giris/dizi sirasi). Baska hicbir sey degismedi.
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

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
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
-- 2) trg_fn_raw_materials_cost_sync — BASELINE govde (999:2208-2228)
--    065'teki ORDER BY product_id KALDIRILDI. CREATE OR REPLACE FUNCTION
--    trigger binding'i korur (trigger yeniden olusturulmaz).
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
-- POST-VALIDATION (salt-okuma)
--   065 ORDER BY'lari GITMIS olmali; DEFINER/search_path/trigger bind korunmali.
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

    IF v_batch_src LIKE '%ORDER BY (value->>''raw_material_id'')%' THEN
        RAISE EXCEPTION '[066] FAIL: insert_purchase_items_batch hala 065 RM ORDER BY iceriyor';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[066] FAIL: insert_purchase_items_batch SECURITY DEFINER degil';
    END IF;
    IF v_batch_src NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION '[066] FAIL: insert_purchase_items_batch search_path SET edilmemis';
    END IF;

    SELECT pg_get_functiondef(p.oid), p.prosecdef
      INTO v_trg_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_fn_raw_materials_cost_sync';

    IF v_trg_src LIKE '%ORDER BY product_id%' THEN
        RAISE EXCEPTION '[066] FAIL: trg_fn_raw_materials_cost_sync hala 065 product ORDER BY iceriyor';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[066] FAIL: trg_fn_raw_materials_cost_sync SECURITY DEFINER degil';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_raw_materials_cost_sync' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '[066] FAIL: trg_raw_materials_cost_sync trigger bind kayboldu';
    END IF;

    RAISE NOTICE '[066] OK: 065 ORDER BY rollback edildi; iki fonksiyon baseline govdesinde. (ACIL stabilizasyon — kalici cozum ayri fazda)';
END;
$post$;
