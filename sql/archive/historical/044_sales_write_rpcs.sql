-- ============================================================
-- 044 — SALES WRITE RPCs (REST fallback kaldirma)
--   create_sale_empty   : urunsuz tek satir sales INSERT
--   update_sale         : sales UPDATE (PUT-stili)
--   soft_delete_sale    : is_deleted=true (mevcut soft_delete_record sarmali)
--
-- Tum tenant_id server-side (auth.uid -> users.tenant_id).
-- create_sales_atomic'e DOKUNULMADI (mevcut akis korundu).
-- ============================================================


-- ============================================================
-- 1) CREATE_SALE_EMPTY — urunsuz satir (sales.js empty-lines path)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_sale_empty(JSONB);

CREATE OR REPLACE FUNCTION public.create_sale_empty(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_new_id    UUID;
    v_idem_key  TEXT;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM public.users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'p_payload object olmali';
    END IF;

    IF p_payload->>'date' IS NULL THEN
        RAISE EXCEPTION 'date zorunlu';
    END IF;

    -- idempotency_key: gelmediyse server-side tureticek
    v_idem_key := COALESCE(
        p_payload->>'idempotency_key',
        md5(
            v_tenant_id::text || '|' ||
            (p_payload->>'date') || '|' ||
            COALESCE((p_payload->>'total')::numeric, 0)::text || '|' ||
            COALESCE((p_payload->>'cash')::numeric, 0)::text  || '|' ||
            COALESCE((p_payload->>'card')::numeric, 0)::text  || '|' ||
            COALESCE(p_payload->>'notes', '')
        )
    );

    BEGIN
        INSERT INTO public.sales (
            tenant_id, date, total, cash, card, notes,
            is_deleted, idempotency_key, created_by
        ) VALUES (
            v_tenant_id,
            (p_payload->>'date')::DATE,
            COALESCE((p_payload->>'total')::numeric, 0),
            COALESCE((p_payload->>'cash')::numeric, 0),
            COALESCE((p_payload->>'card')::numeric, 0),
            p_payload->>'notes',
            false,
            v_idem_key,
            v_auth_uid
        )
        RETURNING id INTO v_new_id;

        RETURN jsonb_build_object(
            'success', true,
            'id', v_new_id,
            'duplicate', false,
            'idempotency_key', v_idem_key
        );

    EXCEPTION WHEN unique_violation THEN
        SELECT id INTO v_new_id FROM public.sales
        WHERE tenant_id = v_tenant_id
          AND idempotency_key = v_idem_key
        LIMIT 1;

        RETURN jsonb_build_object(
            'success', true,
            'id', v_new_id,
            'duplicate', true,
            'idempotency_key', v_idem_key,
            'message', 'Ayni satis zaten kayitli'
        );
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_sale_empty(JSONB) TO authenticated;


-- ============================================================
-- 2) UPDATE_SALE — sales UPDATE (yalnizca yazilabilir alanlar)
--   p_id zorunlu. p_updates: { date, total, cash, card, notes } (partial OK)
-- ============================================================
DROP FUNCTION IF EXISTS public.update_sale(UUID, JSONB);

CREATE OR REPLACE FUNCTION public.update_sale(p_id UUID, p_updates JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
    v_exists    BOOLEAN;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT tenant_id INTO v_tenant_id FROM public.users WHERE id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    IF p_id IS NULL THEN
        RAISE EXCEPTION 'p_id zorunlu';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.sales WHERE id = p_id AND tenant_id = v_tenant_id
    ) INTO v_exists;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'Sale not found or access denied' USING ERRCODE = '42501';
    END IF;

    UPDATE public.sales
    SET
        date  = COALESCE((p_updates->>'date')::DATE,    date),
        total = COALESCE((p_updates->>'total')::numeric, total),
        cash  = COALESCE((p_updates->>'cash')::numeric,  cash),
        card  = COALESCE((p_updates->>'card')::numeric,  card),
        notes = COALESCE(p_updates->>'notes',            notes),
        updated_at = now()
    WHERE id = p_id
      AND tenant_id = v_tenant_id;

    RETURN jsonb_build_object('success', true, 'id', p_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_sale(UUID, JSONB) TO authenticated;


-- ============================================================
-- 3) SOFT_DELETE_SALE — wrapper (mevcut soft_delete_record'a yonlendirir)
-- ============================================================
DROP FUNCTION IF EXISTS public.soft_delete_sale(UUID);

CREATE OR REPLACE FUNCTION public.soft_delete_sale(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_id IS NULL THEN
        RAISE EXCEPTION 'p_id zorunlu';
    END IF;
    -- 009'da tanimli generic soft_delete_record (tenant + audit + delete)
    RETURN public.soft_delete_record('sales', p_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.soft_delete_sale(UUID) TO authenticated;


-- ============================================================
-- DOGRULAMA
-- ============================================================
DO $$
DECLARE v_c INT; v_u INT; v_d INT;
BEGIN
    SELECT count(*) INTO v_c FROM pg_proc WHERE proname='create_sale_empty' AND pronamespace='public'::regnamespace;
    SELECT count(*) INTO v_u FROM pg_proc WHERE proname='update_sale'        AND pronamespace='public'::regnamespace;
    SELECT count(*) INTO v_d FROM pg_proc WHERE proname='soft_delete_sale'   AND pronamespace='public'::regnamespace;
    IF v_c=0 OR v_u=0 OR v_d=0 THEN
        RAISE EXCEPTION 'KRITIK: sales write RPCs eksik';
    END IF;
    RAISE NOTICE 'OK: create_sale_empty + update_sale + soft_delete_sale aktif';
END $$;
