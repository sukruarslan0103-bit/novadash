-- ============================================================
-- 062 — LOAD TEST FAZ 2.C TOTAL FIX
--
-- BUG (061):
--   CTE chain icinde UPDATE sales tablosuna yapılıyor; ayni CTE
--   icindeki new_sales INSERT de sales tablosuna. PostgreSQL CTE
--   same-snapshot kurali: aynı statement icinde data-modifying
--   CTE'ler birbirinin effect'ini gormez — RETURNING haric.
--   UPDATE sales tablosunu eski snapshot'tan okuyor → yeni
--   INSERT'lar gorunmuyor → 0 row UPDATE → sales.total = 0 kalıyor.
--
--   Test sonucu (061): A_sales_total_mismatch = 1000, total_revenue = 0.
--
-- FIX:
--   FAZ 2.C chunk loop'tan UPDATE'i CIKAR. Sadece INSERT sales +
--   INSERT product_sales tek CTE chain. Loop SONRASI ayri SQL
--   statement olarak UPDATE — PL/pgSQL'de her statement kendi
--   snapshot'ini alır (READ COMMITTED), önceki INSERT'lar görünür.
--
-- EK FIX (yan bug):
--   Eski UPDATE:
--     cash = CASE WHEN random() < 0.60 THEN total ELSE 0 END,
--     card = CASE WHEN random() < 0.60 THEN 0     ELSE total END
--   Iki bagimsiz random() → cash + card ≠ total durumu mumkun
--   (random1=cash, random2=card; ikisi de TRUE → 2×total).
--   FIX: subquery'de tek cash_flag (0/1), cash = total * flag,
--   card = total * (1 - flag). Matematiksel garanti.
--
-- DEGISIKLIKLER:
--   - FAZ 2.A ve FAZ 2.B body BIT BIT AYNI (kopyalandı)
--   - FAZ 2.C chunk loop: CTE chain'den UPDATE çıkarıldı
--   - Loop sonrası tek UPDATE statement eklendi
--   - cash/card hesabi cash_flag binary trick ile invariant garantili
--   - v_inserted_sal hesabi loop sonrası SELECT COUNT (eskisi ROW_COUNT'tan geliyordu — yanlış)
--   - v_updated_sales yeni response field
--
-- ROLLBACK:
--   061'i tekrar deploy et (CTE bug geri gelir; sadece test data
--   tutarsiz olur, dataset zaten sonradan cleanup edilebilir).
--
-- IDEMPOTENCY:
--   CREATE OR REPLACE. cleanup_test_dataset (057+059) zaten product_sales
--   + sales temizliyor — bu migration cleanup'i etkilemez.
-- ============================================================


