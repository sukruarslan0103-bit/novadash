-- ============================================================
-- 048 — IDEMPOTENCY: TENANT-SCOPED COMPOSITE UNIQUE
--
-- Amac:
--   sales / expenses / purchases tablolarinda idempotency_key
--   constraint'i GLOBAL UNIQUE iken (tenant_id, idempotency_key)
--   composite UNIQUE'e cekilir.
--
--   Sebep: GLOBAL UNIQUE bir saldirgan icin cross-tenant DoS ve
--   (insert_expense DO UPDATE icin) cross-tenant amount manipulation
--   yuzeyi acikti. Composite scope bu yuzeyi kapatir.
--
-- Kapsam:
--   1. PRE-FLIGHT integrity check (DO block).
--   2. Constraint swap (sales, expenses, purchases).
--   3. insert_expense body replace:
--        - RETURNS JSONB
--        - Server hash fallback
--        - ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
--        - duplicate=true response
--        - DO UPDATE SET amount -> KALDIRILDI (cross-tenant manipulation kapali)
--   4. create_purchase_and_update_product_cost body replace:
--        - SET search_path = public (eksikti)
--        - Server hash fallback (clock_timestamp ile unique per call;
--          ayni gun ayni urun ayni miktar gercek ikinci alis bloklanmaz)
--        - ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
--   5. restore_full_backup body replace: ON CONFLICT kolonu guncellenir.
--   6. VALIDATION DO block.
--
-- KAPSAM DISI (bu fazda DEGISMEZ):
--   - sales RPC'leri (create_sales_atomic, create_sale_empty):
--     lookup'lari zaten composite-aware. Body dokunulmaz.
--   - update_expense, soft_delete_expense
--   - Frontend (ayri commit'te services/expenses.js refactor edilecek).
--   - product_sales / purchase_items / restore'in diger bloklari
--     (sadece sales bloklarindaki ON CONFLICT degisir; digerleri
--      zaten ON CONFLICT (idempotency_key) kullanmiyor).
--
-- Idempotency:
--   Migration tum bolumler IF EXISTS / CREATE OR REPLACE / DROP-ADD
--   patterni kullanir. Birden fazla calistirma guvenli.
--
-- Rollback:
--   Baseline'in 048 oncesi state'i ile (eski global UNIQUE +
--   insert_expense DO UPDATE + purchase RPC tek-col fallback)
--   tek script yeniden RUN edilirse geri donulur.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT INTEGRITY CHECK
-- ============================================================
DO $pre$
DECLARE
    v_bad_tenant_sales     INT;
    v_bad_tenant_expenses  INT;
    v_bad_tenant_purchases INT;

    v_dup_sales     INT;
    v_dup_expenses  INT;
    v_dup_purchases INT;
BEGIN
    -- tenant_id NOT NULL doğrulama
    SELECT count(*) INTO v_bad_tenant_sales     FROM public.sales     WHERE tenant_id IS NULL;
    SELECT count(*) INTO v_bad_tenant_expenses  FROM public.expenses  WHERE tenant_id IS NULL;
    SELECT count(*) INTO v_bad_tenant_purchases FROM public.purchases WHERE tenant_id IS NULL;

    IF v_bad_tenant_sales > 0 OR v_bad_tenant_expenses > 0 OR v_bad_tenant_purchases > 0 THEN
        RAISE EXCEPTION
            'PRE-FLIGHT FAIL: NULL tenant_id satirlari var (sales=%, expenses=%, purchases=%)',
            v_bad_tenant_sales, v_bad_tenant_expenses, v_bad_tenant_purchases;
    END IF;

    -- (tenant_id, idempotency_key) composite icin onceden çakışma var mı?
    -- (Mevcut global UNIQUE zaten zorluyor; bu belt-and-suspenders.)
    SELECT count(*) INTO v_dup_sales FROM (
        SELECT tenant_id, idempotency_key
          FROM public.sales
         WHERE idempotency_key IS NOT NULL
         GROUP BY tenant_id, idempotency_key
        HAVING count(*) > 1
    ) s;

    SELECT count(*) INTO v_dup_expenses FROM (
        SELECT tenant_id, idempotency_key
          FROM public.expenses
         WHERE idempotency_key IS NOT NULL
         GROUP BY tenant_id, idempotency_key
        HAVING count(*) > 1
    ) e;

    SELECT count(*) INTO v_dup_purchases FROM (
        SELECT tenant_id, idempotency_key
          FROM public.purchases
         WHERE idempotency_key IS NOT NULL
         GROUP BY tenant_id, idempotency_key
        HAVING count(*) > 1
    ) p;

    IF v_dup_sales > 0 OR v_dup_expenses > 0 OR v_dup_purchases > 0 THEN
        RAISE EXCEPTION
            'PRE-FLIGHT FAIL: composite duplicate var (sales=%, expenses=%, purchases=%) — beklenmiyor',
            v_dup_sales, v_dup_expenses, v_dup_purchases;
    END IF;

    RAISE NOTICE 'PRE-FLIGHT OK: tenant_id NOT NULL ve composite distinct';
END $pre$;


-- ============================================================
-- 1) CONSTRAINT SWAP — sales / expenses / purchases
-- ============================================================
ALTER TABLE public.sales     DROP CONSTRAINT IF EXISTS sales_idempotency_unique;
ALTER TABLE public.expenses  DROP CONSTRAINT IF EXISTS expenses_idempotency_unique;
ALTER TABLE public.purchases DROP CONSTRAINT IF EXISTS purchases_idempotency_unique;

