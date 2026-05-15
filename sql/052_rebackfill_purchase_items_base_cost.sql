-- ============================================================
-- 052 — REBACKFILL purchase_items.base_unit_cost (HISTORICAL)
--
-- ⚠ ADMIN MAINTENANCE ONLY — NOT FOR CLIENT-FACING RPC USAGE.
--   Bu fonksiyon frontend'den / authenticated rolden cagrilmamali.
--   Granted role list bos; sadece function owner ('postgres'/Dashboard)
--   tarafindan calistirilir.
--
-- Amac:
--   051 oncesi kaydedilmis purchase_items satirlarinin
--   base_unit_cost'unu canonical formul ile yeniden hesaplamak.
--   Cascade trigger zinciri otomatik calisir:
--     purchase_items UPDATE
--       → trg_purchase_items_cost_sync_upd (WHEN base_unit_cost changed)
--       → sync_raw_material_cost → raw_materials.cost guncellenir
--       → trg_raw_materials_cost_sync → sync_product_cost
--       → products.cost guncellenir (recipe'li urunler)
--
-- ROL:
--   Bu bir ADMIN MAINTENANCE migration'idir. Tenant-user RPC degildir.
--   Dashboard SQL Editor uzerinden 'postgres' rolu ile calistirilir.
--   auth.uid() kontrolu YOK — SECURITY DEFINER guvence yeterli.
--   Scope p_tenant_id ile control edilir.
--
-- SIGNATURE:
--   rebackfill_purchase_items_base_cost(
--       p_tenant_id UUID DEFAULT NULL,
--       p_dry_run   BOOLEAN DEFAULT TRUE
--   )
--   p_tenant_id NULL : tum tenantlar (global)
--   p_tenant_id dolu : sadece o tenant
--
-- KRITIK GARANTI:
--   product_sales.cost ASLA degismez. Bu kolon FAZ 1.1 IMMUTABLE
--   snapshot'tir; bu migration UPDATE etmez. Post-validation
--   uc katmanla dogrular:
--     a) COUNT(*) — satir sayisi
--     b) SUM(cost) — toplam maliyet
--     c) MD5(string_agg(id||':'||cost ORDER BY id)) — deterministic
--        ordered checksum
--   Herhangi biri degisirse RAISE EXCEPTION.
--
-- SAFETY THRESHOLD:
--   LIVE modunda would_change > 50000 ise RAISE.
--   Beklenmeyen kitle UPDATE'i durdurmak icin. DRY-RUN bu threshold'a
--   takilmaz (preview amacli).
--
-- Canonical formul (docs/FINANCE.md kural 11+12 + 051 trigger):
--   v_net = COALESCE(line_total,
--                    quantity * unit_cost * (1 - discount_rate/100))
--   v_with_vat = v_net * (1 + vat_rate/100)
--   base_unit_cost = v_with_vat / base_quantity
--
-- Mod:
--   p_dry_run = TRUE (DEFAULT) → sadece analiz + sample + count.
--                                hicbir UPDATE/cascade calismaz.
--   p_dry_run = FALSE → gercek UPDATE + dogal cascade trigger
--                       zinciri + post-validation.
--
-- Idempotent:
--   - CREATE OR REPLACE FUNCTION
--   - Live UPDATE WHERE clause "old IS DISTINCT FROM new" filtrelidir
--     → ikinci kez calistirma sirasinda 0 satir etkilenir.
--
-- Rollback:
--   Bu migration DATA DEGISTIRIR. Eski base_unit_cost degerlerini geri
--   almak icin export_all_data ile alinan PRE-052 BACKUP zorunlu.
--   restore_full_backup ile restore (mevcut tenant verisi wipe edilir).
--   Yoksa geri donus YOK — yeni KDV DAHIL degerler kalir.
--
--   ⚠ LOGICAL RECOVERY, NOT POINT-IN-TIME:
--   restore_full_backup mevcut tenant verisini wipe edip backup
--   JSON'undan yeniden insert eder. Backup tarihi ile rollback
--   anindaki tum YENI kayitlar (backup sonrasi olusturulan satislar,
--   giderler, alisslar, vb.) KAYBOLUR. Bu kabul edilebilir bir
--   risk degilse migration'i bu pencere icin durdur.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT (DO block) — function definition oncesi sanity
-- ============================================================
DO $pre$
DECLARE
    v_has_purchase_items   BOOLEAN;
    v_has_discount_col     BOOLEAN;
    v_has_fill_trigger_fn  BOOLEAN;
    v_has_cost_sync_fn     BOOLEAN;
    v_has_sync_product_fn  BOOLEAN;
    v_bad_base_qty         BIGINT;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='purchase_items'
    ) INTO v_has_purchase_items;
    IF NOT v_has_purchase_items THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: public.purchase_items YOK';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='purchase_items'
          AND column_name='discount_rate'
    ) INTO v_has_discount_col;
    IF NOT v_has_discount_col THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: discount_rate kolonu YOK (034 fold eksik)';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='trg_fn_purchase_items_fill_base'
    ) INTO v_has_fill_trigger_fn;
    IF NOT v_has_fill_trigger_fn THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: trg_fn_purchase_items_fill_base YOK (051 calistirilmamis?)';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='trg_fn_purchase_items_cost_sync'
    ) INTO v_has_cost_sync_fn;
    IF NOT v_has_cost_sync_fn THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: trg_fn_purchase_items_cost_sync YOK (zincir kirik)';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='sync_product_cost'
    ) INTO v_has_sync_product_fn;
    IF NOT v_has_sync_product_fn THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: sync_product_cost YOK (zincir kirik)';
    END IF;

    -- Data sanity: base_quantity <= 0 (NULL hariç) olan satir sayisi.
    -- Bu satirlar rebackfill scope'una zaten girmez (formul NULLIF/NULL'a
    -- duser), ama varsa raporla; ileride bir veri temizligi gerekebilir.
    SELECT count(*) INTO v_bad_base_qty
      FROM public.purchase_items
     WHERE is_deleted = false
       AND base_quantity IS NOT NULL
       AND base_quantity <= 0;

    RAISE NOTICE 'PRE-FLIGHT OK: purchase_items + discount_rate + cascade chain present (bad_base_qty=%)',
                 v_bad_base_qty;
