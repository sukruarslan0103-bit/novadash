-- ============================================================
-- 046 — DB-SIDE COST SNAPSHOT (create_sales_atomic hardening)
--
-- Amac:
--   create_sales_atomic, satis aninda product_sales.cost icin
--   frontend'den gelen 'cost' degerini ARTIK kullanmaz.
--   Bunun yerine her satir icin server-side:
--     SELECT products.cost
--      WHERE id = product_id
--        AND tenant_id = p_tenant_id
--        AND is_deleted = false
--   sorgusu ile authoritative cost snapshot olusturulur.
--
-- Kararlar:
--   - Frontend cost gonderirse: SILENT IGNORE (backwards compatible).
--   - Product yok / tenant mismatch / is_deleted=true: RAISE EXCEPTION.
--   - product_sales.cost SATIS ANINDAKI DONMUS MALIYET olarak yazilir
--     (immutable snapshot; products.cost sonradan degisse de degismez).
--
-- KAPSAM DISI (bu fazda DEGISMEZ):
--   - Function signature (p_tenant_id UUID, p_sales JSONB)
--   - SECURITY INVOKER + search_path
--   - Idempotency (idempotency_key lookup yolu)
--   - Tenant resolve modeli (p_tenant_id parametre olarak alinmaya devam eder)
--   - KDV modeli
--   - restore_full_backup ve diger restore path'leri
--   - product_sales tablo semasi / indexler
--   - Analytics (get_sales_paginated zaten product_sales.cost'u okuyor)
--
-- Rollback:
--   Baseline'in eski D.7 body'sini tek CREATE OR REPLACE ile yeniden RUN.
--   Imza degismedigi icin call site etkilenmez.
-- ============================================================


CREATE OR REPLACE FUNCTION create_sales_atomic(
    p_tenant_id UUID,
    p_sales     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
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
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id is required';
    END IF;

    IF p_sales IS NULL OR jsonb_array_length(p_sales) = 0 THEN
        RAISE EXCEPTION 'At least one sale is required';
    END IF;

    FOR v_sale IN SELECT * FROM jsonb_array_elements(p_sales)
    LOOP
        v_ikey    := v_sale->>'idempotency_key';
        v_sale_id := NULL;
        v_is_new  := FALSE;

        IF v_ikey IS NOT NULL THEN
            SELECT id INTO v_sale_id
            FROM sales
            WHERE idempotency_key = v_ikey
              AND tenant_id   = p_tenant_id
              AND is_deleted  = false
            LIMIT 1;
        END IF;

        IF v_sale_id IS NULL THEN
            INSERT INTO sales (
                tenant_id, date, total, cash, card,
                notes, created_by, idempotency_key
            )
            VALUES (
                p_tenant_id,
                (v_sale->>'date')::DATE,
                COALESCE((v_sale->>'total')::NUMERIC, 0),
                COALESCE((v_sale->>'cash')::NUMERIC, 0),
                COALESCE((v_sale->>'card')::NUMERIC, 0),
                v_sale->>'notes',
                CASE WHEN v_sale->>'created_by' IS NOT NULL
                     THEN (v_sale->>'created_by')::UUID
                     ELSE NULL END,
                v_ikey
            )
            RETURNING id INTO v_sale_id;
            v_is_new := TRUE;
        END IF;

        IF v_sale_id IS NULL THEN CONTINUE; END IF;

        IF v_is_new THEN
            IF v_sale->'products' IS NOT NULL
               AND jsonb_array_length(v_sale->'products') > 0 THEN
                FOR v_product IN SELECT * FROM jsonb_array_elements(v_sale->'products')
                LOOP
                    v_product_id := (v_product->>'product_id')::UUID;

                    IF v_product_id IS NULL THEN
                        RAISE EXCEPTION 'product_id is required for sale line';
                    END IF;

                    -- 046: AUTHORITATIVE COST LOOKUP
                    -- Frontend'den gelen 'cost' alani burada YOK SAYILIR.
                    -- Cost = o anki products.cost (immutable historical snapshot).
                    SELECT p.cost
                      INTO v_snapshot_cost
                      FROM products p
                     WHERE p.id        = v_product_id
                       AND p.tenant_id = p_tenant_id
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
                        p_tenant_id, v_sale_id,
                        v_product_id,
                        (v_sale->>'date')::DATE,
                        COALESCE((v_product->>'quantity')::INT, 0),
                        COALESCE((v_product->>'unit_price')::NUMERIC, 0),
                        COALESCE((v_product->>'total')::NUMERIC, 0),
                        COALESCE(v_snapshot_cost, 0)   -- server-side snapshot
                    );
                END LOOP;
            END IF;
        END IF;

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
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE v_count INT;
BEGIN
    SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_sales_atomic';

    IF v_count = 0 THEN
        RAISE EXCEPTION 'KRITIK: create_sales_atomic kurulamadi';
    END IF;
    RAISE NOTICE 'OK: create_sales_atomic (046 cost snapshot) aktif';
END $$;
