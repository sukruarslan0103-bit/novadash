-- ============================================================
-- 058 — LOAD TEST GENERATOR — FAZ 2.A
--   categories (product) + raw_materials + products + product_recipes
--
-- Amac:
--   057'deki generate_test_dataset stub'ini gercek bulk insert ile
--   degistir. Sadece FAZ 2.A icin: cost zinciri ve recipe altyapisi.
--   purchases / sales / expenses ileri FAZ'larda.
--
-- Bulk insert stratejisi (Mod B):
--   - SET LOCAL session_replication_role = 'replica' → trigger bypass
--   - generate_series ile bulk INSERT
--   - replication_role = 'origin' restore
--   - Manuel sync: products.cost = calculate_product_cost(p.id)
--
--   raw_materials.cost insert sirasinda direkt atanir (purchase yok,
--   WAC yerine baslangic deger). FAZ 2.B'de purchase_items eklenince
--   sync_raw_material_cost ile gercek WAC hesaplanir.
--
-- Idempotency:
--   p_dry_run = false ise generate_test_dataset onceden mevcut data
--   var mi kontrol eder. Varsa REFUSED + "cleanup_test_dataset cagir".
--
-- Rollback:
--   SELECT cleanup_test_dataset('<tenant_id>'::uuid);
--   (Bu fonksiyon 057'de tanimli, FAZ 2.A icin de calisir — tum
--   tablolari hard delete eder.)
--
-- DRY-RUN davranis:
--   FAZ 2.A'da sadece 4 tablo dolar; will_insert.purchases /
--   purchase_items / sales / product_sales / expenses = 0 olarak
--   dondurulur. Kullanici hangi fazda oldugunu net gorur.
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
    v_name           TEXT;
    v_slug           TEXT;
    v_existing_rm    BIGINT;
    v_existing_prod  BIGINT;
    v_existing_sal   BIGINT;
    v_cat_ids        UUID[];
    v_inserted_cats  INT := 0;
    v_inserted_rm    INT := 0;
    v_inserted_p     INT := 0;
    v_inserted_rec   INT := 0;
    v_synced_costs   INT := 0;
