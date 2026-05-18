-- ============================================================
-- 054 — CREATE_SALES_ATOMIC RATE LIMIT
--
-- Amac:
--   Backend-side rate-limit ekle. Frontend double-click guard
--   primary defense; bu migration secondary defense (script
--   bypass, automation abuse, accidental loop, replay flood).
--
-- Pattern: 048'in purchase pattern'i ile ayni (PERFORM
-- check_rate_limit AUTH+TENANT sonrasi, validation oncesi).
--
-- Farklar (purchase'a kiyasla — bilincli):
--   - action     : 'sales_batch' (purchase ile collision yok,
--                  batch semantigi acik)
--   - cooldown   : 1 saniye (purchase 2sn; POS yogunlugunu
--                  engellemez ama spam/script'i durdurur)
--   - konum      : loop DISINDA (batch import'u kirmaz; 1 RPC
--                  = 1 tick, p_sales array boyu fark etmez)
--
-- Korunan davranis (047'den hicbiri DEGISMEDI):
--   - SECURITY DEFINER + SET search_path = public
--   - Tenant resolve auth.uid() -> users.tenant_id
--   - Legacy p_tenant_id cross-check
--   - 046 server-side cost snapshot
--   - Idempotency lookup + INSERT akisi
--   - Bos urunlu satis destegi
--   - md5 fallback hash formulu
--
-- Rollback:
--   047_sales_atomic_hardening.sql'i Dashboard'da tekrar RUN
--   et -> PERFORM check_rate_limit satiri kaybolur, 047 davranisi
--   geri gelir. Frontend uyumlu kalir.
--
-- Idempotency:
--   CREATE OR REPLACE -> migration tekrar tekrar calistirilabilir.
-- ============================================================

CREATE OR REPLACE FUNCTION create_sales_atomic(
    p_tenant_id UUID  DEFAULT NULL,
    p_sales     JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid      UUID;
    v_tenant_id     UUID;

    v_sale          JSONB;
    v_product       JSONB;
    v_sale_id       UUID;
    v_ikey          TEXT;
    v_results       JSONB := '[]'::jsonb;
    v_sale_record   JSONB;
    v_is_new        BOOLEAN;

    -- 046: server-side cost snapshot
    v_product_id    UUID;
    v_snapshot_cost NUMERIC;
BEGIN
    -- ============ AUTH ============
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id
      INTO v_tenant_id
      FROM users u
     WHERE u.id = v_auth_uid
       AND u.is_active = true;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found or user disabled'
            USING ERRCODE = '42501';
    END IF;

    -- Legacy client backward-compat: p_tenant_id verilmisse cross-check.
    -- Mismatch = cross-tenant attempt -> hard fail.
    IF p_tenant_id IS NOT NULL
       AND p_tenant_id IS DISTINCT FROM v_tenant_id THEN
        RAISE EXCEPTION 'Tenant mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- ============ RATE LIMIT (054) ============
    -- Loop DISINDA: 1 RPC = 1 tick. Excel batch import (100+ sale
    -- tek call) etkilenmez. UI tek satis (array uzunlugu 1) icin
    -- 1sn cooldown POS yogunlugunu engellemez.
    -- Pattern: 048 purchase ile ayni; action 'sales_batch' ile
    -- collision-safe.
    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'sales_batch', interval '1 second');

    -- ============ PAYLOAD VALIDATION ============
    IF p_sales IS NULL OR jsonb_array_length(p_sales) = 0 THEN
        RAISE EXCEPTION 'p_sales: at least one sale is required';
    END IF;

    -- ============ MAIN LOOP ============
    FOR v_sale IN SELECT * FROM jsonb_array_elements(p_sales)
    LOOP
        -- Idempotency key: client gondermezse server fallback (ayni formul)
        v_ikey := COALESCE(
            v_sale->>'idempotency_key',
            md5(
                v_tenant_id::text                                   || '|' ||
                COALESCE(v_sale->>'date', '')                       || '|' ||
                COALESCE((v_sale->>'total')::numeric, 0)::text      || '|' ||
                COALESCE((v_sale->>'cash')::numeric, 0)::text       || '|' ||
                COALESCE((v_sale->>'card')::numeric, 0)::text       || '|' ||
                COALESCE(v_sale->>'notes', '')
            )
        );

        v_sale_id := NULL;
        v_is_new  := FALSE;

        IF v_ikey IS NOT NULL THEN
            SELECT id INTO v_sale_id
              FROM sales
             WHERE idempotency_key = v_ikey
               AND tenant_id       = v_tenant_id
               AND is_deleted      = false
             LIMIT 1;
        END IF;

        IF v_sale_id IS NULL THEN
            INSERT INTO sales (
                tenant_id, date, total, cash, card,
                notes, created_by, idempotency_key
            )
            VALUES (
                v_tenant_id,
                (v_sale->>'date')::DATE,
                COALESCE((v_sale->>'total')::NUMERIC, 0),
                COALESCE((v_sale->>'cash')::NUMERIC, 0),
                COALESCE((v_sale->>'card')::NUMERIC, 0),
                v_sale->>'notes',
                v_auth_uid,
                v_ikey
            )
            RETURNING id INTO v_sale_id;
            v_is_new := TRUE;
        END IF;

        IF v_sale_id IS NULL THEN CONTINUE; END IF;

        -- ============ PRODUCT LINES (bos olabilir) ============
        IF v_is_new THEN
            IF v_sale->'products' IS NOT NULL
               AND jsonb_array_length(v_sale->'products') > 0 THEN
                FOR v_product IN SELECT * FROM jsonb_array_elements(v_sale->'products')
                LOOP
                    v_product_id := (v_product->>'product_id')::UUID;

                    IF v_product_id IS NULL THEN
                        RAISE EXCEPTION 'product_id is required for sale line';
                    END IF;

                    -- 046: AUTHORITATIVE COST LOOKUP (DEFINER altinda
                    -- RLS bypass; manuel tenant guard zorunlu).
                    SELECT p.cost
                      INTO v_snapshot_cost
                      FROM products p
                     WHERE p.id        = v_product_id
                       AND p.tenant_id = v_tenant_id
                       AND COALESCE(p.is_deleted, false) = false;

                    IF NOT FOUND THEN
                        RAISE EXCEPTION
                            'Product not found, deleted, or tenant mismatch: %',
                            v_product_id
                            USING ERRCODE = '42501';
                    END IF;

                    INSERT INTO product_sales (
                        tenant_id, sale_id, product_id, date,
                        quantity, unit_price, total, cost
                    )
                    VALUES (
                        v_tenant_id, v_sale_id,
                        v_product_id,
                        (v_sale->>'date')::DATE,
                        COALESCE((v_product->>'quantity')::INT, 0),
                        COALESCE((v_product->>'unit_price')::NUMERIC, 0),
                        COALESCE((v_product->>'total')::NUMERIC, 0),
                        COALESCE(v_snapshot_cost, 0)
                    );
                END LOOP;
            END IF;
        END IF;

        -- ============ RESPONSE BUILDING ============
        IF v_is_new THEN
            SELECT jsonb_build_object(
                'id', s.id, 'tenant_id', s.tenant_id, 'date', s.date,
                'total', s.total, 'cash', s.cash, 'card', s.card, 'notes', s.notes,
                'created_by', s.created_by, 'created_at', s.created_at,
                'is_deleted', s.is_deleted,
                'product_sales', COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'id', ps.id, 'sale_id', ps.sale_id, 'product_id', ps.product_id,
                        'date', ps.date, 'quantity', ps.quantity,
                        'unit_price', ps.unit_price, 'total', ps.total, 'cost', ps.cost
                    )) FROM product_sales ps WHERE ps.sale_id = s.id),
                    '[]'::jsonb
                )
            ) INTO v_sale_record
              FROM sales s WHERE s.id = v_sale_id;

            v_results := v_results || v_sale_record;
        END IF;
    END LOOP;

    RETURN v_results;
