-- ============================================================
-- 043 — RESTORE_FULL_BACKUP: FULL RESTORE (wipe + insert)
--
-- Tenant'in TUM verisini siler ve yedekten birebir yukler.
-- Skip / EXISTS / unique_violation logic YOK.
-- ============================================================

CREATE OR REPLACE FUNCTION restore_full_backup(backup JSONB, tenant UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id UUID;
    v_auth_uid  UUID;
    v_data      JSONB;

    v_rm        JSONB;
    v_product   JSONB;
    v_sale      JSONB;
    v_ps        JSONB;
    v_pi        JSONB;
    v_expense   JSONB;

    v_sale_date    DATE;
    v_idem_key     TEXT;

    v_inserted_raw_materials  INT := 0;
    v_inserted_products       INT := 0;
    v_inserted_sales          INT := 0;
    v_inserted_product_sales  INT := 0;
    v_inserted_purchase_items INT := 0;
    v_inserted_expenses       INT := 0;
BEGIN
    -- ============ AUTH ============
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id FROM users u WHERE u.id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found for user';
    END IF;

    IF tenant IS NOT NULL AND tenant <> v_tenant_id THEN
        RAISE EXCEPTION 'Unauthorized: tenant mismatch';
    END IF;

    IF backup IS NULL OR jsonb_typeof(backup) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_BACKUP';
    END IF;

    v_data := COALESCE(backup->'data', backup);

    -- ============ WIPE (FK sirasina gore: child once) ============
    DELETE FROM product_sales  WHERE tenant_id = v_tenant_id;
    DELETE FROM sales          WHERE tenant_id = v_tenant_id;
    DELETE FROM purchase_items WHERE tenant_id = v_tenant_id;
    DELETE FROM expenses       WHERE tenant_id = v_tenant_id;
    DELETE FROM products       WHERE tenant_id = v_tenant_id;
    DELETE FROM raw_materials  WHERE tenant_id = v_tenant_id;

    -- ============ 1) RAW_MATERIALS ============
    IF jsonb_typeof(v_data->'raw_materials') = 'array' THEN
        FOR v_rm IN SELECT * FROM jsonb_array_elements(v_data->'raw_materials')
        LOOP
            IF v_rm->>'name' IS NULL OR TRIM(v_rm->>'name') = '' THEN
                CONTINUE;
            END IF;

            INSERT INTO raw_materials (
                id, tenant_id, name, unit, cost, vat_rate,
                is_active, is_deleted, base_unit
            ) VALUES (
                COALESCE(NULLIF(v_rm->>'id','')::uuid, gen_random_uuid()),
                v_tenant_id,
                v_rm->>'name',
                COALESCE(v_rm->>'unit', 'gr'),
                COALESCE((v_rm->>'cost')::numeric, 0),
                COALESCE((v_rm->>'vat_rate')::numeric, 20),
                COALESCE((v_rm->>'is_active')::boolean, true),
                COALESCE((v_rm->>'is_deleted')::boolean, false),
                v_rm->>'base_unit'
            );
            v_inserted_raw_materials := v_inserted_raw_materials + 1;
        END LOOP;
    END IF;

    -- ============ 2) PRODUCTS ============
    IF jsonb_typeof(v_data->'products') = 'array' THEN
        FOR v_product IN SELECT * FROM jsonb_array_elements(v_data->'products')
        LOOP
            IF v_product->>'name' IS NULL OR TRIM(v_product->>'name') = '' THEN
                CONTINUE;
            END IF;

            INSERT INTO products (
                id, tenant_id, name, price, cost, is_active, is_deleted,
                category_id, category_name
            ) VALUES (
                COALESCE(NULLIF(v_product->>'id','')::uuid, gen_random_uuid()),
                v_tenant_id,
                v_product->>'name',
                COALESCE((v_product->>'price')::numeric, 0),
                COALESCE((v_product->>'cost')::numeric, 0),
                COALESCE((v_product->>'is_active')::boolean, true),
                COALESCE((v_product->>'is_deleted')::boolean, false),
                NULLIF(v_product->>'category_id','')::uuid,
                COALESCE(
                    v_product->>'category_name',
                    (SELECT name FROM categories
                     WHERE id = NULLIF(v_product->>'category_id','')::uuid LIMIT 1)
                )
            );
            v_inserted_products := v_inserted_products + 1;
        END LOOP;
    END IF;

    -- ============ 3) SALES ============
    IF jsonb_typeof(v_data->'sales') = 'array' THEN
        FOR v_sale IN SELECT * FROM jsonb_array_elements(v_data->'sales')
        LOOP
            IF v_sale->>'date' IS NULL OR v_sale->>'total' IS NULL THEN
                CONTINUE;
            END IF;

            v_sale_date := (v_sale->>'date')::date;

            v_idem_key := COALESCE(
                NULLIF(v_sale->>'idempotency_key', ''),
                'import_' || gen_random_uuid()::text
            );

            INSERT INTO sales (
                id, tenant_id, date, total, cash, card, notes, is_deleted, idempotency_key
            ) VALUES (
                COALESCE(NULLIF(v_sale->>'id','')::uuid, gen_random_uuid()),
                v_tenant_id,
                v_sale_date,
                COALESCE((v_sale->>'total')::numeric, 0),
                COALESCE((v_sale->>'cash')::numeric, 0),
                COALESCE((v_sale->>'card')::numeric, 0),
                v_sale->>'notes',
                COALESCE((v_sale->>'is_deleted')::boolean, false),
                v_idem_key
            );
            v_inserted_sales := v_inserted_sales + 1;
        END LOOP;
    END IF;

    -- ============ 4) PRODUCT_SALES ============
    IF jsonb_typeof(v_data->'product_sales') = 'array' THEN
        FOR v_ps IN SELECT * FROM jsonb_array_elements(v_data->'product_sales')
        LOOP
            IF v_ps->>'sale_id' IS NULL OR v_ps->>'product_id' IS NULL THEN
                CONTINUE;
            END IF;

            SELECT date INTO v_sale_date
            FROM sales
            WHERE id = NULLIF(v_ps->>'sale_id','')::uuid;

            INSERT INTO product_sales (
                id, tenant_id, sale_id, product_id, date,
                quantity, unit_price, total, cost
            ) VALUES (
                COALESCE(NULLIF(v_ps->>'id','')::uuid, gen_random_uuid()),
                v_tenant_id,
                NULLIF(v_ps->>'sale_id','')::uuid,
                NULLIF(v_ps->>'product_id','')::uuid,
                COALESCE((v_ps->>'date')::date, v_sale_date),
                COALESCE((v_ps->>'quantity')::int, 0),
                COALESCE((v_ps->>'unit_price')::numeric, 0),
                COALESCE((v_ps->>'total')::numeric, 0),
                COALESCE(
                    (v_ps->>'cost')::numeric,
                    (SELECT cost FROM products WHERE id = NULLIF(v_ps->>'product_id','')::uuid),
                    0
                )
            );
            v_inserted_product_sales := v_inserted_product_sales + 1;
        END LOOP;
    END IF;

    -- ============ 5) PURCHASE_ITEMS ============
    IF jsonb_typeof(v_data->'purchase_items') = 'array' THEN
        FOR v_pi IN SELECT * FROM jsonb_array_elements(v_data->'purchase_items')
        LOOP
            IF v_pi->>'raw_material_id' IS NULL THEN
                CONTINUE;
            END IF;

            INSERT INTO purchase_items (
                id, tenant_id, raw_material_id,
                quantity, unit, unit_cost, line_total,
                vat_rate, discount_rate,
                base_quantity, base_unit_cost,
                general_discount_amount, general_discount_type,
                note, invoice_date, invoice_no,
                is_deleted, created_at
            ) VALUES (
                COALESCE(NULLIF(v_pi->>'id','')::uuid, gen_random_uuid()),
                v_tenant_id,
                NULLIF(v_pi->>'raw_material_id','')::uuid,
                COALESCE((v_pi->>'quantity')::numeric, 0),
                v_pi->>'unit',
                COALESCE((v_pi->>'unit_cost')::numeric, 0),
                COALESCE((v_pi->>'line_total')::numeric, 0),
                COALESCE((v_pi->>'vat_rate')::numeric, 0),
                COALESCE((v_pi->>'discount_rate')::numeric, 0),
                NULLIF(v_pi->>'base_quantity','')::numeric,
                NULLIF(v_pi->>'base_unit_cost','')::numeric,
                COALESCE((v_pi->>'general_discount_amount')::numeric, 0),
                COALESCE(v_pi->>'general_discount_type', 'amount'),
                v_pi->>'note',
                NULLIF(v_pi->>'invoice_date','')::date,
                NULLIF(v_pi->>'invoice_no','')::bigint,
                COALESCE((v_pi->>'is_deleted')::boolean, false),
                COALESCE((v_pi->>'created_at')::timestamptz, now())
            );
            v_inserted_purchase_items := v_inserted_purchase_items + 1;
        END LOOP;
    END IF;

    -- ============ 6) EXPENSES ============
    IF jsonb_typeof(v_data->'expenses') = 'array' THEN
        FOR v_expense IN SELECT * FROM jsonb_array_elements(v_data->'expenses')
        LOOP
            IF v_expense->>'date' IS NULL OR v_expense->>'amount' IS NULL THEN
                CONTINUE;
            END IF;

            INSERT INTO expenses (
                id, tenant_id, date, amount, description, category_id, category_name
            ) VALUES (
                COALESCE(NULLIF(v_expense->>'id','')::uuid, gen_random_uuid()),
                v_tenant_id,
                (v_expense->>'date')::date,
                COALESCE((v_expense->>'amount')::numeric, 0),
                v_expense->>'description',
                NULLIF(v_expense->>'category_id','')::uuid,
                COALESCE(
                    v_expense->>'category_name',
                    (SELECT name FROM categories
                     WHERE id = NULLIF(v_expense->>'category_id','')::uuid LIMIT 1)
                )
            );
            v_inserted_expenses := v_inserted_expenses + 1;
        END LOOP;
    END IF;

    -- ============ LOG + RETURN ============
    BEGIN
        PERFORM write_system_log(
            v_tenant_id, v_auth_uid, 'restore', 'success',
            'Full restore tamamlandi (wipe + insert)',
            jsonb_build_object(
                'inserted_raw_materials',  v_inserted_raw_materials,
                'inserted_products',       v_inserted_products,
                'inserted_sales',          v_inserted_sales,
                'inserted_product_sales',  v_inserted_product_sales,
                'inserted_purchase_items', v_inserted_purchase_items,
                'inserted_expenses',       v_inserted_expenses
            )
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'inserted', jsonb_build_object(
            'raw_materials',  v_inserted_raw_materials,
            'products',       v_inserted_products,
            'sales',          v_inserted_sales,
            'product_sales',  v_inserted_product_sales,
            'purchase_items', v_inserted_purchase_items,
            'expenses',       v_inserted_expenses
        )
    );

EXCEPTION WHEN OTHERS THEN
    BEGIN
        PERFORM write_system_log(
            COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
            v_auth_uid, 'restore', 'fail', SQLERRM, '{}'::jsonb
        );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE EXCEPTION 'RESTORE_FAILED: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION restore_full_backup(JSONB, UUID) TO authenticated;
