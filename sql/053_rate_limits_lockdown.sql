-- ============================================================
-- 053 — RATE_LIMITS LOCKDOWN (internal-only system table)
--
-- Amac:
--   public.rate_limits tablosunda RLS yok ve authenticated rolune
--   tam table-level grant aciktti (Section I.3 default pattern).
--   Bu drift su saldiri yuzeylerini olusturuyordu:
--     A1) SELECT * → cross-tenant rate-limit metadata enumeration
--     A2) DELETE WHERE user_id = self → kendi cooldown'unu sifirla
--     A3) UPDATE SET last_call_at = '1970-01-01' → tum cooldown bypass
--     A4) DELETE WHERE tenant_id = '<TA>' → cross-tenant DoS bypass
--
--   rate_limits tamamen INTERNAL bir system table'dir:
--     - Sadece check_rate_limit SECURITY DEFINER fonksiyonu erişir.
--     - Frontend hic dokunmaz (services/ ve views/ taramasi = 0 hit).
--     - check_rate_limit owner=postgres → RLS bypass eder.
--
-- Cozum (SECENEK C — defense-in-depth):
--   1) ENABLE ROW LEVEL SECURITY
--   2) RESTRICTIVE DENY ALL policy (authenticated + anon icin)
--   3) REVOKE ALL ON TABLE FROM authenticated, anon, PUBLIC
--
-- check_rate_limit etkilenmez:
--   - SECURITY DEFINER + owner=postgres
--   - postgres RLS bypass (FORCE ROW LEVEL SECURITY KULLANILMIYOR)
--   - postgres ownership ile table privilege ihtiyaci yok
--
-- KRITIK — FORCE ROW LEVEL SECURITY KULLANMA:
--   FORCE flag table owner'i (postgres) bile RLS'e tabi yapar.
--   DENY ALL policy ile birlesince check_rate_limit DEFINER bile
--   patlardi. Sadece ENABLE yeterli.
--
-- KAPSAM DISI:
--   - check_rate_limit function body (dokunulmuyor)
--   - Diger rate_limits cagrici DEFINER fonklar (soft_delete_record,
--     create_purchase_and_update_product_cost, update_expense, vb.)
--
-- Idempotent:
--   - ALTER TABLE ENABLE/DISABLE RLS idempotent (re-run safe)
--   - DROP POLICY IF EXISTS + CREATE POLICY pattern
--   - REVOKE IF EXISTS davranisi (PG zaten no-op verir)
--
-- Rollback:
--   Tek script ile <5sn:
--     ALTER TABLE public.rate_limits DISABLE ROW LEVEL SECURITY;
--     DROP POLICY IF EXISTS rate_limits_deny_all ON public.rate_limits;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limits TO authenticated;
--   Veri kaybi sifir.
-- ============================================================


-- ============================================================
-- PRE-FLIGHT
-- ============================================================
DO $pre$
DECLARE
    v_table_exists    BOOLEAN;
    v_rls_before      BOOLEAN;
    v_auth_can_select BOOLEAN;
    v_policy_count    INT;
BEGIN
    -- 1) Tablo mevcut mu?
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name   = 'rate_limits'
    ) INTO v_table_exists;

    IF NOT v_table_exists THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: public.rate_limits tablosu YOK';
    END IF;

    -- 2) RLS state (drift confirmation)
    SELECT rowsecurity INTO v_rls_before
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename  = 'rate_limits';

    -- 3) authenticated yetki (drift confirmation)
    v_auth_can_select := has_table_privilege('authenticated', 'public.rate_limits', 'SELECT');

    -- 4) Mevcut policy sayisi
    SELECT count(*) INTO v_policy_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'rate_limits';

    RAISE NOTICE '[053] PRE-FLIGHT: rls_before=%, auth_can_select=%, existing_policies=%',
        v_rls_before, v_auth_can_select, v_policy_count;

    -- 5) check_rate_limit fonksiyonu mevcut + SECURITY DEFINER mi?
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'check_rate_limit'
          AND p.prosecdef = true
    ) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAIL: check_rate_limit SECURITY DEFINER bulunamadi (lockdown sonrasi rate-limit zincirini kirardi)';
    END IF;

    RAISE NOTICE '[053] PRE-FLIGHT OK';
END $pre$;


-- ============================================================
-- 1) ENABLE ROW LEVEL SECURITY
--    (FORCE kullanilmiyor — DEFINER bypass'in korunmasi icin)
-- ============================================================
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- 2) RESTRICTIVE DENY ALL POLICY
--    USING (false) + WITH CHECK (false) → tum SELECT/INSERT/UPDATE/DELETE
--    authenticated ve anon icin reddedilir.
--    RESTRICTIVE modifier: baska permissive policy'lerle birleşirse
--    bile DENY kazanir.
-- ============================================================
DROP POLICY IF EXISTS rate_limits_deny_all ON public.rate_limits;

