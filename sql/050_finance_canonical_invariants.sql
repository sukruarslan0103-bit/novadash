-- ============================================================
-- 050 — FINANCE CANONICAL INVARIANTS
--
-- Amac:
--   docs/FINANCE.md'de tanimlanan finansal anayasayi DB seviyesinde
--   freeze etmek. Bu migration:
--     A) Tum parasal kolonlara canonical COMMENT yapistirir.
--     B) Eksik finansal CHECK constraint'leri ekler.
--     C) purchase_items.vat_rate DEFAULT 0 -> 20 (Turkiye standard KDV).
--     D) Kritik finans RPC'lerine COMMENT ON FUNCTION ekler.
--
-- KAPSAM DISI (bu migration DOKUNMAZ):
--   - Hicbir UPDATE/DELETE (data dokunmaz).
--   - Hicbir trigger body (51'de).
--   - raw_materials.cost rebackfill (52'de).
--   - products.cost recalculation (52'de cascade ile).
--   - sales_cash_card_equals_total invariant (UI payment split sonrasi).
--
-- Pre-flight:
--   Tum CHECK adaylari icin ihlal sayisi olcer. Tek satir bile
--   ihlal varsa RAISE EXCEPTION + ABORT. Hicbir DDL calistirilmaz.
--
-- Idempotent:
--   - COMMENT overwrite-safe.
--   - DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pattern.
--   - ALTER COLUMN SET DEFAULT idempotent.
--
-- Rollback:
--   Tek script ile geri: DROP CONSTRAINT + COMMENT IS NULL +
--   DEFAULT 0. <10 saniye. Veri kaybi sifir.
-- ============================================================


-- ============================================================
-- SECTION A — PRE-FLIGHT INTEGRITY CHECK
-- ============================================================
DO $pre$
DECLARE
    v_bad_sales_total       INT;
    v_bad_ps_amounts        INT;
    v_bad_expense_amount    INT;
    v_bad_pi_discount       INT;
    v_bad_pi_unit_cost      INT;
    v_bad_purchases_total   INT;
    v_bad_purchases_vat     INT;
BEGIN
    RAISE NOTICE 'PRE-FLIGHT: scanning canonical invariants...';

    SELECT count(*) INTO v_bad_sales_total
      FROM public.sales WHERE total < 0;

    SELECT count(*) INTO v_bad_ps_amounts
      FROM public.product_sales
     WHERE total < 0 OR unit_price < 0 OR cost < 0 OR quantity < 0;

    SELECT count(*) INTO v_bad_expense_amount
      FROM public.expenses WHERE amount < 0;

    SELECT count(*) INTO v_bad_pi_discount
      FROM public.purchase_items
     WHERE discount_rate < 0 OR discount_rate > 100;

    SELECT count(*) INTO v_bad_pi_unit_cost
      FROM public.purchase_items
     WHERE unit_cost < 0 OR line_total < 0;

    SELECT count(*) INTO v_bad_purchases_total
      FROM public.purchases WHERE total_price < 0;

    SELECT count(*) INTO v_bad_purchases_vat
      FROM public.purchases
     WHERE vat_rate < 0 OR vat_rate > 100;

    IF v_bad_sales_total     > 0
       OR v_bad_ps_amounts        > 0
       OR v_bad_expense_amount    > 0
       OR v_bad_pi_discount       > 0
       OR v_bad_pi_unit_cost      > 0
       OR v_bad_purchases_total   > 0
       OR v_bad_purchases_vat     > 0
    THEN
        RAISE EXCEPTION
            'PRE-FLIGHT FAIL: invariant violations detected. ABORT.
             sales.total<0=%
             product_sales(total/unit_price/cost/quantity)<0=%
             expenses.amount<0=%
             purchase_items.discount out of range=%
             purchase_items.unit_cost/line_total<0=%
             purchases.total_price<0=%
             purchases.vat out of range=%
             Fix violations manually and re-run.',
            v_bad_sales_total, v_bad_ps_amounts, v_bad_expense_amount,
            v_bad_pi_discount, v_bad_pi_unit_cost,
            v_bad_purchases_total, v_bad_purchases_vat;
    END IF;

    RAISE NOTICE 'PRE-FLIGHT OK: 0 violations across 7 invariants';
END $pre$;


-- ============================================================
-- SECTION B — COMMENT ON COLUMN (canonical semantic freeze)
-- ============================================================

-- B.1 sales
COMMENT ON COLUMN public.sales.total IS
    'KDV DAHIL gross satis tutari (TRY). Invariant: cash+card=total (UI hazirlaninca enforce edilecek).';
COMMENT ON COLUMN public.sales.cash IS
    'KDV DAHIL nakit tahsilat.';
COMMENT ON COLUMN public.sales.card IS
    'KDV DAHIL kart tahsilat.';

-- B.2 product_sales
COMMENT ON COLUMN public.product_sales.unit_price IS
    'KDV DAHIL satir birim satis fiyati.';
COMMENT ON COLUMN public.product_sales.total IS
    'KDV DAHIL satir toplami (quantity * unit_price).';
COMMENT ON COLUMN public.product_sales.cost IS
    'KDV DAHIL satis ani IMMUTABLE maliyet snapshot (FAZ 1.1). '
    'Bir kez yazildiktan sonra hicbir trigger/RPC/restore update etmez.';

-- B.3 expenses
COMMENT ON COLUMN public.expenses.amount IS
    'KDV DAHIL gider tutari (kasadan cikan para). '
    'Vergi disi (kira gibi) giderler de ayni kolonda.';

-- B.4 purchases (legacy Akis A)
COMMENT ON COLUMN public.purchases.total_price IS
    'KDV HARIC alis tutari (legacy Akis A; faturada yazan). '
    'Deprecated: yeni faturalar purchase_items uzerinden gelmeli.';
COMMENT ON COLUMN public.purchases.net_total IS
    'KDV DAHIL toplam = total_price * (1 + vat_rate/100).';
COMMENT ON COLUMN public.purchases.unit_cost IS
    'KDV DAHIL birim maliyet = net_total / quantity. products.cost icin source.';
COMMENT ON COLUMN public.purchases.vat_rate IS
    'KDV orani (%). 0-100.';

-- B.5 purchase_items (modern Akis B)
COMMENT ON COLUMN public.purchase_items.unit_cost IS
    'KDV HARIC alis birim fiyati (faturada yazan).';
COMMENT ON COLUMN public.purchase_items.line_total IS
    'KDV HARIC satir toplami (iskonto sonrasi, vergi oncesi). '
    'Formul: quantity * unit_cost * (1 - discount_rate/100).';
COMMENT ON COLUMN public.purchase_items.vat_rate IS
    'Satir KDV orani (%). Default 20. 0-100.';
COMMENT ON COLUMN public.purchase_items.discount_rate IS
    'Satir iskonto orani (%). line_total ve base_unit_cost hesabina dahil. 0-100.';
COMMENT ON COLUMN public.purchase_items.base_unit_cost IS
    'KDV DAHIL base_unit basina maliyet. '
    'trg_fn_purchase_items_fill_base tarafindan yazilir (FAZ 1.4 sonrasi VAT-aware). '
    'Formul: line_total * (1 - discount/100) * (1 + vat/100) / base_quantity.';

-- B.6 raw_materials
COMMENT ON COLUMN public.raw_materials.cost IS
    'KDV DAHIL son alis maliyeti (base_unit basina). '
    'Trigger zinciri ile guncellenir (calculate_raw_material_wac).';

-- B.7 products
COMMENT ON COLUMN public.products.price IS
    'KDV DAHIL menu satis fiyati.';
COMMENT ON COLUMN public.products.cost IS
    'KDV DAHIL urun maliyeti. Recipe motoru (calculate_product_cost) veya '
    'legacy create_purchase_and_update_product_cost RPC yazar. Iki yol da KDV DAHIL.';


-- ============================================================
-- SECTION C — CHECK CONSTRAINTS (financial invariants)
-- ============================================================

-- C.1 sales.total >= 0
ALTER TABLE public.sales
    DROP CONSTRAINT IF EXISTS sales_total_nonneg;
ALTER TABLE public.sales
    ADD CONSTRAINT sales_total_nonneg
    CHECK (total >= 0);

-- C.2 product_sales amounts nonneg
ALTER TABLE public.product_sales
    DROP CONSTRAINT IF EXISTS product_sales_amounts_nonneg;
ALTER TABLE public.product_sales
    ADD CONSTRAINT product_sales_amounts_nonneg
    CHECK (total >= 0 AND unit_price >= 0 AND cost >= 0 AND quantity >= 0);

-- C.3 expenses.amount >= 0
ALTER TABLE public.expenses
    DROP CONSTRAINT IF EXISTS expenses_amount_nonneg;
ALTER TABLE public.expenses
    ADD CONSTRAINT expenses_amount_nonneg
    CHECK (amount >= 0);

-- C.4 purchase_items.discount_rate range
ALTER TABLE public.purchase_items
    DROP CONSTRAINT IF EXISTS purchase_items_discount_range;
ALTER TABLE public.purchase_items
    ADD CONSTRAINT purchase_items_discount_range
    CHECK (discount_rate >= 0 AND discount_rate <= 100);

-- C.5 purchase_items.unit_cost / line_total nonneg
ALTER TABLE public.purchase_items
    DROP CONSTRAINT IF EXISTS purchase_items_unit_cost_nonneg;
ALTER TABLE public.purchase_items
    ADD CONSTRAINT purchase_items_unit_cost_nonneg
    CHECK (unit_cost >= 0 AND line_total >= 0);

-- C.6 purchases.total_price >= 0
ALTER TABLE public.purchases
    DROP CONSTRAINT IF EXISTS purchases_total_nonneg;
ALTER TABLE public.purchases
    ADD CONSTRAINT purchases_total_nonneg
    CHECK (total_price >= 0);

-- C.7 purchases.vat_rate range
ALTER TABLE public.purchases
    DROP CONSTRAINT IF EXISTS purchases_vat_range;
ALTER TABLE public.purchases
    ADD CONSTRAINT purchases_vat_range
    CHECK (vat_rate >= 0 AND vat_rate <= 100);


-- ============================================================
-- SECTION D — DEFAULT ADJUSTMENTS
-- ============================================================

-- D.1 purchase_items.vat_rate: 0 -> 20 (Turkiye genel KDV)
--   Mevcut satirlar dokunulmaz; sadece yeni INSERT'lerde default 20.
ALTER TABLE public.purchase_items
    ALTER COLUMN vat_rate SET DEFAULT 20;


-- ============================================================
-- SECTION E — COMMENT ON FUNCTION (finance semantic in compute engine)
-- ============================================================

COMMENT ON FUNCTION public.calculate_product_cost(UUID) IS
    'Returns KDV DAHIL recipe cost. Formul: SUM(product_recipes.quantity * '
    'raw_materials.cost) WHERE both NOT is_deleted. raw_materials.cost zaten '
    'KDV DAHIL (FAZ 1.4 sonrasi). Canonical finance semantics: docs/FINANCE.md.';

COMMENT ON FUNCTION public.calculate_raw_material_wac(UUID) IS
    'Returns KDV DAHIL last purchase price (base_unit basina). '
    'Despite "wac" name, this is LAST PRICE model (035). Reads from '
    'purchase_items.base_unit_cost ORDER BY created_at DESC. '
    'base_unit_cost trigger tarafindan KDV DAHIL yazilir (FAZ 1.4 sonrasi).';

COMMENT ON FUNCTION public.sync_product_cost(UUID) IS
    'Updates products.cost = calculate_product_cost(product_id) only if '
    'product has at least one active recipe. Recipe yoksa products.cost '
    'manuel kalir (UI ya da legacy purchase RPC tarafindan yazilir). '
    'Canonical: KDV DAHIL.';

COMMENT ON FUNCTION public.create_purchase_and_update_product_cost(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT) IS
    'LEGACY Akis A purchase RPC. p_total KDV HARIC, p_vat oran. '
    'Hesap: net_total = p_total * (1 + p_vat/100), unit_cost = net_total/qty. '
    'Sonuc KDV DAHIL unit_cost products.cost icin direkt yazilir. '
    'DEPRECATED: yeni faturalar purchase_items (Akis B) uzerinden. '
    'FAZ 2 ile kaldirilacak.';

COMMENT ON FUNCTION public.create_sales_atomic(UUID, JSONB) IS
    'Canonical sales write RPC. SECURITY DEFINER. Tenant resolve auth.uid. '
    'product_sales.cost server-side products.cost snapshot (FAZ 1.1 — '
    'immutable). Idempotency: composite UNIQUE (tenant_id, idempotency_key). '
    'Canonical finance: KDV DAHIL.';

COMMENT ON FUNCTION public.insert_expense(DATE, NUMERIC, UUID, TEXT, TEXT, TEXT) IS
    'Canonical expense write RPC. SECURITY DEFINER. Tenant resolve auth.uid. '
    'p_amount KDV DAHIL gross tutar. ON CONFLICT (tenant_id, idempotency_key) '
    'DO NOTHING. Canonical finance: KDV DAHIL.';

COMMENT ON FUNCTION public.get_dashboard_analytics(DATE, DATE) IS
    'Dashboard aggregate RPC. profit = SUM(sales.total) - SUM(product_sales.cost) '
    '- SUM(expenses.amount). Uc bilesen de KDV DAHIL gross. '
    'Returned profit = gross margin (vergi-oncesi muhasebe karina denk DEGIL).';

COMMENT ON FUNCTION public.get_sales_paginated(DATE, DATE, INT, INT) IS
    'Paginated sales read RPC. Returned cost = SUM(product_sales.cost) — '
    'satis ani KDV DAHIL snapshot. profit = s.total - cost (gross margin).';


-- ============================================================
-- SECTION V — VALIDATION (post-apply)
-- ============================================================
DO $val$
DECLARE
    v_comment_col_count INT;
    v_check_count       INT;
    v_func_present      INT;
    v_func_missing      TEXT[];
    v_vat_default       TEXT;
    v_expected_funcs    TEXT[] := ARRAY[
        'calculate_product_cost',
        'calculate_raw_material_wac',
        'sync_product_cost',
        'create_purchase_and_update_product_cost',
        'create_sales_atomic',
        'insert_expense',
        'get_dashboard_analytics',
        'get_sales_paginated'
    ];
    v_fname TEXT;
BEGIN
    RAISE NOTICE 'VALIDATION: starting post-apply checks...';

    -- 1) COMMENT ON COLUMN presence (19 kolon icin)
    SELECT count(*) INTO v_comment_col_count
      FROM pg_description d
      JOIN pg_attribute a
        ON a.attrelid = d.objoid AND a.attnum = d.objsubid
      JOIN pg_class c     ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND (c.relname, a.attname) IN (
            ('sales','total'), ('sales','cash'), ('sales','card'),
            ('product_sales','unit_price'), ('product_sales','total'), ('product_sales','cost'),
            ('expenses','amount'),
            ('purchases','total_price'), ('purchases','net_total'),
            ('purchases','unit_cost'), ('purchases','vat_rate'),
            ('purchase_items','unit_cost'), ('purchase_items','line_total'),
            ('purchase_items','vat_rate'), ('purchase_items','discount_rate'),
            ('purchase_items','base_unit_cost'),
            ('raw_materials','cost'),
            ('products','price'), ('products','cost')
       );

    IF v_comment_col_count < 19 THEN
        RAISE EXCEPTION 'KRITIK: COMMENT ON COLUMN eksik (% / 19)', v_comment_col_count;
    END IF;

    -- 2) 7 CHECK constraint mevcut mu?
    SELECT count(*) INTO v_check_count
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public'
       AND c.conname IN (
            'sales_total_nonneg',
            'product_sales_amounts_nonneg',
            'expenses_amount_nonneg',
            'purchase_items_discount_range',
            'purchase_items_unit_cost_nonneg',
            'purchases_total_nonneg',
            'purchases_vat_range'
       );

    IF v_check_count <> 7 THEN
        RAISE EXCEPTION 'KRITIK: 7 CHECK constraint bekleniyordu, % bulundu', v_check_count;
    END IF;

    -- 3) DEFAULT vat_rate = 20 mu?
    SELECT pg_get_expr(adbin, adrelid)
      INTO v_vat_default
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      JOIN pg_class     c ON c.oid = d.adrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'purchase_items'
       AND a.attname = 'vat_rate'
     LIMIT 1;

    IF v_vat_default IS NULL OR v_vat_default NOT LIKE '20%' THEN
        RAISE EXCEPTION 'KRITIK: purchase_items.vat_rate DEFAULT 20 olmali, bulunan: %', v_vat_default;
    END IF;

    -- 4) Canonical finance function'lar mevcut mu? (drift detection)
    v_func_missing := ARRAY[]::TEXT[];
    FOREACH v_fname IN ARRAY v_expected_funcs LOOP
        SELECT count(*) INTO v_func_present
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = v_fname;

        IF v_func_present = 0 THEN
            v_func_missing := array_append(v_func_missing, v_fname);
        END IF;
    END LOOP;

    IF array_length(v_func_missing, 1) > 0 THEN
        RAISE EXCEPTION
            'KRITIK: canonical finance function eksik (drift?): %',
            array_to_string(v_func_missing, ', ');
    END IF;

    -- 5) COMMENT ON FUNCTION sayisi (8 fonksiyon icin)
    SELECT count(*) INTO v_func_present
      FROM pg_description d
      JOIN pg_proc      p ON p.oid = d.objoid
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND d.objsubid = 0
       AND p.proname = ANY(v_expected_funcs);

    IF v_func_present < array_length(v_expected_funcs, 1) THEN
        RAISE EXCEPTION
            'KRITIK: COMMENT ON FUNCTION eksik (% / %)',
            v_func_present, array_length(v_expected_funcs, 1);
    END IF;

    RAISE NOTICE 'VALIDATION: COMMENT columns... %/19 OK', v_comment_col_count;
    RAISE NOTICE 'VALIDATION: CHECK constraints... %/7 OK', v_check_count;
    RAISE NOTICE 'VALIDATION: purchase_items.vat_rate DEFAULT... % OK', v_vat_default;
    RAISE NOTICE 'VALIDATION: canonical finance functions present... %/% OK',
                 array_length(v_expected_funcs, 1), array_length(v_expected_funcs, 1);
    RAISE NOTICE 'VALIDATION: COMMENT on functions... %/% OK',
                 v_func_present, array_length(v_expected_funcs, 1);

    RAISE NOTICE 'OK: 050 finance canonical invariants applied (docs/FINANCE.md v1.0)';
END $val$;