END;
$$;


-- ============================================================
-- POST-DEPLOY VALIDATION
-- Fonksiyon dogru yuklendi mi, hardening attribute'lari korundu mu,
-- rate-limit satiri eklendi mi — fail-fast kontroller.
-- ============================================================
DO $$
DECLARE
    v_src        TEXT;
    v_security   TEXT;
    v_config     TEXT[];
BEGIN
    SELECT pg_get_functiondef(p.oid),
           CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END,
           p.proconfig
      INTO v_src, v_security, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'create_sales_atomic';

    IF v_src IS NULL THEN
        RAISE EXCEPTION '[054] FAIL: create_sales_atomic bulunamadi';
    END IF;

    IF v_security IS DISTINCT FROM 'DEFINER' THEN
        RAISE EXCEPTION '[054] FAIL: create_sales_atomic SECURITY DEFINER degil (got: %)', v_security;
    END IF;

    IF v_config IS NULL OR NOT (v_config::text LIKE '%search_path%') THEN
        RAISE EXCEPTION '[054] FAIL: search_path SET edilmemis';
    END IF;

    IF v_src NOT LIKE '%check_rate_limit%sales_batch%' THEN
        RAISE EXCEPTION '[054] FAIL: check_rate_limit(sales_batch) satiri eklenmemis';
    END IF;

    -- check_rate_limit fonksiyonu hala DEFINER mi? (053 lockdown sonrasi
    -- zincirin kirilmadigini dogrula)
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'check_rate_limit'
           AND p.prosecdef = true
    ) THEN
        RAISE EXCEPTION '[054] FAIL: check_rate_limit SECURITY DEFINER kayboldu (rate-limit zinciri kiril)';
    END IF;

    RAISE NOTICE '[054] OK: create_sales_atomic rate-limit aktif | action=sales_batch | cooldown=1s | %', v_security;
END;
$$;
