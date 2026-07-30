/* ============================================================
   IMPORT PARSERS — FAZ 2.1 / 073-B
   CSV + XLSX → tek standart kontrat (batchMeta + rawLines + preview)

   SAF KATMAN:
     - RPC cagirmaz, Supabase import etmez, DOM'a dokunmaz, modal acmaz.
     - Yalnizca File → parse sonucu uretir.
     - Cikti import_stage_batch(p_meta, p_lines) RPC'sine (073-A) beslenecek
       sekilde tasarlanmistir; ama bu dosya RPC'yi CAGIRMAZ.

   BAGIMLILIK: yalnizca mevcut SheetJS (global `XLSX`). Yeni dependency yok.

   raw_* FELSEFESI (072 immutability ile uyumlu):
     raw_* alanlari "parser NE GORDU"nun kanitidir → hucrenin ORIJINAL metni
     korunur (TR sayi formati "1.250,50" normalize EDILMEZ, ham kalir).
     Normalize gelecekte matching/commit asamasinda yapilir; bu katman
     yardimci olarak normalizeImportNumber'i DISARI ACAR ama raw_*'a UYGULAMAZ.
   ============================================================ */

window.ImportParsers = (function () {
    'use strict';

    // ------------------------------------------------------------
    // Turkce es anlamli basliklar (normalize edilmis halleriyle eslesir)
    // Sira ONEMLI: bilesik/spesifik alanlar (unit_price, line_total) genel
    // alanlardan (unit) ONCE denenir — "birim fiyat" vs "birim" carismasi.
    // ------------------------------------------------------------
    var SYNONYMS = {
        raw_product_code: ['urun kodu', 'mal hizmet kodu', 'malzeme hizmet kodu', 'stok kodu',
                           'malzeme kodu', 'kod1', 'kod'],
        raw_name:          ['urun', 'urun adi', 'malzeme', 'malzeme adi', 'aciklama', 'stok', 'stok adi', 'kalem', 'mal',
                            'hizmet', 'cinsi', 'ham urun adi', 'mal hizmet', 'mal aciklamasi', 'urun hizmet'],
        raw_discount_amount: ['iskonto tutari', 'iskonto artirim tutari', 'indirim tutari', 'isk tutari'],
        raw_vat_amount:    ['kdv tutari', 'hesaplanan kdv tutari', 'vergi tutari'],
        // Finansal tutar alanlari kontrollu/exact eslesir. Ozellikle yalniz
        // "tutar" substring'i KDV/iskonto tutari kolonlarini yutamaz.
        raw_line_total:    ['mal hizmet tutari', 'malzeme hizmet tutari', 'satir tutari', 'brut tutar', 'net tutar', 'tutar',
                            'toplam', 'ara toplam', 'satir toplam', 'satir net', 'line total', 'kdv haric tutar'],
        raw_unit_price:    ['birim fiyat', 'birim fiyati', 'fiyat', 'alis fiyati', 'alis fiyat', 'b fiyat', 'bfiyat', 'birim tutar'],
        raw_qty:           ['miktar', 'adet', 'qty', 'quantity', 'mik'],
        raw_vat:           ['kdv orani', 'kdv yuzdesi', 'kdv', 'vat', 'kdv %'],
        raw_discount_1:    ['iskonto 1', 'indirim 1'],
        raw_discount_2:    ['iskonto 2', 'indirim 2'],
        raw_discount_3:    ['iskonto 3', 'indirim 3'],
        raw_discount:      ['iskonto orani', 'iskonto artirim orani', 'isk or', 'iskonto yuzdesi', 'indirim orani',
                            'iskonto', 'indirim', 'discount', 'isk', 'isk %', 'indirim %'],
        raw_unit:          ['birim', 'unit', 'olcu', 'olcu birimi', 'birimi']
    };

    // Exact-only alanlar, finansal anlamı belirsiz genis substring eslesmesini
    // engeller. Eski basliklar synonym listelerinde exact olarak korunur.
    var EXACT_ONLY_FIELDS = {
        raw_product_code: true,
        raw_discount_amount: true,
        raw_vat_amount: true,
        raw_line_total: true,
        raw_vat: true,
        raw_discount_1: true,
        raw_discount_2: true,
        raw_discount_3: true,
        raw_discount: true
    };

    // Alan oncelik sirasi: spesifik finansal alanlar genel alanlardan once.
    var FIELD_ORDER = [
        'raw_product_code', 'raw_discount_amount', 'raw_vat_amount', 'raw_line_total',
        'raw_unit_price', 'raw_qty', 'raw_vat', 'raw_discount_1', 'raw_discount_2',
        'raw_discount_3', 'raw_discount', 'raw_unit', 'raw_name'
    ];

    var SOURCE_FIELDS = [
        'raw_name', 'raw_product_code', 'raw_qty', 'raw_unit', 'raw_unit_price',
        'raw_vat', 'raw_vat_amount', 'raw_discount', 'raw_discount_1', 'raw_discount_2',
        'raw_discount_3', 'raw_discount_amount', 'raw_line_total'
    ];
    var DISCOUNT_TYPED_FIELDS = [
        'discount_rates', 'discount_calculation_method', 'discount_parse_status',
        'effective_discount_rate', 'line_discount_amount', 'calculated_gross_amount',
        'calculated_net_amount', 'calculation_input_gross_amount',
        'discount_review_required'
    ];
    var RAW_FIELDS = SOURCE_FIELDS.concat(['source_line_basis', 'line_type']).concat(DISCOUNT_TYPED_FIELDS);

    var PREVIEW_ROW_LIMIT = 20;
    var SOFT_ROW_LIMIT     = 2000;  // RPC hard limit; parser yalnizca UYARIR

    // ============================================================
    // normalizeHeader — TR-aware baslik normalize (locale-bagimsiz)
    //   İ→i, I→ı translate (lower() locale tuzagini onler), punctuation→bosluk,
    //   collapse + trim. Ic boslugu KORUR ("birim fiyat" bozulmaz).
    // ============================================================
    function normalizeHeader(value) {
        if (value == null) return '';
        var s = String(value);
        // TR buyuk harf elle indir (DB normalize_tr_text ile ayni mantik)
        s = s.replace(/İ/g, 'i').replace(/I/g, 'ı')
             .replace(/Ç/g, 'ç').replace(/Ğ/g, 'ğ')
             .replace(/Ö/g, 'ö').replace(/Ş/g, 'ş').replace(/Ü/g, 'ü');
        s = s.toLowerCase();
        // Basliklar alan adidir; Turkce karakter farki eslesme bilgisini
        // degistirmez. Hem ASCII (Urun/Iskonto) hem Unicode (Urun/Iskonto'nun
        // Turkce karakterli halleri) ayni synonym anahtarina katlanir.
        s = s.replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ğ/g, 'g')
             .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
        // alfanumerik + tr harf disi → bosluk; collapse; trim
        s = s.replace(/[^a-z0-9çğıöşü]+/g, ' ').replace(/\s+/g, ' ').trim();
        return s;
    }

    // ============================================================
    // normalizeImportNumber — TR sayi → JS-parse edilebilir string
    //   "1.250,50" → "1250.50" | "1,5" → "1.5" | "850" → "850"
    //   %, bosluk, para simgesi temizlenir. raw_*'a UYGULANMAZ (yardimci).
    //   Belirsiz tek-nokta ("1.250") oldugu gibi birakilir (decimal kabul).
    // ============================================================
    function normalizeImportNumber(value) {
        if (value == null) return null;
        var s = String(value).trim();
        if (s === '') return null;
        // para simgesi / yuzde / bosluk / harf temizligi (rakam, . , - disinda)
        s = s.replace(/[^\d.,\-]/g, '');
        if (s === '' || s === '-' || s === '.' || s === ',') return null;

        var hasDot = s.indexOf('.') !== -1;
        var hasComma = s.indexOf(',') !== -1;

        if (hasDot && hasComma) {
            // TR: '.' binlik, ',' ondalik → noktalari sil, virgulu noktaya cevir
            s = s.replace(/\./g, '').replace(',', '.');
        } else if (hasComma) {
            // yalniz virgul → ondalik ayraci
            s = s.replace(',', '.');
        }
        // yalniz nokta → oldugu gibi (decimal kabul, "1.250" belirsizligi korunur)
        return s;
    }

    // Miktar ve para ayni nokta/virgul semantigini paylasmaz. Bu iki saf
    // yardimci ham metni degistirmez; yalniz analiz icin number|null doner.
    function normalizeQuantityNumber(value) {
        if (typeof value === 'number') return isFinite(value) ? value : null;
        var normalized = normalizeImportNumber(value);
        if (normalized == null || !/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
        var parsed = Number(normalized);
        return isFinite(parsed) ? parsed : null;
    }

    function normalizeMoneyNumber(value) {
        if (typeof value === 'number') return isFinite(value) ? value : null;
        if (value == null) return null;

        var s = String(value).trim();
        if (s === '') return null;
        var parenthesizedNegative = /^\s*\(.*\)\s*$/.test(s);
        s = s.replace(/[^\d.,\-]/g, '');
        if (s === '' || s === '-' || s === '.' || s === ',') return null;
        if ((s.match(/-/g) || []).length > 1 || (s.indexOf('-') > 0)) return null;

        var negative = s.charAt(0) === '-' || parenthesizedNegative;
        s = s.replace(/-/g, '');
        var dotCount = (s.match(/\./g) || []).length;
        var commaCount = (s.match(/,/g) || []).length;

        if (dotCount && commaCount) {
            // Son ayirac ondalik; diger ayirac(lar) binliktir.
            var lastDot = s.lastIndexOf('.');
            var lastComma = s.lastIndexOf(',');
            var decimalSep = lastDot > lastComma ? '.' : ',';
            var parts = s.split(decimalSep);
            var fraction = parts.pop();
            var integerPart = parts.join('').replace(/[.,]/g, '');
            s = integerPart + '.' + fraction.replace(/[.,]/g, '');
        } else if (commaCount) {
            // Turkce para: tek virgul ondaliktir; onceki virgul gruplari binlik.
            var commaParts = s.split(',');
            var commaFraction = commaParts.pop();
            s = commaParts.join('') + '.' + commaFraction;
        } else if (dotCount) {
            var dotParts = s.split('.');
            var allThousands = dotParts.length > 1 && dotParts.slice(1).every(function (p) {
                return /^\d{3}$/.test(p);
            });
            // 2.700 / 3.925 / 4.095 para icin binlik; 35.00 ve 2.7 ondalik.
            s = allThousands ? dotParts.join('') : dotParts.join('.');
        }

        if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
        var parsed = Number((negative ? '-' : '') + s);
        return isFinite(parsed) ? parsed : null;
    }

    function _lineValue(line, canonical, rawName) {
        if (!line) return null;
        return line[canonical] != null ? line[canonical] : line[rawName];
    }

    function _amountsClose(actual, expected) {
        if (actual == null || expected == null) return false;
        var tolerance = Math.max(0.05, Math.abs(expected) * 0.001);
        return Math.abs(actual - expected) <= tolerance;
    }

    var MAX_SEQUENTIAL_DISCOUNT_RATES = 3;

    function _roundMoney(value) {
        return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    }

    function _roundRate(value) {
        return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
    }

    function _roundFiniteMoney(value) {
        if (value == null) return null;
        var numeric = Number(value);
        if (!Number.isFinite(numeric)) return null;
        var rounded = _roundMoney(numeric);
        return Number.isFinite(rounded) ? rounded : null;
    }

    function _roundFiniteRate(value) {
        if (value == null) return null;
        var numeric = Number(value);
        if (!Number.isFinite(numeric)) return null;
        var rounded = _roundRate(numeric);
        return Number.isFinite(rounded) ? rounded : null;
    }

    function _effectiveRateFromRoundedMoney(roundedGross, roundedDiscount) {
        if (roundedGross == null || roundedDiscount == null) return null;
        if (roundedGross === 0) return 0;
        return _roundFiniteRate(roundedDiscount / roundedGross * 100);
    }

    // Saklanacak para alanlarını tek bir kanonik sözleşmede sonuçlandırır.
    // Net otoriterken iskonto, yuvarlanmış gross - yuvarlanmış net farkıdır.
    function finalizeMoneyFromAuthoritativeNet(grossAmount, authoritativeNetAmount) {
        var roundedGross = _roundFiniteMoney(grossAmount);
        var roundedNet = _roundFiniteMoney(authoritativeNetAmount);
        if (roundedGross == null || roundedNet == null) {
            return {
                calculated_gross_amount: roundedGross,
                calculated_net_amount: null,
                line_discount_amount: null,
                effective_discount_rate: null
            };
        }
        var roundedDiscount = _roundFiniteMoney(roundedGross - roundedNet);
        return {
            calculated_gross_amount: roundedGross,
            calculated_net_amount: roundedNet,
            line_discount_amount: roundedDiscount,
            effective_discount_rate: _effectiveRateFromRoundedMoney(
                roundedGross, roundedDiscount
            )
        };
    }

    // İskonto tutarı otoriterken net, hassas ara farktan değil saklanacak
    // yuvarlanmış gross ve iskonto alanlarının farkından türetilir.
    function finalizeMoneyFromAuthoritativeDiscount(grossAmount, authoritativeDiscountAmount) {
        var roundedGross = _roundFiniteMoney(grossAmount);
        var roundedDiscount = _roundFiniteMoney(authoritativeDiscountAmount);
        var roundedNet = roundedGross == null || roundedDiscount == null ||
            roundedDiscount > roundedGross
            ? null : _roundFiniteMoney(roundedGross - roundedDiscount);
        return {
            calculated_gross_amount: roundedGross,
            calculated_net_amount: roundedNet,
            line_discount_amount: roundedDiscount,
            effective_discount_rate: roundedNet == null
                ? null : _effectiveRateFromRoundedMoney(roundedGross, roundedDiscount)
        };
    }

    // Kaynak satır tutarını gross/net adaylarına tolerans içinde en yakın olana
    // bağlar. İki farklı adaya gerçekten eşit uzaklık güvenli biçimde review'dur.
    function classifySourceAmountBasis(sourceAmount, grossAmount, netAmount, hasDiscount) {
        var outcome = {
            source_line_basis: 'unknown',
            discount_parse_status: 'mismatch',
            discount_review_required: true,
            discount_reason: 'source_amount_mismatch'
        };
        if (sourceAmount == null || grossAmount == null || netAmount == null) return outcome;

        var grossDifference = Math.abs(sourceAmount - grossAmount);
        var netDifference = Math.abs(sourceAmount - netAmount);
        var grossClose = _amountsClose(sourceAmount, grossAmount);
        var netClose = _amountsClose(sourceAmount, netAmount);

        if (!hasDiscount && _amountsClose(grossAmount, netAmount) && (grossClose || netClose)) {
            outcome.source_line_basis = 'same';
        } else if (grossClose && !netClose) {
            outcome.source_line_basis = 'gross';
        } else if (netClose && !grossClose) {
            outcome.source_line_basis = 'net';
        } else if (grossClose && netClose) {
            if (grossAmount === netAmount) {
                outcome.source_line_basis = hasDiscount ? 'unknown' : 'same';
            } else if (Math.abs(grossDifference - netDifference) <= Number.EPSILON *
                       Math.max(1, grossDifference, netDifference)) {
                outcome.source_line_basis = 'unknown';
            } else {
                outcome.source_line_basis = grossDifference < netDifference ? 'gross' : 'net';
            }
        }

        if (outcome.source_line_basis !== 'unknown') {
            outcome.discount_parse_status = 'parsed';
            outcome.discount_review_required = false;
            outcome.discount_reason = null;
        }
        return outcome;
    }

    function _applySourceAmountBasis(result, sourceAmount, hasDiscount) {
        if (sourceAmount == null) return;
        var basis = classifySourceAmountBasis(
            sourceAmount,
            result.calculated_gross_amount,
            result.calculated_net_amount,
            hasDiscount
        );
        result.source_line_basis = basis.source_line_basis;
        if (basis.discount_review_required) {
            result.discount_parse_status = 'mismatch';
            result.discount_review_required = true;
            result.discount_reason = result.discount_reason || basis.discount_reason;
        }
    }

    function _normalizeDiscountRateArray(values) {
        if (!Array.isArray(values) || values.length === 0 ||
            values.length > MAX_SEQUENTIAL_DISCOUNT_RATES) {
            return { status: 'unsupported', rates: null, reason: 'rate_count' };
        }
        var rates = [];
        for (var i = 0; i < values.length; i++) {
            var rate = typeof values[i] === 'number'
                ? values[i] : normalizeQuantityNumber(values[i]);
            if (rate == null || !isFinite(rate) || rate < 0 || rate > 100) {
                return { status: 'unsupported', rates: null, reason: 'rate_range' };
            }
            rates.push(rate);
        }
        return { status: 'parsed', rates: rates, reason: null };
    }

    // Birleşik iskonto hücresini yalnız açık +, / ve ; ayraçlarıyla çözer.
    // Ondalık virgül (10,5) tek orandır; boşluk hiçbir zaman ayraç değildir.
    function parseSequentialDiscountRates(raw) {
        if (raw == null || String(raw).trim() === '') {
            return { status: 'not_present', rates: null, reason: null };
        }
        var text = String(raw).trim();
        var tokenPattern = /^%?\s*(\d+(?:[.,]\d+)?)\s*%?$/;
        var single = text.match(tokenPattern);
        if (single) {
            return _normalizeDiscountRateArray([Number(single[1].replace(',', '.'))]);
        }

        if (!/[+\/;]/.test(text)) {
            return {
                status: /\s/.test(text) ? 'ambiguous' : 'unsupported',
                rates: null,
                reason: 'ambiguous_format'
            };
        }

        var tokens = text.split(/\s*[+\/;]\s*/);
        if (tokens.length > MAX_SEQUENTIAL_DISCOUNT_RATES) {
            return { status: 'unsupported', rates: null, reason: 'rate_count' };
        }
        if (tokens.some(function (token) { return token === ''; })) {
            return { status: 'unsupported', rates: null, reason: 'empty_rate' };
        }

        var rates = [];
        for (var i = 0; i < tokens.length; i++) {
            var match = tokens[i].match(tokenPattern);
            if (!match) {
                return { status: 'ambiguous', rates: null, reason: 'ambiguous_token' };
            }
            rates.push(Number(match[1].replace(',', '.')));
        }
        return _normalizeDiscountRateArray(rates);
    }

    function calculateSequentialDiscount(grossAmount, rates) {
        var grossMissing = grossAmount == null ||
            (typeof grossAmount === 'string' && grossAmount.trim() === '');
        var gross = grossMissing ? NaN : Number(grossAmount);
        var normalized = _normalizeDiscountRateArray(rates);
        function unsupportedResult() {
            var parsedRates = normalized.status === 'parsed' ? normalized.rates : null;
            return {
                status: 'unsupported',
                reason: 'invalid_gross_or_rates',
                discount_rates: parsedRates,
                discount_calculation_method: parsedRates
                    ? (parsedRates.length === 1 ? 'single' : 'sequential')
                    : null,
                calculation_input_gross_amount: null,
                calculated_gross_amount: null,
                calculated_net_amount: null,
                line_discount_amount: null,
                effective_discount_rate: null
            };
        }
        if (!Number.isFinite(gross) || gross < 0 || normalized.status !== 'parsed') {
            return unsupportedResult();
        }

        var preciseNet = normalized.rates.reduce(function (amount, rate) {
            return amount * (1 - rate / 100);
        }, gross);
        var finalized = finalizeMoneyFromAuthoritativeNet(gross, preciseNet);
        if (!Number.isFinite(preciseNet) ||
            !Number.isFinite(finalized.calculated_gross_amount) ||
            !Number.isFinite(finalized.calculated_net_amount) ||
            !Number.isFinite(finalized.line_discount_amount) ||
            !Number.isFinite(finalized.effective_discount_rate)) {
            return unsupportedResult();
        }
        return Object.assign({
            status: 'parsed',
            discount_rates: normalized.rates,
            discount_calculation_method: normalized.rates.length === 1 ? 'single' : 'sequential',
            calculation_input_gross_amount: gross
        }, finalized);
    }

    function _separateDiscountRates(input) {
        var raw = [input.raw_discount_1, input.raw_discount_2, input.raw_discount_3];
        var present = raw.map(function (value) {
            return value != null && String(value).trim() !== '';
        });
        if (!present.some(Boolean)) {
            return { status: 'not_present', rates: null, reason: null };
        }
        var last = present.lastIndexOf(true);
        for (var i = 0; i <= last; i++) {
            if (!present[i]) return { status: 'ambiguous', rates: null, reason: 'rate_column_gap' };
        }
        var rates = [];
        for (var j = 0; j <= last; j++) {
            var parsed = parseSequentialDiscountRates(raw[j]);
            if (parsed.status !== 'parsed' || !parsed.rates || parsed.rates.length !== 1) {
                return { status: 'ambiguous', rates: null, reason: 'invalid_rate_column' };
            }
            rates.push(parsed.rates[0]);
        }
        return _normalizeDiscountRateArray(rates);
    }

    function _sameDiscountRates(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
            a.every(function (value, index) { return Math.abs(value - b[index]) <= 0.000001; });
    }

    function _discountResultDefaults() {
        return {
            discount_rates: null,
            discount_calculation_method: 'none',
            discount_parse_status: 'not_present',
            effective_discount_rate: 0,
            line_discount_amount: 0,
            calculated_gross_amount: null,
            calculated_net_amount: null,
            calculation_input_gross_amount: null,
            discount_review_required: false,
            source_line_basis: 'unknown',
            line_type: 'normal',
            discount_reason: null
        };
    }

    // Ham oran, ayrı oran kolonları, açık tutar ve kaynak satır tutarını tek
    // finansal sözleşmede mutabıklaştırır. Review/commit kararı vermez; yalnız
    // typed staging kanıtını ve review_required bayrağını üretir.
    function classifyDiscountEvidence(input) {
        input = input || {};
        var result = _discountResultDefaults();
        var quantity = normalizeQuantityNumber(_lineValue(input, 'quantity', 'raw_qty'));
        var unitPrice = normalizeMoneyNumber(_lineValue(input, 'unit_price', 'raw_unit_price'));
        var sourceAmount = normalizeMoneyNumber(_lineValue(input, 'source_line_amount', 'raw_line_total'));
        var explicitRaw = _lineValue(input, 'discount_amount', 'raw_discount_amount');
        var explicitPresent = explicitRaw != null && String(explicitRaw).trim() !== '';
        var explicitAmount = normalizeMoneyNumber(explicitRaw);
        var combined = parseSequentialDiscountRates(_lineValue(input, 'discount_rate', 'raw_discount'));
        var separate = _separateDiscountRates(input);
        var gross = quantity != null && unitPrice != null ? quantity * unitPrice : null;
        var roundedGross = gross == null ? null : _roundFiniteMoney(gross);
        var grossIsNonFinite = gross != null &&
            (!Number.isFinite(gross) || roundedGross == null);
        if (explicitPresent && explicitAmount == null) {
            result.discount_parse_status = 'ambiguous';
            result.discount_review_required = true;
            result.discount_reason = 'invalid_discount_amount';
            return result;
        }

        if ((quantity != null && quantity < 0) || (unitPrice != null && unitPrice < 0) ||
            (sourceAmount != null && sourceAmount < 0) ||
            (explicitAmount != null && explicitAmount < 0)) {
            result.discount_parse_status = 'unsupported';
            result.discount_review_required = true;
            result.calculation_input_gross_amount = null;
            result.calculated_gross_amount = null;
            result.calculated_net_amount = null;
            result.line_discount_amount = null;
            result.effective_discount_rate = null;
            result.source_line_basis = 'unknown';
            result.line_type = 'unknown';
            result.discount_reason = 'negative_financial_value';
            return result;
        }

        result.calculation_input_gross_amount =
            Number.isFinite(gross) && gross >= 0 ? gross : null;

        if (grossIsNonFinite) {
            var overflowRates = null;
            if (combined.status === 'parsed' && separate.status === 'not_present') {
                overflowRates = combined.rates;
            } else if (separate.status === 'parsed' && combined.status === 'not_present') {
                overflowRates = separate.rates;
            } else if (combined.status === 'parsed' && separate.status === 'parsed' &&
                       _sameDiscountRates(combined.rates, separate.rates)) {
                overflowRates = combined.rates;
            }
            result.discount_rates = overflowRates ? overflowRates.slice() : null;
            result.discount_calculation_method = overflowRates
                ? (overflowRates.length === 1 ? 'single' : 'sequential')
                : (explicitAmount != null ? 'explicit_amount' : 'none');
            result.discount_parse_status = 'unsupported';
            result.discount_review_required = true;
            result.source_line_basis = 'unknown';
            result.line_type = 'unknown';
            result.calculated_gross_amount = null;
            result.calculated_net_amount = null;
            result.effective_discount_rate = null;
            result.line_discount_amount = explicitAmount != null
                ? _roundFiniteMoney(explicitAmount) : null;
            result.discount_reason = 'non_finite_gross_amount';
            return result;
        }
        if (gross != null) result.calculated_gross_amount = roundedGross;

        var combinedPresent = combined.status !== 'not_present';
        var separatePresent = separate.status !== 'not_present';
        var rateEvidence = null;
        if (combinedPresent && combined.status !== 'parsed') {
            result.discount_parse_status = combined.status;
            result.discount_review_required = true;
            result.discount_reason = combined.reason;
            return result;
        }
        if (separatePresent && separate.status !== 'parsed') {
            result.discount_parse_status = separate.status;
            result.discount_review_required = true;
            result.discount_reason = separate.reason;
            return result;
        }
        if (combinedPresent && separatePresent) {
            if (!_sameDiscountRates(combined.rates, separate.rates)) {
                result.discount_parse_status = 'mismatch';
                result.discount_review_required = true;
                result.discount_reason = 'combined_separate_rate_mismatch';
                return result;
            }
            rateEvidence = combined.rates;
        } else if (combinedPresent) {
            rateEvidence = combined.rates;
        } else if (separatePresent) {
            rateEvidence = separate.rates;
        }

        // 0 oranı finansal olarak iskonto yok sözleşmesine katlanır; ham hücre korunur.
        if (rateEvidence && rateEvidence.every(function (rate) { return rate === 0; })) {
            rateEvidence = null;
        }

        if (rateEvidence) {
            result.discount_rates = rateEvidence.slice();
            result.discount_calculation_method = rateEvidence.length === 1 ? 'single' : 'sequential';
            result.discount_parse_status = 'parsed';
            if (gross == null) {
                result.discount_parse_status = 'mismatch';
                result.discount_review_required = true;
                result.calculation_input_gross_amount = null;
                result.calculated_gross_amount = null;
                result.calculated_net_amount = null;
                result.line_discount_amount = null;
                result.effective_discount_rate = null;
                result.source_line_basis = 'unknown';
                result.line_type = 'unknown';
                result.discount_reason = 'gross_not_available';
                return result;
            }
            var calculation = calculateSequentialDiscount(gross, rateEvidence);
            result.calculated_gross_amount = calculation.calculated_gross_amount;
            result.calculated_net_amount = calculation.calculated_net_amount;
            result.line_discount_amount = calculation.line_discount_amount;
            result.effective_discount_rate = calculation.effective_discount_rate;

            if (explicitAmount != null && !_amountsClose(explicitAmount, result.line_discount_amount)) {
                result.discount_parse_status = 'mismatch';
                result.discount_review_required = true;
                result.discount_reason = 'discount_amount_mismatch';
            }
            _applySourceAmountBasis(result, sourceAmount, true);
        } else if (explicitAmount != null) {
            result.discount_calculation_method = 'explicit_amount';
            result.discount_parse_status = 'parsed';
            result.line_discount_amount = _roundFiniteMoney(explicitAmount);
            if (gross == null) {
                result.discount_parse_status = 'mismatch';
                result.discount_review_required = true;
                result.calculation_input_gross_amount = null;
                result.calculated_gross_amount = null;
                result.calculated_net_amount = null;
                result.effective_discount_rate = null;
                result.source_line_basis = 'unknown';
                result.line_type = 'unknown';
                result.discount_reason = 'gross_not_available';
                return result;
            }
            if (explicitAmount > gross ||
                result.line_discount_amount > result.calculated_gross_amount) {
                result.discount_parse_status = 'mismatch';
                result.discount_review_required = true;
                result.calculated_net_amount = null;
                result.effective_discount_rate = null;
                result.discount_reason = 'discount_amount_exceeds_gross';
                return result;
            }
            var explicitFinalized = finalizeMoneyFromAuthoritativeDiscount(gross, explicitAmount);
            result.calculated_gross_amount = explicitFinalized.calculated_gross_amount;
            result.calculated_net_amount = explicitFinalized.calculated_net_amount;
            result.line_discount_amount = explicitFinalized.line_discount_amount;
            result.effective_discount_rate = explicitFinalized.effective_discount_rate;
            _applySourceAmountBasis(result, sourceAmount, true);
        } else if (gross != null && sourceAmount != null && sourceAmount < gross &&
                   !_amountsClose(sourceAmount, gross)) {
            result.discount_calculation_method = 'derived_effective';
            result.discount_parse_status = 'parsed';
            var derivedFinalized = finalizeMoneyFromAuthoritativeNet(gross, sourceAmount);
            result.calculated_gross_amount = derivedFinalized.calculated_gross_amount;
            result.calculated_net_amount = derivedFinalized.calculated_net_amount;
            result.line_discount_amount = derivedFinalized.line_discount_amount;
            result.effective_discount_rate = derivedFinalized.effective_discount_rate;
            _applySourceAmountBasis(result, sourceAmount, true);
        } else {
            result.calculated_net_amount = gross == null ? null : result.calculated_gross_amount;
            _applySourceAmountBasis(result, sourceAmount, false);
        }

        result.line_type = result.calculated_gross_amount > 0 &&
            result.calculated_net_amount === 0 && result.line_discount_amount > 0
            ? 'promotion' : 'normal';
        return result;
    }

    function applyDiscountSemantics(line) {
        line = line || {};
        var evidence = classifyDiscountEvidence(line);
        DISCOUNT_TYPED_FIELDS.forEach(function (field) { line[field] = evidence[field]; });
        line.source_line_basis = evidence.source_line_basis;
        line.line_type = evidence.line_type;
        return line;
    }

    // Geriye dönük public yardımcılar artık kanonik sınıflandırıcıyı kullanır.
    function analyzeSourceLineBasis(line) {
        return classifyDiscountEvidence(line).source_line_basis;
    }

    function _singleDiscountRate(value) {
        var parsed = parseSequentialDiscountRates(value);
        return parsed.status === 'parsed' && parsed.rates.length === 1 ? parsed.rates[0] : null;
    }

    function classifyLineType(line) {
        return classifyDiscountEvidence(line).line_type;
    }

    // ============================================================
    // validateLineMath — SAF hesap kontrolu (075-H-A)
    //   Tek bir ham satirin (rawLine: { raw_qty, raw_unit_price, raw_vat,
    //   raw_discount, raw_line_total, ... }) tutar tutarliligini analiz eder.
    //
    //   GARANTILER:
    //     - raw_* DEGISTIRILMEZ (yalniz okur).
    //     - Supabase / DOM / UI bagimliligi YOK.
    //     - Maliyet YAZMAZ, commit YAPMAZ — yalnizca uyari uretir.
    //
    //   Hipotezler (sirayla):
    //     1) tutar ≈ miktar × birim fiyat                          → net_match
    //     2) tutar ≈ miktar × birim fiyat × (1 - iskonto/100)      → discount_match
    //     3) tutar ≈ miktar × birim fiyat × (1 + kdv/100)          → gross_match
    //     4) tutar ≈ miktar × birim fiyat × (1-isk/100)×(1+kdv/100)→ gross_match
    //     5) Hicbiri tutmuyor                                       → mismatch
    //   Yeterli veri yoksa not_enough_data; sayi cozulemiyorsa invalid_number.
    //
    //   Tolerans: max(0.05 mutlak, beklenen tutarin %1'i) — TR yuvarlama paylari.
    //
    //   Donus: { status:'ok'|'check', code, label, hint }
    // ============================================================
    function _num(raw) {
        if (raw == null || String(raw).trim() === '') return { state: 'empty' };
        var s = normalizeImportNumber(raw);
        if (s == null) return { state: 'empty' };
        var n = parseFloat(s);
        if (!isFinite(n)) return { state: 'invalid' };
        return { state: 'ok', value: n };
    }

    function validateLineMath(rawLine) {
        rawLine = rawLine || {};
        var q = _num(rawLine.raw_qty);
        var p = _num(rawLine.raw_unit_price);
        var t = _num(rawLine.raw_line_total);
        var v = _num(rawLine.raw_vat);

        // Cekirdek alanlardan biri DOLU ama sayiya cevrilemiyorsa → sayisal kontrol
        if (q.state === 'invalid' || p.state === 'invalid' || t.state === 'invalid') {
            return {
                status: 'check', code: 'invalid_number',
                label: 'Sayısal alan kontrol edilmeli',
                hint: 'Miktar, birim fiyat veya satır tutarı sayıya çevrilemedi.'
            };
        }
        // Capraz kontrol icin miktar + birim fiyat + satir tutari sart
        if (q.state !== 'ok' || p.state !== 'ok' || t.state !== 'ok') {
            return {
                status: 'check', code: 'not_enough_data',
                label: 'Tutar kontrolü yapılamadı',
                hint: 'Hesap kontrolü için miktar, birim fiyat ve satır tutarı gerekli.'
            };
        }

        var vat  = (v.state === 'ok') ? v.value : 0;
        var actual = t.value;
        var base = q.value * p.value;
        var discountEvidence = classifyDiscountEvidence(rawLine);
        var discountedNet = discountEvidence.calculated_net_amount;

        function close(expected) {
            var tol = Math.max(0.05, Math.abs(expected) * 0.01);
            return Math.abs(expected - actual) <= tol;
        }

        if (close(base)) {
            return {
                status: 'ok', code: 'net_match', label: 'Uyumlu',
                hint: 'Satır tutarı, miktar × birim fiyat ile uyumlu.'
            };
        }
        if (discountEvidence.discount_parse_status === 'parsed' &&
            discountEvidence.line_discount_amount > 0 && close(discountedNet)) {
            return {
                status: 'ok', code: 'discount_match', label: 'Uyumlu',
                hint: 'Satır tutarı, iskonto sonrası tutarla uyumlu.'
            };
        }
        if (vat > 0 && close(base * (1 + vat / 100))) {
            return {
                status: 'check', code: 'gross_match',
                label: 'KDV dahil/hariç kontrolü gerekli',
                hint: 'Satır tutarı KDV dahil görünüyor; KDV dahil/hariç farkı kontrol edilmeli.'
            };
        }
        if (vat > 0 && discountEvidence.discount_parse_status === 'parsed' &&
            discountEvidence.line_discount_amount > 0 && close(discountedNet * (1 + vat / 100))) {
            return {
                status: 'check', code: 'gross_match',
                label: 'KDV dahil/hariç kontrolü gerekli',
                hint: 'Satır tutarı iskonto + KDV dahil görünüyor; KDV dahil/hariç farkı kontrol edilmeli.'
            };
        }
        return {
            status: 'check', code: 'mismatch',
            label: 'Satır toplamı uyuşmuyor',
            hint: 'Satır toplamı, miktar × birim fiyat ile beklenen tutarla uyuşmuyor.'
        };
    }

    // ============================================================
    // detectDelimiter — CSV ayraci otomatik tespit (; , \t)
    //   Ilk ~5 dolu satirda tirnak-disi sayim; en cok gecen kazanir.
    //   Esitlikte ';' tercih (TR Excel default).
    // ============================================================
    function detectDelimiter(text) {
        if (!text) return ',';
        var lines = String(text).split(/\r\n|\r|\n/).filter(function (l) { return l.trim() !== ''; });
        var sample = lines.slice(0, 5);
        var counts = { ';': 0, ',': 0, '\t': 0 };
        sample.forEach(function (line) {
            var inQ = false;
            for (var i = 0; i < line.length; i++) {
                var ch = line[i];
                if (ch === '"') { inQ = !inQ; continue; }
                if (inQ) continue;
                if (ch === ';')  counts[';']++;
                else if (ch === ',')  counts[',']++;
                else if (ch === '\t') counts['\t']++;
            }
        });
        if (counts['\t'] > counts[';'] && counts['\t'] > counts[',']) return '\t';
        if (counts[';'] >= counts[','] && counts[';'] > 0) return ';';
        if (counts[','] > 0) return ',';
        return ';'; // tek kolonlu / ayrac yok → TR default
    }

    // ------------------------------------------------------------
    // splitCsvLine — tek satiri ayraca gore parcala (tirnak destekli, "" escape)
    // ------------------------------------------------------------
    function splitCsvLine(line, delimiter) {
        var out = [];
        var cur = '';
        var inQ = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (inQ) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++; }
                    else inQ = false;
                } else cur += ch;
            } else {
                if (ch === '"') inQ = true;
                else if (ch === delimiter) { out.push(cur); cur = ''; }
                else cur += ch;
            }
        }
        out.push(cur);
        return out.map(function (c) { return c.trim(); });
    }

    // ============================================================
    // detectColumnMapping — baslik satiri → { field: colIndex }
    //   1) exact gecis (normalize header == synonym)
    //   2) includes gecisi (alan oncelik sirasiyla; bir alan/kolon bir kez)
    // ============================================================
    function detectColumnMapping(headerRow) {
        var mapping = {};
        var usedCols = {};
        var norm = (headerRow || []).map(normalizeHeader);

        // 1) EXACT
        FIELD_ORDER.forEach(function (field) {
            if (mapping[field] != null) return;
            var syns = SYNONYMS[field];
            for (var c = 0; c < norm.length; c++) {
                if (usedCols[c]) continue;
                if (syns.indexOf(norm[c]) !== -1) {
                    mapping[field] = c; usedCols[c] = true; return;
                }
            }
        });

        // 2) INCLUDES (kismi) — oncelik sirasi carisma cozer
        FIELD_ORDER.forEach(function (field) {
            if (mapping[field] != null) return;
            if (EXACT_ONLY_FIELDS[field]) return;
            var syns = SYNONYMS[field];
            for (var c = 0; c < norm.length; c++) {
                if (usedCols[c] || norm[c] === '') continue;
                var hit = syns.some(function (s) {
                    return norm[c] === s || norm[c].indexOf(s) !== -1 || s.indexOf(norm[c]) !== -1;
                });
                if (hit) { mapping[field] = c; usedCols[c] = true; return; }
            }
        });

        return mapping;
    }

    // ============================================================
    // 076-L: PROFESYONEL XLSX — toplam satiri / metadata / footer yardimcilari
    // ============================================================
    // Ürün satiri OLMAYAN (alt-toplam) satir isimleri
    var TOTAL_KEYWORDS = ['ara toplam', 'alt toplam', 'net toplam', 'kdv toplam', 'kdv tutar',
                          'genel toplam', 'toplam', 'iskonto', 'indirim', 'matrah', 'vergi', 'yekun'];

    function firstNonEmptyCell(row) {
        if (!row) return '';
        for (var i = 0; i < row.length; i++) {
            if (row[i] != null && String(row[i]).trim() !== '') return String(row[i]);
        }
        return '';
    }

    // 076-L: normalizeHeader TR harfleri KORUR ("tedarikçi"). Etiket eşleşmesinde
    //   ASCII katla ki plain-ASCII etiketler (tedarikci, son odeme) tutsun.
    function foldTr(s) {
        return String(s == null ? '' : s)
            .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
            .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
    }

    // isTotalRow — satir bir alt-toplam mi? (isim toplam-kelimesi + miktar YOK)
    //   Miktari olan gercek urun ("Toplam Seker 5 kg") YANLIS pozitif olmasin.
    function isTotalRow(row, mapping) {
        var nameIdx = (mapping && mapping.raw_name != null) ? mapping.raw_name : null;
        var nameCell = (nameIdx != null && row[nameIdx] != null) ? String(row[nameIdx]) : firstNonEmptyCell(row);
        var norm = foldTr(normalizeHeader(nameCell));
        if (!norm) return false;
        var matches = TOTAL_KEYWORDS.some(function (k) { return norm === k || norm.indexOf(k) !== -1; });
        if (!matches) return false;
        // miktar kolonu varsa ve sayisal deger iceriyorsa → gercek urun, toplam DEGIL
        var qtyIdx = (mapping && mapping.raw_qty != null) ? mapping.raw_qty : null;
        if (qtyIdx != null && row[qtyIdx] != null && normalizeImportNumber(row[qtyIdx]) != null) return false;
        return true;
    }

    function fmtYmd(y, mo, d) { return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2); }

    // parseMetaDate — Date obj / Excel serial / TR tarih string → 'YYYY-MM-DD' | null
    function parseMetaDate(value) {
        if (value == null) return null;
        // 076-L.3: gerçek tarih hücresi (raw:true+cellDates:true) → JS Date.
        //   Excel tarihleri UTC gece-yarısıdır → UTC accessor (tz kayması yok).
        if (value instanceof Date && !isNaN(value.getTime())) {
            return fmtYmd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
        }
        var s = String(value).trim();
        if (s === '') return null;
        // 076-L.3: Excel serial (GENERAL formatlı tarih hücresi) — saf tamsayı ~1954..2119
        if (/^\d{4,6}(\.\d+)?$/.test(s)) {
            var n = Math.round(Number(s));
            if (n > 20000 && n < 80000) {
                var dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
                if (!isNaN(dt.getTime())) return fmtYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
            }
        }
        var m;
        // dd.mm.yyyy | dd/mm/yyyy | dd-mm-yyyy
        m = s.match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})/);
        if (m) {
            var dd = m[1], mm = m[2], yy = m[3];
            if (yy.length === 2) yy = (Number(yy) > 50 ? '19' : '20') + yy;
            var di = Number(dd), mi = Number(mm);
            if (di >= 1 && di <= 31 && mi >= 1 && mi <= 12) {
                return yy + '-' + ('0' + mi).slice(-2) + '-' + ('0' + di).slice(-2);
            }
        }
        // yyyy-mm-dd
        m = s.match(/^(\d{4})[.\/\-](\d{1,2})[.\/\-](\d{1,2})/);
        if (m) return m[1] + '-' + ('0' + Number(m[2])).slice(-2) + '-' + ('0' + Number(m[3])).slice(-2);
        return null;
    }

    // 076-L.2: metin icinde HERHANGI bir yerde tarih ("Fatura Tarihi: 26.06.2026")
    function findDateInText(s) {
        if (s == null) return null;
        var str = String(s);
        var m = str.match(/(\d{1,2}[.\/\-]\d{1,2}[.\/\-]\d{2,4})/);
        if (m) { var d = parseMetaDate(m[1]); if (d) return d; }
        m = str.match(/(\d{4}[.\/\-]\d{1,2}[.\/\-]\d{1,2})/);
        if (m) { var d2 = parseMetaDate(m[1]); if (d2) return d2; }
        return null;
    }

    // 076-L.2: ayni hucrede "Etiket: deger" → deger kismi (":" veya son bosluk sonrasi degil,
    //   yalniz ilk ":" sonrasi — güvenli).
    function sameCellAfterLabel(raw) {
        var s = String(raw == null ? '' : raw);
        var idx = s.indexOf(':');
        if (idx === -1) return '';
        return s.slice(idx + 1).trim();
    }

    // 076-L.3: etikete komşu HAM hücre (Date/serial/string — stringify ETME)
    function neighborRawCell(rows, r, c) {
        var row = rows[r] || [];
        for (var k = c + 1; k < row.length; k++) {
            if (row[k] != null && String(row[k]).trim() !== '') return row[k];
        }
        var below = rows[r + 1] || [];
        if (below[c] != null && String(below[c]).trim() !== '') return below[c];
        return null;
    }

    // etikete komsu deger (sag hucre, yoksa alt hucre)
    function neighborValue(rows, r, c) {
        var row = rows[r] || [];
        for (var k = c + 1; k < row.length; k++) {
            if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
        }
        var below = rows[r + 1] || [];
        if (below[c] != null && String(below[c]).trim() !== '') return String(below[c]).trim();
        return '';
    }

    var META_LABELS = {
        invoice_date:  ['fatura tarihi', 'fatura tar', 'fat tarihi', 'duzenleme tarihi', 'duzenlenme tarihi',
                        'tanzim tarihi', 'belge tarihi'],
        delivery_date: ['irsaliye tarihi', 'irsaliye trh', 'sevk tarihi', 'sevk trh'],
        due_date:      ['son odeme tarihi', 'son odeme', 'vade tarihi', 'odeme tarihi', 'vade'],
        supplier:      ['tedarikci', 'cari unvan', 'cari', 'firma unvani', 'firma', 'satici', 'unvan'],
        invoice_no:    ['fatura no', 'belge no', 'fatura numarasi', 'fatura seri', 'fis no']
    };

    // extractInvoiceMeta — etiket→deger tarama (best-effort). 076-L.2: deger
    //   AYNI hucrede ("Fatura Tarihi: 26.06.2026"), sag komsuda veya alt hucrede olabilir.
    function extractInvoiceMeta(rows) {
        var out = { invoice_date: null, delivery_date: null, due_date: null, supplier: null, invoice_no: null };
        var scan = Math.min(rows.length, 60);
        for (var r = 0; r < scan; r++) {
            var row = rows[r] || [];
            for (var c = 0; c < row.length; c++) {
                var raw = row[c];
                if (raw == null || String(raw).trim() === '') continue;
                var norm = foldTr(normalizeHeader(raw));
                if (!norm) continue;
                Object.keys(META_LABELS).forEach(function (key) {
                    if (out[key]) return;
                    var hit = META_LABELS[key].some(function (lbl) { return norm.indexOf(lbl) !== -1; });
                    if (!hit) return;
                    if (key === 'invoice_date' || key === 'delivery_date' || key === 'due_date') {
                        // 1) ayni hucrede tarih metni, 2) HAM komşu hücre (Date/serial dahil)
                        var d = findDateInText(raw) || parseMetaDate(raw) || parseMetaDate(neighborRawCell(rows, r, c));
                        if (d) out[key] = d;
                    } else {
                        // metin: ayni hucrede ":" sonrasi → sag komsu / alt
                        var v = sameCellAfterLabel(raw);
                        if (v === '') v = neighborValue(rows, r, c);
                        if (v && v !== '') out[key] = v;
                    }
                });
            }
        }
        return out;
    }

    // extractFooterTotals — alt-toplam satirlarindan ozet (gosterim/uyari icin)
    function extractFooterTotals(rows) {
        var sum = {};
        // Footer etiketleri serbest substring degildir. Yalniz bilinen etiket
        // veya sinirli, parasal bir ek kabul edilir; aciklama/tedarikci metni
        // icindeki "genel iskonto" bu nedenle footer sayilmaz.
        var isControlledLabel = function (norm, keyList) {
            var suffixes = ['', ' tutar', ' tutari', ' toplami', ' tl'];
            return keyList.some(function (k) {
                return suffixes.some(function (suffix) { return norm === k + suffix; });
            });
        };
        var pick = function (norm, val, keyList, outKey) {
            if (sum[outKey] != null) return;
            if (!isControlledLabel(norm, keyList)) return;
            var n = normalizeImportNumber(val);
            if (n == null) return;
            var parsed = parseFloat(n);
            // Gecersiz ilk aday alani kilitlemez; daha sonraki gercek footer
            // satiri okunmaya devam eder.
            if (isFinite(parsed)) sum[outKey] = parsed;
        };
        // Iskonto siniflandirmasi serbest substring/suffix kullanmaz. Belge
        // satir iskontosu toplami ile gercek genel iskonto ayri alanlardir.
        var pickExact = function (norm, val, labels, outKey) {
            if (sum[outKey] != null || labels.indexOf(norm) === -1) return;
            var n = normalizeImportNumber(val);
            if (n == null) return;
            var parsed = parseFloat(n);
            if (isFinite(parsed)) sum[outKey] = parsed;
        };
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r] || [];
            for (var c = 0; c < row.length; c++) {
                var norm = foldTr(normalizeHeader(row[c]));
                if (!norm) continue;
                var val = neighborValue(rows, r, c);
                pick(norm, val, ['ara toplam', 'ara toplami', 'alt toplam', 'alt toplami'], 'ara_toplam');
                // P0: satir iskonto toplami ve genel iskonto exact etiketlerle ayrilir.
                pickExact(norm, val, [
                    'toplam iskonto', 'iskonto toplami', 'toplam iskonto tutari',
                    'satir iskonto toplami', 'toplam satir iskontosu', 'satir iskonto'
                ], 'line_discount_total');
                pickExact(norm, val, [
                    'genel iskonto', 'genel iskonto tutari',
                    'fatura iskontosu', 'belge iskontosu'
                ], 'general_discount');
                // satır iskonto özeti — genel/fatura/toplam ile karışmasın
                if (norm.indexOf('genel') === -1 && norm.indexOf('fatura') === -1 && norm.indexOf('toplam') === -1) {
                    pick(norm, val, ['satir iskonto', 'satir indirim', 'iskonto', 'indirim'], 'iskonto');
                }
                pick(norm, val, ['net toplam', 'net toplami', 'matrah'], 'net_toplam');
                pick(norm, val, ['kdv toplam', 'kdv toplami', 'kdv tutar', 'kdv tutari'], 'kdv_toplam');
                pick(norm, val, ['genel toplam', 'genel toplami', 'yekun'], 'genel_toplam');
            }
        }
        return sum;
    }

    // ------------------------------------------------------------
    // detectHeaderRow — rows icinde en cok alan eslesen ilk anlamli satir.
    //   En az 2 alan + raw_name eslesmis olmali. Bulunamazsa -1.
    //   076-L: tarama 50 satira genisletildi (baslik ustunde metadata olabilir).
    // ------------------------------------------------------------
    function detectHeaderRow(rows) {
        var maxScan = Math.min(rows.length, 50);
        for (var r = 0; r < maxScan; r++) {
            var m = detectColumnMapping(rows[r]);
            var keys = Object.keys(m);
            if (keys.length >= 2 && m.raw_name != null) return r;
        }
        // gevsek fallback: raw_name + (qty veya line_total)
        for (var r2 = 0; r2 < maxScan; r2++) {
            var m2 = detectColumnMapping(rows[r2]);
            if (m2.raw_name != null && (m2.raw_qty != null || m2.raw_line_total != null)) return r2;
        }
        return -1;
    }

    function isEmptyRow(row) {
        return !row || row.every(function (c) { return c == null || String(c).trim() === ''; });
    }

    // ============================================================
    // buildTable — FULL MATRIX (073-B2)
    //   TUM kolonlari korur (parser'in tanimadiklari DAHIL). Kolon
    //   indeksleri ORIJINAL kalir → import-view column_mapping (field→colIndex)
    //   ile birebir hizali. Yalnizca tamamen bos kolon (label yok + hicbir
    //   satirda veri yok) filtrelenir; veri olan kolon ASLA kaybolmaz.
    //
    //   columns: [{ index, key:'col_<index>', label, normalized }]
    //   rows:    [{ col_<index>: string|null, ... }]   (full — preview gibi 20 ile sinirli DEGIL)
    //
    //   NOT: table.rows tum-bos-olmayan satirlari icerir (mapped-field filtresi
    //   YOK). Bu yuzden rawLines.length ile her zaman ayni OLMAYABILIR; table
    //   bagimsiz tam temsildir (mapping ekrani bunu kullanir).
    // ============================================================
    function buildTable(headerLabels, dataRows) {
        headerLabels = headerLabels || [];
        var maxCols = headerLabels.length;
        (dataRows || []).forEach(function (r) { if (r && r.length > maxCols) maxCols = r.length; });

        // hangi kolonlar tutulacak (veri olan veya basligi olan)
        var keep = [];
        for (var c = 0; c < maxCols; c++) {
            var label = headerLabels[c] != null ? String(headerLabels[c]).trim() : '';
            var hasData = label !== '';
            if (!hasData) {
                for (var r = 0; r < dataRows.length; r++) {
                    var cell = (dataRows[r] && dataRows[r][c] != null) ? String(dataRows[r][c]).trim() : '';
                    if (cell !== '') { hasData = true; break; }
                }
            }
            if (hasData) keep.push(c);
        }

        var columns = keep.map(function (c) {
            var label = headerLabels[c] != null ? String(headerLabels[c]) : '';
            return { index: c, key: 'col_' + c, label: label, normalized: normalizeHeader(label) };
        });

        var rows = [];
        (dataRows || []).forEach(function (row) {
            if (isEmptyRow(row)) return;
            var obj = {};
            keep.forEach(function (c) {
                var v = (row && c < row.length && row[c] != null) ? String(row[c]).trim() : '';
                obj['col_' + c] = (v === '') ? null : v;
            });
            rows.push(obj);
        });

        return { columns: columns, rows: rows };
    }

    // ============================================================
    // buildResultFromRows — ORTAK: rows (string[][]) → kontrat ciktisi
    //   CSV ve XLSX bu fonksiyona yakinsar (tek dogruluk kaynagi).
    // ============================================================
    function buildResultFromRows(rows, batchMeta) {
        var warnings = [];

        // bos satirlari at (ham satir indeksini koruyarak header tespiti icin once)
        var cleaned = (rows || []).filter(function (r) { return !isEmptyRow(r); });

        if (cleaned.length === 0) {
            warnings.push('Dosya bos veya okunabilir satir yok.');
            batchMeta.detected_header_row = null;
            batchMeta.column_mapping = null;
            batchMeta.parse_meta = Object.assign({}, batchMeta.parse_meta, {
                total_rows: 0, data_rows: 0, mapped_fields: []
            });
            return {
                batchMeta: batchMeta,
                rawLines: [],
                preview: { columns: [], rows: [], warnings: warnings },
                table: { columns: [], rows: [] }
            };
        }

        var headerIdx = detectHeaderRow(cleaned);
        var mapping, headerRow, dataRows;

        if (headerIdx === -1) {
            warnings.push('Baslik satiri tespit edilemedi. Kolon eslemesi bos — manuel eslesme gerekecek.');
            mapping = {};
            headerRow = cleaned[0];
            dataRows = cleaned; // hicbir basligi atma; hepsi veri kabul edilir
        } else {
            headerRow = cleaned[headerIdx];
            mapping = detectColumnMapping(headerRow);
            dataRows = cleaned.slice(headerIdx + 1);
        }

        // 076-L: alt-toplam satirlarini (Ara/Net/KDV/Genel Toplam, İskonto...) urun
        //   satirlarindan AYIR → import_lines/table'a GIRMEZ. Miktarli gercek urun korunur.
        dataRows = dataRows.filter(function (row) { return !isTotalRow(row, mapping); });

        var mappedFields = Object.keys(mapping);
        if (mappedFields.indexOf('raw_name') === -1) {
            warnings.push('Urun adi kolonu tespit edilemedi (raw_name). Satirlar isimsiz olabilir.');
        }
        if (mapping.raw_unit_price == null && mapping.raw_line_total == null) {
            warnings.push('Birim fiyat ve tutar kolonlarinin IKISI de yok — bu satirlar ileride commit edilemez.');
        }

        // rawLines uret — raw_* ORIJINAL hucre metni (normalize EDILMEZ)
        var rawLines = [];
        dataRows.forEach(function (row) {
            if (isEmptyRow(row)) return;
            var line = {};
            SOURCE_FIELDS.forEach(function (f) {
                var idx = mapping[f];
                var val = (idx != null && idx < row.length) ? row[idx] : null;
                if (val == null) { line[f] = null; return; }
                val = String(val).trim();
                line[f] = val === '' ? null : val;
            });
            applyDiscountSemantics(line);
            // tamamen bos satiri (tum alanlar null) atla
            var allNull = SOURCE_FIELDS.every(function (f) { return line[f] == null; });
            if (!allNull) rawLines.push(line);
        });

        if (rawLines.length > SOFT_ROW_LIMIT) {
            warnings.push(rawLines.length + ' satir bulundu. RPC tek batch\'te ' + SOFT_ROW_LIMIT +
                ' satir kabul eder — cok faturali dosya ayri parcalara bolunmeli.');
        }
        if (rawLines.length === 0) {
            warnings.push('Eslestirilecek veri satiri bulunamadi.');
        }

        // preview
        var previewColumns = (headerRow || []).map(function (c) { return c == null ? '' : String(c); });
        var previewRows = dataRows.slice(0, PREVIEW_ROW_LIMIT).map(function (row) {
            return (row || []).map(function (c) { return c == null ? '' : String(c); });
        });

        // FULL MATRIX (073-B2) — header branch: gercek basliklar; no-header: bos
        // label'lar (tum satirlar veri). Orijinal kolon indeksleri korunur.
        var table = (headerIdx === -1)
            ? buildTable([], dataRows)
            : buildTable(headerRow, dataRows);

        batchMeta.detected_header_row = headerIdx === -1 ? null : (headerIdx + 1); // 1-tabanli (insan)
        batchMeta.column_mapping = mappedFields.length ? mapping : null;

        // 076-L: fatura metadata (tarih/tedarikci/no) + alt-toplam ozeti (best-effort).
        //   ORIJINAL rows uzerinde (dikey hizalama korunur). Bulunmazsa null → manuel.
        var invMeta = extractInvoiceMeta(rows);
        var footer  = extractFooterTotals(rows);
        if (invMeta.invoice_date)  batchMeta.invoice_date       = invMeta.invoice_date;
        batchMeta.delivery_date = invMeta.delivery_date || null;
        batchMeta.due_date      = invMeta.due_date || null;
        if (invMeta.supplier)      batchMeta.supplier_raw_text   = invMeta.supplier;
        if (invMeta.invoice_no)    batchMeta.invoice_external_no = invMeta.invoice_no;
        if (footer.genel_toplam != null) batchMeta.declared_total = footer.genel_toplam;
        // 076-L.4: dosyada bildirilen GENEL iskonto → batch alanları (commit'te SESSIZCE
        //   uygulanmaz; onay ekranında gösterilir + commit engellenir).
        if (footer.general_discount != null && footer.general_discount > 0) {
            batchMeta.general_discount_amount = footer.general_discount;
            batchMeta.general_discount_type   = 'amount';
        }

        batchMeta.parse_meta = Object.assign({}, batchMeta.parse_meta, {
            total_rows: cleaned.length,
            data_rows: rawLines.length,
            mapped_fields: mappedFields,
            table_columns: table.columns.length,
            table_rows: table.rows.length,
            invoice_summary: footer,
            detected_meta: invMeta
        });

        // Dosya toplami ile hesaplanan toplam farki (uyari — otomatik bozma YOK)
        if (footer.genel_toplam != null && rawLines.length > 0) {
            batchMeta.parse_meta.declared_total = footer.genel_toplam;
        }

        return {
            batchMeta: batchMeta,
            rawLines: rawLines,
            preview: { columns: previewColumns, rows: previewRows, warnings: warnings },
            table: table
        };
    }

    // ============================================================
    // computeFileHash — sha256 hex (crypto.subtle). Yoksa null.
    // ============================================================
    async function computeFileHash(arrayBuffer) {
        try {
            if (!window.crypto || !window.crypto.subtle) return null;
            var digest = await window.crypto.subtle.digest('SHA-256', arrayBuffer);
            var bytes = new Uint8Array(digest);
            var hex = '';
            for (var i = 0; i < bytes.length; i++) {
                hex += bytes[i].toString(16).padStart(2, '0');
            }
            return hex;
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------
    // decodeCsvBytes — UTF-8 (BOM strip); bozulursa Windows-1254 fallback.
    // ------------------------------------------------------------
    function decodeCsvBytes(arrayBuffer) {
        var bytes = new Uint8Array(arrayBuffer);
        var encoding = 'utf-8';

        // BOM tespit + strip
        if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            bytes = bytes.subarray(3);
            encoding = 'utf-8-bom';
        }

        var text;
        try {
            text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch (e) {
            text = '';
        }
        // UTF-8 bozulma isareti (replacement char) → Windows-1254 dene
        if (text.indexOf('�') !== -1) {
            try {
                var alt = new TextDecoder('windows-1254', { fatal: false }).decode(bytes);
                if (alt && alt.indexOf('�') === -1) {
                    text = alt;
                    encoding = 'windows-1254';
                }
            } catch (e2) { /* TextDecoder windows-1254 desteklemiyorsa utf-8'de kal */ }
        }
        return { text: text, encoding: encoding };
    }

    // ============================================================
    // parseCsvFile — async
    // ============================================================
    async function parseCsvFile(file, options) {
        options = options || {};
        var buffer = await file.arrayBuffer();
        var fileHash = await computeFileHash(buffer);

        var decoded = decodeCsvBytes(buffer);
        var text = decoded.text;
        var delimiter = options.delimiter || detectDelimiter(text);

        var lines = text.split(/\r\n|\r|\n/);
        var rows = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === '' && i === lines.length - 1) continue; // trailing newline
            rows.push(splitCsvLine(lines[i], delimiter));
        }

        var batchMeta = {
            source_type: 'csv',
            original_filename: file.name || null,
            file_hash: fileHash,
            sheet_name: null,
            delimiter: delimiter,
            encoding: decoded.encoding,
            detected_header_row: null,
            column_mapping: null,
            parse_meta: {}
        };

        return buildResultFromRows(rows, batchMeta);
    }

    // ============================================================
    // 076-L: scoreResult — bir sheet sonucunun "fatura tablosu" gucu
    //   Amac: coklu sayfada EN IYI tabloyu secmek.
    // ============================================================
    function scoreResult(res) {
        var m = (res && res.batchMeta && res.batchMeta.column_mapping) || {};
        var crit = ['raw_name', 'raw_qty', 'raw_unit', 'raw_unit_price', 'raw_vat', 'raw_line_total'];
        var score = 0;
        crit.forEach(function (f) { if (m[f] != null) score += 1; });
        if (m.raw_name != null) score += 2;                 // urun kolonu kritik
        var dataRows = (res && res.batchMeta && res.batchMeta.parse_meta && res.batchMeta.parse_meta.data_rows) || 0;
        if (dataRows > 0) score += 2;
        if (dataRows >= 2) score += 1;
        return score;
    }

    // ============================================================
    // parseXlsxFile — async. 076-L: TUM sayfalar taranir, en iyi fatura
    //   tablosu bulunan sayfa secilir (scoreResult). Gorunen deger; bos satir filtre.
    // ============================================================
    async function parseXlsxFile(file, options) {
        options = options || {};
        if (typeof XLSX === 'undefined') {
            throw new Error('Excel kutuphanesi (SheetJS) yuklenemedi.');
        }
        var buffer = await file.arrayBuffer();
        var fileHash = await computeFileHash(buffer);

        var workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
        if (!workbook.SheetNames || !workbook.SheetNames.length) {
            throw new Error('Excel icinde okunacak sayfa bulunamadi.');
        }
        var names = workbook.SheetNames;

        // 076-L.1: metadata (tarih/tedarikci/no) TUM sayfalardan toplanir. Cunku
        //   urun tablosu bir sayfada, fatura ust-bilgileri BASKA sayfada olabilir.
        //   Ilk boş-olmayan güvenilir deger kullanilir; cakisma varsa uyarilir.
        var META_KEYS = ['invoice_date', 'delivery_date', 'due_date', 'supplier', 'invoice_no'];
        var allMeta = { invoice_date: null, delivery_date: null, due_date: null, supplier: null, invoice_no: null };
        var metaSeen = { invoice_date: {}, delivery_date: {}, due_date: {}, supplier: {}, invoice_no: {} };

        var best = null, bestScore = -1, bestName = names[0];
        for (var i = 0; i < names.length; i++) {
            var ws = workbook.Sheets[names[i]];
            // header:1 → satir-dizisi; raw:false → formul yerine GORUNEN deger; defval:''
            var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

            // 076-L.3: metadata için raw:true + cellDates:true → tarih hücreleri GERÇEK
            //   Date objesi olur (format-string ambiguity "7/4/26" ve Excel serial çözülür).
            //   Ürün tablosu için rows (raw:false, görünen değer) ayrı okunur.
            var rowsMeta = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, cellDates: true, defval: '' });
            var sm = extractInvoiceMeta(rowsMeta);
            META_KEYS.forEach(function (k) {
                if (sm[k]) {
                    if (allMeta[k] == null) allMeta[k] = sm[k];
                    metaSeen[k][String(sm[k])] = true;
                }
            });

            var batchMeta = {
                source_type: 'xlsx',
                original_filename: file.name || null,
                file_hash: fileHash,
                sheet_name: names[i],
                delimiter: null,
                encoding: null,
                detected_header_row: null,
                column_mapping: null,
                parse_meta: { sheet_count: names.length }
            };
            var res = buildResultFromRows(rows, batchMeta);
            var sc = scoreResult(res);
            if (sc > bestScore) { bestScore = sc; best = res; bestName = names[i]; }
        }

        // 076-L.3: tüm-sayfa taramasından gelen değer OTORİTERdir (seçilen tablo
        //   sayfasının yanlış-pozitif "Urun"/"Fatura Tarihi" değerlerini EZER).
        var bm = best.batchMeta;
        if (allMeta.invoice_date)  bm.invoice_date       = allMeta.invoice_date;
        if (allMeta.delivery_date) bm.delivery_date      = allMeta.delivery_date;
        if (allMeta.due_date)      bm.due_date           = allMeta.due_date;
        if (allMeta.supplier)      bm.supplier_raw_text   = allMeta.supplier;
        if (allMeta.invoice_no)    bm.invoice_external_no = allMeta.invoice_no;
        bm.parse_meta = bm.parse_meta || {};
        bm.parse_meta.detected_meta = allMeta;

        // 076-L.3: hiç tarih bulunamadıysa açık uyarı (satır okuma bozulmaz).
        if (!bm.invoice_date && !bm.delivery_date && !bm.due_date) {
            best.preview.warnings.push('Fatura tarihi otomatik okunamadı — onay ekranında manuel seçin.');
        }

        // çakışma uyarısı (aynı alan farklı sayfalarda farklı) — sistemi bozma
        META_KEYS.forEach(function (k) {
            if (Object.keys(metaSeen[k]).length > 1) {
                best.preview.warnings.push('"' + k + '" birden fazla sayfada farklı görünüyor; ilk değer kullanıldı — kontrol edin.');
            }
        });

        if (names.length > 1) {
            best.preview.warnings.push('Dosyada ' + names.length +
                ' sayfa var; fatura tablosu icin "' + bestName + '" sayfasi secildi.');
        }
        if (bestScore <= 2) {
            best.preview.warnings.push('Güvenilir fatura tablosu otomatik bulunamadı. ' +
                'Lütfen kolonları manuel kontrol edip eşleştirin.');
        }
        return best;
    }

    // ============================================================
    // parseFile — uzantiya gore yonlendir
    // ============================================================
    async function parseFile(file, options) {
        if (!file) throw new Error('Dosya secilmedi.');
        var name = (file.name || '').toLowerCase();
        var isXlsx = /\.(xlsx|xls)$/.test(name) ||
            (file.type && file.type.indexOf('sheet') !== -1) ||
            (file.type && file.type.indexOf('excel') !== -1);
        var isCsv = /\.(csv|txt)$/.test(name) ||
            (file.type && file.type.indexOf('csv') !== -1);

        if (isXlsx) return parseXlsxFile(file, options);
        if (isCsv)  return parseCsvFile(file, options);

        // uzanti belirsiz → XLSX dene, olmazsa CSV
        try { return await parseXlsxFile(file, options); }
        catch (e) { return parseCsvFile(file, options); }
    }

    return {
        parseFile: parseFile,
        parseCsvFile: parseCsvFile,
        parseXlsxFile: parseXlsxFile,
        detectDelimiter: detectDelimiter,
        normalizeHeader: normalizeHeader,
        detectColumnMapping: detectColumnMapping,
        normalizeImportNumber: normalizeImportNumber,
        normalizeQuantityNumber: normalizeQuantityNumber,
        normalizeMoneyNumber: normalizeMoneyNumber,
        parseSequentialDiscountRates: parseSequentialDiscountRates,
        calculateSequentialDiscount: calculateSequentialDiscount,
        finalizeMoneyFromAuthoritativeNet: finalizeMoneyFromAuthoritativeNet,
        finalizeMoneyFromAuthoritativeDiscount: finalizeMoneyFromAuthoritativeDiscount,
        classifySourceAmountBasis: classifySourceAmountBasis,
        classifyDiscountEvidence: classifyDiscountEvidence,
        applyDiscountSemantics: applyDiscountSemantics,
        analyzeSourceLineBasis: analyzeSourceLineBasis,
        classifyLineType: classifyLineType,
        validateLineMath: validateLineMath
    };
})();

