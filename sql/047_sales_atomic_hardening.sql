-- ============================================================
-- 047 — CREATE_SALES_ATOMIC SECURITY HARDENING
--
-- Amac:
--   create_sales_atomic'i diger satis yazma RPC'leriyle (044) ayni
--   pattern'e cek:
--     - SECURITY DEFINER + SET search_path = public
--     - Tenant resolve auth.uid() -> users.tenant_id (DB-side)
--     - Client p_tenant_id artik opsiyonel (DEFAULT NULL)
--     - Eger client legacy p_tenant_id gonderir ve resolved
--       v_tenant_id'den FARKLIYSA -> RAISE (cross-tenant attempt)
--
-- Backward compatibility:
--   - Imza: (p_tenant_id UUID DEFAULT NULL, p_sales JSONB DEFAULT NULL)
--   - Eski client {p_tenant_id, p_sales} gondermeye devam edebilir.
--   - Yeni client {p_sales} gonderir; p_tenant_id NULL gelir, cross-
--     check sessizce gecer.
--
-- Korunan davranis:
--   - 046 DB-side authoritative cost snapshot (server-side
--     products.cost lookup, frontend 'cost' silent ignore, product
--     yok/silinmis/baska tenant -> RAISE).
--   - Idempotency lookup ve INSERT akisi (UNIQUE constraint
--     dokunulmadi, hash formulu dokunulmadi).
--   - Bos urunlu satis (lines = []) destegi: sales header yazilir,
--     product_sales bos kalir.
--   - Server-side idempotency_key fallback: client gondermezse ayni
--     formul (md5 tenant|date|total|cash|card|notes) ile uretilir.
--
-- KAPSAM DISI (bu fazda DEGISMEZ):
--   - Idempotency UNIQUE constraint (FAZ 1.3)
--   - Hash formulu degisikligi (FAZ 1.3)
--   - KDV modeli (FAZ 1.4)
--   - restore_full_backup (FAZ 1.5)
--   - create_sale_empty fonksiyonu (frontend artik cagirmaz ama DB'de
--     kalir; rollback guvenligi icin)
--
-- Rollback:
--   Baseline'in eski D.7 body'sini (047 oncesi) Dashboard'da tek
--   CREATE OR REPLACE ile RUN -> eski INVOKER + p_tenant_id required
--   davranisi geri gelir. Frontend revert sonrasinda da uyumlu.
-- ============================================================


