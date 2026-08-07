'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('P1-F.3.16-B: production invoice import button wiring is complete and ordered', () => {
    const productsView = read('views/products-view.js');
    const indexHtml = read('index.html');
    const importButton = productsView.match(/<button id="puImportBtn"[\s\S]*?<\/button>/);

    assert.ok(importButton, 'puImportBtn must exist in products-view');
    assert.match(importButton[0], />Fatura Yükle<\/span>/);
    assert.match(importButton[0], /window\.ImportView\.open\(\)/);
    assert.doesNotMatch(importButton[0], /ImportReviewView\.open/);
    assert.match(productsView, /id="puToggleFormBtnLabel">Yeni Alış Faturası<\/span>/);

    const parserTag = 'utils/import-parsers.js?v=066';
    const importViewTag = 'views/import-view.js?v=065';
    const productsViewTag = 'views/products-view.js?v=059';
    const parserIndex = indexHtml.indexOf(parserTag);
    const importViewIndex = indexHtml.indexOf(importViewTag);
    const productsViewIndex = indexHtml.indexOf(productsViewTag);

    assert.notEqual(parserIndex, -1, 'parser cache tag must remain v=066');
    assert.notEqual(importViewIndex, -1, 'import-view cache tag must remain v=065');
    assert.notEqual(productsViewIndex, -1, 'products-view cache tag must be v=059');
    assert.ok(parserIndex < importViewIndex, 'import-parsers must load before import-view');
    assert.ok(importViewIndex < productsViewIndex, 'import-view must load before products-view');
});
