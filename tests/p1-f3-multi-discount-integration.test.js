'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ROOT,
    createBrowserContext,
    loadImportParsers,
    loadImportViewTestHooks
} = require('./helpers/browser-runtime');

function loadProduction() {
    const context = createBrowserContext();
    const parsers = loadImportParsers(context);
    return { context, parsers };
}

function canonicalLine(overrides) {
    return Object.assign({
        raw_name: 'Çoklu İskontolu Ürün',
        raw_qty: '10',
        raw_unit: 'adet',
        raw_unit_price: '100',
        raw_vat: '10',
        raw_discount: '10+5',
        raw_discount_1: null,
        raw_discount_2: null,
        raw_discount_3: null,
        raw_discount_amount: null,
        raw_line_total: '855'
    }, overrides || {});
}

function evidence(overrides) {
    const { parsers } = loadProduction();
    return parsers.classifyDiscountEvidence(canonicalLine(overrides));
}

test('P1-F.3 01: "10+5" ordered [10,5] üretir', () => {
    const { parsers } = loadProduction();
    const result = parsers.parseSequentialDiscountRates('10+5');
    assert.equal(result.status, 'parsed');
    assert.deepEqual(Array.from(result.rates), [10, 5]);
});

test('P1-F.3 02: "%10 + %5" ordered [10,5] üretir', () => {
    const { parsers } = loadProduction();
    const result = parsers.parseSequentialDiscountRates('%10 + %5');
    assert.equal(result.status, 'parsed');
    assert.deepEqual(Array.from(result.rates), [10, 5]);
});

test('P1-F.3 03: "10 / 5" ordered [10,5] üretir', () => {
    const { parsers } = loadProduction();
    assert.deepEqual(Array.from(parsers.parseSequentialDiscountRates('10 / 5').rates), [10, 5]);
});

test('P1-F.3 04: "10;5" ordered [10,5] üretir', () => {
    const { parsers } = loadProduction();
    assert.deepEqual(Array.from(parsers.parseSequentialDiscountRates('10;5').rates), [10, 5]);
});

test('P1-F.3 05: ondalık virgül "10,5" tek oran 10.5 kalır', () => {
    const { parsers } = loadProduction();
    const result = parsers.parseSequentialDiscountRates('10,5');
    assert.deepEqual(Array.from(result.rates), [10.5]);
});

test('P1-F.3 06: gross 1000 ve [10,5] ardışık net 855 üretir', () => {
    const { parsers } = loadProduction();
    assert.equal(parsers.calculateSequentialDiscount(1000, [10, 5]).calculated_net_amount, 855);
});

test('P1-F.3 07: gross 1000 ve [10,5] iskonto tutarı 145 üretir', () => {
    const { parsers } = loadProduction();
    assert.equal(parsers.calculateSequentialDiscount(1000, [10, 5]).line_discount_amount, 145);
});

test('P1-F.3 08: gross 1000 ve [10,5] efektif oran 14.5 üretir', () => {
    const { parsers } = loadProduction();
    assert.equal(parsers.calculateSequentialDiscount(1000, [10, 5]).effective_discount_rate, 14.5);
});

test('P1-F.3 09: kaynak net 855 parsed ve review=false olur', () => {
    const result = evidence();
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
    assert.equal(result.source_line_basis, 'net');
});

test('P1-F.3 10: kaynak net 850 mismatch ve review=true olur', () => {
    const result = evidence({ raw_line_total: '850' });
    assert.equal(result.calculated_net_amount, 855);
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
});

test('P1-F.3 11: declared total 935, 850 kaynak mismatch kanıtını geçersiz kılamaz', () => {
    const result = evidence({ raw_line_total: '850', declared_total: 935 });
    assert.equal(Math.round(850 * 1.10 * 100) / 100, 935);
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
});

test('P1-F.3 12: boşluk ayraçlı "10 5" ambiguous/review olur', () => {
    const result = evidence({ raw_discount: '10 5' });
    assert.equal(result.discount_parse_status, 'ambiguous');
    assert.equal(result.discount_review_required, true);
});

test('P1-F.3 13: boş elemanlı "10++5" unsupported/review olur', () => {
    const result = evidence({ raw_discount: '10++5' });
    assert.equal(result.discount_parse_status, 'unsupported');
    assert.equal(result.discount_review_required, true);
});

test('P1-F.3 14: dört oran unsupported/review olur', () => {
    const result = evidence({ raw_discount: '10+5+2+1' });
    assert.equal(result.discount_parse_status, 'unsupported');
    assert.equal(result.discount_review_required, true);
});

test('P1-F.3 15: ayrı İskonto 1/2 kolonları mapping sırasıyla [10,5] üretir', () => {
    const { parsers } = loadProduction();
    const mapping = parsers.detectColumnMapping([
        'Ürün', 'Miktar', 'Birim Fiyat', 'İskonto 1', 'İskonto 2', 'Satır Tutarı'
    ]);
    assert.equal(mapping.raw_discount_1, 3);
    assert.equal(mapping.raw_discount_2, 4);
    const result = parsers.classifyDiscountEvidence(canonicalLine({
        raw_discount: null,
        raw_discount_1: '10',
        raw_discount_2: '5'
    }));
    assert.deepEqual(Array.from(result.discount_rates), [10, 5]);
});