END $pre$;


-- ============================================================
-- FUNCTION: rebackfill_purchase_items_base_cost
-- ============================================================
DROP FUNCTION IF EXISTS public.rebackfill_purchase_items_base_cost(BOOLEAN);
DROP FUNCTION IF EXISTS public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.rebackfill_purchase_items_base_cost(
    p_tenant_id UUID    DEFAULT NULL,
    p_dry_run   BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_scope       BIGINT;
    v_would_change      BIGINT;
    v_unchanged         BIGINT;
    v_null_result       BIGINT;
    v_bad_base_qty      BIGINT;
    v_sample            JSONB;

    v_updated_pi        BIGINT;

    -- Immutability uc katman snapshot (product_sales)
    v_ps_count_before   BIGINT;
    v_ps_count_after    BIGINT;
    v_ps_sum_before     NUMERIC;
    v_ps_sum_after      NUMERIC;
    v_ps_cs_before      TEXT;
    v_ps_cs_after       TEXT;

    -- Cascade kanitlari
    v_rm_cs_before      TEXT;
    v_rm_cs_after       TEXT;
    v_prod_cs_before    TEXT;
    v_prod_cs_after     TEXT;
    v_rm_changed        INT;
    v_prod_changed      INT;

    v_safety_max        BIGINT := 50000;

    v_started_at        TIMESTAMPTZ := clock_timestamp();
    v_elapsed_ms        INT;
BEGIN
    RAISE NOTICE '[052] mode=% tenant=% (NULL = global)',
        CASE WHEN p_dry_run THEN 'DRY-RUN' ELSE 'LIVE' END,
        COALESCE(p_tenant_id::text, '<all>');

    -- ============================================================
    -- SCOPE + WOULD-CHANGE ANALYSIS (her iki mod icin ortak)
    -- ============================================================
    WITH calc AS (
        SELECT
            pi.id,
            pi.tenant_id,
            pi.raw_material_id,
            pi.base_unit_cost AS old_value,
            (
                CASE
                    WHEN pi.line_total IS NOT NULL AND pi.line_total >= 0
                        THEN pi.line_total
                    WHEN pi.unit_cost IS NOT NULL AND pi.unit_cost >= 0
                        THEN pi.quantity * pi.unit_cost
                             * (1 - COALESCE(pi.discount_rate, 0) / 100.0)
                    ELSE NULL
                END
                * (1 + COALESCE(pi.vat_rate, 0) / 100.0)
                / NULLIF(pi.base_quantity, 0)
            ) AS new_value
        FROM public.purchase_items pi
        WHERE pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id)
    )
    SELECT
        count(*),
        count(*) FILTER (
            WHERE old_value IS DISTINCT FROM new_value AND new_value IS NOT NULL
        ),
        count(*) FILTER (
            WHERE old_value IS NOT DISTINCT FROM new_value
        ),
        count(*) FILTER (
            WHERE new_value IS NULL
        )
    INTO v_total_scope, v_would_change, v_unchanged, v_null_result
    FROM calc;

    -- Sample 5 changing rows
    WITH calc AS (
        SELECT
            pi.id,
            pi.tenant_id,
            pi.raw_material_id,
            pi.quantity, pi.unit_cost, pi.line_total,
            pi.vat_rate, pi.discount_rate, pi.base_quantity,
            pi.base_unit_cost AS old_value,
            (
                CASE
                    WHEN pi.line_total IS NOT NULL AND pi.line_total >= 0
                        THEN pi.line_total
                    WHEN pi.unit_cost IS NOT NULL AND pi.unit_cost >= 0
                        THEN pi.quantity * pi.unit_cost
                             * (1 - COALESCE(pi.discount_rate, 0) / 100.0)
                    ELSE NULL
                END
                * (1 + COALESCE(pi.vat_rate, 0) / 100.0)
                / NULLIF(pi.base_quantity, 0)
            ) AS new_value
        FROM public.purchase_items pi
        WHERE pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id)
    )
    SELECT jsonb_agg(row_to_json(s)) INTO v_sample
      FROM (
          SELECT
              id, tenant_id, raw_material_id,
              quantity, unit_cost, line_total,
              vat_rate, discount_rate, base_quantity,
              ROUND(old_value::numeric, 6) AS old_value,
              ROUND(new_value::numeric, 6) AS new_value,
              CASE WHEN old_value IS NULL OR old_value = 0
                   THEN NULL
                   ELSE ROUND(((new_value - old_value) / old_value * 100)::numeric, 2)
              END AS delta_pct
          FROM calc
          WHERE old_value IS DISTINCT FROM new_value
            AND new_value IS NOT NULL
          ORDER BY raw_material_id
          LIMIT 5
      ) s;

    -- Data quality sanity: base_quantity <= 0 (NULL haric) satir sayisi.
    -- Scope filtresi ile ayni tenant kapsam.
    SELECT count(*) INTO v_bad_base_qty
      FROM public.purchase_items pi
     WHERE pi.is_deleted = false
       AND pi.base_quantity IS NOT NULL
       AND pi.base_quantity <= 0
       AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id);

    RAISE NOTICE '[052] scope=% would_change=% unchanged=% null_result=% bad_base_qty=%',
        v_total_scope, v_would_change, v_unchanged, v_null_result, v_bad_base_qty;
    RAISE NOTICE '[052] sample (first 5 changing rows): %', COALESCE(v_sample::text, 'none');

    -- ============================================================
    -- DRY-RUN: return report, no DML, threshold check YOK (preview)
    -- ============================================================
    IF p_dry_run THEN
        v_elapsed_ms := EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at))::int * 1000;
        RAISE NOTICE '[052] DRY-RUN tamamlandi (%ms). HICBIR DEGISIKLIK YAPILMADI.', v_elapsed_ms;
        RETURN jsonb_build_object(
            'mode',              'dry_run',
            'tenant_scope',      COALESCE(p_tenant_id::text, 'all'),
            'started_at',        v_started_at,
            'elapsed_ms',        v_elapsed_ms,
            'total_scope',       v_total_scope,
            'would_change',      v_would_change,
            'unchanged',         v_unchanged,
            'null_result',       v_null_result,
            'bad_base_quantity', v_bad_base_qty,
            'sample',            COALESCE(v_sample, '[]'::jsonb),
            'note',              'Re-run with p_dry_run := FALSE to apply.'
        );
    END IF;

    -- ============================================================
    -- LIVE MODE
    -- ============================================================

    -- SAFETY THRESHOLD: kitle UPDATE'i kazara baslatma korumasi
    IF v_would_change > v_safety_max THEN
        RAISE EXCEPTION
            'SAFETY THRESHOLD: would_change=% > max=%. Manuel review gerekli. '
            'Devam etmek icin v_safety_max degerini fonksiyon body''sinde artir veya '
            'tenant-by-tenant kucuk parcalarla calistir.',
            v_would_change, v_safety_max;
    END IF;

    -- 1) BEFORE snapshot (uc katman immutability + cascade md5)
    SELECT
        count(*),
        COALESCE(sum(cost), 0),
        md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_ps_count_before, v_ps_sum_before, v_ps_cs_before
      FROM public.product_sales
     WHERE (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_rm_cs_before
      FROM public.raw_materials
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_prod_cs_before
      FROM public.products
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    RAISE NOTICE '[052] LIVE: pre-snapshot (ps_count=%, ps_sum=%, ps_cs=%)',
        v_ps_count_before, v_ps_sum_before, left(v_ps_cs_before, 12);

    -- 2) UPDATE — dogal cascade trigger zinciri
    WITH calc AS (
        SELECT
            pi.id,
            (
                CASE
                    WHEN pi.line_total IS NOT NULL AND pi.line_total >= 0
                        THEN pi.line_total
                    WHEN pi.unit_cost IS NOT NULL AND pi.unit_cost >= 0
                        THEN pi.quantity * pi.unit_cost
                             * (1 - COALESCE(pi.discount_rate, 0) / 100.0)
                    ELSE NULL
                END
                * (1 + COALESCE(pi.vat_rate, 0) / 100.0)
                / NULLIF(pi.base_quantity, 0)
            ) AS new_value
        FROM public.purchase_items pi
        WHERE pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND (p_tenant_id IS NULL OR pi.tenant_id = p_tenant_id)
    )
    UPDATE public.purchase_items pi
       SET base_unit_cost = calc.new_value
      FROM calc
     WHERE pi.id = calc.id
       AND calc.new_value IS NOT NULL
       AND pi.base_unit_cost IS DISTINCT FROM calc.new_value;

    GET DIAGNOSTICS v_updated_pi = ROW_COUNT;

    RAISE NOTICE '[052] LIVE: purchase_items UPDATE row_count=% (cascade triggered)', v_updated_pi;

    -- 3) AFTER snapshot
    SELECT
        count(*),
        COALESCE(sum(cost), 0),
        md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_ps_count_after, v_ps_sum_after, v_ps_cs_after
      FROM public.product_sales
     WHERE (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_rm_cs_after
      FROM public.raw_materials
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    SELECT md5(coalesce(string_agg(id::text || ':' || cost::text, '|' ORDER BY id), ''))
      INTO v_prod_cs_after
      FROM public.products
     WHERE is_deleted = false
       AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id);

    -- 4) CRITICAL IMMUTABILITY CHECK — uc katman
    IF v_ps_count_after <> v_ps_count_before THEN
        RAISE EXCEPTION
            'KRITIK IMMUTABILITY IHLALI: product_sales count degisti (before=%, after=%)',
            v_ps_count_before, v_ps_count_after;
    END IF;
    IF v_ps_sum_after IS DISTINCT FROM v_ps_sum_before THEN
        RAISE EXCEPTION
            'KRITIK IMMUTABILITY IHLALI: product_sales SUM(cost) degisti (before=%, after=%)',
            v_ps_sum_before, v_ps_sum_after;
    END IF;
    IF v_ps_cs_after <> v_ps_cs_before THEN
        RAISE EXCEPTION
            'KRITIK IMMUTABILITY IHLALI: product_sales ordered MD5 degisti (before=%, after=%)',
            left(v_ps_cs_before, 12), left(v_ps_cs_after, 12);
    END IF;

    -- 5) Cascade kanitlari (boolean)
    v_rm_changed   := CASE WHEN v_rm_cs_before   <> v_rm_cs_after   THEN 1 ELSE 0 END;
    v_prod_changed := CASE WHEN v_prod_cs_before <> v_prod_cs_after THEN 1 ELSE 0 END;

    v_elapsed_ms := EXTRACT(EPOCH FROM (clock_timestamp() - v_started_at))::int * 1000;

    RAISE NOTICE '[052] LIVE: rm_cs_changed=% prod_cs_changed=% elapsed_ms=%',
        v_rm_changed, v_prod_changed, v_elapsed_ms;
    RAISE NOTICE '[052] LIVE: product_sales IMMUTABILITY PASS (count+sum+md5)';
    RAISE NOTICE '[052] LIVE: rebackfill tamamlandi.';

    RETURN jsonb_build_object(
        'mode',                       'live',
        'tenant_scope',               COALESCE(p_tenant_id::text, 'all'),
        'started_at',                 v_started_at,
        'elapsed_ms',                 v_elapsed_ms,
        'total_scope',                v_total_scope,
        'would_change',               v_would_change,
        'bad_base_quantity',          v_bad_base_qty,
        'updated_purchase_items',     v_updated_pi,
        'raw_materials_cs_changed',   v_rm_changed,
        'products_cs_changed',        v_prod_changed,
        'product_sales_immutable',    TRUE,
        'product_sales_count',        v_ps_count_after,
        'product_sales_sum',          v_ps_sum_after,
        'sample',                     COALESCE(v_sample, '[]'::jsonb)
    );
