-- ============================================================
-- 068 — DETERMINISTIC LOCK ORDER v2 (deadlock fix, 067 WAC-safe)
--
-- Amac:
--   065'in deadlock-onleme yaklasimini YENIDEN uygula — ama bu kez 067
--   (WAC tiebreaker) aktifken, boylece WAC flip OLUSMADAN.
--
-- Arka plan:
--   - 065: purchase cascade'de raw_materials + products row-lock'lari icin
--     kanonik kilit sirasi (insert'i rm_id'ye, recipe loop'unu product_id'ye
--     gore sirala) → cross-batch ters-sira deadlock'u elenir.
--   - 065 GERI ALINDI (066) cunku insert sirasini degistirmek,
--     calculate_raw_material_wac'in tiebreaker'siz `ORDER BY created_at DESC`'i
--     ile birlesince ayni-rm-coklu-satir faturada WAC flip'e yol aciyordu
--     (tek fatura satirlari ayni created_at → tie → secim insert sirasina
--     bagliydi).
--   - 067: calculate_raw_material_wac artik `ORDER BY created_at DESC, id DESC`
--     → secim insert sirasindan BAGIMSIZ, deterministik.
--
-- Bu yuzden 068 GUVENLI:
--   Insert sirasini degistirmek artik WAC sonucunu ETKILEMEZ (067 tie'yi id
--   ile cozer). Lock order yeniden gelir → deadlock cozulur, WAC flip olmaz.
--
-- Degisiklik (065 ile AYNI, govdeler 999_baseline + tek ORDER BY):
--   1) insert_purchase_items_batch: FOR loop kaynagi
--        ORDER BY (value->>'raw_material_id')
--   2) trg_fn_raw_materials_cost_sync: product loop
--        ORDER BY product_id
--
-- KAPSAM DISI (DOKUNULMUYOR):
--   - calculate_raw_material_wac (067) / sync_* / calculate_product_cost
--   - trigger LOGIC'i (yalnizca loop sirasi; davranis/sonuc ayni)
--   - KDV/discount formulu / frontend / yeni tablo-kolon / idempotency
--
-- Idempotent: CREATE OR REPLACE FUNCTION, re-run safe.
--
-- ON KOSUL: 067 aktif olmali (asagidaki PRE-FLIGHT dogrular; degilse ABORT).
--
-- Rollback: 066 (baseline govdeleri, ORDER BY'siz) tek CREATE OR REPLACE ile RUN.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT — 067 AKTIF MI? (KRITIK: degilse WAC flip riski → ABORT)
-- ============================================================
DO $pre$
DECLARE
    v_wac_src TEXT;
BEGIN
    -- Hedef fonksiyonlar var mi?
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'insert_purchase_items_batch'
    ) THEN
        RAISE EXCEPTION '[068] ABORT: insert_purchase_items_batch YOK';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'trg_fn_raw_materials_cost_sync'
    ) THEN
        RAISE EXCEPTION '[068] ABORT: trg_fn_raw_materials_cost_sync YOK';
    END IF;

    -- 067 WAC tiebreaker aktif mi? Degilse lock-order yeniden uygulanirsa
    -- WAC flip geri gelir → uygulamayi REDDET.
    SELECT pg_get_functiondef(p.oid) INTO v_wac_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'calculate_raw_material_wac';

    IF v_wac_src IS NULL THEN
        RAISE EXCEPTION '[068] ABORT: calculate_raw_material_wac YOK';
    END IF;

    IF v_wac_src NOT LIKE '%ORDER BY pi.created_at DESC, pi.id DESC%' THEN
        RAISE EXCEPTION '[068] ABORT: 067 (WAC tiebreaker created_at DESC, id DESC) AKTIF DEGIL. Lock order yeniden uygulanirsa WAC flip riski. Once 067_wac_determinism uygulayin.';
    END IF;

    RAISE NOTICE '[068] PRE-FLIGHT OK: 067 WAC tiebreaker aktif → lock order guvenle uygulanabilir.';
END;
$pre$;


-- ============================================================
-- 1) insert_purchase_items_batch — p_items raw_material_id'ye gore SIRALI
--    Govde 999:1628-1746 ile birebir; TEK degisiklik FOR loop kaynagi
--    ORDER BY (value->>'raw_material_id'). 067 aktif oldugu icin insert
--    sirasi WAC sonucunu etkilemez.
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

    -- 068: DETERMINISTIC RM LOCK ORDER — p_items raw_material_id'ye gore sirali.
    -- Tum transaction'lar raw_materials satirlarini ayni sirada kilitler →
    -- cross-batch ters-sira deadlock'u elenir. 067 aktif: insert sirasi WAC'i
    -- etkilemez (tie id ile cozulur).
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
--    Govde 999:2208-2228 ile birebir; TEK degisiklik ORDER BY product_id.
--    CREATE OR REPLACE FUNCTION trigger binding'i korur (trigger yeniden
--    olusturulmaz). Logic ayni; yalnizca product lock sirasi deterministik.
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
        ORDER BY product_id
    LOOP
        PERFORM sync_product_cost(r.product_id);
    END LOOP;

    RETURN NEW;
END;
$$;


-- ============================================================
-- POST-VALIDATION (salt-okuma)
-- ============================================================
DO $post$
DECLARE
    v_batch_src TEXT;
    v_trg_src   TEXT;
    v_wac_src   TEXT;
    v_secdef    BOOLEAN;
BEGIN
    -- batch RM ORDER BY
    SELECT pg_get_functiondef(p.oid), p.prosecdef
      INTO v_batch_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'insert_purchase_items_batch';
    IF v_batch_src NOT LIKE '%ORDER BY (value->>''raw_material_id'')%' THEN
        RAISE EXCEPTION '[068] FAIL: insert_purchase_items_batch RM ORDER BY eklenmemis';
    END IF;
    IF NOT v_secdef THEN RAISE EXCEPTION '[068] FAIL: insert_purchase_items_batch SECURITY DEFINER degil'; END IF;
    IF v_batch_src NOT LIKE '%search_path%' THEN RAISE EXCEPTION '[068] FAIL: insert_purchase_items_batch search_path SET edilmemis'; END IF;

    -- trigger product ORDER BY
    SELECT pg_get_functiondef(p.oid), p.prosecdef
      INTO v_trg_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'trg_fn_raw_materials_cost_sync';
    IF v_trg_src NOT LIKE '%ORDER BY product_id%' THEN
        RAISE EXCEPTION '[068] FAIL: trg_fn_raw_materials_cost_sync product ORDER BY eklenmemis';
    END IF;
    IF NOT v_secdef THEN RAISE EXCEPTION '[068] FAIL: trg_fn_raw_materials_cost_sync SECURITY DEFINER degil'; END IF;

    -- trigger bind hala duruyor mu
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_raw_materials_cost_sync' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '[068] FAIL: trg_raw_materials_cost_sync trigger bind kayboldu';
    END IF;

    -- 067 hala aktif (regresyon kontrolu)
    SELECT pg_get_functiondef(p.oid) INTO v_wac_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'calculate_raw_material_wac';
    IF v_wac_src NOT LIKE '%ORDER BY pi.created_at DESC, pi.id DESC%' THEN
        RAISE EXCEPTION '[068] FAIL: 067 WAC tiebreaker kaybolmus (regresyon)';
    END IF;

    RAISE NOTICE '[068] OK: deterministic lock order (RM asc → product asc) aktif; 067 WAC tiebreaker korunuyor; trigger bind saglam.';
END;
$post$;