CREATE OR REPLACE FUNCTION create_sales_atomic(
    p_tenant_id UUID  DEFAULT NULL,
    p_sales     JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid      UUID;
    v_tenant_id     UUID;

    v_sale          JSONB;
    v_product       JSONB;
    v_sale_id       UUID;
    v_ikey          TEXT;
    v_results       JSONB := '[]'::jsonb;
    v_sale_record   JSONB;
    v_is_new        BOOLEAN;

    -- 046: server-side cost snapshot
    v_product_id    UUID;
    v_snapshot_cost NUMERIC;
BEGIN
    -- ============ AUTH ============
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: no authenticated user'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id
      INTO v_tenant_id
      FROM users u
     WHERE u.id = v_auth_uid
       AND u.is_active = true;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found or user disabled'
            USING ERRCODE = '42501';
    END IF;

    -- Legacy client backward-compat: p_tenant_id verilmisse cross-check.
    -- Mismatch = cross-tenant attempt -> hard fail.
    IF p_tenant_id IS NOT NULL
       AND p_tenant_id IS DISTINCT FROM v_tenant_id THEN
        RAISE EXCEPTION 'Tenant mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- ============ PAYLOAD VALIDATION ============
    IF p_sales IS NULL OR jsonb_array_length(p_sales) = 0 THEN
        RAISE EXCEPTION 'p_sales: at least one sale is required';
    END IF;

    -- ============ MAIN LOOP ============
    FOR v_sale IN SELECT * FROM jsonb_array_elements(p_sales)
    LOOP
        -- Idempotency key: client gondermezse server fallback (ayni formul)
        v_ikey := COALESCE(
            v_sale->>'idempotency_key',
            md5(
                v_tenant_id::text                                   || '|' ||
                COALESCE(v_sale->>'date', '')                       || '|' ||
                COALESCE((v_sale->>'total')::numeric, 0)::text      || '|' ||
                COALESCE((v_sale->>'cash')::numeric, 0)::text       || '|' ||
                COALESCE((v_sale->>'card')::numeric, 0)::text       || '|' ||
                COALESCE(v_sale->>'notes', '')
            )
        );

        v_sale_id := NULL;
        v_is_new  := FALSE;

        IF v_ikey IS NOT NULL THEN
            SELECT id INTO v_sale_id
              FROM sales
             WHERE idempotency_key = v_ikey
               AND tenant_id       = v_tenant_id
               AND is_deleted      = false
             LIMIT 1;
        END IF;

        IF v_sale_id IS NULL THEN
            INSERT INTO sales (
                tenant_id, date, total, cash, card,
                notes, created_by, idempotency_key
            )
            VALUES (
                v_tenant_id,
                (v_sale->>'date')::DATE,
                COALESCE((v_sale->>'total')::NUMERIC, 0),
                COALESCE((v_sale->>'cash')::NUMERIC, 0),
                COALESCE((v_sale->>'card')::NUMERIC, 0),
                v_sale->>'notes',
                v_auth_uid,
                v_ikey
            )
            RETURNING id INTO v_sale_id;
            v_is_new := TRUE;
        END IF;

        IF v_sale_id IS NULL THEN CONTINUE; END IF;

        -- ============ PRODUCT LINES (bos olabilir) ============
        IF v_is_new THEN
            IF v_sale->'products' IS NOT NULL
               AND jsonb_array_length(v_sale->'products') > 0 THEN
                FOR v_product IN SELECT * FROM jsonb_array_elements(v_sale->'products')
                LOOP
                    v_product_id := (v_product->>'product_id')::UUID;

                    IF v_product_id IS NULL THEN
                        RAISE EXCEPTION 'product_id is required for sale line';
                    END IF;

                    -- 046: AUTHORITATIVE COST LOOKUP (DEFINER altinda
                    -- RLS bypass; manuel tenant guard zorunlu).
                    SELECT p.cost
                      INTO v_snapshot_cost
                      FROM products p
                     WHERE p.id        = v_product_id
                       AND p.tenant_id = v_tenant_id
                       AND COALESCE(p.is_deleted, false) = false;

                    IF NOT FOUND THEN
                        RAISE EXCEPTION
                            'Product not found, deleted, or tenant mismatch: %',
                            v_product_id
                            USING ERRCODE = '42501';
                    END IF;

                    INSERT INTO product_sales (
                        tenant_id, sale_id, product_id, date,
                        quantity, unit_price, total, cost
                    )
                    VALUES (
                        v_tenant_id, v_sale_id,
                        v_product_id,
                        (v_sale->>'date')::DATE,
                        COALESCE((v_product->>'quantity')::INT, 0),
                        COALESCE((v_product->>'unit_price')::NUMERIC, 0),
                        COALESCE((v_product->>'total')::NUMERIC, 0),
                        COALESCE(v_snapshot_cost, 0)
                    );
                END LOOP;
            END IF;
        END IF;

        -- ============ RESPONSE BUILDING ============
        IF v_is_new THEN
            SELECT jsonb_build_object(
                'id', s.id, 'tenant_id', s.tenant_id, 'date', s.date,
                'total', s.total, 'cash', s.cash, 'card', s.card, 'notes', s.notes,
                'created_by', s.created_by, 'created_at', s.created_at,
                'is_deleted', s.is_deleted,
                'product_sales', COALESCE(
                    (SELECT jsonb_agg(jsonb_build_object(
                        'id', ps.id, 'sale_id', ps.sale_id, 'product_id', ps.product_id,
                        'date', ps.date, 'quantity', ps.quantity,
                        'unit_price', ps.unit_price, 'total', ps.total, 'cost', ps.cost
                    )) FROM product_sales ps WHERE ps.sale_id = s.id),
                    '[]'::jsonb
                )
            ) INTO v_sale_record
              FROM sales s WHERE s.id = v_sale_id;

            v_results := v_results || v_sale_record;
        END IF;
    END LOOP;

    RETURN v_results;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_sales_atomic(UUID, JSONB) TO authenticated;


-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_count    INT;
    v_secdef   BOOLEAN;
    v_config   TEXT;
BEGIN
    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'create_sales_atomic';

    IF v_count = 0 THEN
        RAISE EXCEPTION 'KRITIK: create_sales_atomic kurulamadi';
    END IF;

    SELECT p.prosecdef,
           (SELECT string_agg(cfg, ', ') FROM unnest(coalesce(p.proconfig,'{}')) AS cfg)
      INTO v_secdef, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'create_sales_atomic'
     LIMIT 1;

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'KRITIK: create_sales_atomic SECURITY DEFINER degil';
    END IF;

    IF v_config IS NULL OR v_config NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION 'KRITIK: create_sales_atomic search_path SET edilmemis';
    END IF;

    RAISE NOTICE 'OK: create_sales_atomic (047 hardened) aktif | SECURITY DEFINER | %', v_config;
END $$;