BEGIN
    -- ZORUNLU GUARD
    PERFORM public._lt_assert_test_tenant(p_tenant_id);

    -- Parameter validation
    IF p_raw_materials < 0 OR p_raw_materials > 50000 THEN
        RAISE EXCEPTION 'p_raw_materials out of range: % (0-50000)', p_raw_materials;
    END IF;
    IF p_products < 0 OR p_products > 20000 THEN
        RAISE EXCEPTION 'p_products out of range: % (0-20000)', p_products;
    END IF;
    IF p_purchases < 0 OR p_purchases > 200000 THEN
        RAISE EXCEPTION 'p_purchases out of range: % (0-200000)', p_purchases;
    END IF;
    IF p_sales < 0 OR p_sales > 200000 THEN
        RAISE EXCEPTION 'p_sales out of range: % (0-200000)', p_sales;
    END IF;
    IF p_expenses < 0 OR p_expenses > 500000 THEN
        RAISE EXCEPTION 'p_expenses out of range: % (0-500000)', p_expenses;
    END IF;
    IF p_months < 1 OR p_months > 60 THEN
        RAISE EXCEPTION 'p_months out of range: % (1-60)', p_months;
    END IF;

    SELECT name, slug INTO v_name, v_slug FROM tenants WHERE id = p_tenant_id;

    SELECT COUNT(*) INTO v_existing_rm   FROM raw_materials  WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_prod FROM products       WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_sal  FROM sales          WHERE tenant_id = p_tenant_id;

    -- ============ DRY-RUN MODU ============
    IF p_dry_run THEN
        RETURN jsonb_build_object(
            'mode', 'dry-run',
            'phase', '2A',
            'ok', true,
            'tenant', jsonb_build_object(
                'id',   p_tenant_id,
                'name', v_name,
                'slug', v_slug
            ),
            'existing', jsonb_build_object(
                'raw_materials', v_existing_rm,
                'products',      v_existing_prod,
                'sales',         v_existing_sal
            ),
            'will_insert', jsonb_build_object(
                'categories',      6,                   -- 6 sabit product category
                'raw_materials',   p_raw_materials,
                'products',        p_products,
                'product_recipes', p_products * 4,       -- ortalama 4 recipe/product
                'purchases',       0,                    -- FAZ 2.B
                'purchase_items',  0,                    -- FAZ 2.B
                'sales',           0,                    -- FAZ 2.C
                'product_sales',   0,                    -- FAZ 2.C
                'expenses',        0,                    -- FAZ 2.D
                'phase_2a_total',  6 + p_raw_materials + p_products + (p_products * 4)
            ),
            'params', jsonb_build_object(
                'months', p_months,
                'seed',   p_seed
            ),
            'next_step', 'Eger plan OK ise: generate_test_dataset(<tenant_id>::uuid, p_dry_run := false)',
            'warning', CASE WHEN v_existing_rm + v_existing_prod + v_existing_sal > 0
                       THEN 'Tenant''ta mevcut data var. Once cleanup_test_dataset() cagir.'
                       ELSE NULL END
        );
    END IF;

    -- ============ REAL MODU — FAZ 2.A ============

    -- Pre-flight: mevcut data var ise REFUSED
    IF v_existing_rm > 0 OR v_existing_prod > 0 THEN
        RAISE EXCEPTION 'REFUSED: tenant''ta mevcut raw_materials/products var (rm=%, prod=%). Once: SELECT cleanup_test_dataset(%L::uuid);',
            v_existing_rm, v_existing_prod, p_tenant_id;
    END IF;

    -- Trigger bypass — bulk insert hizi icin. session-scope.
    PERFORM set_config('session_replication_role', 'replica', true);

    -- ============ 1) CATEGORIES (product, 6 adet) ============
    INSERT INTO categories (tenant_id, name, type, color, sort_order)
    SELECT
        p_tenant_id,
        '__LOAD_TEST__' || cat_name,
        'product',
        cat_color,
        cat_order
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

    -- ============ 2) RAW_MATERIALS ============
    INSERT INTO raw_materials (tenant_id, name, unit, base_unit, cost, vat_rate, is_active)
    SELECT
        p_tenant_id,
        '__LOAD_TEST__RM_' || lpad(i::text, 5, '0'),
        CASE (i % 5)
            WHEN 0 THEN 'kg'
            WHEN 1 THEN 'lt'
            WHEN 2 THEN 'adet'
            WHEN 3 THEN 'paket'
            ELSE        'gr'
        END,
        CASE (i % 5)
            WHEN 0 THEN 'gr'    -- kg → gr base
            WHEN 1 THEN 'ml'    -- lt → ml base
            WHEN 2 THEN 'adet'
            WHEN 3 THEN 'adet'  -- paket → adet (simplifikasyon)
            ELSE        'gr'
        END,
        round((random() * 200 + 5)::numeric, 4),   -- 5-205 TL aralik
        20,                                         -- standart KDV
        (random() > 0.05)                           -- %5 inactive
    FROM generate_series(1, p_raw_materials) AS i;
    GET DIAGNOSTICS v_inserted_rm = ROW_COUNT;

    -- ============ 3) PRODUCTS ============
    INSERT INTO products (tenant_id, name, category_id, category_name, price, cost, is_active)
    SELECT
        p_tenant_id,
        '__LOAD_TEST__P_' || lpad(i::text, 4, '0'),
        v_cat_ids[((i - 1) % array_length(v_cat_ids, 1)) + 1],
        NULL,
        round((15 + random() * 135)::numeric, 2),  -- 15-150 TL satis fiyati
        0,                                           -- recipe sync sonrasi set
        (random() > 0.10)                            -- %10 inactive
    FROM generate_series(1, p_products) AS i;
    GET DIAGNOSTICS v_inserted_p = ROW_COUNT;

    -- ============ 4) PRODUCT_RECIPES ============
    -- Her urune 2-5 random raw_material. ~%5 urun reçetesiz (cost=0 edge case)
    INSERT INTO product_recipes (tenant_id, product_id, raw_material_id, quantity)
    SELECT
        p_tenant_id,
        p.id,
        rm.id,
        round((0.05 + random() * 0.45)::numeric, 4)  -- 0.05-0.50 base_unit
    FROM products p
    CROSS JOIN LATERAL (
        SELECT id FROM raw_materials
         WHERE tenant_id = p_tenant_id
           AND is_active = true
         ORDER BY random()
         LIMIT (2 + (random() * 3)::int)              -- 2-4 raw_material
    ) rm
    WHERE p.tenant_id = p_tenant_id
      AND (hashtext(p.id::text) % 20) <> 0;            -- ~%5 product reçetesiz
    GET DIAGNOSTICS v_inserted_rec = ROW_COUNT;

    -- Restore replication_role — sync_product_cost trigger'i icin GERCEK
    -- modu (replica) bypass eder ama biz manuel cagiriyoruz, fark etmez.
    PERFORM set_config('session_replication_role', 'origin', true);

    -- ============ MANUEL SYNC: products.cost = calculate_product_cost ============
    -- Recipe var ise dolar; recipe yok ise 0 kalir (Faz 1.2 cost=0 badge test).
    UPDATE products p
       SET cost = public.calculate_product_cost(p.id),
           updated_at = now()
     WHERE p.tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_synced_costs = ROW_COUNT;

    RETURN jsonb_build_object(
        'mode', 'real',
        'phase', '2A',
        'ok', true,
        'tenant_id', p_tenant_id,
        'inserted', jsonb_build_object(
            'categories',      v_inserted_cats,
            'raw_materials',   v_inserted_rm,
            'products',        v_inserted_p,
            'product_recipes', v_inserted_rec
        ),
        'synced', jsonb_build_object(
            'products_cost', v_synced_costs
        ),
        'duration_ms', round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::int,
        'next_phase', 'FAZ 2.B: purchases + purchase_items'
    );

