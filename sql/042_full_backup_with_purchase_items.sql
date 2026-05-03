-- ============================================================
-- 042 — FULL BACKUP: export_all_data + restore_full_backup
--   raw_materials + purchase_items eklendi.
--   Mevcut logic korundu; yeni 2 tablo entegre edildi.
--
-- FK SIRA (restore):
--   1. raw_materials   (parent of product_recipes, purchase_items)
--   2. products        (parent of product_sales)
--   3. sales           (parent of product_sales)
--   4. product_sales   (child of products + sales)
--   5. purchase_items  (child of raw_materials)
--   6. expenses        (bagimsiz)
--
-- Tenant: server-side (auth.uid -> users.tenant_id).
-- Idempotent: BEGIN/EXCEPTION unique_violation -> skipped++.
-- ============================================================


-- ============================================================
-- 1) EXPORT — purchase_items + raw_materials eklendi
-- ============================================================
CREATE OR REPLACE FUNCTION public.export_all_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid     uuid := auth.uid();
    v_tenant  uuid;
    v_payload jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant FROM public.users WHERE id = v_uid;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    SELECT jsonb_build_object(
        'export_version', '1.0',
        'export_date',    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'tenant_id',      v_tenant,
        'data', jsonb_build_object(
            'categories',     COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at)
                                         FROM public.categories c
                                         WHERE c.tenant_id = v_tenant), '[]'::jsonb),
            'raw_materials',  COALESCE((SELECT jsonb_agg(to_jsonb(rm) ORDER BY rm.created_at)
                                         FROM public.raw_materials rm
                                         WHERE rm.tenant_id = v_tenant), '[]'::jsonb),
            'products',       COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at)
                                         FROM public.products p
                                         WHERE p.tenant_id = v_tenant), '[]'::jsonb),
            'sales',          COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at)
                                         FROM public.sales s
                                         WHERE s.tenant_id = v_tenant), '[]'::jsonb),
            'product_sales',  COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.created_at)
                                         FROM public.product_sales ps
                                         WHERE ps.tenant_id = v_tenant), '[]'::jsonb),
            'purchase_items', COALESCE((SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.created_at)
                                         FROM public.purchase_items pi
                                         WHERE pi.tenant_id = v_tenant), '[]'::jsonb),
            'expenses',       COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                                         FROM public.expenses e
                                         WHERE e.tenant_id = v_tenant), '[]'::jsonb),
            'events',         COALESCE((SELECT jsonb_agg(to_jsonb(ev) ORDER BY ev.created_at)
                                         FROM public.events ev
                                         WHERE ev.tenant_id = v_tenant), '[]'::jsonb),
            'tasks',          COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
                                         FROM public.tasks t
                                         WHERE t.tenant_id = v_tenant), '[]'::jsonb),
            'settings',       COALESCE((SELECT jsonb_agg(to_jsonb(st))
                                         FROM public.settings st
                                         WHERE st.tenant_id = v_tenant), '[]'::jsonb)
        )
    ) INTO v_payload;

    RETURN v_payload;
END;
$$;

GRANT EXECUTE ON FUNCTION public.export_all_data() TO authenticated;