ALTER TABLE public.sales
    ADD CONSTRAINT sales_idempotency_unique
    UNIQUE (tenant_id, idempotency_key);

ALTER TABLE public.expenses
    ADD CONSTRAINT expenses_idempotency_unique
    UNIQUE (tenant_id, idempotency_key);

ALTER TABLE public.purchases
    ADD CONSTRAINT purchases_idempotency_unique
    UNIQUE (tenant_id, idempotency_key);


-- ============================================================
-- 2) insert_expense — body replace (RETURNS JSONB, DO NOTHING)
--
-- BREAKING (kontrollu): RETURNS UUID -> RETURNS JSONB.
-- Tek caller services/expenses.js (ayri commit'te guncellenecek).
-- Bu migration calistiktan sonra ESKI client REST INSERT yapmaya
-- devam eder (insert_expense'i hic cagirmiyor) -> uyumlu.
-- ============================================================
DROP FUNCTION IF EXISTS public.insert_expense(DATE, NUMERIC, UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.insert_expense(
    p_date            DATE,
    p_amount          NUMERIC,
    p_category_id     UUID,
    p_category_name   TEXT,
    p_description     TEXT,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_idem_key  TEXT;
    v_new_id    UUID;
    v_existing  UUID;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id
      FROM public.users u
     WHERE u.id = v_auth_uid
       AND u.is_active = true;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found or user disabled'
            USING ERRCODE = '42501';
    END IF;

    IF p_date IS NULL THEN
        RAISE EXCEPTION 'date is required';
    END IF;

    -- 048: server-side idempotency_key fallback (formul deterministik;
    -- sales pattern ile simetrik: tenant|date|amount|category|description).
    v_idem_key := COALESCE(
        p_idempotency_key,
        md5(
            v_tenant_id::text                                       || '|' ||
            p_date::text                                            || '|' ||
            COALESCE(p_amount, 0)::text                             || '|' ||
            COALESCE(p_category_id::text, '')                       || '|' ||
            COALESCE(p_category_name, '')                           || '|' ||
            COALESCE(p_description, '')
        )
    );

    -- 048: ON CONFLICT (tenant_id, idempotency_key) DO NOTHING.
    -- Eski DO UPDATE SET amount kaldirildi (cross-tenant manipulation
    -- yuzeyi kapali; amount degisikligi icin update_expense kullanilmali).
    INSERT INTO public.expenses (
        tenant_id, date, amount, category_id, category_name,
        description, idempotency_key, created_by
    ) VALUES (
        v_tenant_id,
        p_date,
        COALESCE(p_amount, 0),
        p_category_id,
        p_category_name,
        p_description,
        v_idem_key,
        v_auth_uid
    )
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success',         true,
            'id',              v_new_id,
            'duplicate',       false,
            'idempotency_key', v_idem_key
        );
    END IF;

    -- INSERT cakisti -> ayni tenant+key satirini bul ve duplicate dön.
    SELECT id INTO v_existing
      FROM public.expenses
     WHERE tenant_id = v_tenant_id
       AND idempotency_key = v_idem_key
     LIMIT 1;

    RETURN jsonb_build_object(
        'success',         true,
        'id',              v_existing,
        'duplicate',       true,
        'idempotency_key', v_idem_key,
        'message',         'Ayni gider zaten kayitli'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.insert_expense(DATE, NUMERIC, UUID, TEXT, TEXT, TEXT) TO authenticated;


-- ============================================================
-- 3) create_purchase_and_update_product_cost — body replace
--
-- Eklenenler:
--   - SET search_path = public (eksikti)
--   - Server hash fallback: clock_timestamp() ile her cagri unique key
--     uretir. AYNI GUN AYNI URUN AYNI MIKTAR gercek ikinci alis
--     bloklanmaz (kasitli — replay korumasi isteyen client kendi
--     deterministic key'ini gondermelidir).
--   - ON CONFLICT (tenant_id, idempotency_key) DO NOTHING ile
--     atomik duplicate skip.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_purchase_and_update_product_cost(
    p_product_id      UUID,
    p_quantity        NUMERIC,
    p_total           NUMERIC,
    p_vat             NUMERIC,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid    UUID;
    v_tenant_id   UUID;
    v_idem_key    TEXT;
    v_existing    UUID;
    v_net_total   NUMERIC;
    v_unit_cost   NUMERIC;
    v_purchase_id UUID;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id
      FROM public.users u
     WHERE u.id = v_auth_uid
       AND u.is_active = true;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found or user disabled'
            USING ERRCODE = '42501';
    END IF;

    PERFORM check_rate_limit(v_tenant_id, v_auth_uid, 'purchase', interval '2 seconds');

    IF p_product_id IS NULL THEN RAISE EXCEPTION 'product_id required'; END IF;
    IF p_quantity   IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Invalid quantity'; END IF;
    IF p_total      IS NULL OR p_total    <= 0 THEN RAISE EXCEPTION 'Invalid total';    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.products
         WHERE id = p_product_id
           AND tenant_id = v_tenant_id
    ) THEN
        RAISE EXCEPTION 'Product not found' USING ERRCODE = '42501';
    END IF;

    -- 048: server-side idempotency_key fallback.
    -- KRITIK: clock_timestamp() ile her cagri UNIQUE key uretir.
    -- "Ayni gun ayni urun ayni miktar" gercek ikinci alis koldan kollaps
    -- olmaz; ikincisi YENI bir kayit olarak gecer. Replay (network retry)
    -- korumasi icin client kendi deterministic key'ini gondermelidir.
    v_idem_key := COALESCE(
        p_idempotency_key,
        md5(
            v_tenant_id::text                                   || '|' ||
            p_product_id::text                                  || '|' ||
            COALESCE(p_quantity, 0)::text                       || '|' ||
            COALESCE(p_total, 0)::text                          || '|' ||
            COALESCE(p_vat, 0)::text                            || '|' ||
            clock_timestamp()::text                             || '|' ||
            v_auth_uid::text
        )
    );

    -- Client key gonderdiyse explicit duplicate check (replay safety).
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_existing
          FROM public.purchases
         WHERE tenant_id       = v_tenant_id
           AND idempotency_key = p_idempotency_key
         LIMIT 1;

        IF v_existing IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', true, 'duplicate', true,
                'purchase_id', v_existing,
                'idempotency_key', p_idempotency_key,
                'message', 'Already recorded'
            );
        END IF;
    END IF;

    v_net_total := p_total + (p_total * COALESCE(p_vat, 0) / 100);
    v_unit_cost := v_net_total / p_quantity;

    INSERT INTO public.purchases (
        tenant_id, product_id, quantity, total_price,
        vat_rate, net_total, unit_cost, idempotency_key
    ) VALUES (
        v_tenant_id, p_product_id, p_quantity, p_total,
        COALESCE(p_vat, 0), v_net_total, v_unit_cost, v_idem_key
    )
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id INTO v_purchase_id;

    -- ON CONFLICT match (cok dusuk olasilik clock_timestamp ile): existing dön
    IF v_purchase_id IS NULL THEN
        SELECT id INTO v_existing
          FROM public.purchases
         WHERE tenant_id       = v_tenant_id
           AND idempotency_key = v_idem_key
         LIMIT 1;

        RETURN jsonb_build_object(
            'success', true, 'duplicate', true,
            'purchase_id', v_existing,
            'idempotency_key', v_idem_key,
            'message', 'Already recorded'
        );
    END IF;

    UPDATE public.products
       SET cost = v_unit_cost, updated_at = now()
     WHERE id = p_product_id
       AND tenant_id = v_tenant_id;

    PERFORM write_system_log(
        v_tenant_id, v_auth_uid, 'purchase', 'success',
        'Alis kaydedildi',
        jsonb_build_object(
            'purchase_id', v_purchase_id, 'product_id', p_product_id,
            'quantity', p_quantity, 'unit_cost', v_unit_cost, 'net_total', v_net_total
        )
    );

    RETURN jsonb_build_object(
        'success', true, 'duplicate', false,
        'purchase_id', v_purchase_id,
        'unit_cost', v_unit_cost,
        'net_total', v_net_total,
        'idempotency_key', v_idem_key
    );

EXCEPTION WHEN OTHERS THEN
    PERFORM write_system_log(
        COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        v_auth_uid, 'purchase', 'fail', SQLERRM, '{}'::jsonb
    );
    RAISE EXCEPTION 'PURCHASE_FAILED: %', SQLERRM;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_purchase_and_update_product_cost(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT) TO authenticated;


-- ============================================================
-- 4) restore_full_backup — body replace
--   Tek değişiklik: sales bloğunda ON CONFLICT kolonu
--     (idempotency_key) -> (tenant_id, idempotency_key)
--   Diğer her şey aynı (043 + H.8 mevcut hali korunur).
-- ============================================================
CREATE OR REPLACE FUNCTION public.restore_full_backup(backup JSONB, tenant UUID)
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

    -- 1) RAW_MATERIALS
    IF jsonb_typeof(v_data->'raw_materials') = 'array' THEN
        FOR v_rm IN SELECT * FROM jsonb_array_elements(v_data->'raw_materials')
        LOOP
            IF v_rm->>'name' IS NULL OR TRIM(v_rm->>'name') = '' THEN
                v_skipped_raw_materials := v_skipped_raw_materials + 1;
                CONTINUE;
            END IF;

            v_old_rm_id := NULLIF(v_rm->>'id','')::uuid;
            v_new_rm_id := NULL;

            SELECT id INTO v_new_rm_id
            FROM raw_materials
            WHERE tenant_id = v_tenant_id AND name = v_rm->>'name'
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
                    WHERE tenant_id = v_tenant_id AND name = v_rm->>'name'
                    LIMIT 1;
                END;
            END IF;

            IF v_old_rm_id IS NOT NULL AND v_new_rm_id IS NOT NULL THEN
                v_rm_map := v_rm_map || jsonb_build_object(v_old_rm_id::text, v_new_rm_id::text);
            END IF;
        END LOOP;
    END IF;

    -- 2) PRODUCTS
    IF jsonb_typeof(v_data->'products') = 'array' THEN
        FOR v_product IN SELECT * FROM jsonb_array_elements(v_data->'products')
        LOOP
            IF v_product->>'name' IS NULL OR TRIM(v_product->>'name') = '' THEN
                v_skipped_products := v_skipped_products + 1;
                CONTINUE;
            END IF;

            v_old_product_id := NULLIF(v_product->>'id','')::uuid;
            v_new_product_id := NULL;

            SELECT id INTO v_new_product_id
            FROM products
            WHERE tenant_id = v_tenant_id AND name = v_product->>'name'
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
                             WHERE id = NULLIF(v_product->>'category_id','')::uuid LIMIT 1)
                        )
                    )
                    RETURNING id INTO v_new_product_id;
                    v_inserted_products := v_inserted_products + 1;
                EXCEPTION WHEN unique_violation THEN
                    v_skipped_products := v_skipped_products + 1;
                    SELECT id INTO v_new_product_id
                    FROM products
                    WHERE tenant_id = v_tenant_id AND name = v_product->>'name' LIMIT 1;
                END;
            END IF;

            IF v_old_product_id IS NOT NULL AND v_new_product_id IS NOT NULL THEN
                v_product_map := v_product_map || jsonb_build_object(v_old_product_id::text, v_new_product_id::text);
            END IF;
        END LOOP;
    END IF;

    -- 3) SALES
    IF jsonb_typeof(v_data->'sales') = 'array' THEN
        FOR v_sale IN SELECT * FROM jsonb_array_elements(v_data->'sales')
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
                v_tenant_id, v_sale_date,
                COALESCE((v_sale->>'total')::numeric, 0),
                COALESCE((v_sale->>'cash')::numeric, 0),
                COALESCE((v_sale->>'card')::numeric, 0),
                v_backup_notes, false, v_idem_key
            )
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING   -- 048: composite
            RETURNING id INTO v_new_sale_id;

            IF v_new_sale_id IS NULL THEN
                v_skipped_sales := v_skipped_sales + 1;
                SELECT id INTO v_new_sale_id
                FROM sales WHERE tenant_id = v_tenant_id AND idempotency_key = v_idem_key LIMIT 1;
            ELSE
                v_inserted_sales := v_inserted_sales + 1;
            END IF;

            IF v_old_sale_id IS NOT NULL AND v_new_sale_id IS NOT NULL THEN
                v_sale_map := v_sale_map || jsonb_build_object(v_old_sale_id::text, v_new_sale_id::text);
            END IF;
        END LOOP;
    END IF;

    -- 4) PRODUCT_SALES
    IF jsonb_typeof(v_data->'product_sales') = 'array' THEN
        FOR v_ps IN SELECT * FROM jsonb_array_elements(v_data->'product_sales')
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
                WHERE sale_id = v_new_sale_id AND product_id = v_new_product_id
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

    -- 5) PURCHASE_ITEMS
    IF jsonb_typeof(v_data->'purchase_items') = 'array' THEN
        FOR v_pi IN SELECT * FROM jsonb_array_elements(v_data->'purchase_items')
        LOOP
            IF v_pi->>'raw_material_id' IS NULL THEN
                v_skipped_purchase_items := v_skipped_purchase_items + 1;
                CONTINUE;
            END IF;

            v_new_rm_id := NULLIF(v_rm_map->>(v_pi->>'raw_material_id'),'')::uuid;
            IF v_new_rm_id IS NULL THEN
                SELECT id INTO v_new_rm_id
                FROM raw_materials
                WHERE id = NULLIF(v_pi->>'raw_material_id','')::uuid
                  AND tenant_id = v_tenant_id LIMIT 1;
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
                    v_tenant_id, v_new_rm_id,
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

    -- 6) EXPENSES
    IF jsonb_typeof(v_data->'expenses') = 'array' THEN
        FOR v_expense IN SELECT * FROM jsonb_array_elements(v_data->'expenses')
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
                         WHERE id = NULLIF(v_expense->>'category_id','')::uuid LIMIT 1)
                    )
                );
                v_inserted_expenses := v_inserted_expenses + 1;
            EXCEPTION WHEN unique_violation THEN
                v_skipped_expenses := v_skipped_expenses + 1;
            END;
        END LOOP;
    END IF;

    BEGIN
        PERFORM write_system_log(
            v_tenant_id, v_auth_uid, 'restore', 'success',
            'Restore tamamlandi (full backup, data path, 048)',
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


-- ============================================================
-- VALIDATION
-- ============================================================
DO $val$
DECLARE
    v_def        TEXT;
    v_concount   INT;
    v_returns    TEXT;
    v_secdef     BOOLEAN;
    v_config     TEXT;
    v_bodyhash   TEXT;
BEGIN
    -- 1) Constraint composite mi? (3 tablo)
    FOR v_def IN
        SELECT pg_get_constraintdef(c.oid)
          FROM pg_constraint c
          JOIN pg_class      t ON t.oid = c.conrelid
          JOIN pg_namespace  n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND c.conname IN (
               'sales_idempotency_unique',
               'expenses_idempotency_unique',
               'purchases_idempotency_unique'
           )
    LOOP
        IF v_def NOT LIKE '%tenant_id%idempotency_key%' THEN
            RAISE EXCEPTION 'KRITIK: constraint composite degil: %', v_def;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_concount
      FROM pg_constraint c
      JOIN pg_class      t ON t.oid = c.conrelid
      JOIN pg_namespace  n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND c.conname IN (
           'sales_idempotency_unique',
           'expenses_idempotency_unique',
           'purchases_idempotency_unique'
       );

    IF v_concount <> 3 THEN
        RAISE EXCEPTION 'KRITIK: 3 constraint bekleniyordu, % bulundu', v_concount;
    END IF;

    -- 2) insert_expense: RETURNS JSONB, DEFINER, search_path SET
    SELECT pg_get_function_result(p.oid),
           p.prosecdef,
           (SELECT string_agg(cfg, ', ') FROM unnest(coalesce(p.proconfig,'{}')) AS cfg)
      INTO v_returns, v_secdef, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'insert_expense'
     LIMIT 1;

    IF v_returns <> 'jsonb' THEN
        RAISE EXCEPTION 'KRITIK: insert_expense RETURNS != jsonb (%)', v_returns;
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION 'KRITIK: insert_expense SECURITY DEFINER degil';
    END IF;
    IF v_config IS NULL OR v_config NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION 'KRITIK: insert_expense search_path SET edilmemis';
    END IF;

    -- 3) create_purchase_and_update_product_cost: DEFINER + search_path
    SELECT p.prosecdef,
           (SELECT string_agg(cfg, ', ') FROM unnest(coalesce(p.proconfig,'{}')) AS cfg)
      INTO v_secdef, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'create_purchase_and_update_product_cost'
     LIMIT 1;

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'KRITIK: create_purchase_and_update_product_cost DEFINER degil';
    END IF;
    IF v_config IS NULL OR v_config NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION 'KRITIK: create_purchase_and_update_product_cost search_path SET edilmemis';
    END IF;

    -- 4) restore_full_backup ON CONFLICT composite mi?
    SELECT pg_get_functiondef(p.oid) INTO v_bodyhash
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'restore_full_backup'
     LIMIT 1;

    IF v_bodyhash NOT LIKE '%ON CONFLICT (tenant_id, idempotency_key)%' THEN
        RAISE EXCEPTION 'KRITIK: restore_full_backup ON CONFLICT composite degil';
    END IF;

    RAISE NOTICE 'OK: 048 idempotency tenant-scoped aktif | 3 composite constraint | insert_expense JSONB+DEFINER | purchase RPC DEFINER+search_path | restore ON CONFLICT composite';
END $val$;
