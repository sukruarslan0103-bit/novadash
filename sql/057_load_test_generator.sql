-- ============================================================
-- 057 — LOAD TEST DATA GENERATOR — FAZ 1 (Infrastructure)
--
-- Amac:
--   NOVA DASHBOARD'u gercek production olcegine yakin veriyle test
--   etmek icin tenant-safe data generator altyapisi.
--
-- FAZ 1 (BU MIGRATION):
--   - Tenant guard helper (_lt_assert_test_tenant)
--   - cleanup_test_dataset(tenant_id) — gercek silme yapar
--   - generate_test_dataset(tenant_id, ...) — STUB: dry-run calisir,
--     real insert henuz IMPLEMENTED DEGIL (FAZ 2'de eklenecek)
--
-- FAZ 2 (sonraki migration):
--   - Bulk insert (categories, raw_materials, products, recipes,
--     purchases, purchase_items, sales, product_sales, expenses)
--   - session_replication_role = 'replica' ile trigger bypass
--   - Manuel sync (raw_materials.cost, products.cost)
--
-- TENANT-SAFE STRATEJI (3-layer guard):
--   1. tenant adi: ILIKE 'LOAD\_TEST%' / 'PERF\_TEST%' / 'STRESS\_TEST%'
--   2. tenant slug: LIKE 'load-test-%' / 'perf-test-%' / 'stress-test-%'
--   3. DRY-RUN zorunlu — generate_test_dataset(p_dry_run := true)
--      ilk cagri preview verir; user explicit p_dry_run := false ile
--      gercek insert tetikler
--
--   Production tenant'a yanlislikla yazma riski:
--     - Sadece name match: REDDEDILIR (slug ek check)
--     - Sadece slug match: REDDEDILIR (name ek check)
--     - Her ikisi de match: dry-run olmadan gercek insert YASAK
--
-- ROLLBACK:
--   DROP FUNCTION public.cleanup_test_dataset(UUID);
--   DROP FUNCTION public.generate_test_dataset(UUID, BOOL, INT, INT, INT, INT, INT, INT, INT);
--   DROP FUNCTION public._lt_assert_test_tenant(UUID);
--
-- GRANT:
--   Sadece postgres (Supabase admin) execute edebilir.
--   authenticated / anon GRANT YOK — UI'dan tetiklenemez.
-- ============================================================


-- ============================================================
-- HELPER — Tenant guard (3-layer)
-- ============================================================
CREATE OR REPLACE FUNCTION public._lt_assert_test_tenant(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
    v_slug TEXT;
BEGIN
    IF p_tenant_id IS NULL THEN
        RAISE EXCEPTION '_lt_assert_test_tenant: p_tenant_id is NULL';
    END IF;

    SELECT name, slug INTO v_name, v_slug
      FROM tenants
     WHERE id = p_tenant_id;

    IF v_name IS NULL THEN
        RAISE EXCEPTION 'REFUSED: tenant % bulunamadi', p_tenant_id;
    END IF;

    -- Layer 1: name prefix
    IF NOT (
        v_name ILIKE 'LOAD\_TEST%'   ESCAPE '\' OR
        v_name ILIKE 'PERF\_TEST%'   ESCAPE '\' OR
        v_name ILIKE 'STRESS\_TEST%' ESCAPE '\'
    ) THEN
        RAISE EXCEPTION 'REFUSED: tenant name "%" — must start with LOAD_TEST / PERF_TEST / STRESS_TEST (load test guard)', v_name;
    END IF;

    -- Layer 2: slug prefix (defense-in-depth — name match bypass'i engeller)
    IF NOT (
        v_slug LIKE 'load-test-%'   OR
        v_slug LIKE 'perf-test-%'   OR
        v_slug LIKE 'stress-test-%' OR
        v_slug LIKE 'load_test_%'   OR  -- underscore varyant
        v_slug LIKE 'perf_test_%'   OR
        v_slug LIKE 'stress_test_%'
    ) THEN
        RAISE EXCEPTION 'REFUSED: tenant slug "%" — must start with load-test- / perf-test- / stress-test- (defense-in-depth)', v_slug;
    END IF;

    -- Pass — tenant load test icin uygun
END;
$$;

COMMENT ON FUNCTION public._lt_assert_test_tenant(UUID) IS
  '057: Load test tenant guard. Tenant adi VE slug whitelist match etmeli. '
  'cleanup_test_dataset ve generate_test_dataset bu fonksiyonu cagirir; '
  'production tenant''a yanlislikla yazma riskini 3-layer kapatir.';


-- ============================================================
-- cleanup_test_dataset — Tum test data'sini hard delete
-- ============================================================
-- FK siralamasi: child → parent. Soft delete kullanilmaz (test data
-- tam temizlenmeli). categories sadece LOAD_TEST prefix'li olanlar
-- silinir; default kategoriler korunur.
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
    -- ZORUNLU GUARD
    PERFORM public._lt_assert_test_tenant(p_tenant_id);

    -- session_replication_role replica → trigger bypass (soft_delete
    -- vb. side effect'leri durdur). FK constraint'leri YINE calisir.
    PERFORM set_config('session_replication_role', 'replica', true);

    -- Child → parent
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

    -- Categories: SADECE LOAD_TEST tag'li olanlar
    DELETE FROM categories
     WHERE tenant_id = p_tenant_id
       AND name LIKE '__LOAD\_TEST\_\_%' ESCAPE '\';
    GET DIAGNOSTICS v_d_cats = ROW_COUNT;

    -- Restore (session-scoped reset)
    PERFORM set_config('session_replication_role', 'origin', true);

    RETURN jsonb_build_object(
        'ok', true,
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

EXCEPTION WHEN OTHERS THEN
    -- Defensive: error halinde session_replication_role'i restore et
    PERFORM set_config('session_replication_role', 'origin', true);
    RAISE;
END;
$$;

COMMENT ON FUNCTION public.cleanup_test_dataset(UUID) IS
  '057: Hard-delete test tenant data. _lt_assert_test_tenant guard zorunlu. '
  'FK siralamasi child → parent. session_replication_role replica ile '
  'soft_delete trigger bypass. categories sadece __LOAD_TEST__ prefix''li '
  'silinir.';


-- ============================================================
-- generate_test_dataset — STUB (FAZ 1: sadece dry-run + guard)
--
-- Imza FAZ 2'de tam implementation icin korunmustur. p_dry_run = true
-- (default) ise expected counts donen preview. p_dry_run = false ise
-- FAZ 1'de RAISE EXCEPTION; FAZ 2'de gercek bulk insert.
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
    v_name          TEXT;
    v_slug          TEXT;
    v_existing_rm   BIGINT;
    v_existing_prod BIGINT;
    v_existing_sal  BIGINT;
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

    -- Mevcut data var mi (cleanup ihtiyaci?)
    SELECT COUNT(*) INTO v_existing_rm   FROM raw_materials  WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_prod FROM products       WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_sal  FROM sales          WHERE tenant_id = p_tenant_id;

    -- ============ DRY-RUN MODU ============
    -- Plan donderi. INSERT YOK.
    IF p_dry_run THEN
        RETURN jsonb_build_object(
            'mode', 'dry-run',
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
                'raw_materials',   p_raw_materials,
                'products',        p_products,
                'product_recipes', p_products * 4,                       -- ortalama 4 recipe/product
                'purchases',       (p_purchases / 4)::int,               -- header (her 4 item bir fatura)
                'purchase_items',  p_purchases,
                'sales',           p_sales,
                'product_sales',   (p_sales * 3.3)::int,                 -- ortalama 3.3 line/sale
                'expenses',        p_expenses,
                'total_rows',      p_raw_materials + p_products + (p_products * 4) +
                                   (p_purchases / 4)::int + p_purchases + p_sales +
                                   (p_sales * 3.3)::int + p_expenses
            ),
            'params', jsonb_build_object(
                'months', p_months,
                'seed',   p_seed
            ),
            'next_step', 'Eger plan OK ise: generate_test_dataset(p_tenant_id, p_dry_run := false, ...)',
            'warning', CASE WHEN v_existing_rm + v_existing_prod + v_existing_sal > 0
                       THEN 'Tenant''ta mevcut data var. Once cleanup_test_dataset() cagir.'
                       ELSE NULL END
        );
    END IF;

    -- ============ REAL MODU — FAZ 1 NOT IMPLEMENTED ============
    RAISE EXCEPTION 'generate_test_dataset real mode FAZ 2''de implement edilecek. Su an sadece dry-run destekleniyor. p_dry_run := true ile cagir.';
END;
$$;

COMMENT ON FUNCTION public.generate_test_dataset(UUID, BOOLEAN, INT, INT, INT, INT, INT, INT, INT) IS
  '057 FAZ 1: Load test data generator stub. Dry-run preview destekleniyor; '
  'real insert FAZ 2''de eklenecek. _lt_assert_test_tenant guard zorunlu.';


-- ============================================================
-- GRANT — Sadece postgres (Supabase SQL Editor)
-- ============================================================
-- authenticated / anon role'lerine GRANT YOK — UI'dan tetiklenemez.
-- Sadece Supabase Dashboard'tan owner uygulayabilir.
REVOKE ALL ON FUNCTION public._lt_assert_test_tenant(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_test_dataset(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_test_dataset(UUID, BOOLEAN, INT, INT, INT, INT, INT, INT, INT) FROM PUBLIC, anon, authenticated;


-- ============================================================
-- POST-DEPLOY VALIDATION
-- ============================================================
DO $$
DECLARE
    v_fn_count INT;
BEGIN
    SELECT COUNT(*) INTO v_fn_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_lt_assert_test_tenant', 'cleanup_test_dataset', 'generate_test_dataset');

    IF v_fn_count <> 3 THEN
        RAISE EXCEPTION '[057] FAIL: bekliyordum 3 fonksiyon, % bulundu', v_fn_count;
    END IF;

    -- Guard fonksiyonlari SECURITY DEFINER mi?
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'cleanup_test_dataset'
           AND p.prosecdef = true
    ) THEN
        RAISE EXCEPTION '[057] FAIL: cleanup_test_dataset SECURITY DEFINER degil';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'generate_test_dataset'
           AND p.prosecdef = true
    ) THEN
        RAISE EXCEPTION '[057] FAIL: generate_test_dataset SECURITY DEFINER degil';
    END IF;

    RAISE NOTICE '[057] OK: load test generator FAZ 1 (infrastructure) aktif | 3 fn registered';
    RAISE NOTICE '[057] NEXT: manuel test tenant create (name LIKE LOAD_TEST%, slug LIKE load-test-%)';
    RAISE NOTICE '[057] TEST: SELECT generate_test_dataset(''<tenant_id>''::uuid);  -- dry-run default';
END;
$$;
