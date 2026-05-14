-- ============================================================
-- 028 — RESTORE FULL BACKUP (skip-on-duplicate)
-- 012 ve 025 ESKITILDI.
--
-- BUG: 025'teki manuel duplicate-check (SELECT ... WHERE) sadece
--      bilinen kolonlari kontrol ediyordu. Ancak DB tarafinda
--      ek unique constraint'ler eklenmis (orn:
--      sales_idempotency_unique). Constraint catch'lemediginde
--      INSERT unique_violation firlatiyor -> tum restore patliyor.
--
-- FIX: Her INSERT'i BEGIN/EXCEPTION bloguna sar.
--      unique_violation yakalandiginda:
--        - skip counter artir
--        - varsa eski kaydi SELECT et, mapping kur
--        - asla exception firlatma
--
-- HIC BIR DURUMDA duplicate yuzunden restore yarim kalmaz.
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
    v_product   JSONB;
    v_sale      JSONB;
    v_ps        JSONB;
    v_expense   JSONB;

    v_old_product_id UUID;
    v_new_product_id UUID;
    v_old_sale_id    UUID;
    v_new_sale_id    UUID;

    v_sale_date    DATE;
    v_backup_notes TEXT;

    v_inserted_products      INT := 0;
    v_inserted_sales         INT := 0;
    v_inserted_product_sales INT := 0;
    v_inserted_expenses      INT := 0;

    v_skipped_products       INT := 0;
    v_skipped_sales          INT := 0;
    v_skipped_product_sales  INT := 0;
    v_skipped_expenses       INT := 0;

    v_product_map JSONB := '{}'::jsonb;
    v_sale_map    JSONB := '{}'::jsonb;
