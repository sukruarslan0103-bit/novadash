-- ============================================================
-- 079 — P1-F.3 MULTI-DISCOUNT STAGING INTEGRATION
-- ============================================================
-- Amaç:
--   Parser'ın ürettiği typed çoklu iskonto kanıtını import_lines'a yazmak.
--
-- Kapsam dışı (bilinçli):
--   import_commit_batch, purchase_items yazımı, review UI, RLS/policy ve canlı veri.
--
-- Güvenlik:
--   076-P1 import_stage_batch imzası, SECURITY DEFINER/search_path,
--   auth.uid(), aktif tenant, rate-limit, batch sınırı ve duplicate davranışı korunur.
-- ============================================================

BEGIN;

DO $preflight$
DECLARE
    v_column_count INTEGER;
BEGIN
    SELECT count(*)
      INTO v_column_count
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'import_lines'
       AND column_name IN (
           'discount_rates',
           'discount_calculation_method',
           'discount_parse_status',
           'effective_discount_rate',
           'line_discount_amount',
           'calculated_gross_amount',
           'calculated_net_amount',
           'discount_review_required'
       );

    IF v_column_count <> 8 THEN
        RAISE EXCEPTION '[079] 078 typed import_lines kolonları eksik (%/8 bulundu)',
            v_column_count;
    END IF;

    IF to_regprocedure('public.is_valid_discount_rates(numeric[])') IS NULL THEN
        RAISE EXCEPTION '[079] public.is_valid_discount_rates(numeric[]) bulunamadı; önce 078 uygulanmalı';
    END IF;
END;
$preflight$;


