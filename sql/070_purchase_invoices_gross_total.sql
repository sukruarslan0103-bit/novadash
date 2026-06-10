-- ============================================================
-- 070 — F2: get_purchase_invoices_paginated GROSS (KDV DAHIL) total
--
-- Root cause (dogrulandi):
--   "Son Alislar" listesi bu RPC'nin total_amount'ini gosteriyor; RPC NET
--   (Σ line_total, KDV HARIC) donuyordu. Detay modal (F1) ise BRUT gosteriyor
--   → liste 416.67 vs detay 500 tutarsizligi.
--
-- Fix:
--   total_amount = SUM(line_total * (1 + vat_rate/100))   ← satir-bazli BRUT
--   Satir bazinda carptigimiz icin KARISIK KDV (satir basina farkli vat_rate)
--   dogru toplanir; tek fatura-geneli oran varsayimi YOK.
--
-- ONEMLI — kanonik tanim:
--   Bu RPC repo SQL'inde TANIMLI DEGILDI (canli DB'de dogrudan olusturulmus,
--   izlenmiyordu). Frontend sozlesmesi products-view.js'ten cikarildi:
--     cagri : rpc('get_purchase_invoices_paginated',
--                 { p_start, p_end, p_limit, p_offset })          (4068-4072)
--     tuketim: invoice_no, invoice_date, created_at, item_count,
--              total_amount, total_count                          (4183-4195, 4163)
--   Bu migration fonksiyonu BU sozlesmeyle kanoniklestirir (artik repo'da).
--   Davranis sozlesmesi korunur: invoice_no bazli gruplama, tarih filtresi,
--   created_at DESC siralama (yeni fatura ustte), limit/offset pagination,
--   total_count window count. DEGISEN TEK SEMANTIK: total_amount NET → BRUT.
--
-- KORUNAN / DOKUNULMAYAN:
--   - Stored NET alanlar (purchase_items.unit_cost / line_total) — okuma RPC'si,
--     hicbir tabloyu YAZMAZ.
--   - WAC / trigger / save pipeline / 067 / 068 / 069 — ilgisiz, dokunulmadi.
--   - Tenant isolation: tenant auth.uid() → users.tenant_id (server-side).
--
-- Not (bilincli): genel iskonto (general_discount_amount) toplama DAHIL DEGIL —
--   detay modal (F1: Σ line_total*(1+vat)) ile birebir AYNI formul; liste ile
--   detay artik ayni sayiyi verir. Genel iskonto gosterimi ayri konu.
--
-- Idempotent: DO-blok DROP (tum overload'lar) + CREATE. Rollback: eski NET
--   icin ayni govdede carpani kaldirip RUN (veri etkisi sifir — read-only RPC).
-- ============================================================


-- ============================================================
-- PRE-FLIGHT (salt-okuma)
-- ============================================================
DO $pre$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='purchase_items'
    ) THEN
        RAISE EXCEPTION '[070] ABORT: purchase_items tablosu yok';
    END IF;
    RAISE NOTICE '[070] PRE-FLIGHT OK';
END;
$pre$;


-- ============================================================
-- DROP — mevcut tum overload'lari kaldir (canli imza repo'da bilinmiyor;
-- RETURN TABLE degisikligi CREATE OR REPLACE ile yapilamaz).
-- ============================================================
DO $drop$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'get_purchase_invoices_paginated'
    LOOP
        EXECUTE 'DROP FUNCTION ' || r.sig;
        RAISE NOTICE '[070] DROP %', r.sig;
    END LOOP;
END;
$drop$;


-- ============================================================
-- CREATE — kanonik tanim, total_amount = BRUT (satir-bazli KDV)
-- ============================================================
CREATE FUNCTION public.get_purchase_invoices_paginated(
    p_start  DATE DEFAULT NULL,
    p_end    DATE DEFAULT NULL,
    p_limit  INT  DEFAULT 20,
    p_offset INT  DEFAULT 0
)
RETURNS TABLE (
    invoice_no    BIGINT,
    invoice_date  DATE,
    created_at    TIMESTAMPTZ,
    item_count    BIGINT,
    total_amount  NUMERIC,
    total_count   BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_auth_uid  UUID;
    v_tenant_id UUID;
BEGIN
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id FROM users u WHERE u.id = v_auth_uid;
    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Tenant not found' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        pi.invoice_no,
        MIN(pi.invoice_date)                                   AS invoice_date,
        MIN(pi.created_at)                                     AS created_at,
        COUNT(*)                                               AS item_count,
        -- 070/F2: BRUT toplam — satir bazinda KDV uygulanir → karisik KDV'li
        -- faturada her satir KENDI oraniyla carpilir (tek-oran varsayimi yok).
        -- Detay modal (F1) ile birebir ayni formul: Σ line_total*(1+vat/100).
        SUM( COALESCE(pi.line_total, 0)
             * (1 + COALESCE(pi.vat_rate, 0) / 100) )::NUMERIC AS total_amount,
        COUNT(*) OVER ()                                       AS total_count
    FROM purchase_items pi
    WHERE pi.tenant_id  = v_tenant_id
      AND pi.is_deleted = false
      AND pi.invoice_no IS NOT NULL
      AND (p_start IS NULL OR COALESCE(pi.invoice_date, pi.created_at::date) >= p_start)
      AND (p_end   IS NULL OR COALESCE(pi.invoice_date, pi.created_at::date) <= p_end)
    GROUP BY pi.invoice_no
    ORDER BY MIN(pi.created_at) DESC
    LIMIT  GREATEST(COALESCE(p_limit, 20), 1)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_purchase_invoices_paginated(DATE, DATE, INT, INT)
    TO authenticated;


-- ============================================================
-- POST-VALIDATION (salt-okuma)
-- ============================================================
DO $post$
DECLARE
    v_src    TEXT;
    v_secdef BOOLEAN;
    v_cnt    INT;
BEGIN
    SELECT count(*) INTO v_cnt
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_purchase_invoices_paginated';
    IF v_cnt <> 1 THEN
        RAISE EXCEPTION '[070] FAIL: tek kanonik tanim bekleniyordu, % bulundu', v_cnt;
    END IF;

    SELECT pg_get_functiondef(p.oid), p.prosecdef INTO v_src, v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_purchase_invoices_paginated';

    IF v_src NOT LIKE '%(1 + COALESCE(pi.vat_rate, 0) / 100)%' THEN
        RAISE EXCEPTION '[070] FAIL: BRUT (satir-bazli KDV) ifadesi govdede yok';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION '[070] FAIL: SECURITY DEFINER degil';
    END IF;
    IF v_src NOT LIKE '%search_path%' THEN
        RAISE EXCEPTION '[070] FAIL: search_path SET edilmemis';
    END IF;
    IF NOT has_function_privilege('authenticated',
        'public.get_purchase_invoices_paginated(date,date,int,int)', 'EXECUTE') THEN
        RAISE EXCEPTION '[070] FAIL: authenticated EXECUTE grant eksik';
    END IF;

    RAISE NOTICE '[070] OK: total_amount artik BRUT (satir-bazli KDV); pagination/sort/tenant-isolation korundu.';
END;
$post$;
