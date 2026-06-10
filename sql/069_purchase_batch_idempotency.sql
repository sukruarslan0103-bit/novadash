-- ============================================================
-- 069 — PURCHASE BATCH IDEMPOTENCY (ledger-tabanli gate)
--
-- Amac:
--   insert_purchase_items_batch'e ledger-tabanli idempotency. Ayni
--   idempotency_key ile gelen replay (transport double-send / hata sonrasi
--   manuel retry / eszamanli cift gonderim) IKINCI KEZ satir INSERT ETMEZ;
--   orijinal sonucu doner. Boylece tek-click duplicate (066/068/duplicate
--   audit) yapisal olarak kapanir.
--
-- Tasarim (onaylanan):
--   - Ayri purchase_idempotency ledger tablosu (batch basina TEK kayit).
--     purchase_items satir-seviyesi unique YANLIS olurdu (N-satir batch'i
--     bloklar) → ledger dogru yapi.
--   - RPC, satir eklemeden ONCE ledger'a ON CONFLICT DO NOTHING ile atomik
--     kapi koyar. Key yeni → satirlar + sonuc; key mevcut → replay, no-op.
--   - Ledger insert + satir insert + trigger cascade AYNI transaction →
--     "commit edilen key <=> commit edilen satirlar" (rollback-safe).
--
-- KORUNAN (DOKUNULMAYAN):
--   - NET storage (purchase_items.unit_cost / line_total) — sema degismez.
--   - WAC (067), trigger cascade, 068 deterministic lock-order — RPC govdesi
--     068 ile BIREBIR; yalnizca basa gate + sona ledger-update eklendi.
--   - Existing invoice_no davranisi (note.invoice_id reuse + nextval) aynen.
--   - Existing response format korunur; yalnizca additive 'duplicate' alani.
--   - Backward compat: p_idempotency_key DEFAULT NULL → key yoksa eski davranis.
--
-- ON KOSUL: 067 WAC tiebreaker aktif (lock-order WAC-safe invariant'i).
--
-- Idempotent migration: CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE.
--
-- Rollback:
--   068_deterministic_lock_order_v2.sql'deki insert_purchase_items_batch(jsonb)
--   govdesini tek CREATE OR REPLACE ile geri yukle + (istege bagli)
--   DROP TABLE purchase_idempotency. Veri etkisi: ledger silinir, NET/WAC etkilenmez.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT (salt-okuma)
-- ============================================================
DO $pre$
DECLARE
    v_wac_src TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'insert_purchase_items_batch'
    ) THEN
        RAISE EXCEPTION '[069] ABORT: insert_purchase_items_batch YOK';
    END IF;

    SELECT pg_get_functiondef(p.oid) INTO v_wac_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'calculate_raw_material_wac';
    IF v_wac_src IS NULL OR v_wac_src NOT LIKE '%ORDER BY pi.created_at DESC, pi.id DESC%' THEN
        RAISE EXCEPTION '[069] ABORT: 067 WAC tiebreaker aktif degil. Once 067 uygulayin (lock-order WAC-safe invariant).';
    END IF;

    RAISE NOTICE '[069] PRE-FLIGHT OK';
END;
$pre$;


