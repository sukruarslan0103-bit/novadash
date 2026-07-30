'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ROOT,
    createBrowserContext,
    loadImportParsers,
    loadImportViewTestHooks
} = require('./helpers/browser-runtime');

const SQL_PATH = path.join(ROOT, 'sql', '079_multi_discount_staging_integration.sql');
const sql079 = fs.readFileSync(SQL_PATH, 'utf8');
// JavaScript Number 99999999999999.9999 değerini 100000000000000'e yuvarlar.
// Test-only model bu nedenle SQL üst sınırının bir sonraki tam sayısını
// exclusive limit olarak kullanır; SQL metni exact NUMERIC sınırı ayrıca test eder.
const AMOUNT_LIMIT_EXCLUSIVE = 100000000000000;
const PERSISTED_TYPED_KEYS = [
    'discount_rates',
    'discount_calculation_method',
    'discount_parse_status',
    'effective_discount_rate',
    'line_discount_amount',
    'calculated_gross_amount',
    'calculated_net_amount',
    'discount_review_required'
];
const TYPED_KEYS = PERSISTED_TYPED_KEYS.concat(['calculation_input_gross_amount']);

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundRate(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

// Migration çalıştırılmadan zorunlu kabul/red fixture'larını aynı sözleşmeyle
// sınayan test-only referans. Aşağıdaki statik testler her kuralın SQL gövdesinde
// de bulunduğunu ayrıca kilitler.
function validateTypedLine(line) {
    const typed = TYPED_KEYS.some((key) => hasOwn(line, key));
    const method = line.discount_calculation_method == null ? null : line.discount_calculation_method;
    const status = line.discount_parse_status == null ? null : line.discount_parse_status;
    const review = line.discount_review_required == null ? false : line.discount_review_required;

    if (hasOwn(line, 'discount_calculation_method') &&
        line.discount_calculation_method != null &&
        typeof line.discount_calculation_method !== 'string') {
        return { ok: false, reason: 'method_type' };
    }
    if (hasOwn(line, 'discount_parse_status') &&
        line.discount_parse_status != null &&
        typeof line.discount_parse_status !== 'string') {
        return { ok: false, reason: 'status_type' };
    }
    if (typed && (method == null || method === '' || status == null || status === '')) {
        return { ok: false, reason: 'typed_contract' };
    }
    if (hasOwn(line, 'discount_review_required') &&
        line.discount_review_required != null &&
        typeof line.discount_review_required !== 'boolean') {
        return { ok: false, reason: 'review_type' };
    }

    let rates = null;
    if (hasOwn(line, 'discount_rates') && line.discount_rates != null) {
        if (!Array.isArray(line.discount_rates)) return { ok: false, reason: 'rates_type' };
        if (line.discount_rates.length < 1 || line.discount_rates.length > 3) {
            return { ok: false, reason: 'rates_length' };
        }
        if (line.discount_rates.some((rate) =>
            typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100)) {
            return { ok: false, reason: 'rate_value' };
        }
        rates = line.discount_rates;
    }

    const numericFields = [
        'effective_discount_rate',
        'line_discount_amount',
        'calculated_gross_amount',
        'calculated_net_amount',
        'calculation_input_gross_amount'
    ];
    for (const field of numericFields) {
        if (hasOwn(line, field) && line[field] != null &&
            (typeof line[field] !== 'number' || !Number.isFinite(line[field]))) {
            return { ok: false, reason: `${field}_type` };
        }
    }

    const effective = line.effective_discount_rate == null ? null : line.effective_discount_rate;
    const discount = line.line_discount_amount == null ? null : line.line_discount_amount;
    const gross = line.calculated_gross_amount == null ? null : line.calculated_gross_amount;
    const net = line.calculated_net_amount == null ? null : line.calculated_net_amount;
    const inputGross = line.calculation_input_gross_amount == null
        ? null
        : line.calculation_input_gross_amount;

    if (effective != null && (effective < 0 || effective > 100)) {
        return { ok: false, reason: 'effective_range' };
    }
    for (const [field, value] of [
        ['discount', discount],
        ['gross', gross],
        ['net', net]
    ]) {
        if (value != null && (value < 0 || value >= AMOUNT_LIMIT_EXCLUSIVE)) {
            return { ok: false, reason: `${field}_range` };
        }
    }
    if (gross != null && net != null && net > gross + 0.01) {
        return { ok: false, reason: 'net_over_gross' };
    }
    if (inputGross != null && inputGross < 0) {
        return { ok: false, reason: 'input_gross_range' };
    }

    if (method === 'single' && (!rates || rates.length !== 1)) {
        return { ok: false, reason: 'single_evidence' };
    }
    if (method === 'sequential' && (!rates || rates.length < 2 || rates.length > 3)) {
        return { ok: false, reason: 'sequential_evidence' };
    }
    if (method === 'explicit_amount' && discount == null) {
        return { ok: false, reason: 'explicit_evidence' };
    }
    if (method === 'derived_effective' && effective == null) {
        return { ok: false, reason: 'derived_evidence' };
    }
    if (method === 'none' && rates && !(rates.length === 1 && rates[0] === 0)) {
        return { ok: false, reason: 'none_evidence' };
    }
    if (typed && status === 'parsed' && review) {
        return { ok: false, reason: 'parsed_review' };
    }
    if (typed && status === 'not_present' && (method !== 'none' || review)) {
        return { ok: false, reason: 'not_present_shape' };
    }
    if (['unsupported', 'ambiguous', 'mismatch'].includes(status) && !review) {
        return { ok: false, reason: 'review_required' };
    }

    if (typed && status === 'parsed' &&
        ['single', 'sequential', 'explicit_amount', 'derived_effective'].includes(method) &&
        (gross == null || net == null || discount == null || effective == null)) {
        return { ok: false, reason: 'parsed_completeness' };
    }
    if (typed && status === 'parsed' && ['single', 'sequential'].includes(method) &&
        inputGross == null) {
        return { ok: false, reason: 'input_gross_required' };
    }

    if (typed && status === 'parsed' &&
        ((gross != null && roundMoney(gross) !== gross) ||
         (net != null && roundMoney(net) !== net) ||
         (discount != null && roundMoney(discount) !== discount) ||
         (effective != null && roundRate(effective) !== effective))) {
        return { ok: false, reason: 'parsed_precision' };
    }

    if (gross != null && discount != null && discount > gross &&
        !(status === 'mismatch' && review && net == null && effective == null)) {
        return { ok: false, reason: 'discount_over_gross' };
    }

    const round4 = roundRate;
    if (status === 'parsed' && gross != null && net != null && discount != null &&
        round4(gross) !== round4(round4(net) + round4(discount))) {
        return { ok: false, reason: 'money_invariant' };
    }

    if (status === 'parsed' && gross != null && discount != null && effective != null) {
        const storedGross = round4(gross);
        if (storedGross === 0) return { ok: false, reason: 'zero_storage_gross' };
        const expectedEffective = round4(round4(discount) / storedGross * 100);
        if (round4(effective) !== expectedEffective) {
            return { ok: false, reason: 'effective_amount_mismatch' };
        }
    }

    if (status === 'parsed' && ['single', 'sequential'].includes(method)) {
        const preciseNet = rates.reduce(
            (amount, rate) => amount * (1 - rate / 100),
            inputGross
        );
        const expectedGross = roundMoney(inputGross);
        const expectedNet = roundMoney(preciseNet);
        const expectedDiscount = roundMoney(expectedGross - expectedNet);
        const expectedEffective = expectedGross === 0
            ? 0
            : roundRate(expectedDiscount / expectedGross * 100);
        if (gross !== expectedGross ||
            net !== expectedNet ||
            discount !== expectedDiscount ||
            effective !== expectedEffective) {
            return { ok: false, reason: 'rate_money_mismatch' };
        }
    }

    if (typed && method === 'none' && ['parsed', 'not_present'].includes(status) &&
        (effective == null || round4(effective) !== 0 ||
         discount == null || round4(discount) !== 0 ||
         (rates && !(rates.length === 1 && round4(rates[0]) === 0)) ||
         (gross != null && net != null && round4(gross) !== round4(net)))) {
        return { ok: false, reason: 'none_shape' };
    }

    if (typed && line.line_type === 'promotion' &&
        !(status === 'parsed' && !review && gross != null && gross > 0 &&
          net === 0 && discount === gross && effective === 100)) {
        return { ok: false, reason: 'promotion_shape' };
    }

    if (typed && status === 'parsed' && !review && gross > 0 &&
        net === 0 && discount === gross && effective === 100 &&
        line.line_type !== 'promotion') {
        return { ok: false, reason: 'promotion_required' };
    }

    return { ok: true };
}

function canonicalTyped(overrides = {}) {
    const line = Object.assign({
        line_type: 'normal',
        discount_rates: null,
        discount_calculation_method: 'explicit_amount',
        discount_parse_status: 'parsed',
        effective_discount_rate: 10,
        line_discount_amount: 10,
        calculated_gross_amount: 100,
        calculated_net_amount: 90,
        calculation_input_gross_amount: 100,
        discount_review_required: false
    }, overrides);
    if (!hasOwn(overrides, 'calculation_input_gross_amount') &&
        hasOwn(overrides, 'calculated_gross_amount')) {
        line.calculation_input_gross_amount = overrides.calculated_gross_amount;
    }
    return line;
}

function oldHalfCentEnvelopeAccepts(line) {
    const roundedEnvelopeNet = (scaledGross) => {
        let numerator = BigInt(scaledGross);
        let denominator = 1n;
        for (const rate of line.discount_rates) {
            const rateScaled = BigInt(Math.round(rate * 10000));
            numerator *= 1000000n - rateScaled;
            denominator *= 1000000n;
        }
        const centDenominator = 10n * denominator;
        return Number((numerator + centDenominator / 2n) / centDenominator) / 100;
    };
    const grossScaled = Math.round(line.calculated_gross_amount * 1000);
    const minNet = roundedEnvelopeNet(grossScaled - 5);
    const maxNet = roundedEnvelopeNet(grossScaled + 5);
    const expectedDiscount = roundMoney(
        roundMoney(line.calculated_gross_amount) -
        roundMoney(line.calculated_net_amount)
    );
    return roundMoney(line.calculated_net_amount) >= Math.min(minNet, maxNet) &&
        roundMoney(line.calculated_net_amount) <= Math.max(minNet, maxNet) &&
        roundMoney(line.line_discount_amount) === expectedDiscount;
}

function buildPayloadLines(fixtures) {
    const context = createBrowserContext();
    loadImportParsers(context);
    const view = loadImportViewTestHooks(context);
    const headers = ['Ürün', 'Miktar', 'Birim Fiyat', 'İskonto', 'Satır Tutarı'];
    const rows = fixtures.map((fixture) => [
        fixture.name,
        fixture.quantity == null ? null : String(fixture.quantity),
        fixture.unitPrice == null ? null : String(fixture.unitPrice),
        fixture.rates.join('+'),
        fixture.lineTotal == null ? null : String(fixture.lineTotal)
    ]);
    const mapping = {
        raw_name: 0,
        raw_qty: 1,
        raw_unit_price: 2,
        raw_discount: 3,
        raw_line_total: 4
    };
    const columnSeries = {};
    headers.forEach((_, index) => {
        columnSeries[index] = rows.map((row) => row[index]);
    });
    view.setState({
        parse: {
            rawLines: [],
            table: { columns: headers, rows },
            batchMeta: {
                source_type: 'xlsx',
                original_filename: 'precise-gross.xlsx',
                file_hash: 'precise-gross',
                column_mapping: mapping,
                parse_meta: {}
            }
        },
        useTable: true,
        sourceColumns: headers.map((header, colIndex) => ({ header, colIndex })),
        columnSeries,
        userMapping: mapping,
        tenantKey: 'tenant-test'
    });
    return view.buildPayload().p_lines;
}

function buildPayloadLine(quantity, unitPrice, rates) {
    return buildPayloadLines([{
        name: 'Precise Gross',
        quantity,
        unitPrice,
        rates,
        lineTotal: null
    }])[0];
}

function splitTopLevelCommaList(source) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let quote = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (char === "'" && source[i - 1] !== '\\') quote = !quote;
        if (quote) continue;
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ',' && depth === 0) {
            parts.push(source.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(source.slice(start).trim());
    return parts.filter(Boolean);
}

test('079 strict scalar JSON number tipini cast öncesinde beş alanda zorunlu kılar', () => {
    for (const field of [
        'effective_discount_rate',
        'line_discount_amount',
        'calculated_gross_amount',
        'calculated_net_amount',
        'calculation_input_gross_amount'
    ]) {
        assert.match(
            sql079,
            new RegExp(
                `v_line \\? '${field}'[\\s\\S]*?jsonb_typeof\\(v_line->'${field}'\\) NOT IN \\('number', 'null'\\)`
            ),
            field
        );
    }
});

test('079 discount_rates container, uzunluk, eleman JSON number ve ordered array sözleşmesini kurar', () => {
    assert.match(sql079, /jsonb_typeof\(v_line->'discount_rates'\) <> 'array'/);
    assert.match(sql079, /jsonb_array_length\(v_line->'discount_rates'\) NOT BETWEEN 1 AND 3/);
    assert.match(sql079, /WHERE jsonb_typeof\(rate\.value\) <> 'number'/);
    assert.match(sql079, /array_agg\(\(rate\.value #>> '\{\}'\)::NUMERIC ORDER BY rate\.ord\)/);
    assert.match(sql079, /public\.is_valid_discount_rates\(v_rates\)/);
});

test('079 NUMERIC(18,4) kapasitesini üç amount alanında INSERT öncesinde sınırlar', () => {
    assert.equal(
        (sql079.match(/> 99999999999999\.9999/g) || []).length,
        3
    );
    for (const field of [
        'line_discount_amount',
        'calculated_gross_amount',
        'calculated_net_amount'
    ]) {
        assert.match(sql079, new RegExp(`${field} finite ve 0\\.\\.99999999999999\\.9999`));
    }
});

test('079 gross aşımını yalnız eksiksiz mismatch audit şekline izin verecek biçimde doğrular', () => {
    assert.match(
        sql079,
        /v_discount_amount > v_calc_gross AND \([\s\S]*v_parse_status IS DISTINCT FROM 'mismatch'[\s\S]*NOT v_review[\s\S]*v_calc_net IS NOT NULL[\s\S]*v_effective IS NOT NULL/
    );

    assert.deepEqual(validateTypedLine(canonicalTyped({
        discount_parse_status: 'mismatch',
        discount_review_required: true,
        effective_discount_rate: null,
        line_discount_amount: 100.05,
        calculated_net_amount: null
    })), { ok: true });

    assert.equal(validateTypedLine(canonicalTyped({
        effective_discount_rate: 100,
        line_discount_amount: 100.05,
        calculated_net_amount: 0
    })).reason, 'discount_over_gross');
});

test('079 parsed kanonik para invariantını operandları storage hassasiyetinde ayrı yuvarlayarak uygular', () => {
    assert.match(
        sql079,
        /v_parse_status = 'parsed'[\s\S]*round\(v_calc_gross, 4\) <>[\s\S]*round\(round\(v_calc_net, 4\) \+ round\(v_discount_amount, 4\), 4\)/
    );
    assert.deepEqual(validateTypedLine(canonicalTyped()), { ok: true });
    assert.equal(validateTypedLine(canonicalTyped({
        calculated_net_amount: 90,
        line_discount_amount: 5
    })).reason, 'money_invariant');
    assert.equal(validateTypedLine(canonicalTyped({
        effective_discount_rate: 0.4985,
        calculated_gross_amount: 1.00505,
        calculated_net_amount: 1.00004,
        line_discount_amount: 0.00501
    })).reason, 'parsed_precision');
});

test('079 effective rate değerini storage-rounded gross ve discount tutarından doğrular', () => {
    assert.match(
        sql079,
        /round\(v_calc_gross, 4\) = 0[\s\S]*v_expected_effective := round\([\s\S]*round\(v_discount_amount, 4\) \/ round\(v_calc_gross, 4\) \* 100,[\s\S]*4[\s\S]*round\(v_effective, 4\) <> v_expected_effective/
    );

    assert.deepEqual(validateTypedLine(canonicalTyped({
        effective_discount_rate: 9.9595,
        line_discount_amount: 1.23,
        calculated_gross_amount: 12.35,
        calculated_net_amount: 11.12
    })), { ok: true });
    assert.equal(validateTypedLine(canonicalTyped({
        effective_discount_rate: 7
    })).reason, 'effective_amount_mismatch');
    assert.equal(validateTypedLine(canonicalTyped({
        effective_discount_rate: 0,
        line_discount_amount: 0,
        calculated_gross_amount: 0,
        calculated_net_amount: 0
    })).reason, 'zero_storage_gross');
});

test('079 parsed single method nominal rate yerine kanonik para sonucunu doğrular', () => {
    assert.match(
        sql079,
        /v_parse_status = 'parsed' AND v_method IN \('single', 'sequential'\)[\s\S]*v_precise_net := v_input_gross[\s\S]*FOREACH v_rate_double IN ARRAY v_rates_double[\s\S]*v_precise_net := v_precise_net \* \(1\.0 - v_rate_double \/ 100\.0\)/
    );
    assert.doesNotMatch(
        sql079,
        /round\(v_effective, 4\)\s*(?:<>|=)\s*round\(v_rates\[1\], 4\)/
    );
    assert.deepEqual(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'single',
        discount_rates: [10],
        calculated_gross_amount: 12.34,
        calculated_net_amount: 11.11,
        line_discount_amount: 1.23,
        effective_discount_rate: 9.9676
    })), { ok: true });
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'single',
        discount_rates: [10],
        effective_discount_rate: 20,
        line_discount_amount: 20,
        calculated_net_amount: 80
    })).reason, 'rate_money_mismatch');
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'single',
        discount_rates: [10],
        effective_discount_rate: 10.01,
        line_discount_amount: 10.01,
        calculated_net_amount: 89.99
    })).reason, 'rate_money_mismatch');
});