test('P1-F.3 16: birleşik ve ayrı kolon aynı oran dizisiyse PASS', () => {
    const result = evidence({ raw_discount_1: '10', raw_discount_2: '5' });
    assert.deepEqual(Array.from(result.discount_rates), [10, 5]);
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
});

test('P1-F.3 17: birleşik ve ayrı kolon farklıysa mismatch/BLOCK', () => {
    const result = evidence({ raw_discount_1: '10', raw_discount_2: '4' });
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
    assert.equal(result.discount_reason, 'combined_separate_rate_mismatch');
});

test('P1-F.3 18: yüzde 100 satır promotion ve calculated net 0 kalır', () => {
    const result = evidence({
        raw_qty: '5', raw_unit_price: '12', raw_discount: '100', raw_line_total: '60'
    });
    assert.deepEqual(Array.from(result.discount_rates), [100]);
    assert.equal(result.discount_calculation_method, 'single');
    assert.equal(result.calculated_net_amount, 0);
    assert.equal(result.line_type, 'promotion');
    assert.equal(result.source_line_basis, 'gross');
});

test('P1-F.3 19: tek yüzde 10 oran calculated net 900 üretir', () => {
    const result = evidence({ raw_discount: '10', raw_line_total: '900' });
    assert.deepEqual(Array.from(result.discount_rates), [10]);
    assert.equal(result.discount_calculation_method, 'single');
    assert.equal(result.calculated_net_amount, 900);
});

