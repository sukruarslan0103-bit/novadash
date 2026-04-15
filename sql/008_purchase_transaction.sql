-- ============================================================
-- CREATE PURCHASE + UPDATE PRODUCT COST — Atomic transaction
-- SECURITY: auth.uid() ile tenant dogrulama
-- ============================================================

CREATE OR REPLACE FUNCTION create_purchase_and_update_product_cost(
    p_product_id UUID,
    p_quantity NUMERIC,
    p_total NUMERIC,
    p_vat NUMERIC,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth_uid   UUID;
    v_tenant_id  UUID;
    v_net_total  NUMERIC;
    v_unit_cost  NUMERIC;
    v_purchase_id UUID;
BEGIN
    -- ========================================================
    -- AUTH GUARD
    -- ========================================================
    v_auth_uid := auth.uid();

    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    SELECT tenant_id INTO v_tenant_id
    FROM users
    WHERE id = v_auth_uid;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found';
    END IF;

    -- ========================================================
    -- VALIDATION
    -- ========================================================
    -- RATE LIMIT: 2 saniye
    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'purchase', interval '2 seconds');

    IF p_product_id IS NULL THEN
        RAISE EXCEPTION 'product_id required';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'Invalid quantity';
    END IF;

    IF p_total IS NULL OR p_total <= 0 THEN
        RAISE EXCEPTION 'Invalid total';
    END IF;

    -- Urun bu tenant'a ait mi?
    IF NOT EXISTS (
        SELECT 1 FROM products
        WHERE id = p_product_id AND tenant_id = v_tenant_id
    ) THEN
        RAISE EXCEPTION 'Product not found';
    END IF;

    -- ========================================================
    -- IDEMPOTENCY CHECK
    -- ========================================================
    IF p_idempotency_key IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM purchases
            WHERE idempotency_key = p_idempotency_key
              AND tenant_id = v_tenant_id
        ) THEN
            -- Zaten kayitli, duplicate gondermis
            RETURN jsonb_build_object(
                'success', true,
                'duplicate', true,
                'message', 'Already recorded'
            );
        END IF;
    END IF;

    -- ========================================================
    -- HESAPLAMA
    -- ========================================================
    v_net_total := p_total + (p_total * COALESCE(p_vat, 0) / 100);
    v_unit_cost := v_net_total / p_quantity;

    -- ========================================================
    -- 1) PURCHASE INSERT
    -- ========================================================
    INSERT INTO purchases (
        tenant_id, product_id, quantity, total_price,
        vat_rate, net_total, unit_cost, idempotency_key
    ) VALUES (
        v_tenant_id, p_product_id, p_quantity, p_total,
        COALESCE(p_vat, 0), v_net_total, v_unit_cost, p_idempotency_key
    )
    RETURNING id INTO v_purchase_id;

    -- ========================================================
    -- 2) PRODUCT COST UPDATE (son alis fiyati)
    -- ========================================================
    UPDATE products
    SET cost = v_unit_cost,
        updated_at = now()
    WHERE id = p_product_id
      AND tenant_id = v_tenant_id;

    -- SUCCESS LOG
    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'purchase', 'success',
        'Alis kaydedildi',
        jsonb_build_object(
            'purchase_id', v_purchase_id,
            'product_id', p_product_id,
            'quantity', p_quantity,
            'unit_cost', v_unit_cost,
            'net_total', v_net_total
        )
    );

    -- ========================================================
    -- RETURN
    -- ========================================================
    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'purchase_id', v_purchase_id,
        'unit_cost', v_unit_cost,
        'net_total', v_net_total
    );

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'purchase', 'fail', SQLERRM, '{}'::jsonb
    );
    RAISE EXCEPTION 'PURCHASE_FAILED: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION create_purchase_and_update_product_cost(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT) TO authenticated;