test('079 parsed sequential method precise gross üzerinde oranları sırayla uygular', () => {
    assert.match(
        sql079,
        /FOREACH v_rate_double IN ARRAY v_rates_double[\s\S]*v_precise_net := v_precise_net \* \(1\.0 - v_rate_double \/ 100\.0\)/
    );
    assert.deepEqual(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'sequential',
        discount_rates: [10, 5],
        effective_discount_rate: 14.5,
        line_discount_amount: 14.5,
        calculated_net_amount: 85.5
    })), { ok: true });
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'sequential',
        discount_rates: [10, 5],
        effective_discount_rate: 15,
        line_discount_amount: 15,
        calculated_net_amount: 85
    })).reason, 'rate_money_mismatch');
});

test('079 rounded gross yeniden hesaplama hatasını gerçek 12.345 parser sonuçlarıyla kanıtlar ve düzeltir', () => {
    const context = createBrowserContext();
    const parsers = loadImportParsers(context);
    const cases = [
        {
            rawDiscount: '10',
            expected: { gross: 12.35, net: 11.11, discount: 1.24, effective: 10.0405 }
        },
        {
            rawDiscount: '10+5',
            expected: { gross: 12.35, net: 10.55, discount: 1.8, effective: 14.5749 }
        }
    ];

    for (const fixture of cases) {
        const parserResult = parsers.classifyDiscountEvidence({
            raw_qty: '1.5',
            raw_unit_price: '8.23',
            raw_discount: fixture.rawDiscount,
            raw_line_total: null
        });
        assert.deepEqual({
            gross: parserResult.calculated_gross_amount,
            net: parserResult.calculated_net_amount,
            discount: parserResult.line_discount_amount,
            effective: parserResult.effective_discount_rate
        }, fixture.expected);

        const oldRecalculation = parsers.calculateSequentialDiscount(
            parserResult.calculated_gross_amount,
            Array.from(parserResult.discount_rates)
        );
        assert.notDeepEqual({
            net: oldRecalculation.calculated_net_amount,
            discount: oldRecalculation.line_discount_amount
        }, {
            net: parserResult.calculated_net_amount,
            discount: parserResult.line_discount_amount
        });

        assert.deepEqual(validateTypedLine(canonicalTyped({
            discount_rates: Array.from(parserResult.discount_rates),
            discount_calculation_method: parserResult.discount_calculation_method,
            effective_discount_rate: parserResult.effective_discount_rate,
            line_discount_amount: parserResult.line_discount_amount,
            calculated_gross_amount: parserResult.calculated_gross_amount,
            calculated_net_amount: parserResult.calculated_net_amount,
            calculation_input_gross_amount: parserResult.calculation_input_gross_amount
        })), { ok: true });
    }
});

