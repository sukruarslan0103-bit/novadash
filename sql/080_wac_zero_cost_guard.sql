-- ============================================================
-- 080 — WAC ZERO-COST GUARD (forward-only, full sync chain)
-- ============================================================
-- AMAÇ
--   0 TL promosyon satırlarının:
--     1) public.calculate_raw_material_wac(uuid) anchor/pay/paydasını,
--     2) public.sync_raw_material_cost(uuid) current/previous belge sırasını,
--     3) raw_materials.cost/prev_cost/last_purchase_at değerlerini
--   etkilemesini engellemek.
--
-- KAPSAM
--   - Yalnız calculate_raw_material_wac(uuid) ve sync_raw_material_cost(uuid)
--     CREATE OR REPLACE edilir.
--   - Trigger fonksiyonu ve triggerlar değiştirilmez veya yeniden oluşturulmaz.
--   - İmzalar, result type, volatility, SECURITY DEFINER ve search_path korunur.
--   - Owner ve ACL CREATE OR REPLACE öncesi/sonrası birebir doğrulanır.
--   - Hiçbir GRANT/REVOKE veya veri DML işlemi yoktur.
--
-- Canlı pg_get_functiondef body hash drift guardları:
--   calculate: e24fb11517138137f4ff16a53abee1d7
--   sync:      db61913f60a1ccad26400d75c9384be7
-- Trigger function pg_get_functiondef body hash drift guardı:
--   trg_fn_purchase_items_cost_sync: 97fcde199ce50f2c83e1d2ae4b0be02b
-- ============================================================

BEGIN;


-- ============================================================
-- 1) PRE-FLIGHT — metadata, kolon, owner/ACL ve trigger snapshot
-- ============================================================
DO $preflight$
DECLARE
    v_calc_oid             OID;
    v_sync_oid             OID;
    v_trigger_function_oid OID;
    v_calc_overloads       INTEGER;
    v_sync_overloads       INTEGER;
    v_trigger_overloads    INTEGER;
    v_missing              TEXT;
    v_owner_oid            OID;
    v_postgres_oid         OID;
    v_service_role_oid     OID;
    v_anon_oid             OID;
    v_authenticated_oid    OID;
    v_acl_text             TEXT;
    v_unsafe_execute_count INTEGER;
    v_service_execute_count INTEGER;
    v_unexpected_execute_count INTEGER;
    v_result_type          TEXT;
    v_volatility           "char";
    v_security_definer     BOOLEAN;
    v_config               TEXT[];
    v_trigger_function_def TEXT;
    v_trigger_count        INTEGER;
    v_enabled_trigger_count INTEGER;
    v_insert_delete_trigger_def TEXT;
    v_update_trigger_def   TEXT;
    v_trigger_defs_hash    TEXT;
