-- ============================================================
-- SOFT DELETE — Atomic: select + audit + delete tek transaction
-- SECURITY: auth.uid() ile tenant dogrulama
-- ============================================================

CREATE OR REPLACE FUNCTION soft_delete_record(
    p_table TEXT,
    p_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_record    JSONB;
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
    -- RATE LIMIT: 1 saniye
    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'delete', interval '1 second');

    IF p_table NOT IN ('products', 'sales', 'product_sales', 'expenses', 'categories', 'purchases') THEN
        RAISE EXCEPTION 'Invalid table: %', p_table;
    END IF;

    IF p_id IS NULL THEN
        RAISE EXCEPTION 'Record ID required';
    END IF;

    -- ========================================================
    -- 1) KAYIT CEK (tenant kontrolu dahil)
    -- ========================================================
    EXECUTE format(
        'SELECT to_jsonb(t.*) FROM %I t WHERE t.id = $1 AND t.tenant_id = $2',
        p_table
    ) INTO v_record USING p_id, v_tenant_id;

    IF v_record IS NULL THEN
        RAISE EXCEPTION 'Record not found';
    END IF;

    -- ========================================================
    -- 2) AUDIT — deleted_records tablosuna yaz
    -- ========================================================
    INSERT INTO deleted_records (
        tenant_id, table_name, record_id, record_data, deleted_by
    ) VALUES (
        v_tenant_id, p_table, p_id, v_record, v_auth_uid
    );

    -- ========================================================
    -- 3) DELETE
    -- ========================================================
    EXECUTE format(
        'DELETE FROM %I WHERE id = $1 AND tenant_id = $2',
        p_table
    ) USING p_id, v_tenant_id;

    -- SUCCESS LOG
    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'delete', 'success',
        'Kayit silindi: ' || p_table,
        jsonb_build_object('table', p_table, 'record_id', p_id)
    );

    -- ========================================================
    -- RETURN
    -- ========================================================
    RETURN jsonb_build_object(
        'success', true,
        'table', p_table,
        'record_id', p_id
    );

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'delete', 'fail', SQLERRM,
        jsonb_build_object('table', p_table, 'record_id', p_id)
    );
    RAISE EXCEPTION 'SOFT_DELETE_FAILED: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION soft_delete_record(TEXT, UUID) TO authenticated;