END;
$$;

-- ADMIN MAINTENANCE — NOT FOR CLIENT-FACING RPC USAGE.
-- Explicit lockdown: PUBLIC, anon, authenticated rollerinin hicbiri EXECUTE
-- yetkisi almaz. Yalnizca function owner ('postgres') Dashboard SQL Editor
-- uzerinden calistirabilir.
REVOKE ALL ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) FROM authenticated;

COMMENT ON FUNCTION public.rebackfill_purchase_items_base_cost(UUID, BOOLEAN) IS
    'ADMIN MAINTENANCE one-shot rebackfill of purchase_items.base_unit_cost '
    'using canonical FAZ 1.4 formula (docs/FINANCE.md kural 11+12). '
    'Tenant scope: p_tenant_id NULL = all tenants, dolu = sadece o tenant. '
    'p_dry_run=TRUE (default): analysis only. '
    'p_dry_run=FALSE: UPDATE + natural cascade (raw_materials, products). '
    'LIVE safety: would_change > 50000 -> RAISE. '
    'product_sales.cost IMMUTABLE — count + SUM + ordered MD5 ile dogrulanir. '
    'Idempotent (WHERE old IS DISTINCT FROM new).';


-- ============================================================
-- POST-VALIDATION
-- ============================================================
DO $val$
DECLARE
    v_present   BOOLEAN;
    v_secdef    BOOLEAN;
    v_config    TEXT;
    v_returns   TEXT;
    v_args      TEXT;
