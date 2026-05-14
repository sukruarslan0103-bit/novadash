-- ============================================================
-- 004 — Idempotency Key (DB-level duplicate prevention)
-- Aynı satış ne olursa olsun 1 kez yazılır.
-- Soft-deleted kayıtlar duplicate kontrolüne girmez.
-- ============================================================

-- 1. Alan
ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- 2. Partial unique index (SADECE is_deleted=false kayıtları benzersiz)
DROP INDEX IF EXISTS sales_idempotency_unique;
CREATE UNIQUE INDEX IF NOT EXISTS sales_idempotency_unique
ON sales(idempotency_key)
WHERE is_deleted = false;

-- ============================================================
-- 3. create_sales_atomic — duplicate kontrol soft-delete hariç
-- ============================================================
CREATE OR REPLACE FUNCTION create_sales_atomic(
    p_tenant_id UUID,
    p_sales JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_sale        JSONB;
    v_product     JSONB;
    v_sale_id     UUID;
    v_ikey        TEXT;
    v_results     JSONB := '[]'::jsonb;
    v_sale_record JSONB;
    v_is_new      BOOLEAN;
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

        -- DUPLICATE KONTROL: sadece is_deleted=false kayıtlar duplicate sayılır
        IF v_ikey IS NOT NULL THEN
            SELECT id INTO v_sale_id
            FROM sales
            WHERE idempotency_key = v_ikey
              AND tenant_id     = p_tenant_id
              AND is_deleted    = false
            LIMIT 1;
        END IF;

        -- INSERT: aktif duplicate yoksa yeni kayıt
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

        IF v_sale_id IS NULL THEN
            CONTINUE;
        END IF;

        -- product_sales sadece yeni insert için
        IF v_is_new THEN
            IF v_sale->'products' IS NOT NULL
               AND jsonb_array_length(v_sale->'products') > 0 THEN
                FOR v_product IN SELECT * FROM jsonb_array_elements(v_sale->'products')
                LOOP
                    INSERT INTO product_sales (
                        tenant_id, sale_id, product_id, date,
                        quantity, unit_price, total, cost
                    )
                    VALUES (
                        p_tenant_id,
                        v_sale_id,
                        (v_product->>'product_id')::UUID,
                        (v_sale->>'date')::DATE,
                        COALESCE((v_product->>'quantity')::INT, 0),
                        COALESCE((v_product->>'unit_price')::NUMERIC, 0),
                        COALESCE((v_product->>'total')::NUMERIC, 0),
                        COALESCE((v_product->>'cost')::NUMERIC, 0)
                    );
                END LOOP;
            END IF;
        END IF;

        -- Sadece yeni insert edilen satışlar döner
        IF v_is_new THEN
            SELECT jsonb_build_object(
                'id',          s.id,
                'tenant_id',   s.tenant_id,
                'date',        s.date,
                'total',       s.total,
                'cash',        s.cash,
                'card',        s.card,
                'notes',       s.notes,
                'created_by',  s.created_by,
                'created_at',  s.created_at,
                'is_deleted',  s.is_deleted,
                'product_sales', COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'id',         ps.id,
                        'sale_id',    ps.sale_id,
                        'product_id', ps.product_id,
                        'date',       ps.date,
                        'quantity',   ps.quantity,
                        'unit_price', ps.unit_price,
                        'total',      ps.total,
                        'cost',       ps.cost
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