test('079 raw gross 12.354 single parser sonucunu precise gross kanıtıyla kabul eder', () => {
    const context = createBrowserContext();
    const parsers = loadImportParsers(context);
    const result = parsers.calculateSequentialDiscount(12.354, [10]);
    assert.deepEqual(validateTypedLine(canonicalTyped({
        discount_rates: Array.from(result.discount_rates),
        discount_calculation_method: result.discount_calculation_method,
        effective_discount_rate: result.effective_discount_rate,
        line_discount_amount: result.line_discount_amount,
        calculated_gross_amount: result.calculated_gross_amount,
        calculated_net_amount: result.calculated_net_amount,
        calculation_input_gross_amount: result.calculation_input_gross_amount
    })), { ok: true });
});

test('079 gerçek parser single/sequential sonuçlarını cross-layer matriste kabul eder', () => {
    const context = createBrowserContext();
    const parsers = loadImportParsers(context);
    const scenarios = [
        { gross: 12.34, rates: [10] },
        { gross: 100, rates: [0.05] },
        { gross: 999.99, rates: [33.3333] },
        { gross: 100, rates: [100] },
        { gross: 12.34, rates: [10, 5] },
        { gross: 1000, rates: [10, 5] },
        { gross: 999.99, rates: [7.5, 2.25, 1] },
        { gross: 100, rates: [100, 5] }
    ];

    for (const scenario of scenarios) {
        const parserResult = parsers.calculateSequentialDiscount(
            scenario.gross,
            scenario.rates
        );
        assert.equal(parserResult.status, 'parsed');

        const typedLine = canonicalTyped({
            line_type: parserResult.calculated_net_amount === 0 &&
                parserResult.line_discount_amount > 0 ? 'promotion' : 'normal',
            discount_rates: Array.from(parserResult.discount_rates),
            discount_calculation_method: parserResult.discount_calculation_method,
            effective_discount_rate: parserResult.effective_discount_rate,
            line_discount_amount: parserResult.line_discount_amount,
            calculated_gross_amount: parserResult.calculated_gross_amount,
            calculated_net_amount: parserResult.calculated_net_amount,
            calculation_input_gross_amount: parserResult.calculation_input_gross_amount
        });
        assert.deepEqual(
            validateTypedLine(typedLine),
            { ok: true },
            JSON.stringify(scenario)
        );
        assert.equal(
            roundRate(parserResult.calculated_gross_amount),
            roundRate(
                roundRate(parserResult.calculated_net_amount) +
                roundRate(parserResult.line_discount_amount)
            ),
            JSON.stringify(scenario)
        );
    }
});

