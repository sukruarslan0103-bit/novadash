-- ============================================================
-- 059 — LOAD TEST GENERATOR — SAFE MODE (Supabase hosted uyumu)
--
-- SORUN:
--   Supabase hosted PG'de `session_replication_role` ayari sadece
--   superuser yetkisi gerektirir. SECURITY DEFINER fonksiyon icinde
--   bile reddedilir (RDS-benzeri kisit; multi-tenant security policy
--   parcasi). Hatasi:
--     'permission denied to set parameter "session_replication_role"'
--
-- NEDEN HOSTED'DA NORMAL:
--   - Supabase paylasimli PG cluster. session_replication_role degisimi
--     RLS bypass + trigger bypass demektir → tenant izolasyonu kirilabilir.
--   - Bu yuzden Supabase bu ayari postgres role'e bile kapatti (REVOKE).
--   - Self-hosted PG'de bu kisit yok; ama hosted ile uyumluluk icin
--     mutlaka KALDIRMALIYIZ.
--
-- COZUM (SAFE MODE):
--   - session_replication_role HIC dokunulmaz
--   - Normal trigger zinciri calisir
--   - set_tenant_id BEFORE INSERT trigger'i NEW.tenant_id IS NOT NULL ise
--     pass-through (line 1778-1780 in 999_baseline) → bizim explicit
--     verdigimiz tenant_id korunur, override YOK
--   - trg_fn_product_recipes_cost_sync AFTER INSERT'te sync_product_cost
--     cagirilir → products.cost recipe insert sirasinda zaten guncellenir
--   - Bizim manuel UPDATE products SET cost = calculate_product_cost(...)
--     adimi ARTIK IDEMPOTENT (trigger yapti, biz tekrar yapiyoruz — ayni
--     sonuc). Bunu kaldirabilir veya defensive olarak birakabiliriz.
--
-- DEGISIKLIKLER (058'e gore):
--   - cleanup_test_dataset: PERFORM set_config(...) satirlari kaldirildi
--   - generate_test_dataset: PERFORM set_config(...) satirlari kaldirildi
--   - generate_test_dataset: EXCEPTION block'tan da set_config kaldirildi
--   - Body geri kalani BIT bit ayni
--
-- PERFORMANS FARKI:
--   - 058 (replica bypass): tahmini ~250-470ms total
--   - 059 (safe mode):      tahmini ~500-1200ms total
--   - Fark sebebi: ~200 recipe insert'inde her birinde
--     sync_product_cost trigger calisiyor (UPDATE products SET cost...).
--   - 200 trigger × ~2-5ms = ~400-1000ms ek yuk
--   - Yine de Supabase Free 8sn timeout'a rahat sigar (~%15 sinir)
--
-- IDEMPOTENCY:
--   059 CREATE OR REPLACE ile 058'in body'sini override eder. Yeniden
--   calistirilabilir; eski body kalintisi yok.
--
-- ROLLBACK (gerekirse):
--   058'in body'sini tekrar RUN (ama hosted'da yine fail eder — bunu
--   yapma; 059 tek dogru hosted davranis).
-- ============================================================


-- ============================================================
-- cleanup_test_dataset — session_replication_role KALDIRILDI
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_test_dataset(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_t0           TIMESTAMPTZ := clock_timestamp();
    v_d_expenses   BIGINT := 0;
    v_d_psales     BIGINT := 0;
    v_d_sales      BIGINT := 0;
    v_d_pitems     BIGINT := 0;
    v_d_purchases  BIGINT := 0;
    v_d_recipes    BIGINT := 0;
    v_d_products   BIGINT := 0;
    v_d_rm         BIGINT := 0;
    v_d_cats       BIGINT := 0;
BEGIN
    PERFORM public._lt_assert_test_tenant(p_tenant_id);

    -- SAFE MODE: replication-role degisimine dokunulmaz (hosted uyumu).
    -- AFTER DELETE trigger'lari (purchase_items → sync_raw_material_cost,
    -- product_recipes → sync_product_cost) calisacak — ama sonrasinda
    -- raw_materials ve products DELETE edildigi icin side effect'ler
    -- zararsiz (gecici UPDATE'ler).

    -- Child → parent FK siralamasi
    DELETE FROM expenses        WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_expenses = ROW_COUNT;

    DELETE FROM product_sales   WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_psales = ROW_COUNT;

    DELETE FROM sales           WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_sales = ROW_COUNT;

    DELETE FROM purchase_items  WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_pitems = ROW_COUNT;

    DELETE FROM purchases       WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_purchases = ROW_COUNT;

    DELETE FROM product_recipes WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_recipes = ROW_COUNT;

    DELETE FROM products        WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_products = ROW_COUNT;

    DELETE FROM raw_materials   WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_d_rm = ROW_COUNT;

    DELETE FROM categories
     WHERE tenant_id = p_tenant_id
       AND name LIKE '__LOAD\_TEST\_\_%' ESCAPE '\';
    GET DIAGNOSTICS v_d_cats = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true,
        'mode', 'safe',
        'tenant_id', p_tenant_id,
        'deleted', jsonb_build_object(
            'expenses',        v_d_expenses,
            'product_sales',   v_d_psales,
            'sales',           v_d_sales,
            'purchase_items',  v_d_pitems,
            'purchases',       v_d_purchases,
            'product_recipes', v_d_recipes,
            'products',        v_d_products,
            'raw_materials',   v_d_rm,
            'categories',      v_d_cats
        ),
        'duration_ms', round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::int
    );
END;
$$;


-- ============================================================
-- generate_test_dataset — SAFE MODE (replication_role kaldirildi)
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
    PERFORM public._lt_assert_test_tenant(p_tenant_id);

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

    -- ============ DRY-RUN ============
    IF p_dry_run THEN
        RETURN jsonb_build_object(
            'mode', 'dry-run',
            'phase', '2A',
            'safe_mode', true,
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
                'categories',      6,
                'raw_materials',   p_raw_materials,
                'products',        p_products,
                'product_recipes', p_products * 4,
                'purchases',       0,
                'purchase_items',  0,
                'sales',           0,
                'product_sales',   0,
                'expenses',        0,
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

    -- ============ REAL MODU — FAZ 2.A SAFE MODE ============

    IF v_existing_rm > 0 OR v_existing_prod > 0 THEN
        RAISE EXCEPTION 'REFUSED: tenant''ta mevcut raw_materials/products var (rm=%, prod=%). Once: SELECT cleanup_test_dataset(%L::uuid);',
            v_existing_rm, v_existing_prod, p_tenant_id;
    END IF;

    -- SAFE MODE: replication-role degisimine dokunulmaz (hosted uyumu).
    -- set_tenant_id trigger'i NEW.tenant_id IS NOT NULL ise pass-through
    -- (999:1778) → bizim explicit verdigimiz tenant_id korunur.

    -- ============ 1) CATEGORIES (6 product) ============
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
            WHEN 0 THEN 'gr'
            WHEN 1 THEN 'ml'
            WHEN 2 THEN 'adet'
            WHEN 3 THEN 'adet'
            ELSE        'gr'
        END,
        round((random() * 200 + 5)::numeric, 4),
        20,
        (random() > 0.05)
    FROM generate_series(1, p_raw_materials) AS i;
    GET DIAGNOSTICS v_inserted_rm = ROW_COUNT;

    -- ============ 3) PRODUCTS ============
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

    -- ============ 4) PRODUCT_RECIPES ============
    -- DIKKAT: AFTER INSERT trigger trg_fn_product_recipes_cost_sync
    -- her satirda sync_product_cost(product_id) cagiriyor → products.cost
    -- bu noktada zaten guncelleniyor. Asagidaki manuel UPDATE idempotent
    -- (sonuc ayni; defensive).
    INSERT INTO product_recipes (tenant_id, product_id, raw_material_id, quantity)
    SELECT
        p_tenant_id,
        p.id,
        rm.id,
        round((0.05 + random() * 0.45)::numeric, 4)
    FROM products p
    CROSS JOIN LATERAL (
        SELECT id FROM raw_materials
         WHERE tenant_id = p_tenant_id
           AND is_active = true
         ORDER BY random()
         LIMIT (2 + (random() * 3)::int)
    ) rm
    WHERE p.tenant_id = p_tenant_id
      AND (hashtext(p.id::text) % 20) <> 0;
    GET DIAGNOSTICS v_inserted_rec = ROW_COUNT;

    -- ============ MANUEL SYNC (defensive, idempotent) ============
    -- Trigger zinciri zaten yapti, ama defensive: recipe trigger
    -- bir sebepten skip ettiyse (RLS, race), bu UPDATE garanti eder.
    UPDATE products p
       SET cost = public.calculate_product_cost(p.id),
           updated_at = now()
     WHERE p.tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_synced_costs = ROW_COUNT;

    RETURN jsonb_build_object(
        'mode', 'real',
        'phase', '2A',
        'safe_mode', true,
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
END;
$$;


-- ============================================================
-- GRANT (defensive)
-- ============================================================
REVOKE ALL ON FUNCTION public.cleanup_test_dataset(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_test_dataset(UUID, BOOLEAN, INT, INT, INT, INT, INT, INT, INT) FROM PUBLIC, anon, authenticated;


-- ============================================================
-- POST-DEPLOY VALIDATION
-- ============================================================
DO $$
DECLARE
    v_src_cleanup  TEXT;
    v_src_generate TEXT;
BEGIN
    SELECT pg_get_functiondef(p.oid)
      INTO v_src_cleanup
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'cleanup_test_dataset';

    SELECT pg_get_functiondef(p.oid)
      INTO v_src_generate
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'generate_test_dataset';

    IF v_src_cleanup IS NULL OR v_src_generate IS NULL THEN
        RAISE EXCEPTION '[059] FAIL: fonksiyonlar yok';
    END IF;

    -- Replication-role degisim cagrisi HIC kullanilmamali (Supabase hosted
    -- uyumu). Pattern: yorumlardaki kelime mention'larini IGNORE et;
    -- sadece gercek set_config(...) cagrisini detect et.
    IF v_src_cleanup ~* E'set_config\\s*\\(\\s*''session_replication_role' THEN
        RAISE EXCEPTION '[059] FAIL: cleanup hala set_config(replication-role) cagiriyor';
    END IF;
    IF v_src_generate ~* E'set_config\\s*\\(\\s*''session_replication_role' THEN
        RAISE EXCEPTION '[059] FAIL: generate hala set_config(replication-role) cagiriyor';
    END IF;

    -- FAZ 2.A marker'i korunmus mu?
    IF v_src_generate NOT LIKE '%FAZ 2.A SAFE MODE%' THEN
        RAISE EXCEPTION '[059] FAIL: FAZ 2.A safe mode body eksik';
    END IF;

    RAISE NOTICE '[059] OK: load test generator SAFE MODE aktif (Supabase hosted uyumlu)';
    RAISE NOTICE '[059] TEST: SELECT generate_test_dataset(<tenant_id>::uuid, p_dry_run := false);';
END;
$$;