BEGIN
    SELECT count(*)
      INTO v_calc_overloads
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'calculate_raw_material_wac';

    v_calc_oid := to_regprocedure('public.calculate_raw_material_wac(uuid)');
    IF v_calc_overloads <> 1 OR v_calc_oid IS NULL THEN
        RAISE EXCEPTION
            '[080] ABORT: calculate_raw_material_wac(uuid) exact/tek overload değil (bulunan=%)',
            v_calc_overloads;
    END IF;

    IF md5(pg_get_functiondef(v_calc_oid)) <>
           'e24fb11517138137f4ff16a53abee1d7' THEN
        RAISE EXCEPTION '[080] ABORT: calculate live body drift detected';
    END IF;

    SELECT count(*)
      INTO v_sync_overloads
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'sync_raw_material_cost';

    v_sync_oid := to_regprocedure('public.sync_raw_material_cost(uuid)');
    IF v_sync_overloads <> 1 OR v_sync_oid IS NULL THEN
        RAISE EXCEPTION
            '[080] ABORT: sync_raw_material_cost(uuid) exact/tek overload değil (bulunan=%)',
            v_sync_overloads;
    END IF;

    IF md5(pg_get_functiondef(v_sync_oid)) <>
           'db61913f60a1ccad26400d75c9384be7' THEN
        RAISE EXCEPTION '[080] ABORT: sync live body drift detected';
    END IF;

    v_postgres_oid := to_regrole('postgres');
    v_service_role_oid := to_regrole('service_role');
    v_anon_oid := to_regrole('anon');
    v_authenticated_oid := to_regrole('authenticated');

    IF v_postgres_oid IS NULL OR
       v_service_role_oid IS NULL OR
       v_anon_oid IS NULL OR
       v_authenticated_oid IS NULL THEN
        RAISE EXCEPTION '[080] ABORT: required database roles are missing';
    END IF;

    SELECT
        p.proowner,
        COALESCE(p.proacl::TEXT, '<NULL>'),
        pg_get_function_result(p.oid),
        p.provolatile,
        p.prosecdef,
        p.proconfig
      INTO
        v_owner_oid,
        v_acl_text,
        v_result_type,
        v_volatility,
        v_security_definer,
        v_config
      FROM pg_proc p
     WHERE p.oid = v_calc_oid;

    IF v_result_type <> 'numeric' OR
       v_volatility <> 's' OR
       NOT v_security_definer OR
       NOT ('search_path=public' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
        RAISE EXCEPTION
            '[080] ABORT: calculate metadata kontratı farklı (result=%, volatility=%, secdef=%, config=%)',
            v_result_type, v_volatility, v_security_definer, v_config;
    END IF;

    IF v_owner_oid IS DISTINCT FROM v_postgres_oid THEN
        RAISE EXCEPTION '[080] ABORT: calculate owner must be postgres';
    END IF;

    SELECT
        count(*) FILTER (
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee IN (
                  0::OID,
                  v_anon_oid,
                  v_authenticated_oid
              )
        ),
        count(*) FILTER (
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee = v_service_role_oid
        ),
        count(*) FILTER (
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee NOT IN (
                  v_postgres_oid,
                  v_service_role_oid
              )
        )
      INTO
        v_unsafe_execute_count,
        v_service_execute_count,
        v_unexpected_execute_count
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
          COALESCE(p.proacl, acldefault('f', p.proowner))
      ) acl
     WHERE p.oid = v_calc_oid;

    IF v_unsafe_execute_count <> 0 OR
       v_unexpected_execute_count <> 0 OR
       v_service_execute_count = 0 THEN
        RAISE EXCEPTION '[080] ABORT: calculate ACL safe-state invalid';
    END IF;

    PERFORM set_config('novadash.wac_080_calc_owner_oid', v_owner_oid::TEXT, true);
    PERFORM set_config('novadash.wac_080_calc_acl', v_acl_text, true);

    SELECT
        p.proowner,
        COALESCE(p.proacl::TEXT, '<NULL>'),
        pg_get_function_result(p.oid),
        p.provolatile,
        p.prosecdef,
        p.proconfig
      INTO
        v_owner_oid,
        v_acl_text,
        v_result_type,
        v_volatility,
        v_security_definer,
        v_config
      FROM pg_proc p
     WHERE p.oid = v_sync_oid;

    IF v_result_type <> 'void' OR
       v_volatility <> 'v' OR
       NOT v_security_definer OR
       NOT ('search_path=public' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
        RAISE EXCEPTION
            '[080] ABORT: sync metadata kontratı farklı (result=%, volatility=%, secdef=%, config=%)',
            v_result_type, v_volatility, v_security_definer, v_config;
    END IF;

    IF v_owner_oid IS DISTINCT FROM v_postgres_oid THEN
        RAISE EXCEPTION '[080] ABORT: sync owner must be postgres';
    END IF;

    SELECT
        count(*) FILTER (
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee IN (
                  0::OID,
                  v_anon_oid,
                  v_authenticated_oid
              )
        ),
        count(*) FILTER (
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee = v_service_role_oid
        ),
        count(*) FILTER (
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee NOT IN (
                  v_postgres_oid,
                  v_service_role_oid
              )
        )
      INTO
        v_unsafe_execute_count,
        v_service_execute_count,
        v_unexpected_execute_count
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
          COALESCE(p.proacl, acldefault('f', p.proowner))
      ) acl
     WHERE p.oid = v_sync_oid;

    IF v_unsafe_execute_count <> 0 OR
       v_unexpected_execute_count <> 0 OR
       v_service_execute_count = 0 THEN
        RAISE EXCEPTION '[080] ABORT: sync ACL safe-state invalid';
    END IF;

    PERFORM set_config('novadash.wac_080_sync_owner_oid', v_owner_oid::TEXT, true);
    PERFORM set_config('novadash.wac_080_sync_acl', v_acl_text, true);

    IF to_regclass('public.purchase_items') IS NULL THEN
        RAISE EXCEPTION '[080] ABORT: public.purchase_items yok';
    END IF;

    SELECT string_agg(req.column_name, ', ' ORDER BY req.column_name)
      INTO v_missing
      FROM (
          VALUES
              ('id'),
              ('tenant_id'),
              ('raw_material_id'),
              ('invoice_no'),
              ('invoice_date'),
              ('created_at'),
              ('is_deleted'),
              ('base_quantity'),
              ('base_unit_cost')
      ) AS req(column_name)
     WHERE NOT EXISTS (
         SELECT 1
           FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name = 'purchase_items'
            AND c.column_name = req.column_name
     );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION '[080] ABORT: purchase_items eksik kolonlar: %', v_missing;
    END IF;

    IF to_regclass('public.raw_materials') IS NULL THEN
        RAISE EXCEPTION '[080] ABORT: public.raw_materials yok';
    END IF;

    SELECT string_agg(req.column_name, ', ' ORDER BY req.column_name)
      INTO v_missing
      FROM (
          VALUES
              ('id'),
              ('tenant_id'),
              ('is_deleted'),
              ('cost'),
              ('prev_cost'),
              ('last_purchase_at'),
              ('updated_at')
      ) AS req(column_name)
     WHERE NOT EXISTS (
         SELECT 1
           FROM information_schema.columns c
          WHERE c.table_schema = 'public'
            AND c.table_name = 'raw_materials'
            AND c.column_name = req.column_name
     );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION '[080] ABORT: raw_materials eksik kolonlar: %', v_missing;
    END IF;

    SELECT count(*)
      INTO v_trigger_overloads
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'trg_fn_purchase_items_cost_sync'
       AND p.prokind = 'f';

    v_trigger_function_oid :=
        to_regprocedure('public.trg_fn_purchase_items_cost_sync()');
    IF v_trigger_overloads <> 1 OR v_trigger_function_oid IS NULL THEN
        RAISE EXCEPTION
            '[080] ABORT: trg_fn_purchase_items_cost_sync() exact/tek fonksiyon değil (bulunan=%)',
            v_trigger_overloads;
    END IF;

    SELECT pg_get_functiondef(v_trigger_function_oid)
      INTO v_trigger_function_def;

    IF md5(pg_get_functiondef(v_trigger_function_oid)) <>
           '97fcde199ce50f2c83e1d2ae4b0be02b' THEN
        RAISE EXCEPTION '[080] ABORT: trigger function live body drift detected';
    END IF;

    IF position('public.sync_raw_material_cost(v_target_rm_id)'
                IN v_trigger_function_def) = 0 THEN
        RAISE EXCEPTION '[080] ABORT: trigger fonksiyonu merkezi sync çağrısını içermiyor';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (WHERE t.tgenabled = 'O'),
        max(pg_get_triggerdef(t.oid, true)) FILTER (
            WHERE t.tgname = 'trg_purchase_items_cost_sync'
        ),
        max(pg_get_triggerdef(t.oid, true)) FILTER (
            WHERE t.tgname = 'trg_purchase_items_cost_sync_upd'
        ),
        md5(string_agg(
            t.tgname || ':' || t.tgenabled::text || ':' ||
                pg_get_triggerdef(t.oid, true),
            E'\n' ORDER BY t.tgname
        ))
      INTO
        v_trigger_count,
        v_enabled_trigger_count,
        v_insert_delete_trigger_def,
        v_update_trigger_def,
        v_trigger_defs_hash
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'purchase_items'
       AND t.tgname IN (
           'trg_purchase_items_cost_sync',
           'trg_purchase_items_cost_sync_upd'
       )
       AND t.tgfoid = v_trigger_function_oid
       AND NOT t.tgisinternal;

    IF v_trigger_count <> 2 OR v_enabled_trigger_count <> 2 THEN
        RAISE EXCEPTION
            '[080] ABORT: aktif cost-sync trigger zinciri eksik/farklı (bulunan=%, enabled=%)',
            v_trigger_count, v_enabled_trigger_count;
    END IF;

    IF position(
           ' AFTER INSERT OR DELETE ON '
           IN upper(v_insert_delete_trigger_def)
       ) = 0 OR
       position(' UPDATE ' IN upper(v_insert_delete_trigger_def)) <> 0 THEN
        RAISE EXCEPTION
            '[080] ABORT: trg_purchase_items_cost_sync event semantics drift detected';
    END IF;

    IF position(
           ' AFTER UPDATE ON '
           IN upper(v_update_trigger_def)
       ) = 0 OR
       position(' INSERT ' IN upper(v_update_trigger_def)) <> 0 OR
       position(' DELETE ' IN upper(v_update_trigger_def)) <> 0 THEN
        RAISE EXCEPTION
            '[080] ABORT: trg_purchase_items_cost_sync_upd event semantics drift detected';
    END IF;

    PERFORM set_config(
        'novadash.wac_080_trigger_function_hash',
        md5(v_trigger_function_def),
        true
    );
    PERFORM set_config(
        'novadash.wac_080_trigger_defs_hash',
        v_trigger_defs_hash,
        true
    );
