-- ============================================================
-- 056 — CONCURRENT PURCHASE RACE HARDENING
--
-- Amac:
--   sync_raw_material_cost cagrilarini ayni raw_material icin
--   serialize et. Boylece concurrent purchase_items insert (iki
--   user paralel UI, veya UI + Excel import vs.) durumunda
--   raw_materials.cost "son alis fiyati" invariant'i bozulmaz.
--
-- Race senaryosu (056 oncesi):
--   T1 (created_at=.001, KOMPLEKS batch — trigger zinciri yavas)
--     INSERT purchase_items rm=X cost=100
--     sync(X): WAC=100 (T1 kendi insert'ini gorur)
--     UPDATE raw_materials.cost=100 → row-lock alir
--   T2 (created_at=.002, basit fatura — hizli)
--     INSERT purchase_items rm=X cost=150
--     sync(X): WAC=150 (T2 kendi insert'ini gorur)
--     UPDATE raw_materials.cost=150 → T1 lock'unu BEKLER
--   T2 commit ÖNCE? Hayir, lock'u alamiyor.
--   T1 commit → cost=100 yazildi, lock release
--   T2 lock alir → cost=150 yazar ✓
--
--   AMA: T1 KOMPLEKS, T2 BASIT senaryoda:
--     T1'in trigger zinciri uzar, T1 lock'u uzun tutar
--     T2 baska bir sirayla daha once basladi (eski created_at=.001)
--     T2 once commit etti (cost=T2'nin fiyati)
--     T1 simdi lock alir, KENDI ESKI WAC degerini yazar
--     Final cost = T1'in fiyati, ama newest created_at = T2'nin
--     → invariant bozuldu.
--
-- 056 cozum:
--   pg_advisory_xact_lock(hashtext('rm_cost:' || rm_id))
--   Lock alindiktan SONRA UPDATE statement fresh snapshot okur;
--   calculate_raw_material_wac diger transaction'larin commit'ini
--   gorur. Lock release sirasi != WAC hesap sirasi; her zaman
--   en yeni created_at'in fiyati yazilir.
--
-- Pattern:
--   - Lock acquisition O(1)
--   - Transaction-scope (COMMIT/ROLLBACK ile otomatik release)
--   - Re-entrant (ayni transaction tekrar alirsa sayac++; batch
--     icinde ayni RM cok kez sync edilse bile deadlock yok)
--   - Per-RM granular → farkli RM'ler engellenmiyor; throughput
--     ayni
--
-- Body'nin geri kalani 999_baseline.sql:2092-2108 ile bit bit AYNI.
--
-- Rollback:
--   999_baseline.sql:2092-2108'deki orijinal body'yi (PERFORM
--   advisory_lock satiri olmadan) Supabase SQL Editor'da tekrar RUN.
--   sync_raw_material_cost eski davranis geri gelir, advisory lock
--   release zaten otomatik (active xact yok). Frontend uyumlu kalir.
--
-- Idempotency:
--   CREATE OR REPLACE FUNCTION + DO bloku ile tekrar calistirilabilir.
-- ============================================================

CREATE OR REPLACE FUNCTION sync_raw_material_cost(p_raw_material_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public
AS $$
BEGIN
    IF p_raw_material_id IS NULL THEN
        RETURN;
    END IF;

    -- 056: Concurrent race koruma.
    -- Ayni RM icin sync_raw_material_cost cagrilari serialize edilir.
    -- Lock alindiktan sonra UPDATE fresh snapshot ile WAC okur;
    -- "son created_at" invariant'i (raw_materials.cost = newest
    -- purchase_items.base_unit_cost) bozulmaz.
    -- xact-scope → COMMIT/ROLLBACK ile otomatik release.
    -- Re-entrant → ayni transaction'da batch icinde ayni RM coklu
    -- sync icin deadlock yok.
    PERFORM pg_advisory_xact_lock(hashtext('rm_cost:' || p_raw_material_id::text));

    UPDATE raw_materials
    SET cost       = calculate_raw_material_wac(p_raw_material_id),
        updated_at = now()
    WHERE id = p_raw_material_id;
END;
$$;


-- ============================================================
-- POST-DEPLOY VALIDATION
-- Fail-fast: fonksiyon, hardening attribute'lari ve advisory lock
-- satiri varligini dogrular. Eksikse transaction roll-back.
-- ============================================================
DO $$
DECLARE
    v_src      TEXT;
    v_security TEXT;
    v_config   TEXT[];
BEGIN
    SELECT pg_get_functiondef(p.oid),
           CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END,
           p.proconfig
      INTO v_src, v_security, v_config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'sync_raw_material_cost';

    IF v_src IS NULL THEN
        RAISE EXCEPTION '[056] FAIL: sync_raw_material_cost bulunamadi';
    END IF;

    IF v_security IS DISTINCT FROM 'DEFINER' THEN
        RAISE EXCEPTION '[056] FAIL: SECURITY DEFINER degil (got: %)', v_security;
    END IF;

    IF v_config IS NULL OR NOT (v_config::text LIKE '%search_path%') THEN
        RAISE EXCEPTION '[056] FAIL: search_path SET edilmemis';
    END IF;

    IF v_src NOT LIKE '%pg_advisory_xact_lock%rm_cost:%' THEN
        RAISE EXCEPTION '[056] FAIL: advisory lock satiri eklenmemis';
    END IF;

    -- Trigger zincirinin sagligini dogrula (bozulmamis olmali)
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_purchase_items_cost_sync'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '[056] FAIL: trg_purchase_items_cost_sync trigger kayboldu';
    END IF;

    RAISE NOTICE '[056] OK: sync_raw_material_cost advisory lock aktif (per-RM, xact-scope) | %', v_security;
END;
$$;
