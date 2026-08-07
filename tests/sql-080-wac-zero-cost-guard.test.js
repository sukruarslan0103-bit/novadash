'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(ROOT, 'sql', '080_wac_zero_cost_guard.sql');
const TRIGGER_SOURCE = path.join(ROOT, 'sql', '077_latest_invoice_effective_purchase_cost.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');
const triggerSource = fs.readFileSync(TRIGGER_SOURCE, 'utf8');

function row(overrides) {
    return Object.assign({
        id: 'item-1',
        tenant_id: 'tenant-a',
        raw_material_id: 'water',
        invoice_no: '100',
        invoice_date: '2026-07-01',
        created_at: '2026-07-01T10:00:00Z',
        base_quantity: 10,
        base_unit_cost: 5,
        is_deleted: false
    }, overrides || {});
}

function dateValue(value) {
    return value
        ? Date.parse(String(value).length === 10 ? value + 'T00:00:00Z' : value)
        : 0;
}

function compareAnchorDesc(a, b) {
    const aDate = a.invoice_date
        ? dateValue(a.invoice_date)
        : dateValue(String(a.created_at).slice(0, 10));
    const bDate = b.invoice_date
        ? dateValue(b.invoice_date)
        : dateValue(String(b.created_at).slice(0, 10));
    return bDate - aDate ||
        dateValue(b.created_at) - dateValue(a.created_at) ||
        String(b.id).localeCompare(String(a.id));
}

function positiveRows(allRows, material, rawMaterialId) {
    return allRows.filter(item =>
        item.tenant_id === material.tenant_id &&
        item.raw_material_id === rawMaterialId &&
        item.is_deleted === false &&
        Number.isFinite(Number(item.base_quantity)) &&
        Number(item.base_quantity) > 0 &&
        Number.isFinite(Number(item.base_unit_cost)) &&
        Number(item.base_unit_cost) > 0
    );
}

function materialFor(rawMaterials, rawMaterialId) {
    return rawMaterials.find(item =>
        item.id === rawMaterialId && item.is_deleted === false) || null;
}

function calculateWac(allRows, rawMaterials, rawMaterialId) {
    if (rawMaterialId == null) return 0;
    const material = materialFor(rawMaterials, rawMaterialId);
    if (!material) return 0;

    const positive = positiveRows(allRows, material, rawMaterialId);
    const anchor = positive.slice().sort(compareAnchorDesc)[0];
    if (!anchor) return 0;

    const anchorRows = positive.filter(item =>
        anchor.invoice_no != null
            ? item.invoice_no === anchor.invoice_no
            : item.id === anchor.id
    );
    const denominator = anchorRows.reduce(
        (sum, item) => sum + Number(item.base_quantity), 0);
    const numerator = anchorRows.reduce(
        (sum, item) => sum + Number(item.base_quantity) * Number(item.base_unit_cost), 0);
    return denominator > 0 ? numerator / denominator : 0;
}

function syncCostModel(allRows, rawMaterials, rawMaterialId) {
    const material = rawMaterialId == null
        ? null
        : materialFor(rawMaterials, rawMaterialId);
    if (!material) {
        return { cost: 0, prev_cost: null, last_purchase_at: null, documentKeys: [] };
    }

    const positive = positiveRows(allRows, material, rawMaterialId);
    const documents = new Map();
    positive.forEach(item => {
        const key = item.invoice_no != null
            ? 'invoice:' + String(item.invoice_no)
            : 'legacy:' + String(item.id);
        if (!documents.has(key)) documents.set(key, []);
        documents.get(key).push(item);
    });

    const ranked = Array.from(documents.entries()).map(([key, items]) => {
        const anchor = items.slice().sort(compareAnchorDesc)[0];
        const denominator = items.reduce(
            (sum, item) => sum + Number(item.base_quantity), 0);
        const numerator = items.reduce(
            (sum, item) => sum + Number(item.base_quantity) * Number(item.base_unit_cost), 0);
        return {
            key,
            anchor,
            effectiveCost: denominator > 0 ? numerator / denominator : null
        };
    }).sort((a, b) => compareAnchorDesc(a.anchor, b.anchor));

    return {
        cost: ranked[0] && ranked[0].effectiveCost != null
            ? ranked[0].effectiveCost : 0,
        prev_cost: ranked[1] ? ranked[1].effectiveCost : null,
        last_purchase_at: ranked[0] ? ranked[0].anchor.created_at : null,
        documentKeys: ranked.map(item => item.key)
    };
}

function extractFunction(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = sql.match(new RegExp(
        'CREATE OR REPLACE FUNCTION public\\.' + escaped +
        '[\\s\\S]*?\\$function\\$;', 'i'
    ));
    assert.ok(match, name + ' body bulunmalı');
    return match[0];
}

