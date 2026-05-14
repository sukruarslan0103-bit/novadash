-- ============================================================
-- 023 — EXPENSES WRITE PATH → RPC-ONLY
-- update_expense + soft_delete_expense
-- tenant_id auth.uid() → users.tenant_id ile resolve edilir.
-- Client tenant spoofing yapamaz.
-- ============================================================

-- ============================================================
-- update_expense(p_id, p_updates JSONB)
-- Whitelist: date, amount, description, category_id, category_name
-- Partial update (COALESCE).
-- ============================================================
CREATE OR REPLACE FUNCTION update_expense(
    p_id      UUID,
    p_updates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_auth_uid     UUID;
    v_tenant_id    UUID;
    v_existing     expenses%ROWTYPE;
    v_new_date     DATE;
    v_new_amount   NUMERIC(12,2);
    v_new_desc     TEXT;
    v_new_cat_id   UUID;
    v_new_cat_name TEXT;
    v_result       JSONB;
BEGIN
    -- ========================================================
    -- AUTH GUARD
    -- ========================================================
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

    -- ========================================================
    -- VALIDATION
    -- ========================================================
    IF p_id IS NULL THEN
        RAISE EXCEPTION 'Expense ID required';
    END IF;

    IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' THEN
        RAISE EXCEPTION 'Updates payload required';
    END IF;

    -- RATE LIMIT: 1 saniye
    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'update_expense', interval '1 second');

    -- ========================================================
    -- ACCESS CONTROL — kayit var mi + tenant es mi?
    -- ========================================================
    SELECT * INTO v_existing
    FROM expenses
    WHERE id = p_id AND tenant_id = v_tenant_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;

    -- ========================================================
    -- WHITELIST + COALESCE (partial update)
    -- ========================================================
    IF p_updates ? 'date' THEN
        v_new_date := NULLIF(p_updates->>'date','')::DATE;
    ELSE
        v_new_date := v_existing.date;
    END IF;

    IF p_updates ? 'amount' THEN
        v_new_amount := COALESCE((p_updates->>'amount')::NUMERIC, 0);
    ELSE
        v_new_amount := v_existing.amount;
    END IF;

    IF p_updates ? 'description' THEN
        v_new_desc := COALESCE(p_updates->>'description', '');
    ELSE
        v_new_desc := v_existing.description;
    END IF;

    IF p_updates ? 'category_id' THEN
        v_new_cat_id := NULLIF(p_updates->>'category_id','')::UUID;
    ELSE
        v_new_cat_id := v_existing.category_id;
    END IF;

    IF p_updates ? 'category_name' THEN
        v_new_cat_name := NULLIF(p_updates->>'category_name','');
    ELSE
        v_new_cat_name := v_existing.category_name;
    END IF;

    -- date NULL olamaz
    IF v_new_date IS NULL THEN
        RAISE EXCEPTION 'date cannot be null';
    END IF;

    -- ========================================================
    -- UPDATE
    -- ========================================================
    UPDATE expenses
       SET date          = v_new_date,
           amount        = v_new_amount,
           description   = v_new_desc,
           category_id   = v_new_cat_id,
           category_name = v_new_cat_name,
           updated_at    = now()
     WHERE id = p_id
       AND tenant_id = v_tenant_id
    RETURNING to_jsonb(expenses.*) INTO v_result;

    -- SUCCESS LOG
    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'update_expense', 'success',
        'Gider guncellendi',
        jsonb_build_object('expense_id', p_id)
    );

    RETURN jsonb_build_object(
        'success', true,
        'data', v_result
    );

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'update_expense', 'fail', SQLERRM,
        jsonb_build_object('expense_id', p_id)
    );
    RAISE EXCEPTION 'UPDATE_EXPENSE_FAILED: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION update_expense(UUID, JSONB) TO authenticated;


-- ============================================================
-- soft_delete_expense(p_id)
-- Mevcut soft_delete_record('expenses', p_id) wrapper.
-- ============================================================
CREATE OR REPLACE FUNCTION soft_delete_expense(
    p_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF p_id IS NULL THEN
        RAISE EXCEPTION 'Expense ID required';
    END IF;

    v_result := soft_delete_record('expenses', p_id);

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION soft_delete_expense(UUID) TO authenticated;
