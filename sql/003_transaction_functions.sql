-- ============================================================
-- 003 — Atomic Sale Creation
-- Tek transaction içinde sale + product_sales oluşturur.
-- Hem tekli satış hem toplu import için kullanılır.
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
    v_sale JSONB;
    v_product JSONB;
    v_sale_id UUID;
    v_results JSONB := '[]'::jsonb;
    v_sale_record JSONB;
BEGIN
    -- Validate
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_id is required';
    END IF;

    IF p_sales IS NULL OR jsonb_array_length(p_sales) = 0 THEN
        RAISE EXCEPTION 'At least one sale is required';
    END IF;

    FOR v_sale IN SELECT * FROM jsonb_array_elements(p_sales)
    LOOP
        -- Insert sale
        INSERT INTO sales (tenant_id, date, total, cash, card, notes, created_by)
        VALUES (
            p_tenant_id,
            (v_sale->>'date')::DATE,
            COALESCE((v_sale->>'total')::NUMERIC, 0),
            COALESCE((v_sale->>'cash')::NUMERIC, 0),
            COALESCE((v_sale->>'card')::NUMERIC, 0),
            v_sale->>'notes',
            CASE WHEN v_sale->>'created_by' IS NOT NULL
                 THEN (v_sale->>'created_by')::UUID
                 ELSE NULL END
        )
        RETURNING id INTO v_sale_id;

        -- Insert product_sales (if any)
        IF v_sale->'products' IS NOT NULL AND jsonb_array_length(v_sale->'products') > 0 THEN
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