EXCEPTION WHEN OTHERS THEN
    -- Defensive: replication_role restore
    PERFORM set_config('session_replication_role', 'origin', true);
    RAISE;
END;
$$;


-- ============================================================
-- GRANT (yeniden) — REVOKE 057'de yapildi; CREATE OR REPLACE
-- privilege'leri korur ama defensive REVOKE.
-- ============================================================
REVOKE ALL ON FUNCTION public.generate_test_dataset(UUID, BOOLEAN, INT, INT, INT, INT, INT, INT, INT) FROM PUBLIC, anon, authenticated;


-- ============================================================
-- POST-DEPLOY VALIDATION
-- ============================================================
DO $$
DECLARE
    v_src TEXT;
BEGIN
    SELECT pg_get_functiondef(p.oid)
      INTO v_src
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'generate_test_dataset';

    IF v_src IS NULL THEN
        RAISE EXCEPTION '[058] FAIL: generate_test_dataset bulunamadi';
    END IF;

    -- FAZ 2.A spesifik marker'lar
    IF v_src NOT LIKE '%REAL MODU — FAZ 2.A%' THEN
        RAISE EXCEPTION '[058] FAIL: FAZ 2.A real-mode body eksik';
    END IF;

    IF v_src NOT LIKE '%calculate_product_cost%' THEN
        RAISE EXCEPTION '[058] FAIL: manuel cost sync eksik';
    END IF;

    IF v_src NOT LIKE '%session_replication_role%' THEN
        RAISE EXCEPTION '[058] FAIL: trigger bypass pattern eksik';
    END IF;

    IF v_src NOT LIKE '%SECURITY DEFINER%' THEN
        RAISE EXCEPTION '[058] FAIL: SECURITY DEFINER kayboldu';
    END IF;

    RAISE NOTICE '[058] OK: generate_test_dataset FAZ 2.A aktif (categories + raw_materials + products + product_recipes)';
    RAISE NOTICE '[058] TEST: SELECT generate_test_dataset(<tenant_id>::uuid, p_dry_run := false);';
END;
$$;