test('079 gross 12.34 ve [10,5] gerçek parser probe sonucunu kilitler', () => {
    const context = createBrowserContext();
    const parsers = loadImportParsers(context);
    const result = parsers.calculateSequentialDiscount(12.34, [10, 5]);
    assert.deepEqual({
        calculated_gross_amount: result.calculated_gross_amount,
        calculated_net_amount: result.calculated_net_amount,
        line_discount_amount: result.line_discount_amount,
        effective_discount_rate: result.effective_discount_rate
    }, {
        calculated_gross_amount: 12.34,
        calculated_net_amount: 10.55,
        line_discount_amount: 1.79,
        effective_discount_rate: 14.5057
    });
});

test('079 none method ve typed status/review kanonik sözleşmelerini uygular', () => {
    assert.match(
        sql079,
        /v_has_typed AND v_parse_status = 'parsed' AND v_review[\s\S]*v_parse_status = 'not_present'[\s\S]*v_method IS DISTINCT FROM 'none' OR v_review/
    );
    assert.match(
        sql079,
        /v_has_typed AND v_method = 'none'[\s\S]*v_parse_status IN \('parsed', 'not_present'\)[\s\S]*round\(v_effective, 4\) <> 0[\s\S]*round\(v_discount_amount, 4\) <> 0[\s\S]*round\(v_calc_gross, 4\) <> round\(v_calc_net, 4\)/
    );

    assert.deepEqual(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'none',
        discount_parse_status: 'not_present',
        discount_rates: null,
        effective_discount_rate: 0,
        line_discount_amount: 0,
        calculated_net_amount: 100
    })), { ok: true });
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'none'
    })).reason, 'none_shape');
    assert.equal(validateTypedLine(canonicalTyped({
        discount_review_required: true
    })).reason, 'parsed_review');
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'explicit_amount',
        discount_parse_status: 'not_present',
        effective_discount_rate: 0,
        line_discount_amount: 0,
        calculated_net_amount: 100
    })).reason, 'not_present_shape');
});