test('P1-F.3 20: import-view staging payload JSON-safe typed alanları taşır', () => {
    const { context, parsers } = loadProduction();
    const view = loadImportViewTestHooks(context);
    const headers = ['Ürün', 'Miktar', 'Birim', 'Birim Fiyat', 'KDV', 'İskonto 1', 'İskonto 2', 'Satır Tutarı'];
    const row = ['Çoklu İskontolu Ürün', '10', 'adet', '100', '10', '10', '5', '855'];
    const mapping = parsers.detectColumnMapping(headers);
    const columnSeries = {};
    headers.forEach((_, index) => { columnSeries[index] = [row[index]]; });

    view.setState({
        parse: {
            rawLines: [],
            table: { columns: headers, rows: [row] },
            batchMeta: {
                source_type: 'xlsx',
                original_filename: 'multi.xlsx',
                file_hash: 'hash-079',
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

    const payload = view.buildPayload();
    assert.equal(payload.p_lines.length, 1);
    const line = payload.p_lines[0];
    assert.deepEqual(Array.from(line.discount_rates), [10, 5]);
    assert.equal(line.discount_calculation_method, 'sequential');
    assert.equal(line.discount_parse_status, 'parsed');
    assert.equal(line.effective_discount_rate, 14.5);
    assert.equal(line.line_discount_amount, 145);
    assert.equal(line.calculated_gross_amount, 1000);
    assert.equal(line.calculated_net_amount, 855);
    assert.equal(line.calculation_input_gross_amount, 1000);
    assert.equal(line.discount_review_required, false);
    assert.deepEqual(JSON.parse(JSON.stringify(line)).discount_rates, [10, 5]);
});

const sql079 = fs.readFileSync(path.join(ROOT, 'sql', '079_multi_discount_staging_integration.sql'), 'utf8');

test('P1-F.3 21: 079 import_lines INSERT sekiz typed kolonu yazar', () => {
    const columns = [
        'discount_rates', 'discount_calculation_method', 'discount_parse_status',
        'effective_discount_rate', 'line_discount_amount', 'calculated_gross_amount',
        'calculated_net_amount', 'discount_review_required'
    ];
    for (const column of columns) {
        assert.match(sql079, new RegExp(`\\b${column}\\b`), column);
    }
    assert.match(sql079, /INSERT INTO public\.import_lines\s*\([\s\S]*discount_rates[\s\S]*discount_review_required[\s\S]*\)\s*SELECT/i);
    assert.match(sql079, /public\.is_valid_discount_rates\(v_rates\)/);
    assert.match(sql079, /finite NUMERIC oranlar/);
});

test('P1-F.3 22: 079 mevcut security/auth/tenant/limit/duplicate sözleşmesini korur', () => {
    assert.match(sql079, /CREATE OR REPLACE FUNCTION public\.import_stage_batch\s*\(\s*p_meta\s+JSONB,\s*p_lines\s+JSONB\s*\)/i);
    assert.match(sql079, /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/i);
    assert.match(sql079, /v_auth_uid := auth\.uid\(\)/);
    assert.match(sql079, /FROM public\.users u[\s\S]*u\.is_active = true/);
    assert.match(sql079, /PERFORM public\.check_rate_limit\('import_stage'\)/);
    assert.match(sql079, /v_line_count > 2000/);
    assert.match(sql079, /b\.tenant_id = v_tenant_id[\s\S]*b\.file_hash = v_file_hash/);
    assert.match(sql079, /REVOKE ALL ON FUNCTION public\.import_stage_batch\(jsonb, jsonb\) FROM PUBLIC/);
    assert.match(sql079, /REVOKE ALL ON FUNCTION public\.import_stage_batch\(jsonb, jsonb\) FROM anon/);
    assert.match(sql079, /GRANT EXECUTE ON FUNCTION public\.import_stage_batch\(jsonb, jsonb\) TO authenticated/);
});

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

test('P1-F.3.1 23: gross 0.05 ve yüzde 10 sonucu 0.05/0.05/0 invariantını korur', () => {
    const { parsers } = loadProduction();
    const result = parsers.calculateSequentialDiscount(0.05, [10]);
    const oldIndependentDiscount = roundMoney(0.05 - (0.05 * 0.90));

    assert.equal(oldIndependentDiscount, 0.01, 'Eski bağımsız iskonto yuvarlaması kanıtlanmalı');
    assert.equal(result.calculated_gross_amount, 0.05);
    assert.equal(result.calculated_net_amount, 0.05);
    assert.equal(result.line_discount_amount, 0);
    assert.equal(result.effective_discount_rate, 0);
    assert.equal(roundMoney(result.calculated_net_amount + result.line_discount_amount), 0.05);
});

test('P1-F.3.1 24: gross 0.03 ve yüzde 10 sonucu 0.03/0.03/0 invariantını korur', () => {
    const { parsers } = loadProduction();
    const result = parsers.calculateSequentialDiscount(0.03, [10]);
    assert.equal(result.calculated_gross_amount, 0.03);
    assert.equal(result.calculated_net_amount, 0.03);
    assert.equal(result.line_discount_amount, 0);
    assert.equal(result.effective_discount_rate, 0);
    assert.equal(roundMoney(result.calculated_net_amount + result.line_discount_amount), 0.03);
});

test('P1-F.3.1 25: gross 12.34 ve yüzde 10 sonucu 12.34/11.11/1.23 üretir', () => {
    const { parsers } = loadProduction();
    const result = parsers.calculateSequentialDiscount(12.34, [10]);
    assert.deepEqual(Array.from(result.discount_rates), [10]);
    assert.equal(result.calculated_gross_amount, 12.34);
    assert.equal(result.calculated_net_amount, 11.11);
    assert.equal(result.line_discount_amount, 1.23);
    assert.equal(roundMoney(result.calculated_net_amount + result.line_discount_amount), 12.34);
});

test('P1-F.3.1 26: efektif oran yuvarlanmış 1.23 / 12.34 üzerinden 9.9676 olur', () => {
    const { parsers } = loadProduction();
    const result = parsers.calculateSequentialDiscount(12.34, [10]);
    assert.equal(result.effective_discount_rate, 9.9676);
    assert.notEqual(result.effective_discount_rate, 10);
});

test('P1-F.3.1 27: 1000 ve [10,5] regresyonu 1000/855/145/14.5 kalır', () => {
    const { parsers } = loadProduction();
    const result = parsers.calculateSequentialDiscount(1000, [10, 5]);
    assert.equal(result.calculated_gross_amount, 1000);
    assert.equal(result.calculated_net_amount, 855);
    assert.equal(result.line_discount_amount, 145);
    assert.equal(result.effective_discount_rate, 14.5);
});

test('P1-F.3.1 28: genel para matrisi her başarılı hesapta gross = net + discount sağlar', () => {
    const { parsers } = loadProduction();
    const grossValues = [0.01, 0.03, 0.05, 0.07, 0.99, 1.01, 12.34, 1000];
    const rateSets = [[5], [10], [10, 5], [33.3333], [100]];

    for (const gross of grossValues) {
        for (const rates of rateSets) {
            const result = parsers.calculateSequentialDiscount(gross, rates);
            assert.equal(result.status, 'parsed', `${gross} / ${rates.join('+')}`);
            assert.equal(
                roundMoney(result.calculated_net_amount + result.line_discount_amount),
                result.calculated_gross_amount,
                `${gross} / ${rates.join('+')}`
            );
        }
    }
});

test('P1-F.3.1 29: gross eksikken geçerli explicit 145 TL typed audit alanında korunur', () => {
    const result = evidence({
        raw_qty: null,
        raw_unit_price: null,
        raw_discount: null,
        raw_discount_amount: '145',
        raw_line_total: '855'
    });
    assert.equal(result.discount_calculation_method, 'explicit_amount');
    assert.equal(result.line_discount_amount, 145);
});

test('P1-F.3.1 30: gross eksik explicit tutar mismatch/review olur ve net/efektif tahmin edilmez', () => {
    const result = evidence({
        raw_qty: null,
        raw_unit_price: null,
        raw_discount: null,
        raw_discount_amount: '145',
        raw_line_total: '855'
    });
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
    assert.equal(result.calculated_gross_amount, null);
    assert.equal(result.calculated_net_amount, null);
    assert.equal(result.calculation_input_gross_amount, null);
    assert.equal(result.effective_discount_rate, null);
    assert.equal(result.discount_reason, 'gross_not_available');
});

test('P1-F.3.1 31: parser yuvarlama/audit testi RPC veya canlı DB bağımlılığı kullanmaz', () => {
    const { context, parsers } = loadProduction();
    Object.defineProperty(context, 'SupabaseService', {
        configurable: true,
        get() { throw new Error('Supabase erişimi yapılmamalı'); }
    });
    Object.defineProperty(context, 'fetch', {
        configurable: true,
        get() { throw new Error('Ağ erişimi yapılmamalı'); }
    });

    const result = parsers.calculateSequentialDiscount(12.34, [10]);
    assert.equal(result.line_discount_amount, 1.23);
});

test('P1-F.3.2 32: explicit 12,345 / 1,234 kanonik para invariantını korur', () => {
    const input = canonicalLine({
        raw_qty: '1',
        raw_unit_price: '12,345',
        raw_discount: null,
        raw_discount_amount: '1,234',
        raw_line_total: '11,111'
    });
    const { parsers } = loadProduction();
    const result = parsers.classifyDiscountEvidence(input);

    assert.equal(result.discount_calculation_method, 'explicit_amount');
    assert.equal(result.calculated_gross_amount, 12.35);
    assert.equal(result.calculated_net_amount, 11.12);
    assert.equal(result.line_discount_amount, 1.23);
    assert.equal(result.effective_discount_rate, 9.9595);
    assert.equal(result.source_line_basis, 'net');
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
    assert.equal(roundMoney(result.calculated_net_amount + result.line_discount_amount), 12.35);
    assert.equal(input.raw_unit_price, '12,345');
    assert.equal(input.raw_discount_amount, '1,234');
    assert.equal(input.raw_line_total, '11,111');
});

test('P1-F.3.2 33: derived 12,345 / 11,111 kanonik para invariantını korur', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '12,345',
        raw_discount: null,
        raw_discount_amount: null,
        raw_line_total: '11,111'
    });

    assert.equal(result.discount_calculation_method, 'derived_effective');
    assert.equal(result.calculated_gross_amount, 12.35);
    assert.equal(result.calculated_net_amount, 11.11);
    assert.equal(result.line_discount_amount, 1.24);
    assert.equal(result.effective_discount_rate, 10.0405);
    assert.equal(result.source_line_basis, 'net');
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
    assert.equal(roundMoney(result.calculated_net_amount + result.line_discount_amount), 12.35);
});

test('P1-F.3.2 34: explicit efektif oran yalnız saklanan typed tutarlardan türetilir', () => {
    const { parsers } = loadProduction();
    const result = parsers.finalizeMoneyFromAuthoritativeDiscount(12.345, 1.234);
    assert.equal(result.calculated_gross_amount, 12.35);
    assert.equal(result.line_discount_amount, 1.23);
    assert.equal(result.calculated_net_amount, 11.12);
    assert.equal(result.effective_discount_rate, 9.9595);
    assert.equal(
        result.effective_discount_rate,
        Math.round(result.line_discount_amount / result.calculated_gross_amount * 1000000) / 10000
    );
});

test('P1-F.3.2 35: derived efektif oran yalnız saklanan typed tutarlardan türetilir', () => {
    const { parsers } = loadProduction();
    const result = parsers.finalizeMoneyFromAuthoritativeNet(12.345, 11.111);
    assert.equal(result.effective_discount_rate, 10.0405);
    assert.equal(
        result.effective_discount_rate,
        Math.round(result.line_discount_amount / result.calculated_gross_amount * 1000000) / 10000
    );
});

test('P1-F.3.2 36: gross 100 / explicit 100,05 mismatch ve review üretir', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '100',
        raw_discount: null,
        raw_discount_amount: '100,05',
        raw_line_total: '0'
    });
    assert.equal(result.discount_calculation_method, 'explicit_amount');
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
    assert.equal(result.calculated_gross_amount, 100);
    assert.equal(result.line_discount_amount, 100.05);
    assert.equal(result.calculated_net_amount, null);
    assert.equal(result.discount_reason, 'discount_amount_exceeds_gross');
});