END;
$preflight$;


-- ============================================================
-- 2) calculate_raw_material_wac — positive-only anchor ve WAC
-- ============================================================
CREATE OR REPLACE FUNCTION public.calculate_raw_material_wac(
    p_raw_material_id UUID
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_tenant_id         UUID;
    v_anchor_invoice_no BIGINT;
    v_anchor_item_id    UUID;
    v_effective_cost    NUMERIC;
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT rm.tenant_id
      INTO v_tenant_id
      FROM public.raw_materials rm
     WHERE rm.id = p_raw_material_id
       AND rm.is_deleted = false;

    IF v_tenant_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT
        pi.invoice_no,
        pi.id
      INTO
        v_anchor_invoice_no,
        v_anchor_item_id
      FROM public.purchase_items pi
     WHERE pi.raw_material_id = p_raw_material_id
       AND pi.tenant_id = v_tenant_id
       AND pi.is_deleted = false
       AND pi.base_quantity IS NOT NULL
       AND pi.base_quantity > 0
       AND pi.base_unit_cost IS NOT NULL
       AND pi.base_unit_cost > 0
     ORDER BY
           COALESCE(pi.invoice_date, pi.created_at::date) DESC,
           pi.created_at DESC,
           pi.id DESC
     LIMIT 1;

    IF v_anchor_item_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT
        SUM(pi.base_quantity * pi.base_unit_cost)
        / NULLIF(SUM(pi.base_quantity), 0)
      INTO v_effective_cost
      FROM public.purchase_items pi
     WHERE pi.tenant_id = v_tenant_id
       AND pi.raw_material_id = p_raw_material_id
       AND (
              (v_anchor_invoice_no IS NOT NULL
               AND pi.invoice_no = v_anchor_invoice_no)
           OR (v_anchor_invoice_no IS NULL
               AND pi.id = v_anchor_item_id)
       )
       AND pi.is_deleted = false
       AND pi.base_quantity IS NOT NULL
       AND pi.base_quantity > 0
       AND pi.base_unit_cost IS NOT NULL
       AND pi.base_unit_cost > 0;

    RETURN COALESCE(v_effective_cost, 0)::NUMERIC;
END;
$function$;

COMMENT ON FUNCTION public.calculate_raw_material_wac(UUID) IS
$calculate_comment$
080: En son pozitif maliyet kanıtı bulunan belgeyi anchor seçer. Yalnız
base_quantity > 0 ve base_unit_cost > 0 aktif satırlar için
SUM(base_quantity*base_unit_cost)/SUM(base_quantity) hesaplar. 0 TL promosyon
satırları anchor, pay veya paydayı etkilemez. Tenant raw_materials kaydından
çözülür; invoice_no NULL legacy anchor yalnız kendi id satırını belge kabul eder.
$calculate_comment$;


-- ============================================================
-- 3) sync_raw_material_cost — positive-only document ranking
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_raw_material_cost(
    p_raw_material_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_tenant_id        UUID;
    v_current_cost     NUMERIC;
    v_previous_cost    NUMERIC;
    v_last_purchase_at TIMESTAMPTZ;
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('rm_cost:' || p_raw_material_id::text));

    SELECT rm.tenant_id
      INTO v_tenant_id
      FROM public.raw_materials rm
     WHERE rm.id = p_raw_material_id
       AND rm.is_deleted = false;

    IF v_tenant_id IS NULL THEN
        RETURN;
    END IF;

    -- Pozitif finansal filtre belge gruplama ve sıralamasından ÖNCE uygulanır.
    WITH active_rows AS (
        SELECT
            pi.*,
            CASE
                WHEN pi.invoice_no IS NOT NULL
                    THEN 'invoice:' || pi.invoice_no::text
                ELSE 'legacy:' || pi.id::text
            END AS document_key
        FROM public.purchase_items pi
        WHERE pi.tenant_id = v_tenant_id
          AND pi.raw_material_id = p_raw_material_id
          AND pi.is_deleted = false
          AND pi.base_quantity IS NOT NULL
          AND pi.base_quantity > 0
          AND pi.base_unit_cost IS NOT NULL
          AND pi.base_unit_cost > 0
    ), ranked_rows AS (
        SELECT
            ar.*,
            row_number() OVER (
                PARTITION BY ar.document_key
                ORDER BY
                    COALESCE(ar.invoice_date, ar.created_at::date) DESC,
                    ar.created_at DESC,
                    ar.id DESC
            ) AS row_in_document
        FROM active_rows ar
    ), document_anchors AS (
        SELECT
            rr.document_key,
            rr.invoice_no,
            rr.id AS legacy_anchor_id,
            rr.invoice_date AS anchor_invoice_date,
            rr.created_at AS anchor_created_at,
            rr.id AS anchor_item_id
        FROM ranked_rows rr
        WHERE rr.row_in_document = 1
    ), ranked_documents AS (
        SELECT
            da.*,
            row_number() OVER (
                ORDER BY
                    COALESCE(da.anchor_invoice_date, da.anchor_created_at::date) DESC,
                    da.anchor_created_at DESC,
                    da.anchor_item_id DESC
            ) AS document_rank
        FROM document_anchors da
    ), document_costs AS (
        SELECT
            rd.document_rank,
            rd.anchor_created_at,
            calc.effective_cost
        FROM ranked_documents rd
        LEFT JOIN LATERAL (
            SELECT
                SUM(ar.base_quantity * ar.base_unit_cost)
                / NULLIF(SUM(ar.base_quantity), 0) AS effective_cost
            FROM active_rows ar
            WHERE (
                      (rd.invoice_no IS NOT NULL
                       AND ar.invoice_no = rd.invoice_no)
                   OR (rd.invoice_no IS NULL
                       AND ar.id = rd.legacy_anchor_id)
                  )
        ) calc ON true
        WHERE rd.document_rank <= 2
    )
    SELECT
        COALESCE(
            MAX(dc.effective_cost) FILTER (WHERE dc.document_rank = 1),
            0
        ),
        MAX(dc.effective_cost) FILTER (WHERE dc.document_rank = 2),
        MAX(dc.anchor_created_at) FILTER (WHERE dc.document_rank = 1)
      INTO
        v_current_cost,
        v_previous_cost,
        v_last_purchase_at
      FROM document_costs dc;

    UPDATE public.raw_materials rm
       SET prev_cost = v_previous_cost,
           cost = COALESCE(v_current_cost, 0),
           last_purchase_at = v_last_purchase_at,
           updated_at = now()
     WHERE rm.id = p_raw_material_id
       AND rm.tenant_id = v_tenant_id
       AND rm.is_deleted = false;