function extractDoBlock(tag) {
    const match = sql.match(new RegExp(
        'DO \\$' + tag + '\\$[\\s\\S]*?\\$' + tag + '\\$;', 'i'
    ));
    assert.ok(match, tag + ' DO bloğu bulunmalı');
    return match[0];
}

const materials = [
    { id: 'water', tenant_id: 'tenant-a', is_deleted: false },
    { id: 'water-b', tenant_id: 'tenant-b', is_deleted: false }
];

test('080 transaction ve her iki exact-overload preflight kontratını içerir', () => {
    assert.match(sql, /^\s*--[\s\S]*?\bBEGIN;[\s\S]*\bCOMMIT;\s*$/i);
    assert.match(sql, /to_regprocedure\('public\.calculate_raw_material_wac\(uuid\)'\)/i);
    assert.match(sql, /to_regprocedure\('public\.sync_raw_material_cost\(uuid\)'\)/i);
    assert.match(sql, /v_calc_overloads\s*<>\s*1/i);
    assert.match(sql, /v_sync_overloads\s*<>\s*1/i);
});

test('080 preflight iki canlı fonksiyon body hashini fail-closed doğrular', () => {
    const preflight = extractDoBlock('preflight');
    assert.match(preflight, /md5\(pg_get_functiondef\(v_calc_oid\)\)\s*<>\s*'e24fb11517138137f4ff16a53abee1d7'/i);
    assert.match(preflight, /\[080\] ABORT: calculate live body drift detected/);
    assert.match(preflight, /md5\(pg_get_functiondef\(v_sync_oid\)\)\s*<>\s*'db61913f60a1ccad26400d75c9384be7'/i);
    assert.match(preflight, /\[080\] ABORT: sync live body drift detected/);
});