test('P1-F.3.2 37: gross aşan explicit tutarda efektif oran NULL kalır', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '100',
        raw_discount: null,
        raw_discount_amount: '100,05',
        raw_line_total: '0'
    });
    assert.equal(result.effective_discount_rate, null);
});

test('P1-F.3.2 38: gross 100 / explicit 100 geçerli promotion kalır', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '100',
        raw_discount: null,
        raw_discount_amount: '100',
        raw_line_total: '0'
    });
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
    assert.equal(result.calculated_net_amount, 0);
    assert.equal(result.effective_discount_rate, 100);
    assert.equal(result.line_type, 'promotion');
});

test('P1-F.3.2 39: yüzde 0,05 kaynak 999,50 olduğunda basis net seçilir', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '1000',
        raw_discount: '0,05',
        raw_line_total: '999,50'
    });
    assert.equal(result.calculated_net_amount, 999.5);
    assert.equal(result.source_line_basis, 'net');
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
});

test('P1-F.3.2 40: yüzde 0,05 kaynak 1000 olduğunda basis gross seçilir', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '1000',
        raw_discount: '0,05',
        raw_line_total: '1000'
    });
    assert.equal(result.source_line_basis, 'gross');
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
});

test('P1-F.3.2 41: explicit 0,50 kaynak 999,50 olduğunda basis net seçilir', () => {
    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '1000',
        raw_discount: null,
        raw_discount_amount: '0,50',
        raw_line_total: '999,50'
    });
    assert.equal(result.discount_calculation_method, 'explicit_amount');
    assert.equal(result.source_line_basis, 'net');
    assert.equal(result.discount_parse_status, 'parsed');
    assert.equal(result.discount_review_required, false);
});