END;
$function$;

COMMENT ON FUNCTION public.sync_raw_material_cost(UUID) IS
$sync_comment$
080: Maliyet senkron otoritesi. Yalnız positive-only active_rows üzerinden
belge sıralar. En güncel pozitif belge cost, ikinci en güncel pozitif belge
prev_cost, güncel pozitif anchor created_at değeri last_purchase_at olur.
Zero-only belgeler document rank alamaz; hiç pozitif belge yoksa cost=0,
prev_cost=NULL ve last_purchase_at=NULL olur.
$sync_comment$;


-- ============================================================
-- 4) POST-VALIDATION — iki fonksiyon + owner/ACL + trigger korunumu
-- ============================================================
DO $post$
DECLARE
    v_calc_oid             OID;
    v_sync_oid             OID;
    v_trigger_function_oid OID;
    v_calc_overloads       INTEGER;
    v_sync_overloads       INTEGER;
    v_calc_src             TEXT;
    v_sync_src             TEXT;
    v_active_rows_src      TEXT;
    v_owner_oid            OID;
    v_acl_text             TEXT;
    v_result_type          TEXT;
    v_volatility           "char";
    v_security_definer     BOOLEAN;
    v_config               TEXT[];
    v_qty_guard_count      INTEGER;
    v_cost_guard_count     INTEGER;
    v_active_start         INTEGER;
    v_ranked_start         INTEGER;
    v_trigger_function_def TEXT;
    v_trigger_count        INTEGER;
    v_enabled_trigger_count INTEGER;
    v_insert_delete_trigger_def TEXT;
    v_update_trigger_def   TEXT;
    v_trigger_defs_hash    TEXT;
