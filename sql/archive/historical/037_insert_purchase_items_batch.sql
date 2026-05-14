-- ============================================================
-- 037 — INSERT_PURCHASE_ITEMS_BATCH
--
-- Amac: Bir faturanin TUM satirlarini TEK transaction icinde ekle.
--       Herhangi biri patlarsa hepsi rollback olur (atomic).
--       Yarim fatura riski biter.
--
-- Imza:
--   insert_purchase_items_batch(p_items JSONB) -> JSONB
--
--   p_items: Item array
--     [{
--       raw_material_id, quantity, unit, unit_cost, line_total,
--       vat_rate, discount_rate, base_quantity, base_unit_cost,
--       general_discount_amount, general_discount_type,
--       note, invoice_date
--     }, ...]
--
-- Donus:
--   { success: true, count: N, invoice_no: BIGINT, inserted_ids: [...] }
--
-- Atomik: plpgsql fonksiyonu zaten tek transaction. Bir EXCEPTION
--   raise edilirse fonksiyon hata firlatir, hicbir satir kalmaz.
--
-- Tenant: server-side (auth.uid -> users.tenant_id). Client tenant
--   gondermez/spoof edemez.
--
-- Invoice no: tum satirlar AYNI invoice_no'yu alir.
--   Eger ilk item'in note'unda invoice_id varsa ve o invoice_id
--   icin onceden kayit varsa -> mevcut invoice_no'yu kullan.
--   Yoksa -> nextval('purchase_invoice_seq').
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
    -- ============ AUTH ============
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM users
    WHERE id = v_auth_uid;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    -- ============ INPUT VALIDATION ============
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'p_items JSONB array olmali';
    END IF;

    IF jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'p_items bos olamaz';
    END IF;

    -- ============ INVOICE NO RESOLUTION ============
    -- Ilk item'in note JSON'undan invoice_id'yi cek.
    BEGIN
        v_note_json := (p_items->0->>'note')::JSONB;
        v_invoice_id := v_note_json->>'invoice_id';
    EXCEPTION WHEN OTHERS THEN
        v_invoice_id := NULL;
    END;

    -- Mevcut bir invoice_id ise (edit mode senaryosu) onun invoice_no'sunu kullan.
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

    -- Yeni fatura -> nextval
    IF v_invoice_no IS NULL THEN
        v_invoice_no := nextval('purchase_invoice_seq');
    END IF;

    -- ============ INSERT LOOP — ATOMIC ============
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_idx := v_idx + 1;

        -- Per-item validation (herhangi biri patlarsa hepsi rollback)
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
            tenant_id,
            raw_material_id,
            quantity,
            unit,
            unit_cost,
            line_total,
            vat_rate,
            discount_rate,
            base_quantity,
            base_unit_cost,
            general_discount_amount,
            general_discount_type,
            note,
            invoice_date,
            invoice_no
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

    -- ============ RETURN ============
    RETURN jsonb_build_object(
        'success', true,
        'count', v_count,
        'invoice_no', v_invoice_no,
        'inserted_ids', to_jsonb(v_ids)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION insert_purchase_items_batch(JSONB) TO authenticated;


-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_count INT;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM pg_proc
    WHERE proname = 'insert_purchase_items_batch'
      AND pronamespace = 'public'::regnamespace;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'KRITIK: insert_purchase_items_batch olusturulamadi!';
    END IF;

    RAISE NOTICE 'OK: insert_purchase_items_batch aktif (count=%)', v_count;
END $$;


-- ============================================================
-- TEST
-- ============================================================
-- SELECT insert_purchase_items_batch(
--   jsonb_build_array(
--     jsonb_build_object(
--       'raw_material_id', '<uuid>',
--       'quantity', 1,
--       'unit', 'kg',
--       'unit_cost', 100,
--       'line_total', 100,
--       'vat_rate', 20,
--       'discount_rate', 0,
--       'base_quantity', 1000,
--       'base_unit_cost', 0.1,
--       'general_discount_amount', 0,
--       'general_discount_type', 'amount',
--       'note', '{"invoice_id":"INV-TEST-1","supplier":"Test"}',
--       'invoice_date', '2025-01-15'
--     )
--   )
-- );
-- ============================================================