test('080 ACL preflight PUBLIC/anon/authenticated erişimini reddeder ve service_role ister', () => {
    const preflight = extractDoBlock('preflight');
    assert.equal((preflight.match(/\baclexplode\(/gi) || []).length, 2);
    assert.match(preflight, /v_postgres_oid\s*:=\s*to_regrole\('postgres'\)/i);
    assert.match(preflight, /v_service_role_oid\s*:=\s*to_regrole\('service_role'\)/i);
    assert.match(preflight, /v_anon_oid\s*:=\s*to_regrole\('anon'\)/i);
    assert.match(preflight, /v_authenticated_oid\s*:=\s*to_regrole\('authenticated'\)/i);
    assert.equal((preflight.match(/v_owner_oid IS DISTINCT FROM v_postgres_oid/gi) || []).length, 2);
    assert.equal((preflight.match(/acl\.grantee IN \(\s*0::OID,\s*v_anon_oid,\s*v_authenticated_oid\s*\)/gi) || []).length, 2);
    assert.equal((preflight.match(/acl\.grantee = v_service_role_oid/gi) || []).length, 2);
    assert.equal((preflight.match(/v_service_execute_count = 0/gi) || []).length, 2);
    assert.match(preflight, /\[080\] ABORT: calculate ACL safe-state invalid/);
    assert.match(preflight, /\[080\] ABORT: sync ACL safe-state invalid/);
});

test('080 calculate ve sync metadata sözleşmelerini korur', () => {
    const calculate = extractFunction('calculate_raw_material_wac');
    const sync = extractFunction('sync_raw_material_cost');

    assert.match(calculate, /RETURNS NUMERIC\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public/i);
    assert.match(sync, /RETURNS VOID\s+LANGUAGE plpgsql\s+VOLATILE\s+SECURITY DEFINER\s+SET search_path = public/i);
    assert.match(sync, /pg_advisory_xact_lock/i);
    assert.match(sync, /SELECT rm\.tenant_id/i);
    assert.match(sync, /SET prev_cost = v_previous_cost,\s+cost = COALESCE\(v_current_cost, 0\),\s+last_purchase_at = v_last_purchase_at,\s+updated_at = now\(\)/i);
});

test('080 preflight gerekli purchase_items ve raw_materials kolonlarını doğrular', () => {
    const purchaseColumns = [
        'id', 'tenant_id', 'raw_material_id', 'invoice_no', 'invoice_date',
        'created_at', 'is_deleted', 'base_quantity', 'base_unit_cost'
    ];
    const materialColumns = [
        'id', 'tenant_id', 'is_deleted', 'cost', 'prev_cost',
        'last_purchase_at', 'updated_at'
    ];
    for (const column of new Set([...purchaseColumns, ...materialColumns])) {
        assert.match(sql, new RegExp("\\('" + column + "'\\)"));
    }
});

test('080 calculate iki sorguda positive-only filtre ve weighted average kullanır', () => {
    const calculate = extractFunction('calculate_raw_material_wac');
    assert.equal((calculate.match(/pi\.base_quantity > 0/g) || []).length, 2);
    assert.equal((calculate.match(/pi\.base_unit_cost > 0/g) || []).length, 2);
    assert.match(calculate, /SUM\(pi\.base_quantity \* pi\.base_unit_cost\)\s*\/ NULLIF\(SUM\(pi\.base_quantity\), 0\)/i);
});

test('080 sync positive-only active_rows filtresini ranking öncesinde uygular', () => {
    const sync = extractFunction('sync_raw_material_cost');
    const activeStart = sync.indexOf('WITH active_rows AS (');
    const rankedStart = sync.indexOf('), ranked_rows AS (');
    assert.ok(activeStart >= 0 && rankedStart > activeStart);
    const active = sync.slice(activeStart, rankedStart);

    assert.match(active, /pi\.is_deleted = false/i);
    assert.match(active, /pi\.base_quantity IS NOT NULL/i);
    assert.match(active, /pi\.base_quantity > 0/i);
    assert.match(active, /pi\.base_unit_cost IS NOT NULL/i);
    assert.match(active, /pi\.base_unit_cost > 0/i);
    assert.match(sync, /SUM\(ar\.base_quantity \* ar\.base_unit_cost\)\s*\/ NULLIF\(SUM\(ar\.base_quantity\), 0\)/i);
});

test('080 dosyasında non-negative maliyet seçimi ve ACL genişletmesi yoktur', () => {
    assert.doesNotMatch(sql, /base_unit_cost\s*>=\s*0/);
    assert.doesNotMatch(sql, /base_quantity\s*>=\s*0/);
    assert.doesNotMatch(sql, /\bGRANT\s+EXECUTE\b/i);
    assert.doesNotMatch(sql, /\bREVOKE\s+EXECUTE\b/i);
    assert.match(sql, /wac_080_calc_owner_oid/i);
    assert.match(sql, /wac_080_calc_acl/i);
    assert.match(sql, /wac_080_sync_owner_oid/i);
    assert.match(sql, /wac_080_sync_acl/i);
});

test('080 trigger function hash, enabled state ve olay semantiğini doğrular', () => {
    const preflight = extractDoBlock('preflight');
    const post = extractDoBlock('post');

    assert.equal((sql.match(/\|\|\s*t\.tgenabled::text\s*\|\|/gi) || []).length, 2);
    assert.doesNotMatch(sql, /\|\|\s*t\.tgenabled\s*\|\|/i);
    assert.match(preflight, /v_trigger_overloads\s*<>\s*1/i);
    assert.match(preflight, /md5\(pg_get_functiondef\(v_trigger_function_oid\)\)\s*<>\s*'97fcde199ce50f2c83e1d2ae4b0be02b'/i);
    assert.match(preflight, /t\.tgenabled\s*=\s*'O'/i);
    assert.match(preflight, /AFTER INSERT OR DELETE ON/);
    assert.match(preflight, /AFTER UPDATE ON/);
    assert.match(preflight, /t\.tgfoid\s*=\s*v_trigger_function_oid/i);
    assert.match(preflight, /NOT t\.tgisinternal/i);

    assert.match(post, /v_enabled_trigger_count\s*<>\s*2/i);
    assert.match(post, /AFTER INSERT OR DELETE ON/);
    assert.match(post, /AFTER UPDATE ON/);
});

test('080 post-validation iki yeni gövdede forbidden >= 0 operatörünü reddeder', () => {
    const post = extractDoBlock('post');
    assert.equal((post.match(/base_unit_cost\[\[:space:\]\]\*>/g) || []).length, 2);
    assert.equal((post.match(/base_quantity\[\[:space:\]\]\*>/g) || []).length, 2);
    assert.match(post, /v_qty_guard_count\s*<>\s*2/i);
    assert.match(post, /v_cost_guard_count\s*<>\s*2/i);
    assert.match(post, /sync active_rows positive-only filtresi eksik/i);
});

test('080 yetki DDL veya geçmiş veri backfill DML içermez', () => {
    assert.doesNotMatch(sql, /^\s*(GRANT|REVOKE)\b/im);

    const withoutFunctionDefinitions = sql.replace(
        /CREATE OR REPLACE FUNCTION public\.[\s\S]*?\$function\$;/gi,
        ''
    );
    assert.doesNotMatch(withoutFunctionDefinitions, /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/im);
});

test('080 trigger fonksiyonunu/triggerları değiştirmez ve sync çağrısını korur', () => {
    assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.trg_fn_purchase_items_cost_sync/i);
    assert.doesNotMatch(sql, /\bCREATE\s+TRIGGER\b/i);
    assert.match(sql, /wac_080_trigger_function_hash/i);
    assert.match(sql, /wac_080_trigger_defs_hash/i);
    assert.match(triggerSource, /PERFORM public\.sync_raw_material_cost\(v_target_rm_id\)/i);
});