CREATE OR REPLACE FUNCTION public.import_stage_batch(
    p_meta  JSONB,
    p_lines JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_uid    UUID;
    v_tenant_id   UUID;

    v_source      TEXT;
    v_file_hash   TEXT;
    v_line_count  INT;
    v_batch_id    UUID;
    v_dup_warning BOOLEAN := false;

    v_inv_date    DATE;
    v_declared    NUMERIC;
    v_gd_amount   NUMERIC;
    v_gd_type     TEXT;
    v_parse_meta  JSONB;

    v_line        JSONB;
    v_line_no     INT;
    v_rates       NUMERIC[];
    v_rates_double DOUBLE PRECISION[];
    v_method      TEXT;
    v_parse_status TEXT;
    v_effective   NUMERIC;
    v_discount_amount NUMERIC;
    v_calc_gross  NUMERIC;
    v_calc_net    NUMERIC;
    v_review      BOOLEAN;
    v_has_typed   BOOLEAN;
    v_expected_effective NUMERIC;
    v_input_gross DOUBLE PRECISION;
    v_precise_net DOUBLE PRECISION;
    v_expected_gross_double DOUBLE PRECISION;
    v_expected_net_double DOUBLE PRECISION;
    v_expected_discount_double DOUBLE PRECISION;
    v_expected_effective_double DOUBLE PRECISION;
    v_rate_double DOUBLE PRECISION;
BEGIN
    -- AUTH + TENANT: 073/076 ile aynı auth.uid()/aktif kullanıcı sözleşmesi.
    v_auth_uid := auth.uid();
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT u.tenant_id INTO v_tenant_id
      FROM public.users u
     WHERE u.id = v_auth_uid
       AND u.is_active = true;

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: tenant not found or user disabled'
            USING ERRCODE = '42501';
    END IF;

    PERFORM public.check_rate_limit('import_stage');

    IF p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object' THEN
        RAISE EXCEPTION 'p_meta JSONB object olmali';
    END IF;
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
        RAISE EXCEPTION 'p_lines JSONB array olmali';
    END IF;

    v_line_count := jsonb_array_length(p_lines);
    IF v_line_count = 0 THEN
        RAISE EXCEPTION 'p_lines bos olamaz (en az 1 satir)';
    END IF;
    IF v_line_count > 2000 THEN
        RAISE EXCEPTION 'p_lines 2000 satiri asamaz (gelen: %). Cok faturali dosya ayri batch''lere bolunmeli.',
            v_line_count;
    END IF;

    v_source := p_meta->>'source_type';
    IF v_source IS NULL OR v_source NOT IN ('csv', 'xlsx') THEN
        RAISE EXCEPTION 'source_type gecersiz: % (v1 izinli: csv, xlsx)',
            COALESCE(v_source, 'NULL');
    END IF;

    -- Constraint mesajına düşmeden önce her typed satır için kontrollü ve
    -- line_no içeren doğrulama. Eski payload'larda alanlar yoksa NULL/false kalır.
    FOR v_line, v_line_no IN
        SELECT elem.value, elem.ord::INT
          FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS elem(value, ord)
    LOOP
        IF jsonb_typeof(v_line) <> 'object' THEN
            RAISE EXCEPTION 'p_lines[%] JSONB object olmali', v_line_no;
        END IF;

        v_rates := NULL;
        v_rates_double := NULL;
        v_method := NULLIF(v_line->>'discount_calculation_method', '');
        v_parse_status := NULLIF(v_line->>'discount_parse_status', '');
        v_effective := NULL;
        v_discount_amount := NULL;
        v_calc_gross := NULL;
        v_calc_net := NULL;
        v_input_gross := NULL;
        v_review := false;
        v_has_typed :=
            v_line ? 'discount_rates' OR
            v_line ? 'discount_calculation_method' OR
            v_line ? 'discount_parse_status' OR
            v_line ? 'effective_discount_rate' OR
            v_line ? 'line_discount_amount' OR
            v_line ? 'calculated_gross_amount' OR
            v_line ? 'calculated_net_amount' OR
            v_line ? 'calculation_input_gross_amount' OR
            v_line ? 'discount_review_required';

        IF v_line ? 'discount_rates' AND jsonb_typeof(v_line->'discount_rates') <> 'null' THEN
            IF jsonb_typeof(v_line->'discount_rates') <> 'array' THEN
                RAISE EXCEPTION 'p_lines[%].discount_rates JSON array olmali', v_line_no;
            END IF;
            IF jsonb_array_length(v_line->'discount_rates') NOT BETWEEN 1 AND 3 THEN
                RAISE EXCEPTION 'p_lines[%].discount_rates 1-3 oran icermeli', v_line_no;
            END IF;
            IF EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(v_line->'discount_rates') AS rate(value)
                 WHERE jsonb_typeof(rate.value) <> 'number'
            ) THEN
                RAISE EXCEPTION 'p_lines[%].discount_rates elemanlari JSON number olmali',
                    v_line_no;
            END IF;
            BEGIN
                SELECT
                    array_agg((rate.value #>> '{}')::NUMERIC ORDER BY rate.ord),
                    array_agg((rate.value #>> '{}')::DOUBLE PRECISION ORDER BY rate.ord)
                  INTO v_rates, v_rates_double
                  FROM jsonb_array_elements(v_line->'discount_rates')
                       WITH ORDINALITY AS rate(value, ord);
            EXCEPTION
                WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                    RAISE EXCEPTION 'p_lines[%].discount_rates yalniz finite NUMERIC oranlar icermeli',
                        v_line_no;
            END;
            IF NOT public.is_valid_discount_rates(v_rates) THEN
                RAISE EXCEPTION 'p_lines[%].discount_rates gecersiz (finite 0..100 ve en fazla 3 oran)',
                    v_line_no;
            END IF;
        END IF;

        IF v_line ? 'discount_calculation_method' AND
           jsonb_typeof(v_line->'discount_calculation_method') NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].discount_calculation_method string veya null olmali', v_line_no;
        END IF;
        IF v_method IS NOT NULL AND v_method NOT IN (
            'none', 'single', 'sequential', 'explicit_amount', 'derived_effective'
        ) THEN
            RAISE EXCEPTION 'p_lines[%].discount_calculation_method gecersiz: %',
                v_line_no, v_method;
        END IF;

        IF v_line ? 'discount_parse_status' AND
           jsonb_typeof(v_line->'discount_parse_status') NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].discount_parse_status string veya null olmali', v_line_no;
        END IF;
        IF v_parse_status IS NOT NULL AND v_parse_status NOT IN (
            'not_present', 'parsed', 'unsupported', 'ambiguous', 'mismatch'
        ) THEN
            RAISE EXCEPTION 'p_lines[%].discount_parse_status gecersiz: %',
                v_line_no, v_parse_status;
        END IF;

        IF v_has_typed AND (v_method IS NULL OR v_parse_status IS NULL) THEN
            RAISE EXCEPTION 'p_lines[%] typed iskonto payload method ve parse_status gerektirir',
                v_line_no;
        END IF;

        IF v_line ? 'effective_discount_rate' AND
           jsonb_typeof(v_line->'effective_discount_rate') NOT IN ('number', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].effective_discount_rate JSON number veya null olmali',
                v_line_no;
        END IF;
        IF v_line ? 'line_discount_amount' AND
           jsonb_typeof(v_line->'line_discount_amount') NOT IN ('number', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].line_discount_amount JSON number veya null olmali',
                v_line_no;
        END IF;
        IF v_line ? 'calculated_gross_amount' AND
           jsonb_typeof(v_line->'calculated_gross_amount') NOT IN ('number', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].calculated_gross_amount JSON number veya null olmali',
                v_line_no;
        END IF;
        IF v_line ? 'calculated_net_amount' AND
           jsonb_typeof(v_line->'calculated_net_amount') NOT IN ('number', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].calculated_net_amount JSON number veya null olmali',
                v_line_no;
        END IF;
        IF v_line ? 'calculation_input_gross_amount' AND
           jsonb_typeof(v_line->'calculation_input_gross_amount') NOT IN ('number', 'null') THEN
            RAISE EXCEPTION
                'p_lines[%].calculation_input_gross_amount JSON number veya null olmali',
                v_line_no;
        END IF;

        BEGIN
            IF v_line ? 'effective_discount_rate' AND
               jsonb_typeof(v_line->'effective_discount_rate') <> 'null' THEN
                v_effective := NULLIF(v_line->>'effective_discount_rate', '')::NUMERIC;
            END IF;
            IF v_line ? 'line_discount_amount' AND
               jsonb_typeof(v_line->'line_discount_amount') <> 'null' THEN
                v_discount_amount := NULLIF(v_line->>'line_discount_amount', '')::NUMERIC;
            END IF;
            IF v_line ? 'calculated_gross_amount' AND
               jsonb_typeof(v_line->'calculated_gross_amount') <> 'null' THEN
                v_calc_gross := NULLIF(v_line->>'calculated_gross_amount', '')::NUMERIC;
            END IF;
            IF v_line ? 'calculated_net_amount' AND
               jsonb_typeof(v_line->'calculated_net_amount') <> 'null' THEN
                v_calc_net := NULLIF(v_line->>'calculated_net_amount', '')::NUMERIC;
            END IF;
        EXCEPTION
            WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                RAISE EXCEPTION 'p_lines[%] typed iskonto tutar/oran alanlari NUMERIC olmali',
                    v_line_no;
        END;

        BEGIN
            IF v_line ? 'calculation_input_gross_amount' AND
               jsonb_typeof(v_line->'calculation_input_gross_amount') <> 'null' THEN
                v_input_gross :=
                    NULLIF(v_line->>'calculation_input_gross_amount', '')::DOUBLE PRECISION;
            END IF;
        EXCEPTION
            WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                RAISE EXCEPTION
                    'p_lines[%].calculation_input_gross_amount finite DOUBLE PRECISION olmali',
                    v_line_no;
        END;

        IF v_effective IS NOT NULL AND (
            v_effective IN ('NaN'::NUMERIC, 'Infinity'::NUMERIC, '-Infinity'::NUMERIC) OR
            v_effective < 0 OR v_effective > 100
        ) THEN
            RAISE EXCEPTION 'p_lines[%].effective_discount_rate finite 0..100 olmali', v_line_no;
        END IF;
        IF v_discount_amount IS NOT NULL AND (
            v_discount_amount IN ('NaN'::NUMERIC, 'Infinity'::NUMERIC, '-Infinity'::NUMERIC) OR
            v_discount_amount < 0 OR
            v_discount_amount > 99999999999999.9999
        ) THEN
            RAISE EXCEPTION
                'p_lines[%].line_discount_amount finite ve 0..99999999999999.9999 araliginda olmali',
                v_line_no;
        END IF;
        IF v_calc_gross IS NOT NULL AND (
            v_calc_gross IN ('NaN'::NUMERIC, 'Infinity'::NUMERIC, '-Infinity'::NUMERIC) OR
            v_calc_gross < 0 OR
            v_calc_gross > 99999999999999.9999
        ) THEN
            RAISE EXCEPTION
                'p_lines[%].calculated_gross_amount finite ve 0..99999999999999.9999 araliginda olmali',
                v_line_no;
        END IF;
        IF v_calc_net IS NOT NULL AND (
            v_calc_net IN ('NaN'::NUMERIC, 'Infinity'::NUMERIC, '-Infinity'::NUMERIC) OR
            v_calc_net < 0 OR
            v_calc_net > 99999999999999.9999
        ) THEN
            RAISE EXCEPTION
                'p_lines[%].calculated_net_amount finite ve 0..99999999999999.9999 araliginda olmali',
                v_line_no;
        END IF;
        IF v_input_gross IS NOT NULL AND (
            v_input_gross IN (
                'NaN'::DOUBLE PRECISION,
                'Infinity'::DOUBLE PRECISION,
                '-Infinity'::DOUBLE PRECISION
            ) OR
            v_input_gross < 0
        ) THEN
            RAISE EXCEPTION
                'p_lines[%].calculation_input_gross_amount finite ve negatif olmayan DOUBLE PRECISION olmali',
                v_line_no;
        END IF;
        IF v_calc_gross IS NOT NULL AND v_calc_net IS NOT NULL AND
           v_calc_net > v_calc_gross + 0.01 THEN
            RAISE EXCEPTION 'p_lines[%] calculated_net_amount gross tutari asamaz', v_line_no;
        END IF;

        IF v_line ? 'discount_review_required' AND
           jsonb_typeof(v_line->'discount_review_required') NOT IN ('boolean', 'null') THEN
            RAISE EXCEPTION 'p_lines[%].discount_review_required boolean veya null olmali', v_line_no;
        END IF;
        IF jsonb_typeof(v_line->'discount_review_required') = 'boolean' THEN
            v_review := (v_line->>'discount_review_required')::BOOLEAN;
        END IF;

        IF v_method = 'single' AND (v_rates IS NULL OR cardinality(v_rates) <> 1) THEN
            RAISE EXCEPTION 'p_lines[%] single method tam bir discount_rate gerektirir', v_line_no;
        ELSIF v_method = 'sequential' AND (v_rates IS NULL OR cardinality(v_rates) NOT BETWEEN 2 AND 3) THEN
            RAISE EXCEPTION 'p_lines[%] sequential method 2-3 discount_rate gerektirir', v_line_no;
        ELSIF v_method = 'explicit_amount' AND v_discount_amount IS NULL THEN
            RAISE EXCEPTION 'p_lines[%] explicit_amount method line_discount_amount gerektirir', v_line_no;
        ELSIF v_method = 'derived_effective' AND v_effective IS NULL THEN
            RAISE EXCEPTION 'p_lines[%] derived_effective method effective_discount_rate gerektirir', v_line_no;
        ELSIF v_method = 'none' AND v_rates IS NOT NULL AND NOT (
            cardinality(v_rates) = 1 AND v_rates[1] = 0
        ) THEN
            RAISE EXCEPTION 'p_lines[%] none method iskonto oran dizisi tasiyamaz', v_line_no;
        END IF;

        IF v_has_typed AND v_parse_status = 'parsed' AND v_review THEN
            RAISE EXCEPTION 'p_lines[%] parsed discount_parse_status review_required=false gerektirir',
                v_line_no;
        ELSIF v_has_typed AND v_parse_status = 'not_present' AND (
            v_method IS DISTINCT FROM 'none' OR v_review
        ) THEN
            RAISE EXCEPTION
                'p_lines[%] not_present discount_parse_status none method ve review_required=false gerektirir',
                v_line_no;
        ELSIF v_parse_status IN ('unsupported', 'ambiguous', 'mismatch') AND NOT v_review THEN
            RAISE EXCEPTION 'p_lines[%] % discount_parse_status review_required=true gerektirir',
                v_line_no, v_parse_status;
        END IF;

        IF v_has_typed AND v_parse_status = 'parsed' AND
           v_method IN ('single', 'sequential', 'explicit_amount', 'derived_effective') AND (
               v_calc_gross IS NULL OR
               v_calc_net IS NULL OR
               v_discount_amount IS NULL OR
               v_effective IS NULL
           ) THEN
            RAISE EXCEPTION
                'p_lines[%] parsed % method gross/net/discount/effective kanitlarinin tamamini gerektirir',
                v_line_no, v_method;
        END IF;
        IF v_has_typed AND v_parse_status = 'parsed' AND
           v_method IN ('single', 'sequential') AND v_input_gross IS NULL THEN
            RAISE EXCEPTION
                'p_lines[%] parsed % method calculation_input_gross_amount kaniti gerektirir',
                v_line_no, v_method;
        END IF;

        -- Parser kanonik para alanlarını iki, effective rate'i dört ondalıkta
        -- üretir. Audit statülerindeki ham kanıt bu parsed-only kurala bağlanmaz.
        IF v_has_typed AND v_parse_status = 'parsed' AND (
               (v_calc_gross IS NOT NULL AND round(v_calc_gross, 2) <> v_calc_gross) OR
               (v_calc_net IS NOT NULL AND round(v_calc_net, 2) <> v_calc_net) OR
               (v_discount_amount IS NOT NULL AND round(v_discount_amount, 2) <> v_discount_amount) OR
               (v_effective IS NOT NULL AND round(v_effective, 4) <> v_effective)
           ) THEN
            RAISE EXCEPTION
                'p_lines[%] parsed money alanlari 2, effective rate 4 ondalik hassasiyette olmali',
                v_line_no;
        END IF;

        -- Gross'u aşan iskonto yalnız parser'ın eksiksiz mismatch/audit
        -- şeklinde kabul edilir; tutar kanıtı korunur, net/rate tahmin edilmez.
        IF v_calc_gross IS NOT NULL AND v_discount_amount IS NOT NULL AND
           v_discount_amount > v_calc_gross AND (
               v_parse_status IS DISTINCT FROM 'mismatch' OR
               NOT v_review OR
               v_calc_net IS NOT NULL OR
               v_effective IS NOT NULL
           ) THEN
            RAISE EXCEPTION
                'p_lines[%] gross asimi yalniz mismatch/review ve null net/effective audit seklinde kabul edilir',
                v_line_no;
        END IF;

        -- Her operand önce NUMERIC(18,4) storage sonucuna yuvarlanır. Böylece
        -- validation, INSERT sonrasında gerçekten saklanacak para değerleriyle
        -- aynı gross = net + discount invariantını uygular.
        IF v_parse_status = 'parsed' AND
           v_calc_gross IS NOT NULL AND
           v_calc_net IS NOT NULL AND
           v_discount_amount IS NOT NULL AND
           round(v_calc_gross, 4) <>
               round(round(v_calc_net, 4) + round(v_discount_amount, 4), 4) THEN
            RAISE EXCEPTION
                'p_lines[%] parsed storage tutarlari gross = net + discount invariantini saglamali',
                v_line_no;
        END IF;

        -- Effective rate, saklanacak gross ve discount tutarlarından türetilir.
        -- Storage gross'u sıfırsa division yapılmaz ve parsed sonuç reddedilir.
        IF v_parse_status = 'parsed' AND
           v_calc_gross IS NOT NULL AND
           v_discount_amount IS NOT NULL AND
           v_effective IS NOT NULL THEN
            IF round(v_calc_gross, 4) = 0 THEN
                RAISE EXCEPTION
                    'p_lines[%] parsed effective rate icin storage gross sifirdan buyuk olmali',
                    v_line_no;
            END IF;
            v_expected_effective := round(
                round(v_discount_amount, 4) / round(v_calc_gross, 4) * 100,
                4
            );
            IF round(v_effective, 4) <> v_expected_effective THEN
                RAISE EXCEPTION
                    'p_lines[%] effective_discount_rate storage gross/discount tutarlariyla uyusmali',
                    v_line_no;
            END IF;
        END IF;

        -- Parser'ın yuvarlanmamış finite gross kanıtı ve oranlar DOUBLE PRECISION
        -- olarak JavaScript Number işlem sırasıyla yeniden hesaplanır. Ara net
        -- yuvarlanmaz; para/effective sonuçları parser algoritmasıyla doğrulanır.
        IF v_parse_status = 'parsed' AND v_method IN ('single', 'sequential') THEN
            v_precise_net := v_input_gross;
            FOREACH v_rate_double IN ARRAY v_rates_double
            LOOP
                v_precise_net := v_precise_net * (1.0 - v_rate_double / 100.0);
            END LOOP;

            v_expected_gross_double := floor(
                ((v_input_gross + 2.220446049250313e-16::DOUBLE PRECISION) * 100.0) + 0.5
            ) / 100.0;
            v_expected_net_double := floor(
                ((v_precise_net + 2.220446049250313e-16::DOUBLE PRECISION) * 100.0) + 0.5
            ) / 100.0;
            v_expected_discount_double := floor(
                (((v_expected_gross_double - v_expected_net_double) +
                  2.220446049250313e-16::DOUBLE PRECISION) * 100.0) + 0.5
            ) / 100.0;
            v_expected_effective_double := CASE
                WHEN v_expected_gross_double = 0 THEN 0.0
                ELSE floor(
                    (((v_expected_discount_double / v_expected_gross_double * 100.0) +
                      2.220446049250313e-16::DOUBLE PRECISION) * 10000.0) + 0.5
                ) / 10000.0
            END;

            IF v_calc_gross::DOUBLE PRECISION IS DISTINCT FROM v_expected_gross_double OR
               v_calc_net::DOUBLE PRECISION IS DISTINCT FROM v_expected_net_double OR
               v_discount_amount::DOUBLE PRECISION IS DISTINCT FROM v_expected_discount_double OR
               v_effective::DOUBLE PRECISION IS DISTINCT FROM v_expected_effective_double THEN
                RAISE EXCEPTION
                    'p_lines[%] parsed % method precise gross/rates JavaScript kanonik sonucuyla birebir uyusmali',
                    v_line_no, v_method;
            END IF;
        END IF;

        IF v_has_typed AND v_method = 'none' AND
           v_parse_status IN ('parsed', 'not_present') AND (
               v_effective IS NULL OR round(v_effective, 4) <> 0 OR
               v_discount_amount IS NULL OR round(v_discount_amount, 4) <> 0 OR
               (
                   v_rates IS NOT NULL AND NOT (
                       cardinality(v_rates) = 1 AND round(v_rates[1], 4) = 0
                   )
               ) OR
               (
                   v_calc_gross IS NOT NULL AND v_calc_net IS NOT NULL AND
                   round(v_calc_gross, 4) <> round(v_calc_net, 4)
               )
           ) THEN
            RAISE EXCEPTION
                'p_lines[%] none method rate/effective/discount sifir ve storage gross=net olmali',
                v_line_no;
        END IF;

        -- Promotion farklı method yollarından üretilebilir; ortak kanonik şekil
        -- parsed, review=false, pozitif gross, net=0, discount=gross ve rate=100'dür.
        -- Typed alanı olmayan legacy promotion satırları bu bloktan muaftır.
        IF v_has_typed AND NULLIF(v_line->>'line_type', '') = 'promotion' AND (
               v_parse_status IS DISTINCT FROM 'parsed' OR
               v_review OR
               v_calc_gross IS NULL OR
               v_calc_gross <= 0 OR
               v_calc_net IS DISTINCT FROM 0 OR
               v_discount_amount IS DISTINCT FROM v_calc_gross OR
               v_effective IS DISTINCT FROM 100
           ) THEN
            RAISE EXCEPTION
                'p_lines[%] typed promotion parsed/review=false ve gross=discount, net=0, effective=100 olmali',
                v_line_no;
        END IF;

        IF v_has_typed AND
           v_parse_status = 'parsed' AND
           NOT v_review AND
           v_calc_gross > 0 AND
           v_calc_net = 0 AND
           v_discount_amount = v_calc_gross AND
           v_effective = 100 AND
           NULLIF(v_line->>'line_type', '') IS DISTINCT FROM 'promotion' THEN
            RAISE EXCEPTION
                'p_lines[%] kanonik sifir-net sonucu line_type=promotion gerektirir',
                v_line_no;
        END IF;
    END LOOP;

    v_file_hash := NULLIF(p_meta->>'file_hash', '');
    v_inv_date  := NULLIF(p_meta->>'invoice_date', '')::DATE;
    v_declared  := NULLIF(p_meta->>'declared_total', '')::NUMERIC;
    v_gd_amount := COALESCE(NULLIF(p_meta->>'general_discount_amount', '')::NUMERIC, 0);
    v_gd_type   := NULLIF(p_meta->>'general_discount_type', '');

    v_parse_meta :=
        COALESCE(p_meta->'parse_meta', '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
               'sheet_name',          p_meta->'sheet_name',
               'delimiter',           p_meta->'delimiter',
               'encoding',            p_meta->'encoding',
               'detected_header_row', p_meta->'detected_header_row',
               'column_mapping',      p_meta->'column_mapping'
           ));

    IF v_file_hash IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1
              FROM public.import_batches b
             WHERE b.tenant_id = v_tenant_id
               AND b.file_hash = v_file_hash
        ) INTO v_dup_warning;
    END IF;

    INSERT INTO public.import_batches (
        tenant_id, created_by, source_type, original_filename,
        file_ref, file_hash, supplier_raw_text,
        invoice_external_no, invoice_date, declared_total,
        general_discount_amount, general_discount_type,
        status, raw_payload, parse_meta
    ) VALUES (
        v_tenant_id,
        v_auth_uid,
        v_source,
        NULLIF(p_meta->>'original_filename', ''),
        NULLIF(p_meta->>'file_ref', ''),
        v_file_hash,
        NULLIF(p_meta->>'supplier_raw_text', ''),
        NULLIF(p_meta->>'invoice_external_no', ''),
        v_inv_date,
        v_declared,
        v_gd_amount,
        v_gd_type,
        'parsed',
        NULL,
        v_parse_meta
    )
    RETURNING id INTO v_batch_id;

    INSERT INTO public.import_lines (
        tenant_id, batch_id, line_no,
        raw_name, raw_product_code, raw_qty, raw_unit, raw_unit_price,
        raw_vat, raw_vat_amount, raw_discount, raw_discount_amount, raw_line_total,
        source_line_basis, line_type,
        discount_rates, discount_calculation_method, discount_parse_status,
        effective_discount_rate, line_discount_amount,
        calculated_gross_amount, calculated_net_amount, discount_review_required
    )
    SELECT
        v_tenant_id,
        v_batch_id,
        elem.ord,
        NULLIF(elem.value->>'raw_name', ''),
        NULLIF(elem.value->>'raw_product_code', ''),
        NULLIF(elem.value->>'raw_qty', ''),
        NULLIF(elem.value->>'raw_unit', ''),
        NULLIF(elem.value->>'raw_unit_price', ''),
        NULLIF(elem.value->>'raw_vat', ''),
        NULLIF(elem.value->>'raw_vat_amount', ''),
        NULLIF(elem.value->>'raw_discount', ''),
        NULLIF(elem.value->>'raw_discount_amount', ''),
        NULLIF(elem.value->>'raw_line_total', ''),
        NULLIF(elem.value->>'source_line_basis', ''),
        NULLIF(elem.value->>'line_type', ''),
        CASE
            WHEN elem.value->'discount_rates' IS NULL OR
                 jsonb_typeof(elem.value->'discount_rates') = 'null' THEN NULL
            ELSE ARRAY(
                SELECT (rate.value #>> '{}')::NUMERIC
                  FROM jsonb_array_elements(elem.value->'discount_rates')
                       WITH ORDINALITY AS rate(value, ord)
                 ORDER BY rate.ord
            )
        END,
        NULLIF(elem.value->>'discount_calculation_method', ''),
        NULLIF(elem.value->>'discount_parse_status', ''),
        NULLIF(elem.value->>'effective_discount_rate', '')::NUMERIC,
        NULLIF(elem.value->>'line_discount_amount', '')::NUMERIC,
        NULLIF(elem.value->>'calculated_gross_amount', '')::NUMERIC,
        NULLIF(elem.value->>'calculated_net_amount', '')::NUMERIC,
        COALESCE(NULLIF(elem.value->>'discount_review_required', '')::BOOLEAN, false)
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS elem(value, ord);

    RETURN jsonb_build_object(
        'ok',                true,
        'batch_id',          v_batch_id,
        'line_count',        v_line_count,
        'duplicate_warning', v_dup_warning,
        'file_hash',         v_file_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.import_stage_batch(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_stage_batch(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.import_stage_batch(jsonb, jsonb) TO authenticated;

COMMIT;

-- Bu migration repository'de hazırlanmıştır; canlıya otomatik uygulanmaz.
