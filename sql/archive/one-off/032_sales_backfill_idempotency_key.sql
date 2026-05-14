-- ============================================================
-- 032 — SALES idempotency_key BACKFILL
--
-- Mevcut NULL idempotency_key'lere deterministik md5 hash uret.
-- Formul: tenant_id | date | total | cash | card | notes
--
-- Bu formul restore_full_backup (030) icindeki formul ile
-- BIREBIR AYNI -> ayni icerikli backup tekrar yuklendiginde
-- ON CONFLICT yakalar.
--
-- DIKKAT: 031'deki FULL UNIQUE constraint aktif. Eger ayni
-- composite key'e sahip 2+ kayit varsa UPDATE patlar.
-- Bu durumda once duplicate'lari temizle / soft-delete et.
-- Asagidaki TANI bloguna bak.
-- ============================================================


-- ============================================================
-- ADIM 0 — TANI: Olasi composite duplicate var mi?
-- ============================================================
DO $$
DECLARE
    v_dup INT;
BEGIN
    SELECT COUNT(*) INTO v_dup
    FROM (
        SELECT
            tenant_id, date, total,
            COALESCE(cash, 0) AS cash,
            COALESCE(card, 0) AS card,
            COALESCE(notes, '') AS notes,
            COUNT(*) AS c
        FROM public.sales
        WHERE idempotency_key IS NULL
        GROUP BY 1, 2, 3, 4, 5, 6
        HAVING COUNT(*) > 1
    ) t;

    IF v_dup > 0 THEN
        RAISE WARNING
            'DIKKAT: % adet composite-duplicate grubu bulundu. '
            'UPDATE patlayabilir. Once duplicate temizligi gerekli.',
            v_dup;
    ELSE
        RAISE NOTICE 'TANI OK: composite duplicate yok, backfill guvenli.';
    END IF;
END $$;


-- ============================================================
-- ADIM 1 — BACKFILL
-- ============================================================
UPDATE public.sales
SET idempotency_key = md5(
    tenant_id::text                    || '|' ||
    date::text                         || '|' ||
    COALESCE(total, 0)::text           || '|' ||
    COALESCE(cash, 0)::text            || '|' ||
    COALESCE(card, 0)::text            || '|' ||
    COALESCE(notes, '')
)
WHERE idempotency_key IS NULL;


-- ============================================================
-- ADIM 2 — DOGRULAMA
-- ============================================================
DO $$
DECLARE
    v_null_count INT;
    v_total      INT;
BEGIN
    SELECT COUNT(*) INTO v_null_count
    FROM public.sales
    WHERE idempotency_key IS NULL;

    SELECT COUNT(*) INTO v_total
    FROM public.sales;

    RAISE NOTICE 'Backfill sonucu: % / % satirin idempotency_key''i hala NULL',
                 v_null_count, v_total;

    IF v_null_count > 0 THEN
        RAISE WARNING 'NULL kayitlar kaldi. Backfill tam olmadi.';
    ELSE
        RAISE NOTICE 'OK: tum sales kayitlarinin idempotency_key''i dolu.';
    END IF;
END $$;