/* ============================================================
   MANUEL TEST NOTU (DevTools console — ImportParsers ile)
   ------------------------------------------------------------
   Hazirlik: bir <input type="file"> ile File al, veya drag&drop.
   Ornek:  const r = await ImportParsers.parseFile(file); console.log(r);

   1) TR NOKTALI VIRGUL CSV
      Icerik:  Urun;Miktar;Birim;Birim Fiyat;KDV;Tutar
               Dana Kiyma 80/20;5;kg;1.250,50;20;6.252,50
      Beklenti: delimiter ';', column_mapping 6 alan, raw_unit_price "1.250,50"
                HAM korunur (normalize EDILMEZ), raw_name "Dana Kiyma 80/20".

   2) VIRGULLU CSV
      Icerik:  Urun,Miktar,Birim Fiyat,Tutar
               Domates,10,18,180
      Beklenti: delimiter ',', sayilar tek hucre (TR ondalik YOK), 4 alan eslesir.
      DIKKAT: virgullu CSV'de "1.250,50" KIRILIR — kullaniciya ';' onerilmeli (UI isi).

   3) XLSX
      Ilk sayfa okunur, sheet_name dolu, formul yerine gorunen deger gelir,
      bos satirlar filtrelenir, coklu sayfa varsa warning.

   4) BOS DOSYA
      rawLines = [], preview.warnings "Dosya bos..." icerir, hata FIRLATMAZ.

   5) 2000+ SATIR
      rawLines tamami doner + warning "RPC tek batch'te 2000 satir kabul eder...".
      Parser CAP'LEMEZ; bolme karari cagirana (view) aittir.

   6) EKSIK KOLONLU DOSYA
      Yalniz "Urun, Miktar" varsa: mapping {raw_name, raw_qty}, warning
      "Birim fiyat ve tutar kolonlarinin IKISI de yok — commit edilemez".
      Hata FIRLATMAZ; staging yine de uretilir (permissive).

   7) TURKCE KARAKTERLI DOSYA
      UTF-8: dogru okunur. Windows-1254 (eski POS): UTF-8 decode'da �
      gorulurse otomatik windows-1254'e dusulur, encoding meta'da raporlanir.
      "Sucuk", "Yogurt", "Cig kofte" gibi kelimeler bozulmamali.

   GUVENLIK KONTROLU (her testte):
     - Cikti SADECE veri uretir; RPC/Supabase/DOM cagrisi YOK.
     - raw_* alanlari orijinal metin (kanit); normalizeImportNumber ayri yardimci.

   ------------------------------------------------------------
   FULL MATRIX (073-B2) — table alani
   ------------------------------------------------------------
   parseFile ciktisina EK olarak `table` doner (mevcut yapi BOZULMAZ):
     table.columns: [{ index, key:'col_<index>', label, normalized }]  ← TUM kolonlar
     table.rows:    [{ col_<index>: string|null, ... }]                ← TUM satirlar (full)

   Amac: import-view, parser'in OTOMATIK tanimadigi kolonlari da mapping
   dropdown'unda gosterebilsin. Ornek: "Mal Açıklaması" otomatik raw_name
   olarak taninmasa bile table.columns'ta yer alir → kullanici secebilir.

   GARANTILER:
     - Veri olan hicbir kolon kaybolmaz (yalniz tamamen-bos kolon filtrelenir).
     - Kolon `index` ORIJINAL pozisyondur → batchMeta.column_mapping (field→colIndex)
       ile birebir hizali; iki yapi cakismaz.
     - table.rows full'dur (preview gibi 20 ile sinirli degil); mapped-field
       filtresi YOK, bu yuzden rawLines.length ile ayni OLMAYABILIR (bagimsiz temsil).
     - rawLines + detectColumnMapping + normalizeHeader davranisi DEGISMEDI.

   TEST 8) FULL MATRIX
     Kolonlari ["Mal Aciklamasi","Adet","Olcu","Tutar"] olan dosyada:
       table.columns 4 kolon (label'lar dahil), table.rows tum satirlar.
       Parser raw_name'i otomatik bulamasa bile "Mal Aciklamasi" table'da DURUR.
   ============================================================ */
