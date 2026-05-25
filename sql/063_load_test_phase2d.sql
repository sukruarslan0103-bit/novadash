-- ============================================================
-- 063 — LOAD TEST GENERATOR — FAZ 2.D (expenses)
--
-- AMAC:
--   Mevcut FAZ 2.A/B/C data'sina expense yuku ekle. Dashboard expense
--   chart / expense KPI / monthly aggregation / health score'a gercekci
--   baski olusturmak.
--
-- VERI DAGILIMI (8 expense category):
--   1) Personel    — %15, ~450 satir, 4000-12000 TL (recurring aylik)
--   2) Kira        — %0.4, 12 satir, 8000-15000 TL (her ayin 1-3'u)
--   3) Elektrik    — %2, ~60 satir, 500-3000 TL (her ayin ~25'i)
--   4) Su          — %0.4, 12 satir, 150-500 TL (her ayin ~20'si)
--   5) Internet    — %0.4, 12 satir, 200-400 TL (her ayin ~10'u)
--   6) Malzeme     — %50, ~1500 satir, 50-800 TL (gunluk random)
--   7) Tamirat     — %5, ~150 satir, 500-5000 TL (random spike)
--   8) Diger       — %26, ~795 satir, 20-2000 TL (noise)
--   Toplam: ~3000 expense @ 12 ay
--
-- RECURRING PATTERN:
--   - Kira/Elektrik/Su/Internet: 4 kategori × 12 ay = 48 satir
--   - Personel: aylik 1-3 ödeme = ~25-40 satir recurring
--   Toplam recurring: ~75-90 satir
--   Geri kalan ~2900 random (chunk loop, Pareto bias)
--
-- IDEMPOTENT SKIP CHAIN (062'den geri uyumlu):
--   - FAZ 2.A: existing_rm > 0 → skip
--   - FAZ 2.B: existing_pit > 0 → skip
--   - FAZ 2.C: existing_sal > 0 → skip (062'de REFUSED idi, simdi skip)
--   - FAZ 2.D: existing_exp > 0 → REFUSED (kendi icinde idempotent)
--
-- Boylece kullanici:
--   1) 062 ile 2.A+2.B+2.C tamamlamis durumda
--   2) 063 deploy → generate_test_dataset(<tenant>, false)
--   3) 2.A/B/C skip, 2.D fresh insert
--
-- CHUNK STRATEGY:
--   chunk_size = 500 expense / chunk. 3000 = 6 chunk × ~300-500ms.
--   30k expense icin Pro tier (60 chunk × ~500ms = ~30sn).
--
-- VALIDATION:
--   A) expense total > 0 (insert basarisi)
--   B) Her kategoride en az 1 satir (8 distinct category)
--   C) Manual dashboard expense aggregate (today/yesterday/monthly)
--   D) Invalid amount count (negatif veya > 1M) = 0
--   E) Monthly distinct count = 10-12
--
-- ROLLBACK:
--   SELECT cleanup_test_dataset('<tenant>'::uuid);
--   Cleanup (057+059) zaten expense + LOAD_TEST kategoriler temizliyor.
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
    v_t_phase_d_cats TIMESTAMPTZ;
    v_t_phase_d_rec  TIMESTAMPTZ;
    v_t_phase_d_rnd  TIMESTAMPTZ;
    v_t_validation   TIMESTAMPTZ;

    v_name           TEXT;
    v_slug           TEXT;
    v_existing_rm    BIGINT;
    v_existing_prod  BIGINT;
    v_existing_pit   BIGINT;
    v_existing_sal   BIGINT;
    v_existing_exp   BIGINT;
    v_cat_ids        UUID[];
    v_exp_cat_ids    UUID[];

    v_inserted_cats     INT := 0;
    v_inserted_rm       INT := 0;
    v_inserted_p        INT := 0;
    v_inserted_rec      INT := 0;
    v_synced_costs      INT := 0;

    v_chunk_size_pit    INT := 250;
    v_chunk_n_pit       INT;
    v_chunk_ins_pit     INT;
    v_inserted_pit      BIGINT := 0;
    v_chunk_count_pit   INT := 0;

    v_chunk_size_sal    INT := 250;
    v_chunk_n_sal       INT;
    v_chunk_ins_ps      INT;
    v_inserted_sal      BIGINT := 0;
    v_inserted_ps       BIGINT := 0;
    v_chunk_count_sal   INT := 0;
    v_updated_sales     BIGINT := 0;

    v_chunk_size_exp    INT := 500;
    v_chunk_n_exp       INT;
    v_chunk_ins_exp     INT;
    v_inserted_exp_cats INT := 0;
    v_inserted_exp_rec_a INT := 0;
    v_inserted_exp_rec_b INT := 0;
    v_inserted_exp_rec  INT := 0;
    v_inserted_exp_rnd  BIGINT := 0;
    v_inserted_exp_tot  BIGINT := 0;
    v_chunk_count_exp   INT := 0;
    v_random_target     INT;

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

    v_val_exp_total      NUMERIC;
    v_val_exp_categories JSONB;
    v_val_exp_invalid    BIGINT;
    v_val_exp_months     BIGINT;
    v_val_exp_analytics  JSONB;
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
    SELECT COUNT(*) INTO v_existing_exp  FROM expenses       WHERE tenant_id = p_tenant_id;

    -- ============ DRY-RUN ============
    IF p_dry_run THEN
        RETURN jsonb_build_object(
            'mode', 'dry-run',
            'phase', '2D',
            'safe_mode', true,
            'fix_version', '063',
            'ok', true,
            'tenant', jsonb_build_object('id', p_tenant_id, 'name', v_name, 'slug', v_slug),
            'existing', jsonb_build_object(
                'raw_materials',  v_existing_rm,
                'products',       v_existing_prod,
                'purchase_items', v_existing_pit,
                'sales',          v_existing_sal,
                'expenses',       v_existing_exp
            ),
            'will_insert', jsonb_build_object(
                'phase_2a', jsonb_build_object('skipped', v_existing_rm > 0),
                'phase_2b', jsonb_build_object('skipped', v_existing_pit > 0),
                'phase_2c', jsonb_build_object('skipped', v_existing_sal > 0),
                'phase_2d', jsonb_build_object(
                    'expense_categories', 8,
                    'recurring_expenses', p_months * 6,
                    'random_expenses',    p_expenses - p_months * 6,
                    'chunk_size',         v_chunk_size_exp,
                    'chunk_count_random', ceil((p_expenses - p_months * 6)::numeric / v_chunk_size_exp)::int
                )
            ),
            'warning', CASE
                WHEN v_existing_exp > 0 THEN 'expenses zaten var, cleanup_test_dataset() cagir.'
                WHEN v_existing_sal = 0 THEN 'FAZ 2.C henuz calismadi. Tek call ile A+B+C+D birlikte yapilir.'
                ELSE NULL
            END
        );
    END IF;

    -- ============ REAL MODE ============

    -- ============ FAZ 2.A (idempotent skip) — 062 ile AYNI ============
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
         WHERE tenant_id = p_tenant_id AND type = 'product'
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
        SELECT p_tenant_id, p.id, rm.id, round((0.05 + random() * 0.45)::numeric, 4)
        FROM products p
        CROSS JOIN LATERAL (
            SELECT id FROM raw_materials
             WHERE tenant_id = p_tenant_id AND is_active = true
             ORDER BY random() LIMIT (2 + (random() * 3)::int)
        ) rm
        WHERE p.tenant_id = p_tenant_id AND (hashtext(p.id::text) % 20) <> 0;
        GET DIAGNOSTICS v_inserted_rec = ROW_COUNT;

        UPDATE products p SET cost = public.calculate_product_cost(p.id), updated_at = now()
         WHERE p.tenant_id = p_tenant_id;
        GET DIAGNOSTICS v_synced_costs = ROW_COUNT;
    END IF;
    v_t_phase_a := clock_timestamp();

    -- ============ FAZ 2.B (idempotent skip) — 062 ile AYNI ============
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

        UPDATE products p SET cost = public.calculate_product_cost(p.id), updated_at = now()
         WHERE p.tenant_id = p_tenant_id;
    END IF;
    v_t_phase_b := clock_timestamp();

    -- ============ FAZ 2.C (idempotent skip) — 062'den uyarlandi ============
    -- DEGISIM: 062'de existing_sal > 0 → REFUSED idi. 063'te skip yapildi
    -- ki 2.D'yi mevcut 2.C uzerine ekleyebilelim.
    IF v_existing_sal = 0 THEN
        SELECT COUNT(*) INTO v_active_prod_n
          FROM products WHERE tenant_id = p_tenant_id AND is_active = true;

        IF v_active_prod_n = 0 THEN
            RAISE EXCEPTION 'REFUSED: aktif product yok — FAZ 2.A calismamis';
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

        IF v_top_ids IS NULL OR array_length(v_top_ids, 1) IS NULL THEN v_top_ids := v_rest_ids; END IF;
        IF v_rest_ids IS NULL OR array_length(v_rest_ids, 1) IS NULL THEN v_rest_ids := v_top_ids; END IF;

        v_top_n  := COALESCE(array_length(v_top_ids, 1), 0);
        v_rest_n := COALESCE(array_length(v_rest_ids, 1), 0);

        v_chunk_n_sal := 0;
        WHILE v_chunk_n_sal * v_chunk_size_sal < p_sales LOOP
            WITH new_sales AS (
                INSERT INTO sales (tenant_id, date, total, cash, card, notes, created_by)
                SELECT
                    p_tenant_id,
                    CASE WHEN random() < 0.35
                         THEN (CURRENT_DATE - (random() * p_months * 4)::int * 7 - (random() * 2)::int)::date
                         ELSE (CURRENT_DATE - (random() * p_months * 30)::int)::date
                    END,
                    0, 0, 0, NULL, NULL
                FROM generate_series(
                    v_chunk_n_sal * v_chunk_size_sal + 1,
                    LEAST((v_chunk_n_sal + 1) * v_chunk_size_sal, p_sales)
                ) AS i
                RETURNING id, date
            )
            INSERT INTO product_sales (tenant_id, sale_id, product_id, date, quantity, unit_price, total, cost)
            SELECT
                p_tenant_id, ns.id, line.product_id, ns.date, line.qty,
                round((p.price * line.price_factor)::numeric, 2)::numeric(12,2),
                round((line.qty * p.price * line.price_factor)::numeric, 2)::numeric(12,2),
                COALESCE(p.cost, 0)
            FROM new_sales ns
            CROSS JOIN LATERAL generate_series(1,
                CASE WHEN random() < 0.30 THEN 1
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
                    CASE WHEN random() < 0.75 THEN 1 WHEN random() < 0.95 THEN 2
                         ELSE 3 + (random() * 2)::int END AS qty,
                    (0.90 + random() * 0.15) AS price_factor
            ) line
            JOIN products p ON p.id = line.product_id AND p.tenant_id = p_tenant_id;

            GET DIAGNOSTICS v_chunk_ins_ps = ROW_COUNT;
            v_inserted_ps := v_inserted_ps + v_chunk_ins_ps;
            v_chunk_n_sal := v_chunk_n_sal + 1;
        END LOOP;
        v_chunk_count_sal := v_chunk_n_sal;

        SELECT COUNT(*) INTO v_inserted_sal FROM sales WHERE tenant_id = p_tenant_id;
        v_t_phase_c := clock_timestamp();

        -- Post-loop total UPDATE (FIX 062)
        UPDATE sales s
           SET total = la.line_total,
               cash  = la.line_total * la.cash_flag,
               card  = la.line_total * (1 - la.cash_flag)
          FROM (
              SELECT ps.sale_id, SUM(ps.total) AS line_total,
                     CASE WHEN random() < 0.60 THEN 1 ELSE 0 END AS cash_flag
                FROM product_sales ps
               WHERE ps.tenant_id = p_tenant_id
               GROUP BY ps.sale_id
          ) la
         WHERE s.tenant_id = p_tenant_id AND s.id = la.sale_id;

        GET DIAGNOSTICS v_updated_sales = ROW_COUNT;
        v_t_total_update := clock_timestamp();
    ELSE
        v_t_phase_c := clock_timestamp();
        v_t_total_update := v_t_phase_c;
    END IF;

    -- ============ FAZ 2.D — expenses (YENI 063) ============

    IF v_existing_exp > 0 THEN
        RAISE EXCEPTION 'REFUSED: expenses zaten var (%). FAZ 2.D re-run icin: SELECT cleanup_test_dataset(%L::uuid);',
            v_existing_exp, p_tenant_id;
    END IF;

    -- ============ 1) 8 EXPENSE CATEGORIES ============
    INSERT INTO categories (tenant_id, name, type, color, sort_order)
    SELECT p_tenant_id, '__LOAD_TEST__' || cat_name, 'expense', cat_color, cat_order
    FROM (VALUES
        ('Personel',  '#f59e0b',  1),
        ('Kira',      '#dc2626',  2),
        ('Elektrik',  '#eab308',  3),
        ('Su',        '#06b6d4',  4),
        ('İnternet',  '#6366f1',  5),
        ('Malzeme',   '#64748b',  6),
        ('Tamirat',   '#a8a29e',  7),
        ('Diğer',     '#10b981',  8)
    ) AS t(cat_name, cat_color, cat_order);
    GET DIAGNOSTICS v_inserted_exp_cats = ROW_COUNT;

    -- v_exp_cat_ids array — sort_order'a gore
    SELECT array_agg(id ORDER BY sort_order) INTO v_exp_cat_ids
      FROM categories
     WHERE tenant_id = p_tenant_id
       AND type = 'expense'
       AND name LIKE '__LOAD\_TEST\_\_%' ESCAPE '\';

    v_t_phase_d_cats := clock_timestamp();

    -- ============ 2) RECURRING EXPENSES (~75 satir) ============
    -- 4 sabit kategori × 12 ay + Personel aylik 1-3 odeme
    -- Toplam: 48 + ~25 = ~73 recurring satir

    -- 2a) Kira / Elektrik / Su / Internet (her ay 1 satir × 4 kategori)
    INSERT INTO expenses (tenant_id, date, amount, category_id, category_name, description, created_by)
    SELECT
        p_tenant_id,
        -- Her ayin belli gunu civari ± 1 gun
        (date_trunc('month', CURRENT_DATE - (m * INTERVAL '1 month'))::date
            + (rec.day_offset + (random() * 2 - 1)::int)
        )::date,
        round((rec.min_amt + random() * (rec.max_amt - rec.min_amt))::numeric, 2),
        v_exp_cat_ids[rec.cat_idx],
        rec.cat_name,
        rec.cat_desc,
        NULL
    FROM generate_series(0, p_months - 1) AS m
    CROSS JOIN (VALUES
        -- (cat_idx, cat_name, cat_desc, min_amt, max_amt, day_offset)
        (2, 'Kira',      'Aylık kira ödemesi',         8000.0,  15000.0,  1),
        (3, 'Elektrik',  'Elektrik faturası',           500.0,   3000.0, 25),
        (4, 'Su',        'Su faturası',                 150.0,    500.0, 20),
        (5, 'İnternet',  'İnternet/Telefon faturası',   200.0,    400.0, 10)
    ) AS rec(cat_idx, cat_name, cat_desc, min_amt, max_amt, day_offset);

    GET DIAGNOSTICS v_inserted_exp_rec_a = ROW_COUNT;

    -- 2b) Personel maaslari (her ay 2 sabit odeme — random count generate_series
    --     SRF'inde implementation-specific olabilirdi; sabit 2 deterministic)
    INSERT INTO expenses (tenant_id, date, amount, category_id, category_name, description, created_by)
    SELECT
        p_tenant_id,
        (date_trunc('month', CURRENT_DATE - (m * INTERVAL '1 month'))::date
            + (1 + (random() * 4)::int)
        )::date,
        round((4000 + random() * 8000)::numeric, 2),
        v_exp_cat_ids[1],   -- Personel
        'Personel',
        'Personel maaş ödemesi',
        NULL
    FROM generate_series(0, p_months - 1) AS m
    CROSS JOIN generate_series(1, 2) AS k;

    GET DIAGNOSTICS v_inserted_exp_rec_b = ROW_COUNT;

    -- Toplam recurring
    v_inserted_exp_rec := v_inserted_exp_rec_a + v_inserted_exp_rec_b;

    v_t_phase_d_rec := clock_timestamp();

    -- ============ 3) RANDOM EXPENSES (~2920 satir, chunk loop) ============
    -- Hedef: p_expenses - recurring_count
    v_random_target := GREATEST(0, p_expenses - v_inserted_exp_rec);

    v_chunk_n_exp := 0;
    WHILE v_chunk_n_exp * v_chunk_size_exp < v_random_target LOOP
        INSERT INTO expenses (tenant_id, date, amount, category_id, category_name, description, created_by)
        SELECT
            p_tenant_id,
            -- Tarih: weekend slight bias (%15 weekend)
            CASE WHEN random() < 0.85
                 THEN (CURRENT_DATE - (random() * p_months * 30)::int)::date
                 ELSE (CURRENT_DATE - (random() * p_months * 4)::int * 7 - (random() * 2)::int)::date
            END,
            -- Amount: kategori bazli range
            cp.amount,
            v_exp_cat_ids[cp.cat_idx],
            cp.cat_name,
            cp.cat_desc,
            NULL
        FROM generate_series(
            v_chunk_n_exp * v_chunk_size_exp + 1,
            LEAST((v_chunk_n_exp + 1) * v_chunk_size_exp, v_random_target)
        ) AS i
        CROSS JOIN LATERAL (
            -- Pareto kategori pick + amount range
            SELECT
                CASE
                    WHEN r < 0.50 THEN 6    -- Malzeme (50%)
                    WHEN r < 0.65 THEN 8    -- Diger   (15%)
                    WHEN r < 0.78 THEN 1    -- Personel ekstra (13%)
                    WHEN r < 0.83 THEN 7    -- Tamirat (5%)
                    WHEN r < 0.92 THEN 3    -- Elektrik ekstra (9%)
                    WHEN r < 0.96 THEN 4    -- Su ekstra (4%)
                    ELSE              5     -- Internet ekstra (4%)
                END AS cat_idx,
                r
            FROM (SELECT random() AS r) rnd
        ) cat_pick
        CROSS JOIN LATERAL (
            -- Amount range kategori bazli
            SELECT
                cat_pick.cat_idx,
                CASE cat_pick.cat_idx
                    WHEN 1 THEN 'Personel'   WHEN 3 THEN 'Elektrik'
                    WHEN 4 THEN 'Su'         WHEN 5 THEN 'İnternet'
                    WHEN 6 THEN 'Malzeme'    WHEN 7 THEN 'Tamirat'
                    ELSE        'Diğer'
                END AS cat_name,
                CASE cat_pick.cat_idx
                    WHEN 1 THEN 'Ek mesai/prim'
                    WHEN 3 THEN 'Elektrik ek tüketim'
                    WHEN 4 THEN 'Su ek tüketim'
                    WHEN 5 THEN 'İnternet ek hizmet'
                    WHEN 6 THEN 'Malzeme/Market alımı'
                    WHEN 7 THEN 'Tamirat/Bakım'
                    ELSE        'Diğer gider'
                END AS cat_desc,
                CASE cat_pick.cat_idx
                    WHEN 1 THEN round((500  + random() * 3000)::numeric, 2)    -- Personel ek
                    WHEN 3 THEN round((100  + random() * 500)::numeric, 2)     -- Elektrik ek
                    WHEN 4 THEN round((50   + random() * 200)::numeric, 2)     -- Su ek
                    WHEN 5 THEN round((50   + random() * 250)::numeric, 2)     -- Internet ek
                    WHEN 6 THEN round((50   + random() * 750)::numeric, 2)     -- Malzeme
                    WHEN 7 THEN round((500  + random() * 4500)::numeric, 2)    -- Tamirat
                    ELSE        round((20   + random() * 1980)::numeric, 2)    -- Diger
                END AS amount
        ) cp;

        GET DIAGNOSTICS v_chunk_ins_exp = ROW_COUNT;
        v_inserted_exp_rnd := v_inserted_exp_rnd + v_chunk_ins_exp;
        v_chunk_n_exp := v_chunk_n_exp + 1;
    END LOOP;
    v_chunk_count_exp := v_chunk_n_exp;
    v_inserted_exp_tot := v_inserted_exp_rec + v_inserted_exp_rnd;

    v_t_phase_d_rnd := clock_timestamp();

    -- ============ VALIDATION ============

    -- A) Total expense amount
    SELECT COALESCE(SUM(amount), 0) INTO v_val_exp_total
      FROM expenses WHERE tenant_id = p_tenant_id;

    -- B) Per-category aggregate
    SELECT jsonb_agg(t) INTO v_val_exp_categories
    FROM (
        SELECT
            c.name AS category,
            COUNT(e.id) AS expense_count,
            ROUND(SUM(e.amount)::numeric, 2) AS total_amount,
            ROUND(AVG(e.amount)::numeric, 2) AS avg_amount
          FROM categories c
          LEFT JOIN expenses e ON e.category_id = c.id AND e.tenant_id = p_tenant_id
         WHERE c.tenant_id = p_tenant_id AND c.type = 'expense'
           AND c.name LIKE '__LOAD\_TEST\_\_%' ESCAPE '\'
         GROUP BY c.id, c.name, c.sort_order
         ORDER BY c.sort_order
    ) t;

    -- C) Manual dashboard expense analytics
    SELECT jsonb_build_object(
        'today_total',      COALESCE(SUM(CASE WHEN e.date = CURRENT_DATE THEN e.amount ELSE 0 END), 0),
        'yesterday_total',  COALESCE(SUM(CASE WHEN e.date = CURRENT_DATE - 1 THEN e.amount ELSE 0 END), 0),
        'this_month_total', COALESCE(SUM(CASE WHEN e.date >= date_trunc('month', CURRENT_DATE)::date THEN e.amount ELSE 0 END), 0),
        'last_month_total', COALESCE(SUM(
            CASE WHEN e.date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
                  AND e.date <  date_trunc('month', CURRENT_DATE)::date
                 THEN e.amount ELSE 0 END
        ), 0),
        'total',            COALESCE(SUM(e.amount), 0)
    ) INTO v_val_exp_analytics
    FROM expenses e
    WHERE e.tenant_id = p_tenant_id;

    -- D) Invalid amount count (negatif veya > 1M)
    SELECT COUNT(*) INTO v_val_exp_invalid
      FROM expenses
     WHERE tenant_id = p_tenant_id
       AND (amount < 0 OR amount > 1000000);

    -- E) Distinct month count
    SELECT COUNT(DISTINCT date_trunc('month', date))
      INTO v_val_exp_months
      FROM expenses WHERE tenant_id = p_tenant_id;

    -- 2.C validation tekrari (uyumluluk)
    SELECT COUNT(*) INTO v_val_sales_total
      FROM sales s
     WHERE s.tenant_id = p_tenant_id
       AND ABS(s.total - COALESCE(
           (SELECT SUM(ps.total) FROM product_sales ps WHERE ps.sale_id = s.id), 0
       )) > 0.01;

    SELECT COUNT(*) INTO v_val_cash_card_inv
      FROM sales s WHERE s.tenant_id = p_tenant_id
       AND ABS(COALESCE(s.cash, 0) + COALESCE(s.card, 0) - COALESCE(s.total, 0)) > 0.01;

    v_t_validation := clock_timestamp();

    RETURN jsonb_build_object(
        'mode', 'real',
        'phase', '2D',
        'fix_version', '063',
        'safe_mode', true,
        'ok', true,
        'tenant_id', p_tenant_id,
        'inserted', jsonb_build_object(
            'phase_2a', jsonb_build_object('skipped', v_existing_rm > 0),
            'phase_2b', jsonb_build_object('skipped', v_existing_pit > 0),
            'phase_2c', jsonb_build_object('skipped', v_existing_sal > 0,
                                            'sales_updated', v_updated_sales),
            'phase_2d', jsonb_build_object(
                'expense_categories', v_inserted_exp_cats,
                'recurring_expenses', v_inserted_exp_rec,
                'random_expenses',    v_inserted_exp_rnd,
                'total_expenses',     v_inserted_exp_tot,
                'chunks',             v_chunk_count_exp
            )
        ),
        'validation', jsonb_build_object(
            'A_expense_total',         v_val_exp_total,
            'B_categories',            v_val_exp_categories,
            'C_dashboard_analytics',   v_val_exp_analytics,
            'D_invalid_amount_count',  v_val_exp_invalid,
            'E_distinct_months',       v_val_exp_months,
            'phase_2c_sales_total_mismatch',  v_val_sales_total,
            'phase_2c_cash_card_mismatch',    v_val_cash_card_inv
        ),
        'durations_ms', jsonb_build_object(
            'phase_2a',     round(EXTRACT(EPOCH FROM (v_t_phase_a      - v_t0))            * 1000)::int,
            'phase_2b',     round(EXTRACT(EPOCH FROM (v_t_phase_b      - v_t_phase_a))     * 1000)::int,
            'phase_2c_ins', round(EXTRACT(EPOCH FROM (v_t_phase_c      - v_t_phase_b))     * 1000)::int,
            'total_update', round(EXTRACT(EPOCH FROM (v_t_total_update - v_t_phase_c))     * 1000)::int,
            'phase_2d_cats',round(EXTRACT(EPOCH FROM (v_t_phase_d_cats - v_t_total_update)) * 1000)::int,
            'phase_2d_rec', round(EXTRACT(EPOCH FROM (v_t_phase_d_rec  - v_t_phase_d_cats)) * 1000)::int,
            'phase_2d_rnd', round(EXTRACT(EPOCH FROM (v_t_phase_d_rnd  - v_t_phase_d_rec))  * 1000)::int,
            'validation',   round(EXTRACT(EPOCH FROM (v_t_validation   - v_t_phase_d_rnd))  * 1000)::int,
            'total',        round(EXTRACT(EPOCH FROM (clock_timestamp()- v_t0))             * 1000)::int
        ),
        'next_steps', jsonb_build_array(
            'Hard refresh browser (Ctrl+Shift+R)',
            'Dashboard → expense chart, KPI gider, health score gozlem',
            'window.RpcObserver.summary() ile get_dashboard_analytics p95',
            'Expenses sekmesi → kategori dagilimi',
            'Monthly view → 12 ay distinct'
        ),
        'next_phase', 'COMPLETE — full dataset ready for frontend stress test'
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

    IF v_src IS NULL THEN RAISE EXCEPTION '[063] FAIL: generate_test_dataset bulunamadi'; END IF;

    IF v_src ~* E'set_config\\s*\\(\\s*''session_replication_role' THEN
        RAISE EXCEPTION '[063] FAIL: replication-role bypass var';
    END IF;

    IF v_src NOT LIKE '%FAZ 2.D%' THEN
        RAISE EXCEPTION '[063] FAIL: FAZ 2.D body eksik';
    END IF;

    IF v_src NOT LIKE '%RECURRING EXPENSES%' THEN
        RAISE EXCEPTION '[063] FAIL: recurring expense block eksik';
    END IF;

    IF v_src NOT LIKE '%v_exp_cat_ids%' THEN
        RAISE EXCEPTION '[063] FAIL: expense category array eksik';
    END IF;

    RAISE NOTICE '[063] OK: FAZ 2.D aktif (8 expense categories + recurring + random chunk loop)';
END;
$$;