-- ============================================================
-- 1) LEDGER TABLOSU + UNIQUE + RLS
--    Internal tablo: dogrudan PostgREST grant YOK (rate_limits 053 precedent).
--    Yalnizca SECURITY DEFINER RPC (owner=postgres) erisir.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.purchase_idempotency (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    payload_hash    TEXT,
    invoice_no      BIGINT,
    result          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT purchase_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_purchase_idem_tenant_created
    ON public.purchase_idempotency(tenant_id, created_at DESC);

-- RLS: ENABLE (FORCE degil → DEFINER/postgres bypass eder, RPC calisir).
ALTER TABLE public.purchase_idempotency ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS purchase_idem_tenant_isolation ON public.purchase_idempotency;
CREATE POLICY purchase_idem_tenant_isolation ON public.purchase_idempotency
    FOR ALL
    USING (tenant_id = get_my_tenant_id())
    WITH CHECK (tenant_id = get_my_tenant_id());

-- Internal: authenticated/anon DIREKT erisemez (RPC-only). PostgREST expose etmez.
REVOKE ALL ON TABLE public.purchase_idempotency FROM PUBLIC, anon, authenticated;


-- ============================================================
-- 2) RPC — eski (jsonb) imzasini DROP et (overload ambiguity'yi onle),
--    yeni (jsonb, text DEFAULT NULL) imzasini olustur.
--    Govde 068 ile BIREBIR; basta IDEMPOTENCY GATE, sonda ledger-update eklendi.
-- ============================================================
DROP FUNCTION IF EXISTS public.insert_purchase_items_batch(jsonb);

CREATE OR REPLACE FUNCTION public.insert_purchase_items_batch(
    p_items           JSONB,
    p_idempotency_key TEXT DEFAULT NULL
)
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
    -- 069 idempotency
    v_has_key         BOOLEAN := (p_idempotency_key IS NOT NULL AND p_idempotency_key <> '');
    v_payload_hash    TEXT;
    v_ins_key         TEXT;
    v_existing_hash   TEXT;
    v_existing_result JSONB;
    v_result          JSONB;
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

    -- ========================================================
    -- 069: IDEMPOTENCY GATE (key varsa). Ledger insert + transaction kapisi.
    --   - Key yeni  → ledger satiri eklenir, batch'e devam.
    --   - Conflict  → replay (eszamanli ise ilk commit'e kadar BLOKLANIR).
    --       payload ayni → orijinal sonuc + duplicate:true.
    --       payload farkli → IDEMPOTENCY_KEY_REUSE (explicit reject).
    --   Ledger insert AYNI transaction'da → batch fail olursa key de rollback.
    -- ========================================================
    IF v_has_key THEN
        v_payload_hash := md5(p_items::text);

        INSERT INTO purchase_idempotency (tenant_id, idempotency_key, payload_hash)
        VALUES (v_tenant_id, p_idempotency_key, v_payload_hash)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING idempotency_key INTO v_ins_key;

        IF v_ins_key IS NULL THEN
            -- Replay: ledger satiri zaten var (ve committed — conflict insert
            -- ilk transaction commit edene kadar bekledi).
            SELECT payload_hash, result
              INTO v_existing_hash, v_existing_result
              FROM purchase_idempotency
             WHERE tenant_id = v_tenant_id
               AND idempotency_key = p_idempotency_key;

            IF v_existing_hash IS DISTINCT FROM v_payload_hash THEN
                RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE: ayni idempotency_key farkli payload ile geldi'
                    USING ERRCODE = '23505';
            END IF;

            RETURN COALESCE(
                v_existing_result,
                jsonb_build_object('success', true, 'count', 0,
                                   'invoice_no', NULL, 'inserted_ids', '[]'::jsonb)
            ) || jsonb_build_object('duplicate', true);
        END IF;
        -- v_ins_key NOT NULL → key yeni, ledger satiri eklendi, devam.
    END IF;

    -- ===== 068 ile BIREBIR: invoice_no cozumu =====
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

    -- ===== 068 ile BIREBIR: DETERMINISTIC RM LOCK ORDER (deadlock-safe) =====
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

    -- Existing response format + additive 'duplicate'
    v_result := jsonb_build_object(
        'success', true,
        'count', v_count,
        'invoice_no', v_invoice_no,
        'inserted_ids', to_jsonb(v_ids),
        'duplicate', false
    );

    -- 069: ledger sonucu kaydet (replay aynen donsun). Ayni transaction.
    IF v_has_key THEN
        UPDATE purchase_idempotency
           SET invoice_no = v_invoice_no,
               result     = v_result
         WHERE tenant_id = v_tenant_id
           AND idempotency_key = p_idempotency_key;
    END IF;

    RETURN v_result;
END;
$$;

-- Yeni imzaya EXECUTE grant (DROP eski grant'i sildi).
GRANT EXECUTE ON FUNCTION public.insert_purchase_items_batch(jsonb, text) TO authenticated;


-- ============================================================
-- POST-VALIDATION (salt-okuma)
-- ============================================================
DO $post$
DECLARE
    v_src      TEXT;
    v_secdef   BOOLEAN;
    v_old_cnt  INT;
    v_new_cnt  INT;
BEGIN
    -- Tablo + unique
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='purchase_idempotency'
    ) THEN
        RAISE EXCEPTION '[069] FAIL: purchase_idempotency tablosu yok';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'purchase_idempotency_unique'
    ) THEN
        RAISE EXCEPTION '[069] FAIL: UNIQUE(tenant_id, idempotency_key) yok';
    END IF;

    -- Eski (jsonb) imza GITMIS, yeni (jsonb,text) VAR (tek fonksiyon)
    SELECT count(*) INTO v_old_cnt
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='insert_purchase_items_batch'
       AND pg_get_function_identity_arguments(p.oid) = 'p_items jsonb';
    SELECT count(*) INTO v_new_cnt
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='insert_purchase_items_batch'
       AND pg_get_function_identity_arguments(p.oid) = 'p_items jsonb, p_idempotency_key text';
    IF v_old_cnt <> 0 THEN
        RAISE EXCEPTION '[069] FAIL: eski (jsonb) imza hala mevcut → overload ambiguity riski';
    END IF;
    IF v_new_cnt <> 1 THEN
        RAISE EXCEPTION '[069] FAIL: yeni (jsonb, text) imza bulunamadi';
    END IF;

    -- Lock-order + DEFINER + idempotency korunmus mu
    SELECT pg_get_functiondef(p.oid), p.prosecdef INTO v_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='insert_purchase_items_batch';
    IF v_src NOT LIKE '%ORDER BY (value->>''raw_material_id'')%' THEN
        RAISE EXCEPTION '[069] FAIL: 068 lock-order (RM ORDER BY) kaybolmus';
    END IF;
    IF v_src NOT LIKE '%purchase_idempotency%' THEN
        RAISE EXCEPTION '[069] FAIL: idempotency gate govdede yok';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[069] FAIL: SECURITY DEFINER degil';
    END IF;
    IF v_src NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION '[069] FAIL: search_path SET edilmemis';
    END IF;

    -- authenticated ledger tablosuna DIREKT erisememeli
    IF has_table_privilege('authenticated', 'public.purchase_idempotency', 'SELECT') THEN
        RAISE EXCEPTION '[069] FAIL: authenticated purchase_idempotency SELECT yetkisi var (internal olmali)';
    END IF;

    RAISE NOTICE '[069] OK: ledger idempotency aktif; 068 lock-order + DEFINER + search_path korundu; tablo internal.';
END;
$post$;
