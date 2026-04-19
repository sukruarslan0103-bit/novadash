-- ============================================================
-- IMPORT / EXPORT RPCs
-- ============================================================

-- ============================================================
-- EXPORT — tenant-scoped full dump
-- ============================================================
CREATE OR REPLACE FUNCTION public.export_all_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid      uuid := auth.uid();
    v_tenant   uuid;
    v_payload  jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant FROM public.users WHERE id = v_uid;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    SELECT jsonb_build_object(
        'export_version', '1.0',
        'export_date',    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'tenant_id',      v_tenant,
        'data', jsonb_build_object(
            'categories',    COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at)
                                        FROM public.categories c
                                        WHERE c.tenant_id = v_tenant), '[]'::jsonb),
            'products',      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at)
                                        FROM public.products p
                                        WHERE p.tenant_id = v_tenant), '[]'::jsonb),
            'sales',         COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at)
                                        FROM public.sales s
                                        WHERE s.tenant_id = v_tenant), '[]'::jsonb),
            'product_sales', COALESCE((SELECT jsonb_agg(to_jsonb(ps) ORDER BY ps.created_at)
                                        FROM public.product_sales ps
                                        WHERE ps.tenant_id = v_tenant), '[]'::jsonb),
            'expenses',      COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                                        FROM public.expenses e
                                        WHERE e.tenant_id = v_tenant), '[]'::jsonb),
            'events',        COALESCE((SELECT jsonb_agg(to_jsonb(ev) ORDER BY ev.created_at)
                                        FROM public.events ev
                                        WHERE ev.tenant_id = v_tenant), '[]'::jsonb),
            'tasks',         COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at)
                                        FROM public.tasks t
                                        WHERE t.tenant_id = v_tenant), '[]'::jsonb),
            'settings',      COALESCE((SELECT jsonb_agg(to_jsonb(st))
                                        FROM public.settings st
                                        WHERE st.tenant_id = v_tenant), '[]'::jsonb)
        )
    ) INTO v_payload;

    RETURN v_payload;
END;
$$;

GRANT EXECUTE ON FUNCTION public.export_all_data() TO authenticated;