test('P1-F.3.2 42: gross ve nete eşit uzaklıktaki kaynak tutar review gerektirir', () => {
    const { parsers } = loadProduction();
    const basis = parsers.classifySourceAmountBasis(999.75, 1000, 999.5, true);
    assert.equal(basis.source_line_basis, 'unknown');
    assert.equal(basis.discount_parse_status, 'mismatch');
    assert.equal(basis.discount_review_required, true);

    const result = evidence({
        raw_qty: '1',
        raw_unit_price: '1000',
        raw_discount: '0,05',
        raw_line_total: '999,75'
    });
    assert.equal(result.source_line_basis, 'unknown');
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
});

test('P1-F.3.2 43: dört method para matrisi gross = net + discount invariantını korur', () => {
    const { parsers } = loadProduction();
    const grossValues = [0.05, 0.99, 1.005, 12.345, 1000];
    const methods = [
        ['single', gross => parsers.calculateSequentialDiscount(gross, [10])],
        ['sequential', gross => parsers.calculateSequentialDiscount(gross, [10, 5])],
        ['explicit_amount', gross => parsers.finalizeMoneyFromAuthoritativeDiscount(
            gross, roundMoney(gross * 0.10)
        )],
        ['derived_effective', gross => parsers.finalizeMoneyFromAuthoritativeNet(
            gross, roundMoney(gross * 0.90)
        )]
    ];

    for (const gross of grossValues) {
        for (const [method, calculate] of methods) {
            const result = calculate(gross);
            assert.equal(
                roundMoney(result.calculated_net_amount + result.line_discount_amount),
                result.calculated_gross_amount,
                `${method} / ${gross}`
            );
        }
    }
});

test('P1-F.3.2 44: parser parsed sonuçlarda 0..100 dışında efektif oran üretmez', () => {
    const methodResults = [
        ['single', evidence({ raw_discount: '0,05', raw_line_total: '999,50' })],
        ['sequential', evidence({ raw_discount: '10+5', raw_line_total: '855' })],
        ['explicit_amount', evidence({ raw_discount: null, raw_discount_amount: '1,234',
            raw_qty: '1', raw_unit_price: '12,345', raw_line_total: '11,111' })],
        ['derived_effective', evidence({ raw_discount: null, raw_discount_amount: null,
            raw_qty: '1', raw_unit_price: '12,345', raw_line_total: '11,111' })]
    ];
    for (const [method, result] of methodResults) {
        assert.equal(result.discount_calculation_method, method);
        assert.equal(result.discount_parse_status, 'parsed');
        assert.ok(
            result.effective_discount_rate === null ||
            (result.effective_discount_rate >= 0 && result.effective_discount_rate <= 100),
            method
        );
    }
});

test('P1-F.3.2 45: 079 migration SHA-256 hash değeri değişmez', () => {
    const hash = crypto.createHash('sha256').update(sql079).digest('hex').toUpperCase();
    assert.equal(hash, 'A38CE3044B700209D1DF6A564D45D61FF7EA3AB1816A9F17525F897A05FE2283');
});

test('P1-F.3.2 46: direct helper gross aşımında audit tutarını korur ve net/rate NULL üretir', () => {
    const { parsers } = loadProduction();
    const result = parsers.finalizeMoneyFromAuthoritativeDiscount(100, 100.05);
    assert.equal(result.calculated_gross_amount, 100);
    assert.equal(result.line_discount_amount, 100.05);
    assert.equal(result.calculated_net_amount, null);
    assert.equal(result.effective_discount_rate, null);
});

test('P1-F.3.2 47: direct helper grossa eşit iskontoda net 0 ve rate 100 üretir', () => {
    const { parsers } = loadProduction();
    const result = parsers.finalizeMoneyFromAuthoritativeDiscount(100, 100);
    assert.equal(result.calculated_gross_amount, 100);
    assert.equal(result.line_discount_amount, 100);
    assert.equal(result.calculated_net_amount, 0);
    assert.equal(result.effective_discount_rate, 100);
});