BEGIN
    SELECT count(*)
      INTO v_calc_overloads
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'calculate_raw_material_wac';

    SELECT count(*)
      INTO v_sync_overloads
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'sync_raw_material_cost';

    v_calc_oid := to_regprocedure('public.calculate_raw_material_wac(uuid)');
    v_sync_oid := to_regprocedure('public.sync_raw_material_cost(uuid)');
    IF v_calc_overloads <> 1 OR v_calc_oid IS NULL OR
       v_sync_overloads <> 1 OR v_sync_oid IS NULL THEN
        RAISE EXCEPTION
            '[080] FAIL: exact fonksiyon/overload kontratı bozuk (calculate=%, sync=%)',
            v_calc_overloads, v_sync_overloads;
    END IF;

    SELECT
        pg_get_functiondef(p.oid),
        p.proowner,
        COALESCE(p.proacl::TEXT, '<NULL>'),
        pg_get_function_result(p.oid),
        p.provolatile,
        p.prosecdef,
        p.proconfig
      INTO
        v_calc_src,
        v_owner_oid,
        v_acl_text,
        v_result_type,
        v_volatility,
        v_security_definer,
        v_config
      FROM pg_proc p
     WHERE p.oid = v_calc_oid;

    IF v_result_type <> 'numeric' OR
       v_volatility <> 's' OR
       NOT v_security_definer OR
       NOT ('search_path=public' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
        RAISE EXCEPTION '[080] FAIL: calculate metadata kontratı korunmadı';
    END IF;

    IF current_setting('novadash.wac_080_calc_owner_oid', true)
           IS DISTINCT FROM v_owner_oid::TEXT OR
       current_setting('novadash.wac_080_calc_acl', true)
           IS DISTINCT FROM v_acl_text THEN
        RAISE EXCEPTION '[080] FAIL: calculate owner veya ACL değişti';
    END IF;

    v_qty_guard_count :=
        (length(v_calc_src) - length(replace(v_calc_src, 'pi.base_quantity > 0', '')))
        / length('pi.base_quantity > 0');
    v_cost_guard_count :=
        (length(v_calc_src) - length(replace(v_calc_src, 'pi.base_unit_cost > 0', '')))
        / length('pi.base_unit_cost > 0');

    IF v_calc_src ~ 'base_unit_cost[[:space:]]*>=[[:space:]]*0' OR
       v_calc_src ~ 'base_quantity[[:space:]]*>=[[:space:]]*0' OR
       v_qty_guard_count <> 2 OR v_cost_guard_count <> 2 OR
       position('SUM(pi.base_quantity * pi.base_unit_cost)' IN v_calc_src) = 0 OR
       position('NULLIF(SUM(pi.base_quantity), 0)' IN v_calc_src) = 0 THEN
        RAISE EXCEPTION '[080] FAIL: calculate positive-only WAC kontratı eksik';
    END IF;

    SELECT
        pg_get_functiondef(p.oid),
        p.proowner,
        COALESCE(p.proacl::TEXT, '<NULL>'),
        pg_get_function_result(p.oid),
        p.provolatile,
        p.prosecdef,
        p.proconfig
      INTO
        v_sync_src,
        v_owner_oid,
        v_acl_text,
        v_result_type,
        v_volatility,
        v_security_definer,
        v_config
      FROM pg_proc p
     WHERE p.oid = v_sync_oid;

    IF v_result_type <> 'void' OR
       v_volatility <> 'v' OR
       NOT v_security_definer OR
       NOT ('search_path=public' = ANY(COALESCE(v_config, ARRAY[]::TEXT[]))) THEN
        RAISE EXCEPTION '[080] FAIL: sync metadata kontratı korunmadı';
    END IF;

    IF current_setting('novadash.wac_080_sync_owner_oid', true)
           IS DISTINCT FROM v_owner_oid::TEXT OR
       current_setting('novadash.wac_080_sync_acl', true)
           IS DISTINCT FROM v_acl_text THEN
        RAISE EXCEPTION '[080] FAIL: sync owner veya ACL değişti';
    END IF;

    v_active_start := position('WITH active_rows AS (' IN v_sync_src);
    v_ranked_start := position('), ranked_rows AS (' IN v_sync_src);
    IF v_active_start = 0 OR v_ranked_start <= v_active_start THEN
        RAISE EXCEPTION '[080] FAIL: sync active_rows/ranked_rows sırası eksik';
    END IF;

    v_active_rows_src := substring(
        v_sync_src FROM v_active_start FOR v_ranked_start - v_active_start
    );

    IF position('pi.is_deleted = false' IN v_active_rows_src) = 0 OR
       position('pi.base_quantity IS NOT NULL' IN v_active_rows_src) = 0 OR
       position('pi.base_quantity > 0' IN v_active_rows_src) = 0 OR
       position('pi.base_unit_cost IS NOT NULL' IN v_active_rows_src) = 0 OR
       position('pi.base_unit_cost > 0' IN v_active_rows_src) = 0 THEN
        RAISE EXCEPTION '[080] FAIL: sync active_rows positive-only filtresi eksik';
    END IF;

    IF position('SUM(ar.base_quantity * ar.base_unit_cost)' IN v_sync_src) = 0 OR
       position('NULLIF(SUM(ar.base_quantity), 0)' IN v_sync_src) = 0 OR
       position('dc.document_rank = 1' IN v_sync_src) = 0 OR
       position('dc.document_rank = 2' IN v_sync_src) = 0 OR
       position('pg_advisory_xact_lock' IN v_sync_src) = 0 OR
       position('SELECT rm.tenant_id' IN v_sync_src) = 0 OR
       position('prev_cost = v_previous_cost' IN v_sync_src) = 0 OR
       position('cost = COALESCE(v_current_cost, 0)' IN v_sync_src) = 0 OR
       position('last_purchase_at = v_last_purchase_at' IN v_sync_src) = 0 THEN
        RAISE EXCEPTION '[080] FAIL: sync ranking/lock/update kontratı eksik';
    END IF;

    IF v_sync_src ~ 'base_unit_cost[[:space:]]*>=[[:space:]]*0' OR
       v_sync_src ~ 'base_quantity[[:space:]]*>=[[:space:]]*0' THEN
        RAISE EXCEPTION '[080] FAIL: sync forbidden non-negative guard bulundu';
    END IF;

    v_trigger_function_oid :=
        to_regprocedure('public.trg_fn_purchase_items_cost_sync()');
    SELECT pg_get_functiondef(v_trigger_function_oid)
      INTO v_trigger_function_def;

    SELECT
        count(*),
        count(*) FILTER (WHERE t.tgenabled = 'O'),
        max(pg_get_triggerdef(t.oid, true)) FILTER (
            WHERE t.tgname = 'trg_purchase_items_cost_sync'
        ),
        max(pg_get_triggerdef(t.oid, true)) FILTER (
            WHERE t.tgname = 'trg_purchase_items_cost_sync_upd'
        ),
        md5(string_agg(
            t.tgname || ':' || t.tgenabled::text || ':' ||
                pg_get_triggerdef(t.oid, true),
            E'\n' ORDER BY t.tgname
        ))
      INTO
        v_trigger_count,
        v_enabled_trigger_count,
        v_insert_delete_trigger_def,
        v_update_trigger_def,
        v_trigger_defs_hash
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'purchase_items'
       AND t.tgname IN (
           'trg_purchase_items_cost_sync',
           'trg_purchase_items_cost_sync_upd'
       )
       AND t.tgfoid = v_trigger_function_oid
       AND NOT t.tgisinternal;

    IF v_trigger_count <> 2 OR
       v_enabled_trigger_count <> 2 OR
       position(
           ' AFTER INSERT OR DELETE ON '
           IN upper(v_insert_delete_trigger_def)
       ) = 0 OR
       position(' UPDATE ' IN upper(v_insert_delete_trigger_def)) <> 0 OR
       position(
           ' AFTER UPDATE ON '
           IN upper(v_update_trigger_def)
       ) = 0 OR
       position(' INSERT ' IN upper(v_update_trigger_def)) <> 0 OR
       position(' DELETE ' IN upper(v_update_trigger_def)) <> 0 OR
       current_setting('novadash.wac_080_trigger_function_hash', true)
           IS DISTINCT FROM md5(v_trigger_function_def) OR
       current_setting('novadash.wac_080_trigger_defs_hash', true)
           IS DISTINCT FROM v_trigger_defs_hash THEN
        RAISE EXCEPTION '[080] FAIL: trigger fonksiyonu veya triggerlar değişti';
    END IF;
END;
$post$;

COMMIT;