CREATE OR REPLACE FUNCTION public.generate_test_dataset(
    p_tenant_id      UUID,
    p_dry_run        BOOLEAN DEFAULT true,
    p_raw_materials  INT     DEFAULT 200,
    p_products       INT     DEFAULT 50,
    p_purchases      INT     DEFAULT 1000,
    p_sales          INT     DEFAULT 1000,
    p_expenses       INT     DEFAULT 3000,
    p_months         INT     DEFAULT 12,
    p_seed           INT     DEFAULT 42
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_t0             TIMESTAMPTZ := clock_timestamp();
    v_t_phase_a      TIMESTAMPTZ;
    v_t_phase_b      TIMESTAMPTZ;
    v_t_phase_c      TIMESTAMPTZ;
    v_t_total_update TIMESTAMPTZ;
    v_t_validation   TIMESTAMPTZ;

    v_name           TEXT;
    v_slug           TEXT;
    v_existing_rm    BIGINT;
    v_existing_prod  BIGINT;
    v_existing_pit   BIGINT;
    v_existing_sal   BIGINT;
    v_cat_ids        UUID[];

    v_inserted_cats  INT := 0;
    v_inserted_rm    INT := 0;
    v_inserted_p     INT := 0;
    v_inserted_rec   INT := 0;
    v_synced_costs   INT := 0;

    v_chunk_size_pit INT := 250;
    v_chunk_n_pit    INT;
    v_chunk_ins_pit  INT;
    v_inserted_pit   BIGINT := 0;
    v_chunk_count_pit INT := 0;

    v_chunk_size_sal INT := 250;
    v_chunk_n_sal    INT;
    v_chunk_ins_ps   INT;
    v_inserted_sal   BIGINT := 0;
    v_inserted_ps    BIGINT := 0;
    v_chunk_count_sal INT := 0;
    v_updated_sales  BIGINT := 0;

    v_top_ids        UUID[];
    v_rest_ids       UUID[];
    v_top_n          INT;
    v_rest_n         INT;
    v_active_prod_n  INT;

    v_val_prod_mism      BIGINT;
    v_val_rm_mism        BIGINT;
    v_val_recipe_orphan  BIGINT;
    v_val_sales_total    BIGINT;
    v_val_cost_snapshot  BIGINT;
    v_val_distinct_month BIGINT;
    v_val_top5           JSONB;
    v_val_analytics      JSONB;
    v_val_cash_card_inv  BIGINT;
BEGIN
    PERFORM public._lt_assert_test_tenant(p_tenant_id);

    IF p_raw_materials < 0 OR p_raw_materials > 50000 THEN RAISE EXCEPTION 'p_raw_materials out of range'; END IF;
    IF p_products     < 0 OR p_products     > 20000 THEN RAISE EXCEPTION 'p_products out of range'; END IF;
    IF p_purchases    < 0 OR p_purchases    > 200000 THEN RAISE EXCEPTION 'p_purchases out of range'; END IF;
    IF p_sales        < 0 OR p_sales        > 200000 THEN RAISE EXCEPTION 'p_sales out of range'; END IF;
    IF p_expenses     < 0 OR p_expenses     > 500000 THEN RAISE EXCEPTION 'p_expenses out of range'; END IF;
    IF p_months       < 1 OR p_months       > 60     THEN RAISE EXCEPTION 'p_months out of range'; END IF;

    SELECT name, slug INTO v_name, v_slug FROM tenants WHERE id = p_tenant_id;

    SELECT COUNT(*) INTO v_existing_rm   FROM raw_materials  WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_prod FROM products       WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_pit  FROM purchase_items WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_sal  FROM sales          WHERE tenant_id = p_tenant_id;

    -- ============ DRY-RUN ============
    IF p_dry_run THEN
        RETURN jsonb_build_object(
            'mode', 'dry-run',
            'phase', '2C',
            'safe_mode', true,
            'fix_version', '062',
            'ok', true,
            'tenant', jsonb_build_object('id', p_tenant_id, 'name', v_name, 'slug', v_slug),
            'existing', jsonb_build_object(
                'raw_materials',  v_existing_rm,
                'products',       v_existing_prod,
                'purchase_items', v_existing_pit,
                'sales',          v_existing_sal
            ),
            'will_insert', jsonb_build_object(
                'phase_2a', jsonb_build_object(
                    'skipped', v_existing_rm > 0,
                    'categories',      CASE WHEN v_existing_rm > 0 THEN 0 ELSE 6 END,
                    'raw_materials',   CASE WHEN v_existing_rm > 0 THEN 0 ELSE p_raw_materials END,
                    'products',        CASE WHEN v_existing_prod > 0 THEN 0 ELSE p_products END,
                    'product_recipes', CASE WHEN v_existing_prod > 0 THEN 0 ELSE p_products * 4 END
                ),
                'phase_2b', jsonb_build_object(
                    'skipped', v_existing_pit > 0,
                    'purchase_items', CASE WHEN v_existing_pit > 0 THEN 0 ELSE p_purchases END
                ),
                'phase_2c', jsonb_build_object(
                    'sales', p_sales,
                    'product_sales_estimated', (p_sales * 3.0)::int,
                    'chunk_size', v_chunk_size_sal,
                    'chunk_count', ceil(p_sales::numeric / v_chunk_size_sal)::int,
                    'post_loop_update', 'sales.total = SUM(product_sales.total) tek pass'
                )
            ),
            'fix_applied', jsonb_build_object(
                'cte_snapshot_bug', 'UPDATE chunk loop disina cikarildi (PG CTE same-snapshot kurali)',
                'cash_card_invariant', 'cash_flag binary trick; cash + card = total garantili'
            ),
            'next_step', 'generate_test_dataset(<tenant_id>::uuid, p_dry_run := false)',
            'warning', CASE
                WHEN v_existing_sal > 0 THEN 'sales zaten var, cleanup_test_dataset() cagir.'
                WHEN v_existing_prod = 0 THEN 'FAZ 2.A henuz calismadi. Tek call ile A+B+C birlikte yapilir.'
                ELSE NULL
            END
        );
    END IF;

    -- ============ REAL MODE ============

    -- ============ FAZ 2.A (idempotent skip) — 061 ile BIT BIT AYNI ============
    IF v_existing_rm = 0 AND v_existing_prod = 0 THEN
        INSERT INTO categories (tenant_id, name, type, color, sort_order)
        SELECT p_tenant_id, '__LOAD_TEST__' || cat_name, 'product', cat_color, cat_order
        FROM (VALUES
            ('Kahve',     '#92400e', 1),
            ('İçecek',    '#2563eb', 2),
            ('Alkol',     '#7c3aed', 3),
            ('Mutfak',    '#16a34a', 4),
            ('Sos',       '#dc2626', 5),
            ('Garnitür',  '#475569', 6)
        ) AS t(cat_name, cat_color, cat_order);
        GET DIAGNOSTICS v_inserted_cats = ROW_COUNT;

        SELECT array_agg(id ORDER BY sort_order) INTO v_cat_ids
          FROM categories
         WHERE tenant_id = p_tenant_id
           AND type = 'product'
           AND name LIKE '__LOAD\_TEST\_\_%' ESCAPE '\';

        INSERT INTO raw_materials (tenant_id, name, unit, base_unit, cost, vat_rate, is_active)
        SELECT
            p_tenant_id,
            '__LOAD_TEST__RM_' || lpad(i::text, 5, '0'),
            CASE (i % 5) WHEN 0 THEN 'kg' WHEN 1 THEN 'lt' WHEN 2 THEN 'adet' WHEN 3 THEN 'paket' ELSE 'gr' END,
            CASE (i % 5) WHEN 0 THEN 'gr' WHEN 1 THEN 'ml' WHEN 2 THEN 'adet' WHEN 3 THEN 'adet' ELSE 'gr' END,
            round((random() * 200 + 5)::numeric, 4),
            20,
            (random() > 0.05)
        FROM generate_series(1, p_raw_materials) AS i;
        GET DIAGNOSTICS v_inserted_rm = ROW_COUNT;

        INSERT INTO products (tenant_id, name, category_id, category_name, price, cost, is_active)
        SELECT
            p_tenant_id,
            '__LOAD_TEST__P_' || lpad(i::text, 4, '0'),
            v_cat_ids[((i - 1) % array_length(v_cat_ids, 1)) + 1],
            NULL,
            round((15 + random() * 135)::numeric, 2),
            0,
            (random() > 0.10)
        FROM generate_series(1, p_products) AS i;
        GET DIAGNOSTICS v_inserted_p = ROW_COUNT;

        INSERT INTO product_recipes (tenant_id, product_id, raw_material_id, quantity)
        SELECT
            p_tenant_id, p.id, rm.id,
            round((0.05 + random() * 0.45)::numeric, 4)
        FROM products p
        CROSS JOIN LATERAL (
            SELECT id FROM raw_materials
             WHERE tenant_id = p_tenant_id AND is_active = true
             ORDER BY random() LIMIT (2 + (random() * 3)::int)
        ) rm
        WHERE p.tenant_id = p_tenant_id
          AND (hashtext(p.id::text) % 20) <> 0;
        GET DIAGNOSTICS v_inserted_rec = ROW_COUNT;

        UPDATE products p
           SET cost = public.calculate_product_cost(p.id), updated_at = now()
         WHERE p.tenant_id = p_tenant_id;
        GET DIAGNOSTICS v_synced_costs = ROW_COUNT;
    END IF;
    v_t_phase_a := clock_timestamp();

    -- ============ FAZ 2.B (idempotent skip) — 061 ile BIT BIT AYNI ============
    IF v_existing_pit = 0 THEN
        v_chunk_n_pit := 0;
        WHILE v_chunk_n_pit * v_chunk_size_pit < p_purchases LOOP
            INSERT INTO purchase_items (
                tenant_id, purchase_id, raw_material_id,
                quantity, unit, unit_cost, line_total, vat_rate, discount_rate,
                invoice_date, invoice_no
            )
            SELECT
                p_tenant_id, NULL, rm.id,
                qty.q, rm.unit, unit_cost_val.uc,
                round((qty.q * unit_cost_val.uc)::numeric, 4)::numeric(14,4),
                rm.vat_rate, 0,
                purchase_date.d,
                100000 + ceil(i::numeric / 4)::bigint
            FROM generate_series(
                v_chunk_n_pit * v_chunk_size_pit + 1,
                LEAST((v_chunk_n_pit + 1) * v_chunk_size_pit, p_purchases)
            ) AS i
            CROSS JOIN LATERAL (
                SELECT id, unit, cost, vat_rate FROM raw_materials
                 WHERE tenant_id = p_tenant_id AND is_active = true
                 ORDER BY random() LIMIT 1
            ) rm
            CROSS JOIN LATERAL (
                SELECT CASE WHEN random() < 0.7 THEN round((0.5 + random() * 1.5)::numeric, 2)
                            ELSE                       round((5 + random() * 10)::numeric, 2)
                       END AS q
            ) qty
            CROSS JOIN LATERAL (
                SELECT (CURRENT_DATE - (random() * p_months * 30)::int)::date AS d
            ) purchase_date
            CROSS JOIN LATERAL (
                SELECT round(
                    (rm.cost * GREATEST(0.3,
                        (0.7 + (1.0 - LEAST(1.0,
                            (CURRENT_DATE - purchase_date.d)::numeric / 365.0
                        )) * 0.3)
                        * (0.85 + random() * 0.30)
                    ))::numeric, 4
                )::numeric(14,4) AS uc
            ) unit_cost_val;

            GET DIAGNOSTICS v_chunk_ins_pit = ROW_COUNT;
            v_inserted_pit := v_inserted_pit + v_chunk_ins_pit;
            v_chunk_n_pit := v_chunk_n_pit + 1;
        END LOOP;
        v_chunk_count_pit := v_chunk_n_pit;

        UPDATE products p
           SET cost = public.calculate_product_cost(p.id), updated_at = now()
         WHERE p.tenant_id = p_tenant_id;
    END IF;
    v_t_phase_b := clock_timestamp();

    -- ============ FAZ 2.C — sales + product_sales (FIX 062) ============

    IF v_existing_sal > 0 THEN
        RAISE EXCEPTION 'REFUSED: sales zaten var (%). FAZ 2.C re-run icin: SELECT cleanup_test_dataset(%L::uuid);',
            v_existing_sal, p_tenant_id;
    END IF;

    -- Pareto product array
    SELECT COUNT(*) INTO v_active_prod_n
      FROM products WHERE tenant_id = p_tenant_id AND is_active = true;

    IF v_active_prod_n = 0 THEN
        RAISE EXCEPTION 'REFUSED: aktif product yok — FAZ 2.A calismamis veya tum urunler inactive';
    END IF;

    SELECT
        array_agg(id) FILTER (WHERE rn <= GREATEST(1, (total * 0.20)::int)),
        array_agg(id) FILTER (WHERE rn >  GREATEST(1, (total * 0.20)::int))
    INTO v_top_ids, v_rest_ids
    FROM (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY hashtext(id::text)) AS rn,
               COUNT(*) OVER () AS total
          FROM products
         WHERE tenant_id = p_tenant_id AND is_active = true
    ) ranked;

    IF v_top_ids IS NULL OR array_length(v_top_ids, 1) IS NULL THEN
        v_top_ids := v_rest_ids;
    END IF;
    IF v_rest_ids IS NULL OR array_length(v_rest_ids, 1) IS NULL THEN
        v_rest_ids := v_top_ids;
    END IF;

    v_top_n  := COALESCE(array_length(v_top_ids, 1), 0);
    v_rest_n := COALESCE(array_length(v_rest_ids, 1), 0);

    -- CHUNK LOOP — sadece INSERT (UPDATE loop sonrasi)
    -- FIX (062): UPDATE'i CTE chain'den cikardik. PostgreSQL same-snapshot
    -- kurali geregi UPDATE sales target tabloya yapilan INSERT'leri
    -- goremiyordu (0 row affected). Simdi sadece INSERT sales + INSERT
    -- product_sales (RETURNING zinciri ile bagli, ayri target tablolar).
    v_chunk_n_sal := 0;
    WHILE v_chunk_n_sal * v_chunk_size_sal < p_sales LOOP

        WITH new_sales AS (
            INSERT INTO sales (tenant_id, date, total, cash, card, notes, created_by)
            SELECT
                p_tenant_id,
                CASE
                    WHEN random() < 0.35 THEN
                        (CURRENT_DATE
                            - (random() * p_months * 4)::int * 7
                            - (random() * 2)::int
                        )::date
                    ELSE
                        (CURRENT_DATE - (random() * p_months * 30)::int)::date
                END,
                0,    -- total placeholder — chunk loop sonrasi UPDATE'lenir
                0,    -- cash placeholder
                0,    -- card placeholder
                NULL,
                NULL
            FROM generate_series(
                v_chunk_n_sal * v_chunk_size_sal + 1,
                LEAST((v_chunk_n_sal + 1) * v_chunk_size_sal, p_sales)
            ) AS i
            RETURNING id, date
        )
        INSERT INTO product_sales (tenant_id, sale_id, product_id, date, quantity, unit_price, total, cost)
        SELECT
            p_tenant_id,
            ns.id,
            line.product_id,
            ns.date,
            line.qty,
            round((p.price * line.price_factor)::numeric, 2)::numeric(12,2),
            round((line.qty * p.price * line.price_factor)::numeric, 2)::numeric(12,2),
            COALESCE(p.cost, 0)
        FROM new_sales ns
        CROSS JOIN LATERAL generate_series(1,
            CASE
                WHEN random() < 0.30 THEN 1
                WHEN random() < 0.65 THEN 2 + (random() * 1)::int
                WHEN random() < 0.90 THEN 3 + (random() * 2)::int
                ELSE                       5 + (random() * 3)::int
            END
        ) AS line_idx
        CROSS JOIN LATERAL (
            SELECT
                CASE WHEN random() < 0.60 AND v_top_n > 0
                     THEN v_top_ids[1 + (random() * (v_top_n - 1))::int]
                     ELSE v_rest_ids[1 + (random() * (v_rest_n - 1))::int]
                END AS product_id,
                CASE WHEN random() < 0.75 THEN 1
                     WHEN random() < 0.95 THEN 2
                     ELSE 3 + (random() * 2)::int
                END AS qty,
                (0.90 + random() * 0.15) AS price_factor
        ) line
        JOIN products p ON p.id = line.product_id
                        AND p.tenant_id = p_tenant_id;

        GET DIAGNOSTICS v_chunk_ins_ps = ROW_COUNT;
        v_inserted_ps := v_inserted_ps + v_chunk_ins_ps;
        v_chunk_n_sal := v_chunk_n_sal + 1;
    END LOOP;
    v_chunk_count_sal := v_chunk_n_sal;

    -- Sales toplam count (chunk_size * chunk_count'tan değil, gerçek count)
    SELECT COUNT(*) INTO v_inserted_sal
      FROM sales WHERE tenant_id = p_tenant_id;

    v_t_phase_c := clock_timestamp();

    -- ============ POST-LOOP TOTAL UPDATE (FIX 062) ============
    -- Ayri SQL statement: yeni snapshot, yukarda INSERT edilen sales
    -- artik visible. UPDATE sales.total = SUM(product_sales.total).
    -- cash_flag binary trick: tek random per sale, cash + card = total
    -- matematiksel garanti.
    UPDATE sales s
       SET total = la.line_total,
           cash  = la.line_total * la.cash_flag,
           card  = la.line_total * (1 - la.cash_flag)
      FROM (
          SELECT
              ps.sale_id,
              SUM(ps.total) AS line_total,
              CASE WHEN random() < 0.60 THEN 1 ELSE 0 END AS cash_flag
            FROM product_sales ps
           WHERE ps.tenant_id = p_tenant_id
           GROUP BY ps.sale_id
      ) la
     WHERE s.tenant_id = p_tenant_id
       AND s.id = la.sale_id;

    GET DIAGNOSTICS v_updated_sales = ROW_COUNT;
    v_t_total_update := clock_timestamp();

    -- ============ VALIDATION ============

    -- Faz 2.B replay
    SELECT COUNT(*) INTO v_val_prod_mism
      FROM products p
     WHERE p.tenant_id = p_tenant_id
       AND ABS(COALESCE(p.cost, 0) - public.calculate_product_cost(p.id)) > 0.01;

    SELECT COUNT(*) INTO v_val_rm_mism
      FROM raw_materials rm
      LEFT JOIN LATERAL (
          SELECT base_unit_cost FROM purchase_items pi
           WHERE pi.tenant_id = rm.tenant_id AND pi.raw_material_id = rm.id
             AND pi.is_deleted = false AND pi.base_unit_cost IS NOT NULL
             AND pi.base_unit_cost > 0
           ORDER BY pi.created_at DESC LIMIT 1
      ) latest ON TRUE
     WHERE rm.tenant_id = p_tenant_id
       AND latest.base_unit_cost IS NOT NULL
       AND ABS(rm.cost - latest.base_unit_cost) > 0.0001;

    -- FAZ 2.C validation
    SELECT COUNT(*) INTO v_val_sales_total
      FROM sales s
     WHERE s.tenant_id = p_tenant_id
       AND ABS(s.total - COALESCE(
           (SELECT SUM(ps.total) FROM product_sales ps WHERE ps.sale_id = s.id),
           0
       )) > 0.01;

    -- YENI VALIDATION (062): cash + card = total invariant
    SELECT COUNT(*) INTO v_val_cash_card_inv
      FROM sales s
     WHERE s.tenant_id = p_tenant_id
       AND ABS(COALESCE(s.cash, 0) + COALESCE(s.card, 0) - COALESCE(s.total, 0)) > 0.01;

    SELECT COUNT(*) INTO v_val_cost_snapshot
      FROM product_sales ps
      JOIN products p ON p.id = ps.product_id
     WHERE ps.tenant_id = p_tenant_id
       AND ABS(ps.cost - COALESCE(p.cost, 0)) > 0.01;

    SELECT jsonb_build_object(
        'sale_count',    COALESCE(COUNT(DISTINCT s.id), 0),
        'line_count',    COALESCE(COUNT(ps.id), 0),
        'total_revenue', COALESCE(SUM(s.total), 0),
        'total_cost',    COALESCE(SUM(ps.cost * ps.quantity), 0),
        'gross_profit',  COALESCE(SUM(s.total) - SUM(ps.cost * ps.quantity), 0)
    ) INTO v_val_analytics
    FROM sales s
    LEFT JOIN product_sales ps ON ps.sale_id = s.id
    WHERE s.tenant_id = p_tenant_id;

    SELECT jsonb_agg(t) INTO v_val_top5
    FROM (
        SELECT
            p.name,
            SUM(ps.quantity)::int AS qty_sum,
            ROUND(SUM(ps.total)::numeric, 2) AS revenue
          FROM product_sales ps
          JOIN products p ON p.id = ps.product_id
         WHERE ps.tenant_id = p_tenant_id
         GROUP BY p.id, p.name
         ORDER BY SUM(ps.quantity) DESC
         LIMIT 5
    ) t;

    SELECT COUNT(DISTINCT date_trunc('month', s.date))
      INTO v_val_distinct_month
      FROM sales s WHERE s.tenant_id = p_tenant_id;

    SELECT COUNT(*) INTO v_val_recipe_orphan
      FROM products p
     WHERE p.tenant_id = p_tenant_id
       AND p.cost > 0
       AND NOT EXISTS (
           SELECT 1 FROM product_recipes pr
            WHERE pr.product_id = p.id AND pr.is_deleted = false
       );

    v_t_validation := clock_timestamp();

    RETURN jsonb_build_object(
        'mode', 'real',
        'phase', '2C',
        'fix_version', '062',
        'safe_mode', true,
        'ok', true,
        'tenant_id', p_tenant_id,
        'inserted', jsonb_build_object(
            'phase_2a', jsonb_build_object(
                'categories',      v_inserted_cats,
                'raw_materials',   v_inserted_rm,
                'products',        v_inserted_p,
                'product_recipes', v_inserted_rec
            ),
            'phase_2b', jsonb_build_object(
                'purchase_items', v_inserted_pit,
                'chunks',         v_chunk_count_pit
            ),
            'phase_2c', jsonb_build_object(
                'sales',          v_inserted_sal,
                'product_sales',  v_inserted_ps,
                'sales_updated',  v_updated_sales,
                'chunks',         v_chunk_count_sal,
                'top_pool_size',  v_top_n,
                'rest_pool_size', v_rest_n
            )
        ),
        'validation', jsonb_build_object(
            'A_sales_total_mismatch',       v_val_sales_total,
            'A2_cash_card_invariant_fail',  v_val_cash_card_inv,
            'B_cost_snapshot_mismatch',     v_val_cost_snapshot,
            'C_manual_analytics',           v_val_analytics,
            'D_top5_products',              v_val_top5,
            'E_distinct_months',            v_val_distinct_month,
            'phase_2b_prod_cost_mismatch',  v_val_prod_mism,
            'phase_2b_rm_cost_mismatch',    v_val_rm_mism,
            'phase_2b_recipe_orphan',       v_val_recipe_orphan
        ),
        'durations_ms', jsonb_build_object(
            'phase_2a',     round(EXTRACT(EPOCH FROM (v_t_phase_a      - v_t0))            * 1000)::int,
            'phase_2b',     round(EXTRACT(EPOCH FROM (v_t_phase_b      - v_t_phase_a))     * 1000)::int,
            'phase_2c_ins', round(EXTRACT(EPOCH FROM (v_t_phase_c      - v_t_phase_b))     * 1000)::int,
            'total_update', round(EXTRACT(EPOCH FROM (v_t_total_update - v_t_phase_c))     * 1000)::int,
            'validation',   round(EXTRACT(EPOCH FROM (v_t_validation   - v_t_total_update)) * 1000)::int,
            'total',        round(EXTRACT(EPOCH FROM (clock_timestamp()- v_t0))             * 1000)::int
        ),
        'next_steps', jsonb_build_array(
            'Hard refresh browser (Ctrl+Shift+R)',
            'Login as test tenant',
            'Dashboard ilk acilis hizi gozlem',
            'window.RpcObserver.summary() ile p95 olc',
            'Sales sekmesi → daily/monthly view'
        ),
        'next_phase', 'FAZ 2.D: expenses'
    );
END;
$$;


-- ============================================================
-- GRANT (defensive)
-- ============================================================
REVOKE ALL ON FUNCTION public.generate_test_dataset(UUID, BOOLEAN, INT, INT, INT, INT, INT, INT, INT)
    FROM PUBLIC, anon, authenticated;


-- ============================================================
-- POST-DEPLOY VALIDATION
-- ============================================================
DO $$
DECLARE
    v_src TEXT;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'generate_test_dataset';

    IF v_src IS NULL THEN
        RAISE EXCEPTION '[062] FAIL: generate_test_dataset bulunamadi';
    END IF;

    IF v_src ~* E'set_config\\s*\\(\\s*''session_replication_role' THEN
        RAISE EXCEPTION '[062] FAIL: replication-role bypass var';
    END IF;

    IF v_src NOT LIKE '%FIX 062%' THEN
        RAISE EXCEPTION '[062] FAIL: FIX 062 marker eksik';
    END IF;

    IF v_src NOT LIKE '%POST-LOOP TOTAL UPDATE%' THEN
        RAISE EXCEPTION '[062] FAIL: post-loop UPDATE bloku eksik';
    END IF;

    IF v_src NOT LIKE '%cash_flag%' THEN
        RAISE EXCEPTION '[062] FAIL: cash_flag invariant fix eksik';
    END IF;

    -- CTE chain'de UPDATE sales artik OLMAMALI (FIX kontrolu)
    -- (CTE chain'i tespit edip UPDATE'i ararız — heuristic)
    IF v_src LIKE '%line_aggs AS (%' THEN
        RAISE EXCEPTION '[062] FAIL: eski line_aggs CTE hala duruyor (061 bug)';
    END IF;

    RAISE NOTICE '[062] OK: FAZ 2.C total fix aktif (CTE snapshot bug + cash/card invariant)';
END;
$$;
