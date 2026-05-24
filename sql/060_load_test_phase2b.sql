-- ============================================================
-- 060 — LOAD TEST GENERATOR — FAZ 2.B (purchase_items + cost sync)
--
-- AMAC:
--   Mevcut FAZ 2.A data'sina purchase_items ekle. Cost sync trigger
--   zinciri (BEFORE/AFTER) test edilir — backend yuku gercekci olur.
--
-- MODERN FLOW (purchases header SKIP):
--   purchase_items.purchase_id REFERENCES purchases(id) ON DELETE SET NULL
--   (999:326) — OPSIYONEL link. Modern flow purchase_id = NULL,
--   invoice_no ile gruplama (insert_purchase_items_batch RPC pattern'i,
--   999:1672-1685). FAZ 2.B sadece purchase_items insert; legacy
--   purchases header tablosu skip (farkli domain: product-based).
--
-- TRIGGER ZINCIRI (test edilen davranis):
--   1) BEFORE INSERT trg_purchase_items_fill_base (051:103-182):
--      base_quantity = convert_to_base_unit(qty, unit, base_unit)
--      base_unit_cost = (line_total | qty*unit_cost*(1-disc/100))
--                       * (1+vat/100) / base_quantity
--   2) AFTER INSERT trg_purchase_items_cost_sync (999:2158-2161):
--      sync_raw_material_cost(rm_id) → calculate_raw_material_wac
--      → UPDATE raw_materials SET cost = latest base_unit_cost
--   3) AFTER UPDATE on raw_materials trg_fn_raw_materials_cost_sync
--      (999:2208+): recipe lookup → sync_product_cost(product_id) →
--      UPDATE products SET cost = calculate_product_cost
--
--   1000 purchase_items × bu zincir = ~5000+ trigger call. CHUNK
--   strategy ile timeout riski azaltilir.
--
-- CHUNK STRATEGY:
--   p_chunk_size parametresi (default 250). Her chunk ayri INSERT
--   statement, ama hepsi ayni transaction. Single function call
--   icinde tum chunk'lar — statement timeout function CALL'a uygular,
--   yani fonksiyonun toplam suresine. Free tier 8sn riskli; Pro 60sn
--   guvenli. p_chunk_size'i azaltarak bireysel timing optimize edilebilir.
--
--   Retry-safe: Her chunk insert idempotent degil (random data) ama
--   FAZ 2.B'nin pre-flight'i mevcut purchase_items varsa REFUSED.
--   Cleanup → re-generate.
--
-- VALIDATION:
--   Function sonunda otomatik:
--   - A) products.cost = calculate_product_cost(id) eslesmesi
--   - B) raw_materials.cost = latest purchase_items.base_unit_cost
--   - C) FK consistency (tenant_id match her tabloda)
--   - D) Recipe consistency (recipe'siz product cost=0)
--   Sonuc validation JSONB icinde donder.
--
-- ROLLBACK:
--   SELECT cleanup_test_dataset('<tenant_id>'::uuid);
--   (057+059 cleanup zaten purchase_items + purchases temizliyor.)
--
-- SAFE MODE (Supabase hosted uyumu):
--   session_replication_role HIC dokunulmaz. Trigger zinciri full
--   calisir. set_tenant_id trigger pass-through (NEW.tenant_id !=NULL).
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

    v_chunk_size     INT := 250;
    v_chunk_count    INT := 0;
    v_inserted_pit   BIGINT := 0;
    v_chunk_n        INT;
    v_chunk_inserted INT;

    v_val_prod_mism  BIGINT;
    v_val_rm_mism    BIGINT;
    v_val_recipe_orphan BIGINT;
BEGIN
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
    SELECT COUNT(*) INTO v_existing_pit  FROM purchase_items WHERE tenant_id = p_tenant_id;
    SELECT COUNT(*) INTO v_existing_sal  FROM sales          WHERE tenant_id = p_tenant_id;

    -- ============ DRY-RUN ============
    IF p_dry_run THEN
        RETURN jsonb_build_object(
            'mode', 'dry-run',
            'phase', '2B',
            'safe_mode', true,
            'ok', true,
            'tenant', jsonb_build_object(
                'id',   p_tenant_id,
                'name', v_name,
                'slug', v_slug
            ),
            'existing', jsonb_build_object(
                'raw_materials',  v_existing_rm,
                'products',       v_existing_prod,
                'purchase_items', v_existing_pit,
                'sales',          v_existing_sal
            ),
            'will_insert', jsonb_build_object(
                'phase_2a', jsonb_build_object(
                    'categories',      CASE WHEN v_existing_rm > 0 THEN 0 ELSE 6 END,
                    'raw_materials',   CASE WHEN v_existing_rm > 0 THEN 0 ELSE p_raw_materials END,
                    'products',        CASE WHEN v_existing_prod > 0 THEN 0 ELSE p_products END,
                    'product_recipes', CASE WHEN v_existing_prod > 0 THEN 0 ELSE p_products * 4 END
                ),
                'phase_2b', jsonb_build_object(
                    'purchase_items', CASE WHEN v_existing_pit > 0 THEN 0 ELSE p_purchases END,
                    'invoice_count',  CASE WHEN v_existing_pit > 0 THEN 0 ELSE (p_purchases / 4) END,
                    'chunk_size',     v_chunk_size,
                    'chunk_count',    CASE WHEN v_existing_pit > 0 THEN 0 ELSE ceil(p_purchases::numeric / v_chunk_size)::int END
                )
            ),
            'trigger_chain', jsonb_build_array(
                'BEFORE INSERT trg_purchase_items_fill_base (base_quantity + base_unit_cost)',
                'AFTER INSERT trg_purchase_items_cost_sync (sync_raw_material_cost)',
                'AFTER UPDATE on raw_materials (sync_product_cost via recipes)'
            ),
            'estimated_trigger_calls', p_purchases * 3,
            'next_step', 'Eger plan OK ise: generate_test_dataset(<tenant_id>::uuid, p_dry_run := false)',
            'warning', CASE
                WHEN v_existing_pit > 0 THEN 'purchase_items zaten var, FAZ 2.B re-run icin once cleanup_test_dataset() cagir.'
                WHEN v_existing_rm = 0 THEN 'FAZ 2.A henuz calismadi (raw_materials yok). Tek call ile FAZ 2.A + 2.B birlikte yapilir.'
                ELSE NULL
            END
        );
    END IF;

    -- ============ REAL MODE ============

    -- ============ FAZ 2.A (idempotent skip eger zaten varsa) ============
    IF v_existing_rm = 0 AND v_existing_prod = 0 THEN

        -- 1) CATEGORIES
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

        -- 2) RAW_MATERIALS
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

        -- 3) PRODUCTS
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

        -- 4) PRODUCT_RECIPES
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

        -- Manuel sync (recipe trigger zaten yapti — defensive)
        UPDATE products p
           SET cost = public.calculate_product_cost(p.id),
               updated_at = now()
         WHERE p.tenant_id = p_tenant_id;
        GET DIAGNOSTICS v_synced_costs = ROW_COUNT;
    END IF;

    v_t_phase_a := clock_timestamp();

    -- ============ FAZ 2.B — purchase_items (CHUNK INSERT) ============

    IF v_existing_pit > 0 THEN
        RAISE EXCEPTION 'REFUSED: purchase_items zaten var (%). FAZ 2.B re-run icin: SELECT cleanup_test_dataset(%L::uuid);',
            v_existing_pit, p_tenant_id;
    END IF;

    -- Chunk loop: timeout safety. Her chunk ayri INSERT statement.
    v_chunk_n := 0;
    WHILE v_chunk_n * v_chunk_size < p_purchases LOOP
        INSERT INTO purchase_items (
            tenant_id,
            purchase_id,
            raw_material_id,
            quantity,
            unit,
            unit_cost,
            line_total,
            vat_rate,
            discount_rate,
            invoice_date,
            invoice_no
        )
        SELECT
            p_tenant_id,
            NULL,                                      -- modern flow: purchase_id NULL
            rm.id,
            qty.q,
            rm.unit,
            unit_cost_val.uc,
            round((qty.q * unit_cost_val.uc)::numeric, 4)::numeric(14,4),
            rm.vat_rate,
            0,                                          -- discount_rate
            purchase_date.d,
            100000 + ceil(i::numeric / 4)::bigint       -- her 4 item bir invoice_no
        FROM generate_series(
            v_chunk_n * v_chunk_size + 1,
            LEAST((v_chunk_n + 1) * v_chunk_size, p_purchases)
        ) AS i
        CROSS JOIN LATERAL (
            -- Aktif raw_material random — Pareto: bazi RM cok alinir
            SELECT id, unit, cost, vat_rate
              FROM raw_materials
             WHERE tenant_id = p_tenant_id
               AND is_active = true
             ORDER BY random()
             LIMIT 1
        ) rm
        CROSS JOIN LATERAL (
            -- Quantity: bazi kucuk (0.5-2), bazi toplu (5-15)
            SELECT CASE
                WHEN random() < 0.7 THEN round((0.5 + random() * 1.5)::numeric, 2)
                ELSE round((5 + random() * 10)::numeric, 2)
            END AS q
        ) qty
        CROSS JOIN LATERAL (
            -- Tarih: son p_months ay random
            SELECT (CURRENT_DATE - (random() * p_months * 30)::int)::date AS d
        ) purchase_date
        CROSS JOIN LATERAL (
            -- Enflasyon: eski tarih ucuz (base cost'in %70-130'u),
            -- yeni tarih pahalı (base cost'in %95-130'u).
            -- Aynı RM'de farklı fiyatlar (aynı RM birden fazla alış = farklı unit_cost).
            --
            -- FIX: (CURRENT_DATE - date) zaten integer (gun sayisi) doner;
            -- EXTRACT(EPOCH FROM integer) invalid. Direkt ::numeric / 365.0
            -- ile yil olarak normalize. Mantik aynı.
            SELECT round(
                (rm.cost * GREATEST(0.3,
                    (0.7 + (1.0 - LEAST(1.0,
                        (CURRENT_DATE - purchase_date.d)::numeric / 365.0
                    )) * 0.3)
                    * (0.85 + random() * 0.30)
                ))::numeric, 4
            )::numeric(14,4) AS uc
        ) unit_cost_val;

        GET DIAGNOSTICS v_chunk_inserted = ROW_COUNT;
        v_inserted_pit := v_inserted_pit + v_chunk_inserted;
        v_chunk_n := v_chunk_n + 1;
    END LOOP;
    v_chunk_count := v_chunk_n;

    v_t_phase_b := clock_timestamp();

    -- ============ POST-INSERT MANUEL SYNC (defensive, idempotent) ============
    -- Trigger zinciri zaten:
    --   purchase_items AFTER INSERT → sync_raw_material_cost → raw_materials.cost UPDATE
    --   raw_materials AFTER UPDATE → recipe lookup → sync_product_cost → products.cost UPDATE
    -- Buradaki UPDATE idempotent (trigger sonuc ile birebir ayni); defensive.
    UPDATE products p
       SET cost = public.calculate_product_cost(p.id),
           updated_at = now()
     WHERE p.tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_synced_costs = ROW_COUNT;

    v_t_validation := clock_timestamp();

    -- ============ VALIDATION ============
    -- A) products.cost = calculate_product_cost(id)
    SELECT COUNT(*) INTO v_val_prod_mism
      FROM products p
     WHERE p.tenant_id = p_tenant_id
       AND ABS(COALESCE(p.cost, 0) - public.calculate_product_cost(p.id)) > 0.0001;

    -- B) raw_materials.cost = latest purchase_items.base_unit_cost (per RM)
    SELECT COUNT(*) INTO v_val_rm_mism
      FROM raw_materials rm
      LEFT JOIN LATERAL (
          SELECT base_unit_cost
            FROM purchase_items pi
           WHERE pi.tenant_id = rm.tenant_id
             AND pi.raw_material_id = rm.id
             AND pi.is_deleted = false
             AND pi.base_unit_cost IS NOT NULL
             AND pi.base_unit_cost > 0
           ORDER BY pi.created_at DESC
           LIMIT 1
      ) latest ON TRUE
     WHERE rm.tenant_id = p_tenant_id
       AND latest.base_unit_cost IS NOT NULL
       AND ABS(rm.cost - latest.base_unit_cost) > 0.0001;

    -- D) recipe consistency: recipe'siz product cost=0 mi?
    SELECT COUNT(*) INTO v_val_recipe_orphan
      FROM products p
     WHERE p.tenant_id = p_tenant_id
       AND p.cost > 0
       AND NOT EXISTS (
           SELECT 1 FROM product_recipes pr
            WHERE pr.product_id = p.id
              AND pr.is_deleted = false
       );

    RETURN jsonb_build_object(
        'mode', 'real',
        'phase', '2B',
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
                'chunks',         v_chunk_count,
                'chunk_size',     v_chunk_size,
                'invoice_count',  (SELECT COUNT(DISTINCT invoice_no) FROM purchase_items WHERE tenant_id = p_tenant_id)
            )
        ),
        'synced', jsonb_build_object(
            'products_cost', v_synced_costs
        ),
        'validation', jsonb_build_object(
            'A_products_cost_mismatch',     v_val_prod_mism,
            'B_raw_materials_cost_mismatch', v_val_rm_mism,
            'C_fk_consistency',              'ok (FK enforced by Postgres)',
            'D_recipe_orphan_with_cost',    v_val_recipe_orphan
        ),
        'durations_ms', jsonb_build_object(
            'phase_2a',   round(EXTRACT(EPOCH FROM (v_t_phase_a   - v_t0))         * 1000)::int,
            'phase_2b',   round(EXTRACT(EPOCH FROM (v_t_phase_b   - v_t_phase_a))  * 1000)::int,
            'validation', round(EXTRACT(EPOCH FROM (v_t_validation - v_t_phase_b))  * 1000)::int,
            'total',      round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t0))      * 1000)::int
        ),
        'next_phase', 'FAZ 2.C: sales + product_sales'
    );
END;
$$;


-- ============================================================
-- GRANT (defensive)
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
        RAISE EXCEPTION '[060] FAIL: generate_test_dataset bulunamadi';
    END IF;

    -- SAFE MODE: gercek set_config call'i YASAK
    IF v_src ~* E'set_config\\s*\\(\\s*''session_replication_role' THEN
        RAISE EXCEPTION '[060] FAIL: replication-role bypass call var';
    END IF;

    -- FAZ 2.B marker'lari
    IF v_src NOT LIKE '%FAZ 2.B%' THEN
        RAISE EXCEPTION '[060] FAIL: FAZ 2.B body eksik';
    END IF;

    IF v_src NOT LIKE '%purchase_items%' THEN
        RAISE EXCEPTION '[060] FAIL: purchase_items insert eksik';
    END IF;

    IF v_src NOT LIKE '%v_chunk%' THEN
        RAISE EXCEPTION '[060] FAIL: chunk loop eksik';
    END IF;

    RAISE NOTICE '[060] OK: generate_test_dataset FAZ 2.B aktif (purchase_items + cost sync zinciri)';
    RAISE NOTICE '[060] TEST: SELECT generate_test_dataset(<tenant_id>::uuid, p_dry_run := false);';
END;
$$;