function assertFiniteOrNullTypedAmounts(result) {
    for (const field of [
        'calculated_gross_amount', 'calculated_net_amount',
        'line_discount_amount', 'effective_discount_rate'
    ]) {
        assert.ok(
            result[field] === null ||
            (typeof result[field] === 'number' && Number.isFinite(result[field])),
            `${field}: ${String(result[field])}`
        );
    }
}

test('P1-F.3.3.1 48: finite çarpım taşması unsupported/review olur ve raw audit korunur', () => {
    const { parsers } = loadProduction();
    const input = {
        raw_qty: 1e308,
        raw_unit_price: 10,
        raw_discount: '10+5',
        raw_discount_amount: '12,34',
        raw_line_total: null
    };
    const result = parsers.classifyDiscountEvidence(input);

    assert.equal(result.discount_parse_status, 'unsupported');
    assert.equal(result.discount_review_required, true);
    assert.equal(result.source_line_basis, 'unknown');
    assert.equal(result.calculated_gross_amount, null);
    assert.equal(result.calculated_net_amount, null);
    assert.equal(result.calculation_input_gross_amount, null);
    assert.equal(result.effective_discount_rate, null);
    assert.equal(result.line_discount_amount, 12.34);
    assert.deepEqual(Array.from(result.discount_rates), [10, 5]);
    assert.equal(result.discount_reason, 'non_finite_gross_amount');
    assertFiniteOrNullTypedAmounts(result);

    assert.equal(input.raw_qty, 1e308);
    assert.equal(input.raw_unit_price, 10);
    assert.equal(input.raw_discount, '10+5');
    assert.equal(input.raw_discount_amount, '12,34');
});

test('P1-F.3.3.1 49: overflow null değerleri JSON öncesinde hazırdır ve round-tripte kalır', () => {
    const { parsers } = loadProduction();
    const result = parsers.classifyDiscountEvidence({
        raw_qty: 1e308,
        raw_unit_price: 10
    });

    assert.equal(result.calculated_gross_amount, null, 'stringify öncesi gross');
    assert.equal(result.calculated_net_amount, null, 'stringify öncesi net');
    assert.equal(result.calculation_input_gross_amount, null, 'stringify öncesi input gross');
    const serialized = JSON.stringify(result);
    const roundTrip = JSON.parse(serialized);
    assert.equal(roundTrip.calculated_gross_amount, null);
    assert.equal(roundTrip.calculated_net_amount, null);
    assert.equal(roundTrip.calculation_input_gross_amount, null);
    assert.match(serialized, /"calculated_gross_amount":null/);
    assert.match(serialized, /"calculated_net_amount":null/);
    assert.match(serialized, /"calculation_input_gross_amount":null/);
});