-- ============================================================
-- IMPORT — atomic, tenant enforced
-- Sales ALWAYS get a new id; product_sales.sale_id remapped
-- via per-call _sales_id_map (ON COMMIT DROP).
-- Other tables preserve ids with ON CONFLICT DO NOTHING.
-- ============================================================
CREATE OR REPLACE FUNCTION public.import_all_data(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid        uuid := auth.uid();
    v_tenant     uuid;
    v_data       jsonb;
    v_version    text;
    v_counts     jsonb := '{}'::jsonb;
    v_n          int;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant FROM public.users WHERE id = v_uid;
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'Invalid payload' USING ERRCODE = '22023';
    END IF;

    v_version := p_payload->>'export_version';
    IF v_version IS NULL THEN
        RAISE EXCEPTION 'Missing export_version' USING ERRCODE = '22023';
    END IF;

    v_data := p_payload->'data';
    IF v_data IS NULL OR jsonb_typeof(v_data) <> 'object' THEN
        RAISE EXCEPTION 'Missing data block' USING ERRCODE = '22023';
    END IF;

    -- Per-call mapping table: old sale id -> new sale id
    CREATE TEMP TABLE IF NOT EXISTS _sales_id_map (
        old_id uuid PRIMARY KEY,
        new_id uuid NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE _sales_id_map;

    -- categories
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'categories','[]'::jsonb)) AS x(
            id uuid, name text, type text, color text, sort_order int, created_at timestamptz
        )
    )
    INSERT INTO public.categories (id, tenant_id, name, type, color, sort_order, created_at)
    SELECT COALESCE(s.id, gen_random_uuid()), v_tenant, s.name, s.type,
           COALESCE(s.color, '#6B7280'), COALESCE(s.sort_order, 0),
           COALESCE(s.created_at, now())
    FROM src s
    WHERE s.name IS NOT NULL AND s.type IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('categories', v_n);

    -- products
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'products','[]'::jsonb)) AS x(
            id uuid, name text, category_id uuid, price numeric, cost numeric,
            is_active boolean, is_deleted boolean, category_name text,
            created_at timestamptz, updated_at timestamptz
        )
    )
    INSERT INTO public.products (id, tenant_id, name, category_id, price, cost,
                                 is_active, is_deleted, category_name, created_at, updated_at)
    SELECT COALESCE(s.id, gen_random_uuid()), v_tenant, s.name, s.category_id,
           COALESCE(s.price, 0), COALESCE(s.cost, 0),
           COALESCE(s.is_active, true), COALESCE(s.is_deleted, false),
           s.category_name, COALESCE(s.created_at, now()), COALESCE(s.updated_at, now())
    FROM src s
    WHERE s.name IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('products', v_n);

    -- sales — ALWAYS generate new id, persist old->new mapping
    WITH src AS MATERIALIZED (
        SELECT x.*, gen_random_uuid() AS new_id
        FROM jsonb_to_recordset(COALESCE(v_data->'sales','[]'::jsonb)) AS x(
            id uuid, date date, total numeric, cash numeric, card numeric,
            notes text, is_deleted boolean, idempotency_key text,
            created_at timestamptz, updated_at timestamptz
        )
        WHERE x.date IS NOT NULL
    ),
    inserted AS (
        INSERT INTO public.sales (id, tenant_id, date, total, cash, card, notes,
                                  is_deleted, idempotency_key, created_by,
                                  created_at, updated_at)
        SELECT s.new_id, v_tenant, s.date,
               COALESCE(s.total, 0), COALESCE(s.cash, 0), COALESCE(s.card, 0),
               s.notes, COALESCE(s.is_deleted, false), s.idempotency_key,
               v_uid, COALESCE(s.created_at, now()), COALESCE(s.updated_at, now())
        FROM src s
        RETURNING id
    ),
    mapped AS (
        INSERT INTO _sales_id_map (old_id, new_id)
        SELECT s.id, s.new_id
        FROM src s
        WHERE s.id IS NOT NULL
        ON CONFLICT (old_id) DO NOTHING
        RETURNING old_id
    )
    SELECT COUNT(*) INTO v_n FROM inserted;
    v_counts := v_counts || jsonb_build_object('sales', v_n);

    -- product_sales — new id; remap sale_id via _sales_id_map
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'product_sales','[]'::jsonb)) AS x(
            id uuid, product_id uuid, sale_id uuid, date date,
            quantity int, unit_price numeric, total numeric, cost numeric,
            created_at timestamptz
        )
    )
    INSERT INTO public.product_sales (id, tenant_id, product_id, sale_id, date,
                                      quantity, unit_price, total, cost, created_at)
    SELECT gen_random_uuid(), v_tenant, s.product_id,
           m.new_id,
           s.date, COALESCE(s.quantity, 0), COALESCE(s.unit_price, 0),
           COALESCE(s.total, 0), COALESCE(s.cost, 0),
           COALESCE(s.created_at, now())
    FROM src s
    LEFT JOIN _sales_id_map m ON m.old_id = s.sale_id
    WHERE s.product_id IS NOT NULL
      AND s.date IS NOT NULL
      AND (s.sale_id IS NULL OR m.new_id IS NOT NULL);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('product_sales', v_n);

    -- expenses
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'expenses','[]'::jsonb)) AS x(
            id uuid, date date, amount numeric, category_id uuid,
            description text, category_name text,
            created_at timestamptz, updated_at timestamptz
        )
    )
    INSERT INTO public.expenses (id, tenant_id, date, amount, category_id, description,
                                 category_name, created_by, created_at, updated_at)
    SELECT COALESCE(s.id, gen_random_uuid()), v_tenant, s.date,
           COALESCE(s.amount, 0), s.category_id, s.description, s.category_name,
           v_uid, COALESCE(s.created_at, now()), COALESCE(s.updated_at, now())
    FROM src s
    WHERE s.date IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('expenses', v_n);

    -- events
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'events','[]'::jsonb)) AS x(
            id uuid, name text, type text, date date,
            start_time time, end_time time, venue text, description text,
            est_cost numeric, est_revenue numeric,
            actual_cost numeric, actual_revenue numeric,
            created_at timestamptz, updated_at timestamptz
        )
    )
    INSERT INTO public.events (id, tenant_id, name, type, date, start_time, end_time,
                               venue, description, est_cost, est_revenue,
                               actual_cost, actual_revenue, created_at, updated_at)
    SELECT COALESCE(s.id, gen_random_uuid()), v_tenant, s.name, s.type, s.date,
           s.start_time, s.end_time, s.venue, s.description,
           COALESCE(s.est_cost, 0), COALESCE(s.est_revenue, 0),
           s.actual_cost, s.actual_revenue,
           COALESCE(s.created_at, now()), COALESCE(s.updated_at, now())
    FROM src s
    WHERE s.name IS NOT NULL AND s.date IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('events', v_n);

    -- tasks
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'tasks','[]'::jsonb)) AS x(
            id uuid, title text, description text, assignee text,
            due_date date, priority text, status text, category text,
            created_at timestamptz, updated_at timestamptz
        )
    )
    INSERT INTO public.tasks (id, tenant_id, title, description, assignee, due_date,
                              priority, status, category, created_at, updated_at)
    SELECT COALESCE(s.id, gen_random_uuid()), v_tenant, s.title, s.description,
           s.assignee, s.due_date,
           COALESCE(s.priority, 'medium'), COALESCE(s.status, 'todo'),
           s.category, COALESCE(s.created_at, now()), COALESCE(s.updated_at, now())
    FROM src s
    WHERE s.title IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('tasks', v_n);

    -- settings
    WITH src AS (
        SELECT * FROM jsonb_to_recordset(COALESCE(v_data->'settings','[]'::jsonb)) AS x(
            id uuid, key text, value jsonb
        )
    )
    INSERT INTO public.settings (id, tenant_id, key, value)
    SELECT COALESCE(s.id, gen_random_uuid()), v_tenant, s.key, s.value
    FROM src s
    WHERE s.key IS NOT NULL
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('settings', v_n);

    RETURN jsonb_build_object(
        'ok', true,
        'tenant_id', v_tenant,
        'import_version', v_version,
        'inserted', v_counts
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.import_all_data(jsonb) TO authenticated;