BEGIN
    SELECT TRUE, p.prosecdef, pg_get_function_result(p.oid),
           pg_get_function_identity_arguments(p.oid),
           (SELECT string_agg(cfg, ', ') FROM unnest(coalesce(p.proconfig,'{}')) AS cfg)
      INTO v_present, v_secdef, v_returns, v_args, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname='rebackfill_purchase_items_base_cost'
     LIMIT 1;

    IF NOT v_present THEN
        RAISE EXCEPTION 'KRITIK: rebackfill_purchase_items_base_cost YOK';
    END IF;
    IF v_returns <> 'jsonb' THEN
        RAISE EXCEPTION 'KRITIK: RETURNS != jsonb (%)', v_returns;
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION 'KRITIK: SECURITY DEFINER degil';
    END IF;
    IF v_config IS NULL OR v_config NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION 'KRITIK: search_path SET edilmemis';
    END IF;
    IF v_args NOT LIKE '%uuid%' OR v_args NOT LIKE '%boolean%' THEN
        RAISE EXCEPTION 'KRITIK: signature beklenmeyen: %', v_args;
    END IF;

    RAISE NOTICE 'OK: 052 rebackfill function kuruldu. signature: (%)', v_args;
    RAISE NOTICE 'USAGE:';
    RAISE NOTICE '  --- GLOBAL (tum tenantlar) ---';
    RAISE NOTICE '  1) DRY-RUN:   SELECT rebackfill_purchase_items_base_cost(NULL, TRUE);';
    RAISE NOTICE '  2) Inceleyin: would_change + sample';
    RAISE NOTICE '  3) BACKUP:    SELECT export_all_data();   ← KRITIK';
    RAISE NOTICE '  4) LIVE:      SELECT rebackfill_purchase_items_base_cost(NULL, FALSE);';
    RAISE NOTICE '  --- TENANT-SCOPED ---';
    RAISE NOTICE '  1) DRY-RUN:   SELECT rebackfill_purchase_items_base_cost(''<uuid>''::uuid, TRUE);';
    RAISE NOTICE '  2) LIVE:      SELECT rebackfill_purchase_items_base_cost(''<uuid>''::uuid, FALSE);';
    RAISE NOTICE '  SAFETY: would_change > 50000 -> abort. Tenant-by-tenant calistirin.';
END $val$;