test('079 parsed precision ve dört-alan completeness sözleşmelerini uygular', () => {
    assert.match(
        sql079,
        /v_method IN \('single', 'sequential', 'explicit_amount', 'derived_effective'\)[\s\S]*v_calc_gross IS NULL[\s\S]*v_calc_net IS NULL[\s\S]*v_discount_amount IS NULL[\s\S]*v_effective IS NULL/
    );
    assert.match(
        sql079,
        /v_parse_status = 'parsed'[\s\S]*round\(v_calc_gross, 2\) <> v_calc_gross[\s\S]*round\(v_calc_net, 2\) <> v_calc_net[\s\S]*round\(v_discount_amount, 2\) <> v_discount_amount[\s\S]*round\(v_effective, 4\) <> v_effective/
    );

    assert.equal(validateTypedLine(canonicalTyped({
        calculated_gross_amount: 100.001
    })).reason, 'parsed_precision');
    assert.equal(validateTypedLine(canonicalTyped({
        calculated_gross_amount: null,
        calculated_net_amount: null,
        effective_discount_rate: null
    })).reason, 'parsed_completeness');
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'derived_effective',
        line_discount_amount: null,
        calculated_gross_amount: null,
        calculated_net_amount: null
    })).reason, 'parsed_completeness');
    assert.deepEqual(validateTypedLine(canonicalTyped({
        discount_parse_status: 'mismatch',
        discount_review_required: true,
        effective_discount_rate: null,
        calculated_net_amount: null,
        line_discount_amount: 10.1234
    })), { ok: true });
});