test('P1-F.3.3.1 50: normal ve overflow satırı aynı payload batchinde throw etmeden ayrışır', () => {
    const { context, parsers } = loadProduction();
    const view = loadImportViewTestHooks(context);
    const huge = '1' + '0'.repeat(200);
    const headers = ['Ürün', 'Miktar', 'Birim Fiyat', 'İskonto', 'Satır Tutarı'];
    const rows = [
        ['Normal', '1', '1000', '10', '900'],
        ['Overflow', huge, huge, null, null]
    ];
    const mapping = {
        raw_name: 0, raw_qty: 1, raw_unit_price: 2,
        raw_discount: 3, raw_line_total: 4
    };
    const columnSeries = {};
    headers.forEach((_, index) => {
        columnSeries[index] = rows.map(row => row[index]);
    });

    view.setState({
        parse: {
            rawLines: [],
            table: { columns: headers, rows },
            batchMeta: {
                source_type: 'xlsx',
                original_filename: 'overflow-probe.xlsx',
                file_hash: 'overflow-probe',
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

    let payload;
    assert.doesNotThrow(() => { payload = view.buildPayload(); });
    const lines = payload.p_lines;
    assert.equal(lines.length, 2);
    assert.equal(lines[0].discount_parse_status, 'parsed');
    assert.equal(lines[0].calculated_gross_amount, 1000);
    assert.equal(lines[0].calculated_net_amount, 900);
    assert.equal(lines[0].calculation_input_gross_amount, 1000);
    assert.equal(lines[1].discount_parse_status, 'unsupported');
    assert.equal(lines[1].discount_review_required, true);
    assert.equal(lines[1].calculated_gross_amount, null);
    assert.equal(lines[1].calculated_net_amount, null);
    assert.equal(lines[1].calculation_input_gross_amount, null);
    assertFiniteOrNullTypedAmounts(lines[1]);
});

test('P1-F.3.3.1 51: public finalizerlar non-finite girdilerde yalnız finite veya null döndürür', () => {
    const { parsers } = loadProduction();
    const results = [
        parsers.finalizeMoneyFromAuthoritativeNet(Infinity, 10),
        parsers.finalizeMoneyFromAuthoritativeNet(100, Infinity),
        parsers.finalizeMoneyFromAuthoritativeNet(NaN, 10),
        parsers.finalizeMoneyFromAuthoritativeNet(100, NaN),
        parsers.finalizeMoneyFromAuthoritativeDiscount(Infinity, 10),
        parsers.finalizeMoneyFromAuthoritativeDiscount(100, Infinity),
        parsers.finalizeMoneyFromAuthoritativeDiscount(NaN, 10),
        parsers.finalizeMoneyFromAuthoritativeDiscount(100, NaN)
    ];

    for (const result of results) {
        assertFiniteOrNullTypedAmounts(result);
    }
});

test('P1-F.3.9 52: parser finite yuvarlanmamış gross kanıtını typed sözleşmede korur', () => {
    const { parsers } = loadProduction();
    const result = parsers.classifyDiscountEvidence({
        raw_qty: '1.5',
        raw_unit_price: '52.25',
        raw_discount: '88'
    });
    assert.equal(result.calculation_input_gross_amount, 78.375);
    assert.deepEqual({
        gross: result.calculated_gross_amount,
        net: result.calculated_net_amount,
        discount: result.line_discount_amount,
        effective: result.effective_discount_rate
    }, {
        gross: 78.38,
        net: 9.40,
        discount: 68.98,
        effective: 88.0071
    });
    assert.equal(
        parsers.calculateSequentialDiscount(78.375, [88]).calculation_input_gross_amount,
        78.375
    );
});

test('P1-F.3.10 53: rate evidence ve gross yoksa kanonik mismatch audit sonucu üretir', () => {
    const { parsers } = loadProduction();
    const result = parsers.classifyDiscountEvidence({
        raw_qty: '5',
        raw_unit_price: null,
        raw_line_total: '450',
        raw_discount: '10'
    });
    assert.deepEqual(Array.from(result.discount_rates), [10]);
    assert.equal(result.discount_calculation_method, 'single');
    assert.equal(result.discount_parse_status, 'mismatch');
    assert.equal(result.discount_review_required, true);
    for (const field of [
        'calculation_input_gross_amount',
        'calculated_gross_amount',
        'calculated_net_amount',
        'line_discount_amount',
        'effective_discount_rate'
    ]) {
        assert.equal(result[field], null, field);
    }
    assert.equal(result.source_line_basis, 'unknown');
    assert.equal(result.line_type, 'unknown');
    assert.equal(result.discount_reason, 'gross_not_available');
});

test('P1-F.3.10 54: explicit amount ve gross yoksa finite audit tutarı, özellikle 0, korunur', () => {
    const { parsers } = loadProduction();
    for (const [rawAmount, expectedAmount] of [['45,67', 45.67], ['0', 0]]) {
        const result = parsers.classifyDiscountEvidence({
            raw_qty: '5',
            raw_unit_price: null,
            raw_discount: null,
            raw_discount_amount: rawAmount,
            raw_line_total: '450'
        });
        assert.equal(result.discount_calculation_method, 'explicit_amount');
        assert.equal(result.discount_parse_status, 'mismatch');
        assert.equal(result.discount_review_required, true);
        assert.equal(result.line_discount_amount, expectedAmount);
        assert.equal(result.calculation_input_gross_amount, null);
        assert.equal(result.calculated_gross_amount, null);
        assert.equal(result.calculated_net_amount, null);
        assert.equal(result.effective_discount_rate, null);
        assert.equal(result.source_line_basis, 'unknown');
        assert.equal(result.line_type, 'unknown');
        assert.equal(result.discount_reason, 'gross_not_available');
    }
});

test('P1-F.3.10 55: public sequential helper üretilemeyen para alanlarıyla parsed dönmez', () => {
    const { parsers } = loadProduction();
    for (const gross of [Infinity, -Infinity, NaN, Number.MAX_VALUE, 1e308]) {
        const result = parsers.calculateSequentialDiscount(gross, [10]);
        assert.equal(result.status, 'unsupported', String(gross));
        assert.equal(result.reason, 'invalid_gross_or_rates', String(gross));
        for (const field of [
            'calculation_input_gross_amount',
            'calculated_gross_amount',
            'calculated_net_amount',
            'line_discount_amount',
            'effective_discount_rate'
        ]) {
            assert.equal(result[field], null, `${String(gross)} / ${field}`);
        }
    }
});

function findNonFiniteNumbers(value, pathPrefix = '$', found = []) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        found.push(pathPrefix);
    } else if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            findNonFiniteNumbers(entry, `${pathPrefix}[${index}]`, found);
        });
    } else if (value && typeof value === 'object') {
        Object.keys(value).forEach((key) => {
            findNonFiniteNumbers(value[key], `${pathPrefix}.${key}`, found);
        });
    }
    return found;
}