test('080 A: aynı faturada 10x5 + 2x0 calculate ve sync sonucu 5 olur', () => {
    const rows = [
        row(),
        row({ id: 'promo', base_quantity: 2, base_unit_cost: 0 })
    ];
    assert.equal(calculateWac(rows, materials, 'water'), 5);
    assert.equal(syncCostModel(rows, materials, 'water').cost, 5);
});

test('080 B: yeni zero-only belge rank ve last_purchase_at değerini etkilemez', () => {
    const rows = [
        row(),
        row({
            id: 'new-promo', invoice_no: '101', invoice_date: '2026-07-02',
            created_at: '2026-07-02T10:00:00Z', base_quantity: 4, base_unit_cost: 0
        })
    ];
    const result = syncCostModel(rows, materials, 'water');
    assert.equal(calculateWac(rows, materials, 'water'), 5);
    assert.equal(result.cost, 5);
    assert.equal(result.prev_cost, null);
    assert.equal(result.last_purchase_at, '2026-07-01T10:00:00Z');
    assert.deepEqual(result.documentKeys, ['invoice:100']);
});

test('080 C: zero-only ara belge atlanır; cost ve prev_cost pozitif belgelerden gelir', () => {
    const rows = [
        row({ invoice_no: '100', base_unit_cost: 4 }),
        row({
            id: 'zero-middle', invoice_no: '101', invoice_date: '2026-07-02',
            created_at: '2026-07-02T10:00:00Z', base_unit_cost: 0
        }),
        row({
            id: 'positive-new', invoice_no: '102', invoice_date: '2026-07-03',
            created_at: '2026-07-03T10:00:00Z', base_unit_cost: 6
        })
    ];
    const result = syncCostModel(rows, materials, 'water');
    assert.equal(result.cost, 6);
    assert.equal(result.prev_cost, 4);
    assert.equal(result.last_purchase_at, '2026-07-03T10:00:00Z');
    assert.deepEqual(result.documentKeys, ['invoice:102', 'invoice:100']);
});

test('080 D: yalnız zero-only geçmiş cost 0, prev_cost ve last_purchase_at NULL üretir', () => {
    const rows = [
        row({ base_unit_cost: 0 }),
        row({ id: 'zero-2', invoice_no: '101', base_unit_cost: 0 })
    ];
    assert.equal(calculateWac(rows, materials, 'water'), 0);
    assert.deepEqual(syncCostModel(rows, materials, 'water'), {
        cost: 0,
        prev_cost: null,
        last_purchase_at: null,
        documentKeys: []
    });
});

test('080 E: aynı belgedeki çoklu pozitif satırlar gerçek weighted average üretir', () => {
    const rows = [
        row({ base_quantity: 10, base_unit_cost: 5 }),
        row({ id: 'item-2', base_quantity: 5, base_unit_cost: 8 })
    ];
    assert.equal(calculateWac(rows, materials, 'water'), 6);
    assert.equal(syncCostModel(rows, materials, 'water').cost, 6);
});

test('080 F: deleted, başka tenant ve başka material satırları dışlanır', () => {
    const rows = [
        row(),
        row({
            id: 'deleted', invoice_no: '200', invoice_date: '2026-07-05',
            base_unit_cost: 999, is_deleted: true
        }),
        row({
            id: 'other-rm', raw_material_id: 'oil', invoice_no: '201',
            invoice_date: '2026-07-06', base_unit_cost: 888
        }),
        row({
            id: 'other-tenant', tenant_id: 'tenant-b', invoice_no: '202',
            invoice_date: '2026-07-07', base_unit_cost: 777
        })
    ];
    assert.equal(calculateWac(rows, materials, 'water'), 5);
    assert.equal(syncCostModel(rows, materials, 'water').cost, 5);
});

test('080 null, bulunamayan ve silinmiş raw material için güvenli sonuç üretir', () => {
    assert.equal(calculateWac([], materials, null), 0);
    assert.equal(calculateWac([], materials, 'missing'), 0);
    assert.deepEqual(syncCostModel([], materials, 'missing'), {
        cost: 0, prev_cost: null, last_purchase_at: null, documentKeys: []
    });
    assert.equal(calculateWac([], [
        { id: 'water', tenant_id: 'tenant-a', is_deleted: true }
    ], 'water'), 0);
});