test('079 typed promotion ortak kanonik şeklini zorunlu kılar ve legacy satırı kırmaz', () => {
    assert.match(
        sql079,
        /v_has_typed AND NULLIF\(v_line->>'line_type', ''\) = 'promotion'[\s\S]*v_parse_status IS DISTINCT FROM 'parsed'[\s\S]*v_review[\s\S]*v_calc_gross <= 0[\s\S]*v_calc_net IS DISTINCT FROM 0[\s\S]*v_discount_amount IS DISTINCT FROM v_calc_gross[\s\S]*v_effective IS DISTINCT FROM 100/
    );

    assert.deepEqual(validateTypedLine(canonicalTyped({
        line_type: 'promotion',
        effective_discount_rate: 100,
        line_discount_amount: 100,
        calculated_net_amount: 0
    })), { ok: true });

    assert.equal(validateTypedLine(canonicalTyped({
        line_type: 'promotion',
        effective_discount_rate: 50,
        line_discount_amount: 50,
        calculated_net_amount: 50
    })).reason, 'promotion_shape');

    assert.equal(validateTypedLine(canonicalTyped({
        line_type: 'normal',
        discount_calculation_method: 'single',
        discount_rates: [100],
        effective_discount_rate: 100,
        line_discount_amount: 100,
        calculated_net_amount: 0
    })).reason, 'promotion_required');

    assert.deepEqual(validateTypedLine(canonicalTyped({
        line_type: 'promotion',
        discount_calculation_method: 'sequential',
        discount_rates: [100, 5],
        effective_discount_rate: 100,
        line_discount_amount: 100,
        calculated_net_amount: 0
    })), { ok: true });

    assert.match(
        sql079,
        /v_calc_net = 0[\s\S]*v_discount_amount = v_calc_gross[\s\S]*v_effective = 100[\s\S]*line_type', ''\) IS DISTINCT FROM 'promotion'/
    );

    assert.deepEqual(validateTypedLine({
        raw_name: 'Legacy bedelsiz satır',
        raw_qty: '1',
        raw_unit_price: '100',
        line_type: 'promotion'
    }), { ok: true });
});

test('079 string/boş/özel scalar ile boolean, object ve array scalar değerlerini reddeder', () => {
    for (const invalidGross of ['100', '', 'NaN', 'Infinity', true, {}, [100], NaN, Infinity]) {
        assert.equal(
            validateTypedLine(canonicalTyped({ calculated_gross_amount: invalidGross })).ok,
            false,
            String(invalidGross)
        );
    }
});

test('079 string rate array ve boş rate array değerlerini reddeder', () => {
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'sequential',
        discount_rates: ['10', '5']
    })).reason, 'rate_value');
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'sequential',
        discount_rates: []
    })).reason, 'rates_length');
});

