-- ============================================================
-- 003 — Atomic Sale Creation
-- Tek transaction içinde sale + product_sales oluşturur.
-- Hem tekli satış hem toplu import için kullanılır.
--
-- Contract:
--   Sadece (p_sales JSONB) alır.
--   tenant_id → auth.uid() üzerinden users tablosundan resolve edilir.
--   created_by = auth.uid() (her zaman gerçek kullanıcı).
--   Client tenant_id / created_by spoofing yapamaz.
-- ============================================================

CREATE OR REPLACE FUNCTION create_sales_atomic(
    p_sales JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_sale      JSONB;
    v_product   JSONB;
    v_sale_id   UUID;
    v_results   JSONB := '[]'::jsonb;
    v_sale_record JSONB;
BEGIN
    -- === AUTH GUARD ===
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

    -- === INPUT VALIDATION ===
    IF p_sales IS NULL OR jsonb_array_length(p_sales) = 0 THEN
        RAISE EXCEPTION 'At least one sale is required';
    END IF;

    -- === SALE LOOP ===
    FOR v_sale IN SELECT * FROM jsonb_array_elements(p_sales)
    LOOP
        INSERT INTO sales (tenant_id, date, total, cash, card, notes, created_by)
        VALUES (
            v_tenant_id,
            (v_sale->>'date')::DATE,
            COALESCE((v_sale->>'total')::NUMERIC, 0),
            COALESCE((v_sale->>'cash')::NUMERIC, 0),
            COALESCE((v_sale->>'card')::NUMERIC, 0),
            v_sale->>'notes',
            v_auth_uid
        )
        RETURNING id INTO v_sale_id;

        -- Insert product_sales (varsa)
        IF v_sale->'products' IS NOT NULL AND jsonb_array_length(v_sale->'products') > 0 THEN
            INSERT INTO product_sales (
                tenant_id, sale_id, product_id, date,
                quantity, unit_price, total, cost
            )
            SELECT
                v_tenant_id,
                v_sale_id,
                (prod->>'product_id')::UUID,
                (v_sale->>'date')::DATE,
                COALESCE((prod->>'quantity')::INT, 0),
                COALESCE((prod->>'unit_price')::NUMERIC, 0),
                COALESCE((prod->>'total')::NUMERIC, 0),
                COALESCE((prod->>'cost')::NUMERIC, 0)
            FROM jsonb_array_elements(v_sale->'products') AS prod;
        END IF;

        -- Build result with embedded product_sales
        SELECT jsonb_build_object(
            'id', s.id,
            'tenant_id', s.tenant_id,
            'date', s.date,
            'total', s.total,
            'cash', s.cash,
            'card', s.card,
            'notes', s.notes,
            'created_by', s.created_by,
            'created_at', s.created_at,
            'is_deleted', s.is_deleted,
            'product_sales', COALESCE(
                (SELECT jsonb_agg(jsonb_build_object(
                    'id', ps.id,
                    'sale_id', ps.sale_id,
                    'product_id', ps.product_id,
                    'date', ps.date,
                    'quantity', ps.quantity,
                    'unit_price', ps.unit_price,
                    'total', ps.total,
                    'cost', ps.cost
                )) FROM product_sales ps WHERE ps.sale_id = s.id),
                '[]'::jsonb
            )
        ) INTO v_sale_record
        FROM sales s WHERE s.id = v_sale_id;

        v_results := v_results || v_sale_record;
    END LOOP;

    RETURN v_results;
END;
$$;