BEGIN
    -- ========================================================
    -- AUTH GUARD
    -- ========================================================
    v_auth_uid := auth.uid();

    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id
    FROM users u
    WHERE u.id = v_auth_uid;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found for user';
    END IF;

    IF tenant IS NOT NULL AND tenant <> v_tenant_id THEN
        RAISE EXCEPTION 'Unauthorized: tenant mismatch';
    END IF;

    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'restore', interval '5 seconds');

    IF backup IS NULL OR jsonb_typeof(backup) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_BACKUP';
    END IF;

    -- ========================================================
    -- 1) PRODUCTS — duplicate-safe
    -- ========================================================
    IF jsonb_typeof(backup->'products') = 'array' THEN
        FOR v_product IN SELECT * FROM jsonb_array_elements(backup->'products')
        LOOP
            IF v_product->>'name' IS NULL OR TRIM(v_product->>'name') = '' THEN
                v_skipped_products := v_skipped_products + 1;
                CONTINUE;
            END IF;

            v_old_product_id := NULLIF(v_product->>'id','')::uuid;
            v_new_product_id := NULL;

            -- Onceden var mi? (name + tenant)
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
                    -- Race condition / unbeklenen unique constraint
                    v_skipped_products := v_skipped_products + 1;
                    SELECT id INTO v_new_product_id
                    FROM products
                    WHERE tenant_id = v_tenant_id
                      AND name = v_product->>'name'
                    LIMIT 1;
                END;
            END IF;

            IF v_old_product_id IS NOT NULL AND v_new_product_id IS NOT NULL THEN
                v_product_map := v_product_map
                    || jsonb_build_object(v_old_product_id::text, v_new_product_id::text);
            END IF;
        END LOOP;
    END IF;

    -- ========================================================
    -- 2) SALES — duplicate-safe + notes-NULL fix
    -- ========================================================
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

            -- Manuel duplicate check (semantic match)
            SELECT id INTO v_new_sale_id
            FROM sales
            WHERE tenant_id = v_tenant_id
              AND date = v_sale_date
              AND total = COALESCE((v_sale->>'total')::numeric, 0)
              AND COALESCE(cash, 0) = COALESCE((v_sale->>'cash')::numeric, 0)
              AND COALESCE(card, 0) = COALESCE((v_sale->>'card')::numeric, 0)
              AND COALESCE(notes, '') = COALESCE(v_backup_notes, '')
              AND COALESCE(is_deleted, false) = false
            LIMIT 1;

            IF v_new_sale_id IS NOT NULL THEN
                v_skipped_sales := v_skipped_sales + 1;
            ELSE
                BEGIN
                    INSERT INTO sales (
                        tenant_id, date, total, cash, card, notes, is_deleted
                    ) VALUES (
                        v_tenant_id,
                        v_sale_date,
                        COALESCE((v_sale->>'total')::numeric, 0),
                        COALESCE((v_sale->>'cash')::numeric, 0),
                        COALESCE((v_sale->>'card')::numeric, 0),
                        v_backup_notes,
                        false
                    )
                    RETURNING id INTO v_new_sale_id;

                    v_inserted_sales := v_inserted_sales + 1;

                EXCEPTION WHEN unique_violation THEN
                    -- DB tarafinda baska bir unique constraint
                    -- (orn: sales_idempotency_unique) varsa burada yakala.
                    v_skipped_sales := v_skipped_sales + 1;

                    -- Mapping icin mevcut kaydi bul
                    SELECT id INTO v_new_sale_id
                    FROM sales
                    WHERE tenant_id = v_tenant_id
                      AND date = v_sale_date
                      AND total = COALESCE((v_sale->>'total')::numeric, 0)
                      AND COALESCE(is_deleted, false) = false
                    ORDER BY created_at DESC
                    LIMIT 1;
                END;
            END IF;

            IF v_old_sale_id IS NOT NULL AND v_new_sale_id IS NOT NULL THEN
                v_sale_map := v_sale_map
                    || jsonb_build_object(v_old_sale_id::text, v_new_sale_id::text);
            END IF;
        END LOOP;
    END IF;

    -- ========================================================
    -- 3) PRODUCT_SALES — duplicate-safe
    -- ========================================================
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

            -- Manuel duplicate check
            IF EXISTS (
                SELECT 1 FROM product_sales
                WHERE sale_id = v_new_sale_id
                  AND product_id = v_new_product_id
            ) THEN
                v_skipped_product_sales := v_skipped_product_sales + 1;
                CONTINUE;
            END IF;

            SELECT date INTO v_sale_date
            FROM sales
            WHERE id = v_new_sale_id;

            BEGIN
                INSERT INTO product_sales (
                    tenant_id, sale_id, product_id, date,
                    quantity, unit_price, total, cost
                ) VALUES (
                    v_tenant_id,
                    v_new_sale_id,
                    v_new_product_id,
                    v_sale_date,
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

    -- ========================================================
    -- 4) EXPENSES — duplicate-safe
    -- ========================================================
    IF jsonb_typeof(backup->'expenses') = 'array' THEN
        FOR v_expense IN SELECT * FROM jsonb_array_elements(backup->'expenses')
        LOOP
            IF v_expense->>'date' IS NULL OR v_expense->>'amount' IS NULL THEN
                v_skipped_expenses := v_skipped_expenses + 1;
                CONTINUE;
            END IF;

            -- Manuel duplicate check
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

    -- ========================================================
    -- LOG + RETURN
    -- ========================================================
    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'restore', 'success',
        'Restore tamamlandi',
        jsonb_build_object(
            'inserted_products', v_inserted_products,
            'inserted_sales', v_inserted_sales,
            'inserted_product_sales', v_inserted_product_sales,
            'inserted_expenses', v_inserted_expenses,
            'skipped_products', v_skipped_products,
            'skipped_sales', v_skipped_sales,
            'skipped_product_sales', v_skipped_product_sales,
            'skipped_expenses', v_skipped_expenses
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'inserted', jsonb_build_object(
            'products',      v_inserted_products,
            'sales',         v_inserted_sales,
            'product_sales', v_inserted_product_sales,
            'expenses',      v_inserted_expenses
        ),
        'skipped', jsonb_build_object(
            'products',      v_skipped_products,
            'sales',         v_skipped_sales,
            'product_sales', v_skipped_product_sales,
            'expenses',      v_skipped_expenses
        )
    );

EXCEPTION WHEN OTHERS THEN
    -- Buraya yalnizca duplicate DISI hatalar dusmeli
    -- (auth, validation, sistem hatasi vb.)
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'restore', 'fail', SQLERRM, '{}'::jsonb
    );
    RAISE EXCEPTION 'RESTORE_FAILED: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION restore_full_backup(JSONB, UUID) TO authenticated;


-- ============================================================
-- TEST
-- ============================================================
-- 1) Bos tenant'a backup yukle:
--    Beklenen: inserted=N, skipped=0
--
-- 2) Ayni backup'i ikinci kez yukle:
--    Beklenen: inserted=0, skipped=N
--    UI mesaji: "0 satis eklendi | N kayit zaten mevcuttu (atlandi)"
--    Exception YOK.
--
-- 3) sales_idempotency_unique constraint'i devrede iken:
--    Restore patlamamali, skip etmeli.
--
-- 4) system_logs'da action='restore', status='success' kaydi olmali.
-- ============================================================