test('079 NUMERIC(18,4) kapasitesini aşan gross/net/discount fixturelarını reddeder', () => {
    const tooLarge = 100000000000000;
    for (const field of [
        'line_discount_amount',
        'calculated_gross_amount',
        'calculated_net_amount'
    ]) {
        const result = validateTypedLine(canonicalTyped({ [field]: tooLarge }));
        const reasonField = field === 'line_discount_amount'
            ? 'discount'
            : (field === 'calculated_gross_amount' ? 'gross' : 'net');
        assert.equal(result.reason, `${reasonField}_range`, field);
    }
});

test('079 mevcut review ve method/rates kanıt korumalarını sürdürür', () => {
    for (const status of ['mismatch', 'ambiguous', 'unsupported']) {
        assert.equal(validateTypedLine(canonicalTyped({
            discount_parse_status: status,
            discount_review_required: false
        })).reason, 'review_required');
    }
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'sequential',
        discount_rates: null
    })).reason, 'sequential_evidence');
    assert.equal(validateTypedLine(canonicalTyped({
        discount_calculation_method: 'single',
        discount_rates: [10, 5]
    })).reason, 'single_evidence');
});

test('079 eski yarım-kuruş zarfının false reject ve false accept kusurlarını kilitler', () => {
    const validParserLine = {
        discount_rates: [88],
        calculated_gross_amount: 78.38,
        calculated_net_amount: 9.40,
        line_discount_amount: 68.98
    };
    const unproducibleLine = {
        discount_rates: [88],
        calculated_gross_amount: 80.37,
        calculated_net_amount: 9.65,
        line_discount_amount: 70.72
    };
    assert.equal(oldHalfCentEnvelopeAccepts(validParserLine), false);
    assert.equal(oldHalfCentEnvelopeAccepts(unproducibleLine), true);
});