-- ============================================================
-- 2) RESTORE — raw_materials + purchase_items eklendi
--    Mevcut blocklar (products/sales/product_sales/expenses) KORUNDU.
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

    v_rm        JSONB;
    v_product   JSONB;
    v_sale      JSONB;
    v_ps        JSONB;
    v_pi        JSONB;
    v_expense   JSONB;

    v_old_rm_id      UUID;
    v_new_rm_id      UUID;
    v_old_product_id UUID;
    v_new_product_id UUID;
    v_old_sale_id    UUID;
    v_new_sale_id    UUID;

    v_sale_date    DATE;
    v_backup_notes TEXT;
    v_idem_key     TEXT;

    v_inserted_raw_materials  INT := 0;
    v_inserted_products       INT := 0;
    v_inserted_sales          INT := 0;
    v_inserted_product_sales  INT := 0;
    v_inserted_purchase_items INT := 0;
    v_inserted_expenses       INT := 0;

    v_skipped_raw_materials   INT := 0;
    v_skipped_products        INT := 0;
    v_skipped_sales           INT := 0;
    v_skipped_product_sales   INT := 0;
    v_skipped_purchase_items  INT := 0;
    v_skipped_expenses        INT := 0;

    v_rm_map      JSONB := '{}'::jsonb;
    v_product_map JSONB := '{}'::jsonb;
    v_sale_map    JSONB := '{}'::jsonb;
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

    -- ============ 1) RAW_MATERIALS (FK parent: products/recipes/purchase_items) ============
    IF jsonb_typeof(backup->'raw_materials') = 'array' THEN
        FOR v_rm IN SELECT * FROM jsonb_array_elements(backup->'raw_materials')
        LOOP
            IF v_rm->>'name' IS NULL OR TRIM(v_rm->>'name') = '' THEN
                v_skipped_raw_materials := v_skipped_raw_materials + 1;
                CONTINUE;
            END IF;

            v_old_rm_id := NULLIF(v_rm->>'id','')::uuid;
            v_new_rm_id := NULL;

            SELECT id INTO v_new_rm_id
            FROM raw_materials
            WHERE tenant_id = v_tenant_id
              AND name = v_rm->>'name'
            LIMIT 1;

            IF v_new_rm_id IS NOT NULL THEN
                v_skipped_raw_materials := v_skipped_raw_materials + 1;
            ELSE
                BEGIN
                    INSERT INTO raw_materials (
                        tenant_id, name, unit, cost, vat_rate,
                        is_active, is_deleted, base_unit
                    ) VALUES (
                        v_tenant_id,
                        v_rm->>'name',
                        COALESCE(v_rm->>'unit', 'gr'),
                        COALESCE((v_rm->>'cost')::numeric, 0),
                        COALESCE((v_rm->>'vat_rate')::numeric, 20),
                        COALESCE((v_rm->>'is_active')::boolean, true),
                        COALESCE((v_rm->>'is_deleted')::boolean, false),
                        v_rm->>'base_unit'
                    )
                    RETURNING id INTO v_new_rm_id;
                    v_inserted_raw_materials := v_inserted_raw_materials + 1;
                EXCEPTION WHEN unique_violation THEN
                    v_skipped_raw_materials := v_skipped_raw_materials + 1;
                    SELECT id INTO v_new_rm_id
                    FROM raw_materials
                    WHERE tenant_id = v_tenant_id
                      AND name = v_rm->>'name'
                    LIMIT 1;
                END;
            END IF;

            IF v_old_rm_id IS NOT NULL AND v_new_rm_id IS NOT NULL THEN
                v_rm_map := v_rm_map || jsonb_build_object(v_old_rm_id::text, v_new_rm_id::text);
            END IF;
        END LOOP;
    END IF;

    -- ============ 2) PRODUCTS ============
    IF jsonb_typeof(backup->'products') = 'array' THEN
        FOR v_product IN SELECT * FROM jsonb_array_elements(backup->'products')
        LOOP
            IF v_product->>'name' IS NULL OR TRIM(v_product->>'name') = '' THEN
                v_skipped_products := v_skipped_products + 1;
                CONTINUE;
            END IF;

            v_old_product_id := NULLIF(v_product->>'id','')::uuid;
            v_new_product_id := NULL;

            SELECT id INTO v_new_product_id
            FROM products
            WHERE tenant_id = v_tenant_id
              AND name = v_product->>'name'
            LIMIT 1;

            IF v_new_product_id IS NOT NULL THEN
                v_skipped_products := v_skipped_products + 1;
            ELSE
                BEGIN
                    INSERT INTO products (
                        tenant_id, name, price, cost, is_active, is_deleted,
                        category_id, category_name
                    ) VALUES (
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
                             WHERE id = NULLIF(v_product->>'category_id','')::uuid
                             LIMIT 1)
                        )
                    )
                    RETURNING id INTO v_new_product_id;
                    v_inserted_products := v_inserted_products + 1;
                EXCEPTION WHEN unique_violation THEN
                    v_skipped_products := v_skipped_products + 1;
                    SELECT id INTO v_new_product_id
                    FROM products
                    WHERE tenant_id = v_tenant_id
                      AND name = v_product->>'name'
                    LIMIT 1;
                END;
            END IF;

            IF v_old_product_id IS NOT NULL AND v_new_product_id IS NOT NULL THEN
                v_product_map := v_product_map || jsonb_build_object(v_old_product_id::text, v_new_product_id::text);
            END IF;
        END LOOP;
    END IF;

    -- ============ 3) SALES ============
    IF jsonb_typeof(backup->'sales') = 'array' THEN
        FOR v_sale IN SELECT * FROM jsonb_array_elements(backup->'sales')
        LOOP
            IF v_sale->>'date' IS NULL OR v_sale->>'total' IS NULL THEN
                v_skipped_sales := v_skipped_sales + 1;
                CONTINUE;
            END IF;

            v_old_sale_id  := NULLIF(v_sale->>'id','')::uuid;
            v_new_sale_id  := NULL;
            v_sale_date    := (v_sale->>'date')::date;
            v_backup_notes := v_sale->>'notes';

            v_idem_key := md5(
                v_tenant_id::text || '|' ||
                v_sale_date::text  || '|' ||
                COALESCE((v_sale->>'total')::numeric, 0)::text || '|' ||
                COALESCE((v_sale->>'cash')::numeric, 0)::text  || '|' ||
                COALESCE((v_sale->>'card')::numeric, 0)::text  || '|' ||
                COALESCE(v_backup_notes, '')
            );

            INSERT INTO sales (
                tenant_id, date, total, cash, card, notes, is_deleted, idempotency_key
            ) VALUES (
                v_tenant_id,
                v_sale_date,
                COALESCE((v_sale->>'total')::numeric, 0),
                COALESCE((v_sale->>'cash')::numeric, 0),
                COALESCE((v_sale->>'card')::numeric, 0),
                v_backup_notes,
                false,
                v_idem_key
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id INTO v_new_sale_id;

            IF v_new_sale_id IS NULL THEN
                v_skipped_sales := v_skipped_sales + 1;
                SELECT id INTO v_new_sale_id
                FROM sales
                WHERE tenant_id = v_tenant_id
                  AND idempotency_key = v_idem_key
                LIMIT 1;
            ELSE
                v_inserted_sales := v_inserted_sales + 1;
            END IF;

            IF v_old_sale_id IS NOT NULL AND v_new_sale_id IS NOT NULL THEN
                v_sale_map := v_sale_map || jsonb_build_object(v_old_sale_id::text, v_new_sale_id::text);
            END IF;
        END LOOP;
    END IF;

    -- ============ 4) PRODUCT_SALES ============
    IF jsonb_typeof(backup->'product_sales') = 'array' THEN
        FOR v_ps IN SELECT * FROM jsonb_array_elements(backup->'product_sales')
        LOOP
            IF v_ps->>'sale_id' IS NULL OR v_ps->>'product_id' IS NULL THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            v_new_sale_id := NULLIF(v_sale_map->>(v_ps->>'sale_id'),'')::uuid;
            IF v_new_sale_id IS NULL THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            v_new_product_id := NULLIF(v_product_map->>(v_ps->>'product_id'),'')::uuid;
            IF v_new_product_id IS NULL THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            IF EXISTS (
                SELECT 1 FROM product_sales
                WHERE sale_id = v_new_sale_id
                  AND product_id = v_new_product_id
            ) THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            SELECT date INTO v_sale_date FROM sales WHERE id = v_new_sale_id;

            BEGIN
                INSERT INTO product_sales (
                    tenant_id, sale_id, product_id, date,
                    quantity, unit_price, total, cost
                ) VALUES (
                    v_tenant_id, v_new_sale_id, v_new_product_id, v_sale_date,
                    COALESCE((v_ps->>'quantity')::int, 0),
                    COALESCE((v_ps->>'unit_price')::numeric, 0),
                    COALESCE((v_ps->>'total')::numeric, 0),
                    COALESCE(
                        (v_ps->>'cost')::numeric,
                        (SELECT cost FROM products WHERE id = v_new_product_id),
                        0
                    )
                );
                v_inserted_product_sales := v_inserted_product_sales + 1;
            EXCEPTION WHEN unique_violation THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
            END;
        END LOOP;
    END IF;

    -- ============ 5) PURCHASE_ITEMS (FK: raw_materials) ============
    IF jsonb_typeof(backup->'purchase_items') = 'array' THEN
        FOR v_pi IN SELECT * FROM jsonb_array_elements(backup->'purchase_items')
        LOOP
            IF v_pi->>'raw_material_id' IS NULL THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
                CONTINUE;
            END IF;

            -- raw_material_id remap
            v_new_rm_id := NULLIF(v_rm_map->>(v_pi->>'raw_material_id'),'')::uuid;
            IF v_new_rm_id IS NULL THEN
                -- Mevcut tenantta zaten var mi (rm_map'e yazilmamis ama isim eslesir)?
                -- Fallback: id direkt mevcut tenantta varsa kullan.
                SELECT id INTO v_new_rm_id
                FROM raw_materials
                WHERE id = NULLIF(v_pi->>'raw_material_id','')::uuid
                  AND tenant_id = v_tenant_id
                LIMIT 1;
            END IF;
            IF v_new_rm_id IS NULL THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
                CONTINUE;
            END IF;

            BEGIN
                INSERT INTO purchase_items (
                    tenant_id, raw_material_id,
                    quantity, unit, unit_cost, line_total,
                    vat_rate, discount_rate,
                    base_quantity, base_unit_cost,
                    general_discount_amount, general_discount_type,
                    note, invoice_date, invoice_no,
                    is_deleted, created_at
                ) VALUES (
                    v_tenant_id,
                    v_new_rm_id,
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
            EXCEPTION WHEN unique_violation THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
            END;
        END LOOP;
    END IF;

    -- ============ 6) EXPENSES ============
    IF jsonb_typeof(backup->'expenses') = 'array' THEN
        FOR v_expense IN SELECT * FROM jsonb_array_elements(backup->'expenses')
        LOOP
            IF v_expense->>'date' IS NULL OR v_expense->>'amount' IS NULL THEN
                v_skipped_expenses := v_skipped_expenses + 1;
                CONTINUE;
            END IF;

            IF EXISTS (
                SELECT 1 FROM expenses
                WHERE tenant_id = v_tenant_id
                  AND date = (v_expense->>'date')::date
                  AND amount = COALESCE((v_expense->>'amount')::numeric, 0)
                  AND COALESCE(description, '') = COALESCE(v_expense->>'description', '')
            ) THEN
                v_skipped_expenses := v_skipped_expenses + 1;
                CONTINUE;
            END IF;

            BEGIN
                INSERT INTO expenses (
                    tenant_id, date, amount, description, category_id, category_name
                ) VALUES (
                    v_tenant_id,
                    (v_expense->>'date')::date,
                    COALESCE((v_expense->>'amount')::numeric, 0),
                    v_expense->>'description',
                    NULLIF(v_expense->>'category_id','')::uuid,
                    COALESCE(
                        v_expense->>'category_name',
                        (SELECT name FROM categories
                         WHERE id = NULLIF(v_expense->>'category_id','')::uuid
                         LIMIT 1)
                    )
                );
                v_inserted_expenses := v_inserted_expenses + 1;
            EXCEPTION WHEN unique_violation THEN
                v_skipped_expenses := v_skipped_expenses + 1;
            END;
        END LOOP;
    END IF;

    -- ============ LOG + RETURN ============
    BEGIN
        PERFORM write_system_log(
            v_tenant_id, v_auth_uid, 'restore', 'success',
            'Restore tamamlandi (full backup)',
            jsonb_build_object(
                'inserted_raw_materials',  v_inserted_raw_materials,
                'inserted_products',       v_inserted_products,
                'inserted_sales',          v_inserted_sales,
                'inserted_product_sales',  v_inserted_product_sales,
                'inserted_purchase_items', v_inserted_purchase_items,
                'inserted_expenses',       v_inserted_expenses,
                'skipped_raw_materials',   v_skipped_raw_materials,
                'skipped_products',        v_skipped_products,
                'skipped_sales',           v_skipped_sales,
                'skipped_product_sales',   v_skipped_product_sales,
                'skipped_purchase_items',  v_skipped_purchase_items,
                'skipped_expenses',        v_skipped_expenses
            )
        );
    EXCEPTION WHEN OTHERS THEN
        -- write_system_log yoksa veya patlarsa restore'u kirmaa
        NULL;
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
        ),
        'skipped', jsonb_build_object(
            'raw_materials',  v_skipped_raw_materials,
            'products',       v_skipped_products,
            'sales',          v_skipped_sales,
            'product_sales',  v_skipped_product_sales,
            'purchase_items', v_skipped_purchase_items,
            'expenses',       v_skipped_expenses
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


-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE v_e INT; v_r INT;
BEGIN
    SELECT count(*) INTO v_e FROM pg_proc WHERE proname='export_all_data'
        AND pronamespace='public'::regnamespace;
    SELECT count(*) INTO v_r FROM pg_proc WHERE proname='restore_full_backup'
        AND pronamespace='public'::regnamespace;
    IF v_e=0 OR v_r=0 THEN
        RAISE EXCEPTION 'KRITIK: backup RPC kurulamadi';
    END IF;
    RAISE NOTICE 'OK: export_all_data + restore_full_backup (full backup) aktif';
END $$;