test('P1-F.3.10 56: gross-yok satırı gerçek buildPayload zincirinden silinmeden geçer', () => {
    const { context } = loadProduction();
    const view = loadImportViewTestHooks(context);
    const headers = ['Ürün', 'Miktar', 'Birim Fiyat', 'Satır Tutarı', 'İskonto'];
    const row = ['Gross Yok İskontolu', '5', null, '450', '10'];
    const mapping = {
        raw_name: 0,
        raw_qty: 1,
        raw_unit_price: 2,
        raw_line_total: 3,
        raw_discount: 4
    };
    const columnSeries = {};
    headers.forEach((_, index) => { columnSeries[index] = [row[index]]; });
    view.setState({
        parse: {
            rawLines: [],
            table: { columns: headers, rows: [row] },
            batchMeta: {
                source_type: 'xlsx',
                original_filename: 'gross-yok.xlsx',
                file_hash: 'gross-yok',
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

    const payload = view.buildPayload();
    assert.equal(payload.p_lines.length, 1);
    const line = payload.p_lines[0];
    assert.equal(line.discount_calculation_method, 'single');
    assert.deepEqual(Array.from(line.discount_rates), [10]);
    assert.equal(line.discount_parse_status, 'mismatch');
    assert.equal(line.discount_review_required, true);
    assert.equal(line.line_type, 'unknown');
    for (const field of [
        'calculation_input_gross_amount',
        'calculated_gross_amount',
        'calculated_net_amount',
        'line_discount_amount',
        'effective_discount_rate'
    ]) {
        assert.equal(line[field], null, field);
    }
    assert.deepEqual(findNonFiniteNumbers(payload), []);
    const roundTrip = JSON.parse(JSON.stringify(payload));
    assert.deepEqual(findNonFiniteNumbers(roundTrip), []);
    assert.deepEqual(roundTrip.p_lines[0].discount_rates, [10]);
    assert.equal(roundTrip.p_lines[0].calculated_gross_amount, null);
});

test('P1-F.3.11 57: parser v066 ve import-view v065 cache etiketlerini kullanır', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.match(html, /utils\/import-parsers\.js\?v=066/);
    assert.match(html, /views\/import-view\.js\?v=065/);
});

test('P1-F.3.11 58: negatif kaynaklar transient gross veya sıfır finansal kanıt sızdırmaz', () => {
    const { parsers } = loadProduction();
    assert.equal(Number('-2') * Number('-5'), 10, 'eski çift-negatif sızıntı önkoşulu');
    for (const unitPrice of ['-5', '5']) {
        const result = parsers.classifyDiscountEvidence({
            raw_qty: '-2',
            raw_unit_price: unitPrice,
            raw_discount: '10'
        });
        assert.equal(result.discount_parse_status, 'unsupported');
        assert.equal(result.discount_review_required, true);
        for (const field of [
            'calculation_input_gross_amount',
            'calculated_gross_amount',
            'calculated_net_amount',
            'line_discount_amount',
            'effective_discount_rate'
        ]) {
            assert.equal(result[field], null, `${unitPrice} / ${field}`);
        }
        assert.equal(result.source_line_basis, 'unknown');
        assert.equal(result.line_type, 'unknown');
        assert.equal(result.discount_reason, 'negative_financial_value');
        assert.deepEqual(findNonFiniteNumbers(result), []);
        assert.deepEqual(findNonFiniteNumbers(JSON.parse(JSON.stringify(result))), []);
    }
});

test('P1-F.3.11 59: public helper null/undefined/blank ve geçersiz gross girdilerini reddeder', () => {
    const { parsers } = loadProduction();
    const invalidGrosses = [
        null,
        undefined,
        '',
        '   ',
        NaN,
        Infinity,
        -Infinity,
        -1,
        Number.MAX_VALUE
    ];
    for (const gross of invalidGrosses) {
        const result = parsers.calculateSequentialDiscount(gross, [10]);
        assert.equal(result.status, 'unsupported', String(gross));
        assert.equal(result.reason, 'invalid_gross_or_rates', String(gross));
        for (const field of [
            'calculation_input_gross_amount',
            'calculated_gross_amount',
            'calculated_net_amount',
            'line_discount_amount',
            'effective_discount_rate'
        ]) {
            assert.equal(result[field], null, `${String(gross)} / ${field}`);
        }
    }
});

test('P1-F.3.11 60: public helper gerçek 0 ve "0" gross değerlerini parsed sıfır olarak korur', () => {
    const { parsers } = loadProduction();
    for (const gross of [0, '0']) {
        const result = parsers.calculateSequentialDiscount(gross, [10]);
        assert.equal(result.status, 'parsed', String(gross));
        assert.equal(result.calculation_input_gross_amount, 0);
        assert.equal(result.calculated_gross_amount, 0);
        assert.equal(result.calculated_net_amount, 0);
        assert.equal(result.line_discount_amount, 0);
        assert.equal(result.effective_discount_rate, 0);
    }
});