test('079 precise gross ile JavaScript roundMoney/roundRate algoritmasını birebir uygular', () => {
    assert.match(sql079, /v_input_gross DOUBLE PRECISION/);
    assert.match(sql079, /v_rates_double DOUBLE PRECISION\[\]/);
    assert.match(
        sql079,
        /floor\([\s\S]*v_input_gross \+ 2\.220446049250313e-16::DOUBLE PRECISION[\s\S]*100\.0[\s\S]*\+ 0\.5[\s\S]*\/ 100\.0/
    );
    assert.match(
        sql079,
        /v_expected_effective_double := CASE[\s\S]*v_expected_gross_double = 0[\s\S]*10000\.0[\s\S]*\/ 10000\.0/
    );
    assert.match(
        sql079,
        /v_calc_gross::DOUBLE PRECISION IS DISTINCT FROM v_expected_gross_double[\s\S]*v_calc_net::DOUBLE PRECISION IS DISTINCT FROM v_expected_net_double[\s\S]*v_discount_amount::DOUBLE PRECISION IS DISTINCT FROM v_expected_discount_double[\s\S]*v_effective::DOUBLE PRECISION IS DISTINCT FROM v_expected_effective_double/
    );
    assert.doesNotMatch(
        sql079,
        /v_min_precise_net|v_max_precise_net|v_min_expected_net|v_max_expected_net|\b0\.005\b/
    );
});

test('079 gerçek parser → buildPayload → referans doğrulamasında precise gross matrisini kabul eder', () => {
    const scenarios = [
        {
            quantity: 1.5, unitPrice: 52.25, rates: [88],
            expected: [78.38, 9.40, 68.98, 88.0071]
        },
        {
            quantity: 1.5, unitPrice: 8.23, rates: [10],
            expected: [12.35, 11.11, 1.24, 10.0405]
        },
        {
            quantity: 1.5, unitPrice: 8.23, rates: [10, 5],
            expected: [12.35, 10.55, 1.80, 14.5749]
        },
        {
            quantity: 1, unitPrice: 80.37499999999999, rates: [88],
            expected: [80.37, 9.64, 70.73, 88.0055]
        }
    ];

    for (const scenario of scenarios) {
        const line = buildPayloadLine(
            scenario.quantity,
            scenario.unitPrice,
            scenario.rates
        );
        assert.deepEqual([
            line.calculated_gross_amount,
            line.calculated_net_amount,
            line.line_discount_amount,
            line.effective_discount_rate
        ], scenario.expected, JSON.stringify(scenario));
        assert.equal(
            line.calculation_input_gross_amount,
            scenario.quantity * scenario.unitPrice
        );
        assert.deepEqual(validateTypedLine(line), { ok: true }, JSON.stringify(line));
    }
});

test('079 üretilemeyen 80.37/9.65/70.72/87.9930 payloadını precise gross çapraz kontrolüyle reddeder', () => {
    const forged = canonicalTyped({
        discount_calculation_method: 'single',
        discount_rates: [88],
        calculated_gross_amount: 80.37,
        calculated_net_amount: 9.65,
        line_discount_amount: 70.72,
        effective_discount_rate: 87.993
    });
    assert.equal(validateTypedLine(Object.assign({}, forged, {
        calculation_input_gross_amount: 80.375
    })).reason, 'rate_money_mismatch');
    assert.equal(validateTypedLine(Object.assign({}, forged, {
        calculation_input_gross_amount: 80.37499999999999
    })).reason, 'rate_money_mismatch');
});

test('079 precise gross promotion [100] ve [100,5] sonuçlarını kabul eder', () => {
    for (const rates of [[100], [100, 5]]) {
        const line = buildPayloadLine(1, 100, rates);
        assert.equal(line.line_type, 'promotion');
        assert.equal(line.calculated_net_amount, 0);
        assert.equal(line.line_discount_amount, 100);
        assert.equal(line.effective_discount_rate, 100);
        assert.deepEqual(validateTypedLine(line), { ok: true });
    }
});

test('079 calculation_input_gross_amount strict tip, null, non-finite/overflow ve negatif girdileri reddeder', () => {
    const single = canonicalTyped({
        discount_calculation_method: 'single',
        discount_rates: [10]
    });
    const cases = [
        ['100', 'calculation_input_gross_amount_type'],
        [null, 'input_gross_required'],
        [Infinity, 'calculation_input_gross_amount_type'],
        [Number.MAX_VALUE * 2, 'calculation_input_gross_amount_type'],
        [-1, 'input_gross_range']
    ];
    for (const [value, reason] of cases) {
        assert.equal(
            validateTypedLine(Object.assign({}, single, {
                calculation_input_gross_amount: value
            })).reason,
            reason,
            String(value)
        );
    }
    assert.match(
        sql079,
        /calculation_input_gross_amount'\) NOT IN \('number', 'null'\)[\s\S]*::DOUBLE PRECISION[\s\S]*numeric_value_out_of_range/
    );
    assert.match(
        sql079,
        /v_method IN \('single', 'sequential'\) AND v_input_gross IS NULL/
    );
});

test('079 normal parsed ve gross_not_available review satırını aynı staging batchinde kabul eder', () => {
    const lines = buildPayloadLines([
        {
            name: 'Normal',
            quantity: 1,
            unitPrice: 100,
            rates: [10],
            lineTotal: 90
        },
        {
            name: 'Gross Yok',
            quantity: 5,
            unitPrice: null,
            rates: [10],
            lineTotal: 450
        }
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].discount_parse_status, 'parsed');
    assert.equal(lines[0].discount_review_required, false);
    assert.deepEqual(validateTypedLine(lines[0]), { ok: true });

    const reviewLine = lines[1];
    assert.equal(reviewLine.discount_calculation_method, 'single');
    assert.deepEqual(Array.from(reviewLine.discount_rates), [10]);
    assert.equal(reviewLine.discount_parse_status, 'mismatch');
    assert.equal(reviewLine.discount_review_required, true);
    assert.equal(reviewLine.calculated_gross_amount, null);
    assert.equal(reviewLine.calculated_net_amount, null);
    assert.equal(reviewLine.line_discount_amount, null);
    assert.equal(reviewLine.effective_discount_rate, null);
    assert.equal(reviewLine.calculation_input_gross_amount, null);
    assert.deepEqual(validateTypedLine(reviewLine), { ok: true });

    const oldContradiction = Object.assign({}, reviewLine, {
        discount_parse_status: 'parsed'
    });
    assert.equal(validateTypedLine(oldContradiction).reason, 'parsed_review');
});

test('079 auth/tenant/rate-limit/grant sözleşmesini ve 23/23 INSERT eşleşmesini korur', () => {
    assert.match(sql079, /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/i);
    assert.match(sql079, /v_auth_uid := auth\.uid\(\)/);
    assert.match(sql079, /FROM public\.users u[\s\S]*u\.is_active = true/);
    assert.match(sql079, /PERFORM public\.check_rate_limit\('import_stage'\)/);
    assert.match(sql079, /v_line_count > 2000/);
    assert.match(sql079, /b\.tenant_id = v_tenant_id[\s\S]*b\.file_hash = v_file_hash/);
    assert.match(sql079, /REVOKE ALL ON FUNCTION public\.import_stage_batch\(jsonb, jsonb\) FROM PUBLIC/);
    assert.match(sql079, /REVOKE ALL ON FUNCTION public\.import_stage_batch\(jsonb, jsonb\) FROM anon/);
    assert.match(sql079, /GRANT EXECUTE ON FUNCTION public\.import_stage_batch\(jsonb, jsonb\) TO authenticated/);

    const insert = sql079.match(
        /INSERT INTO public\.import_lines\s*\(([\s\S]*?)\)\s*SELECT\s*([\s\S]*?)\s+FROM jsonb_array_elements\(p_lines\) WITH ORDINALITY AS elem\(value, ord\);/i
    );
    assert.ok(insert, 'import_lines INSERT ... SELECT bulunmalı');
    const columns = splitTopLevelCommaList(insert[1]);
    const values = splitTopLevelCommaList(insert[2]);
    assert.equal(columns.length, 23);
    assert.equal(values.length, 23);
    assert.deepEqual(columns.slice(-8), PERSISTED_TYPED_KEYS);
    assert.equal(columns.includes('calculation_input_gross_amount'), false);
});