CREATE POLICY rate_limits_deny_all
    ON public.rate_limits
    AS RESTRICTIVE
    FOR ALL
    TO authenticated, anon
    USING (false)
    WITH CHECK (false);


-- ============================================================
-- 3) REVOKE TABLE PRIVILEGES (defense-in-depth)
--    Section I.3 default GRANT pattern'i rate_limits'e de inebilir;
--    burada explicit revoke ile garanti.
-- ============================================================
REVOKE ALL ON TABLE public.rate_limits FROM authenticated;
REVOKE ALL ON TABLE public.rate_limits FROM anon;
REVOKE ALL ON TABLE public.rate_limits FROM PUBLIC;


-- ============================================================
-- POST-VALIDATION
-- ============================================================
DO $val$
DECLARE
    v_rls_after         BOOLEAN;
    v_force_rls         BOOLEAN;
    v_policy_present    BOOLEAN;
    v_policy_restrictive BOOLEAN;
    v_policy_cmd        TEXT;
    v_policy_qual       TEXT;
    v_policy_check      TEXT;

    v_auth_select       BOOLEAN;
    v_auth_insert       BOOLEAN;
    v_auth_update       BOOLEAN;
    v_auth_delete       BOOLEAN;

    v_anon_select       BOOLEAN;

    v_definer_present   BOOLEAN;
BEGIN
    RAISE NOTICE '[053] POST-VALIDATION: starting...';

    -- 1) RLS enabled mi? FORCE kapali mi?
    SELECT rowsecurity, relforcerowsecurity
      INTO v_rls_after, v_force_rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'rate_limits';

    IF NOT v_rls_after THEN
        RAISE EXCEPTION 'KRITIK: RLS aktif degil';
    END IF;

    IF v_force_rls THEN
        RAISE EXCEPTION 'KRITIK: FORCE RLS aktif — DEFINER fonksiyonlar patlar!';
    END IF;

    -- 2) DENY ALL policy var ve RESTRICTIVE mi?
    SELECT TRUE,
           (permissive = 'RESTRICTIVE'),
           cmd::text,
           qual::text,
           with_check::text
      INTO v_policy_present, v_policy_restrictive, v_policy_cmd, v_policy_qual, v_policy_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'rate_limits'
       AND policyname = 'rate_limits_deny_all';

    IF NOT v_policy_present THEN
        RAISE EXCEPTION 'KRITIK: rate_limits_deny_all policy YOK';
    END IF;

    IF NOT v_policy_restrictive THEN
        RAISE EXCEPTION 'KRITIK: policy RESTRICTIVE degil (permissive policylerle birleşince bypass mumkun)';
    END IF;

    IF v_policy_qual NOT LIKE '%false%' OR v_policy_check NOT LIKE '%false%' THEN
        RAISE EXCEPTION 'KRITIK: policy USING/WITH CHECK false degil (qual=%, check=%)',
            v_policy_qual, v_policy_check;
    END IF;

    -- 3) authenticated tam yetkiden temiz mi?
    v_auth_select := has_table_privilege('authenticated', 'public.rate_limits', 'SELECT');
    v_auth_insert := has_table_privilege('authenticated', 'public.rate_limits', 'INSERT');
    v_auth_update := has_table_privilege('authenticated', 'public.rate_limits', 'UPDATE');
    v_auth_delete := has_table_privilege('authenticated', 'public.rate_limits', 'DELETE');

    IF v_auth_select OR v_auth_insert OR v_auth_update OR v_auth_delete THEN
        RAISE EXCEPTION 'KRITIK: authenticated hala table privilege''lere sahip (S=%, I=%, U=%, D=%)',
            v_auth_select, v_auth_insert, v_auth_update, v_auth_delete;
    END IF;

    -- 4) anon temiz mi?
    v_anon_select := has_table_privilege('anon', 'public.rate_limits', 'SELECT');
    IF v_anon_select THEN
        RAISE EXCEPTION 'KRITIK: anon hala SELECT yetkisine sahip';
    END IF;

    -- 5) check_rate_limit hala DEFINER mi? (kritik — yoksa rate-limit zinciri kirilir)
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'check_rate_limit'
          AND p.prosecdef = true
    ) INTO v_definer_present;

    IF NOT v_definer_present THEN
        RAISE EXCEPTION 'KRITIK: check_rate_limit DEFINER kayboldu';
    END IF;

    RAISE NOTICE '[053] VALIDATION: RLS=ENABLED, FORCE=OFF (DEFINER bypass korunur)';
    RAISE NOTICE '[053] VALIDATION: rate_limits_deny_all RESTRICTIVE policy aktif';
    RAISE NOTICE '[053] VALIDATION: authenticated/anon table privileges = 0';
    RAISE NOTICE '[053] VALIDATION: check_rate_limit SECURITY DEFINER korundu';
    RAISE NOTICE 'OK: 053 rate_limits lockdown applied — internal-only access enforced';
END $val$;
