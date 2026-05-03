/* ============================================================
   IMPORT / EXPORT
   Excel parse + urun dogrulama + import
   FIX: her import = yeni sale
   FIX: sale_id baglantisi korunur
   FIX: "Toplam Satis Tutari" satir toplami olarak ele alinir
   FIX: deterministic idempotency key eklendi
   FIX: duplicate durumda false success engellendi
   ============================================================ */

window.ImportExport = (function () {
    'use strict';

    function normalizeText(value) {
        return String(value || '')
            .trim()
            .toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i')
            .replace(/ğ/g, 'g')
            .replace(/ü/g, 'u')
            .replace(/ş/g, 's')
            .replace(/ö/g, 'o')
            .replace(/ç/g, 'c')
            .replace(/\s+/g, ' ');
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeHeader(value) {
        return normalizeText(value);
    }

    function normalizeProductName(value) {
        return normalizeText(value);
    }

    function formatExcelDate(value) {
        const text = String(value || '').trim();
        if (!text) return '';

        const dotMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (dotMatch) {
            const day = dotMatch[1].padStart(2, '0');
            const month = dotMatch[2].padStart(2, '0');
            const year = dotMatch[3];
            return `${day}.${month}.${year}`;
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            const parts = text.split('-');
            return `${parts[2]}.${parts[1]}.${parts[0]}`;
        }

        const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
        if (slashMatch) {
            let month = slashMatch[1].padStart(2, '0');
            let day = slashMatch[2].padStart(2, '0');
            let year = slashMatch[3];

            if (year.length === 2) {
                year = `20${year}`;
            }

            return `${day}.${month}.${year}`;
        }

        return text;
    }

    function toISODate(displayDate) {
        const text = String(displayDate || '').trim();

        const dotMatch = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (dotMatch) {
            const day = dotMatch[1].padStart(2, '0');
            const month = dotMatch[2].padStart(2, '0');
            const year = dotMatch[3];
            return `${year}-${month}-${day}`;
        }

        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            return text;
        }

        const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
        if (slashMatch) {
            let month = slashMatch[1].padStart(2, '0');
            let day = slashMatch[2].padStart(2, '0');
            let year = slashMatch[3];

            if (year.length === 2) {
                year = `20${year}`;
            }

            return `${year}-${month}-${day}`;
        }

        return '';
    }

    function toNumber(value) {
        const text = String(value || '')
            .trim()
            .replace(/\s/g, '')
            .replace(/\./g, '')
            .replace(',', '.');

        const number = parseFloat(text);
        return Number.isFinite(number) ? number : NaN;
    }

    function toInteger(value) {
        const number = parseInt(String(value || '').trim(), 10);
        return Number.isFinite(number) ? number : NaN;
    }

    function hashString(value) {
        const text = String(value || '');
        let hash = 2166136261;

        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash +=
                (hash << 1) +
                (hash << 4) +
                (hash << 7) +
                (hash << 8) +
                (hash << 24);
        }

        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function buildDeterministicDayKey(isoDate, dayRows, tenantId) {
        const normalizedRows = dayRows
            .map(row => ({
                urun: normalizeProductName(row.urun),
                adet: Number(row.adetNumber),
                unitPrice: Number(row.unitPrice).toFixed(4),
                total: Number(row.rowTotal).toFixed(4)
            }))
            .sort((a, b) => {
                const left = `${a.urun}|${a.adet}|${a.unitPrice}|${a.total}`;
                const right = `${b.urun}|${b.adet}|${b.unitPrice}|${b.total}`;
                return left.localeCompare(right, 'tr');
            });

        const payload = JSON.stringify({
            tenantId: String(tenantId || ''),
            date: isoDate,
            rows: normalizedRows
        });

        return `import_${isoDate}_${hashString(payload)}`;
    }

    function normalizeRows(rows) {
        if (!Array.isArray(rows) || !rows.length) return [];

        const cleaned = rows
            .map(row => Array.isArray(row) ? row.map(cell => String(cell).trim()) : [])
            .filter(row => row.some(cell => cell !== ''));

        if (!cleaned.length) return [];

        const headerIndex = cleaned.findIndex(row => {
            const normalized = row.map(cell => normalizeHeader(cell));
            const hasTarih = normalized.some(h => h === 'tarih');
            const hasUrun = normalized.some(h => h.includes('urun'));
            const hasAdet = normalized.some(h => h === 'adet');
            const hasTutar = normalized.some(h => h.includes('tutar'));
            return hasTarih && hasUrun && hasAdet && hasTutar;
        });

        if (headerIndex === -1) return [];

        const headerRow = cleaned[headerIndex].map(cell => normalizeHeader(cell));
        const dataRows = cleaned.slice(headerIndex + 1);

        const tarihIndex = headerRow.findIndex(h => h === 'tarih');
        const urunIndex = headerRow.findIndex(h => h.includes('urun'));
        const adetIndex = headerRow.findIndex(h => h === 'adet');
        const tutarIndex = headerRow.findIndex(h => h.includes('tutar'));

        if ([tarihIndex, urunIndex, adetIndex, tutarIndex].some(index => index === -1)) {
            return [];
        }

        return dataRows
            .map(row => ({
                tarih: formatExcelDate(row[tarihIndex]),
                urun: String(row[urunIndex] || '').trim(),
                adet: String(row[adetIndex] || '').trim(),
                tutar: String(row[tutarIndex] || '').trim()
            }))
            .filter(row => row.tarih || row.urun || row.adet || row.tutar);
    }

    function groupRowsByDate(rows) {
        const grouped = {};
        const skipped = [];

        for (const row of rows) {
            const isoDate = toISODate(row.tarih);
            const adetNumber = toInteger(row.adet);
            const rowTotal = toNumber(row.tutar);
            const unitPrice = Number.isFinite(adetNumber) && adetNumber > 0
                ? (rowTotal / adetNumber)
                : NaN;

            if (
                !isoDate ||
                !Number.isFinite(adetNumber) ||
                adetNumber <= 0 ||
                !Number.isFinite(rowTotal) ||
                rowTotal < 0 ||
                !Number.isFinite(unitPrice) ||
                unitPrice < 0
            ) {
                skipped.push(row);
                continue;
            }

            if (!grouped[isoDate]) grouped[isoDate] = [];

            grouped[isoDate].push({
                ...row,
                isoDate,
                adetNumber,
                unitPrice,
                rowTotal
            });
        }

        return { grouped, skipped };
    }

    async function readSalesExcel(file) {
        if (!file) {
            return { ok: false, message: 'Dosya seçilmedi.' };
        }

        if (typeof XLSX === 'undefined') {
            return { ok: false, message: 'Excel kütüphanesi yüklenemedi.' };
        }

        try {
            const buffer = await file.arrayBuffer();
            const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });

            if (!workbook.SheetNames || !workbook.SheetNames.length) {
                return { ok: false, message: 'Excel içinde okunacak sayfa bulunamadı.' };
            }

            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, {
                header: 1,
                raw: false,
                defval: ''
            });

            const parsedRows = normalizeRows(rows);
            const MAX_IMPORT_ROWS = 400;

            if (!parsedRows.length) {
                return {
                    ok: false,
                    message: 'Dosya boş veya uygun formatta değil. Beklenen kolonlar: Tarih, Ürün Adı, Adet, Toplam Satış Tutarı'
                };
            }

            if (parsedRows.length > MAX_IMPORT_ROWS) {
                return {
                    ok: false,
                    code: 'IMPORT_LIMIT_EXCEEDED',
                    message: `Dosya çok büyük (${parsedRows.length} satır). Maksimum ${MAX_IMPORT_ROWS} satır yükleyebilirsiniz.`
                };
            }

            const invalidDates = parsedRows.filter(row => !toISODate(row.tarih));

            if (invalidDates.length > 0) {
                return {
                    ok: false,
                    code: 'INVALID_DATE',
                    rows: parsedRows,
                    invalidCount: invalidDates.length,
                    message: `${invalidDates.length} satırda geçersiz tarih formatı var. Desteklenen formatlar: 24.03.2026, 1.03.2026, 2026-03-24`
                };
            }

            return {
                ok: true,
                rows: parsedRows
            };
        } catch (error) {
            return {
                ok: false,
                message: 'Excel dosyası okunurken hata oluştu.',
                rawError: error
            };
        }
    }

    async function loadActiveProducts() {
        if (!window.SupabaseService || !window.SupabaseService.isConnected()) {
            return {
                ok: false,
                productMap: new Map(),
                message: 'Supabase bağlı değil. Ürün doğrulaması yapılamadı.'
            };
        }

        const result = await window.ProductsService.getAll();
        const data = Array.isArray(result?.data) ? result.data : [];
        const error = result?.error || null;

        if (error) {
            return {
                ok: false,
                productMap: new Map(),
                message: 'Products tablosu okunamadı. Ürün doğrulaması yapılamadı.'
            };
        }

        const activeProducts = data.filter(item => item && item.is_active !== false);

        if (!activeProducts.length) {
            return {
                ok: false,
                productMap: new Map(),
                message: 'Products tablosunda kayıtlı aktif ürün yok.'
            };
        }

        const productMap = new Map();

        for (const item of activeProducts) {
            const rawName = String(item.name || '').trim();
            const normalized = normalizeProductName(rawName);

            if (!normalized) continue;

            productMap.set(normalized, {
                id: item.id,
                name: rawName,
                price: Number(item.price) || 0,
                cost: Number(item.cost) || 0
            });
        }

        return {
            ok: true,
            productMap
        };
    }

    function validateRowsAgainstProducts(rows, productMap) {
        const missing = [];
        const seen = new Set();

        for (const row of rows) {
            const normalized = normalizeProductName(row.urun);

            if (!normalized || !productMap.has(normalized)) {
                const label = row.urun || '(boş ürün)';
                if (!seen.has(label)) {
                    seen.add(label);
                    missing.push(label);
                }
            }
        }

        return {
            ok: missing.length === 0,
            missing
        };
    }

    async function importSalesRows(rows, productMap, importSessionKey) {
        if (!Array.isArray(rows) || !rows.length) {
            return { ok: false, message: 'Aktarılacak geçerli veri bulunamadı.' };
        }

        if (!window.SupabaseService || !window.SupabaseService.isConnected()) {
            return { ok: false, message: 'Supabase bağlı değil. Kayıt yapılamadı.' };
        }

        const groupedByDate = groupRowsByDate(rows);
        const dates = Object.keys(groupedByDate.grouped);

        if (!dates.length) {
            return { ok: false, message: 'Aktarılacak geçerli veri bulunamadı.' };
        }

        if (groupedByDate.skipped.length > 0) {
            return {
                ok: false,
                message: `${groupedByDate.skipped.length} satır geçersiz veri içerdiği için aktarım durduruldu.`
            };
        }

        const client = window.SupabaseService.getClient();
        const tenantId = await window.SupabaseService.getTenantId();

        if (!client || !tenantId) {
            return { ok: false, message: 'Supabase bağlantısı veya tenant bilgisi alınamadı.' };
        }

        const salesBatch = [];
        let totalProducts = 0;

        for (const date of dates) {
            const dayRows = groupedByDate.grouped[date];
            const dailyTotal = dayRows.reduce((sum, row) => sum + row.rowTotal, 0);

            const products = [];
            for (const row of dayRows) {
                const productInfo = productMap.get(normalizeProductName(row.urun));

                if (!productInfo) {
                    return { ok: false, message: `Ürün eşlemesi kayboldu: ${row.urun}` };
                }

                products.push({
                    product_id: productInfo.id,
                    quantity: row.adetNumber,
                    unit_price: row.unitPrice,
                    total: row.rowTotal,
                    cost: Number(productInfo.cost) || 0
                });
            }

            const deterministicKey = buildDeterministicDayKey(date, dayRows, tenantId);

            salesBatch.push({
                date: date,
                total: dailyTotal,
                cash: 0,
                card: 0,
                notes: 'Aktarma ekranından oluşturuldu',
                products: products,
                idempotency_key: deterministicKey,
                import_session_key: importSessionKey || null
            });

            totalProducts += products.length;
        }

        try {
            const { data, error } = await client.rpc('create_sales_atomic', {
                p_tenant_id: tenantId,
                p_sales: salesBatch
            });

            if (error) {
                return { ok: false, message: error.message || 'Toplu satış kaydı oluşturulamadı.' };
            }

            if (!Array.isArray(data) || data.length === 0) {
                return { ok: false, message: 'Bu veri zaten daha önce aktarılmış. Yeni kayıt oluşturulmadı.' };
            }

            let actualImportedProducts = 0;

            for (const sale of data) {
                const productSales = Array.isArray(sale?.product_sales) ? sale.product_sales : [];
                actualImportedProducts += productSales.length;
            }

            if (actualImportedProducts === 0) {
                return { ok: false, message: 'Bu veri zaten daha önce aktarılmış. Yeni kayıt oluşturulmadı.' };
            }

            return { ok: true, importedCount: actualImportedProducts };
        } catch (err) {
            return { ok: false, message: err?.message || 'Aktarım sırasında beklenmeyen hata oluştu.' };
        }
    }

    function createSalesTemplate() {
        if (typeof XLSX === 'undefined') {
            return { ok: false, message: 'Excel kütüphanesi yüklenemedi.' };
        }

        try {
            const workbook = XLSX.utils.book_new();
            const sheetData = [
                ['Tarih', 'Ürün Adı', 'Adet', 'Toplam Satış Tutarı'],
                ['24.03.2026', 'Latte', 3, 186]
            ];

            const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
            worksheet['!cols'] = [
                { wch: 14 },
                { wch: 28 },
                { wch: 10 },
                { wch: 20 }
            ];

            XLSX.utils.book_append_sheet(workbook, worksheet, 'SatisAktarma');
            XLSX.writeFile(workbook, 'satis_sablonu.xlsx');

            return { ok: true };
        } catch (error) {
            return { ok: false, message: 'Şablon indirilirken hata oluştu.', rawError: error };
        }
    }

    async function restoreFromBackup(backupData, productMap) {
        if (!backupData || !Array.isArray(backupData.sales)) {
            return { ok: false, message: 'Geçersiz backup dosyası.' };
        }

        const rows = [];

        for (const sale of backupData.sales) {
            if (!sale.date || !Array.isArray(sale.product_sales)) continue;

            for (const item of sale.product_sales) {
                rows.push({
                    tarih: sale.date,
                    urun: item.product_name || '',
                    adet: item.quantity,
                    tutar: item.total
                });
            }
        }

        if (!rows.length) {
            return { ok: false, message: 'Backup içinde geçerli veri yok.' };
        }

        // mevcut import pipeline kullan
        return await importSalesRows(rows, productMap, 'restore_session');
    }

    /* ============================================================
       FULL BACKUP — export_all_data() + restore_full_backup()
       TEK YOL: import sadece restore_full_backup uzerinden yapilir.
       (Eski import_all_data RPC'si kullanilmiyor.)
       Tenant server-side (auth.uid). Idempotent (ON CONFLICT DO NOTHING).
    ============================================================ */

    const BACKUP_EXPORT_VERSION = '1.0';
    const BACKUP_REQUIRED_TABLES = [
        'categories', 'products', 'sales', 'product_sales',
        'purchase_items', 'raw_materials',
        'expenses', 'events', 'tasks', 'settings'
    ];

    function backupClient() {
        return window.SupabaseService && window.SupabaseService.getClient
            ? window.SupabaseService.getClient()
            : null;
    }

    function triggerBackupDownload(payload) {
        try {
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            a.href = url;
            a.download = 'nova-backup-' + ts + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } catch (e) {
            console.warn('[backup] download failed:', e);
        }
    }

    function validateBackupPayload(payload) {
        if (!payload || typeof payload !== 'object') return 'Invalid JSON: not an object';
        if (!payload.export_version) return 'Missing export_version';
        if (payload.export_version !== BACKUP_EXPORT_VERSION) {
            return 'Unsupported export_version: ' + payload.export_version;
        }
        if (!payload.data || typeof payload.data !== 'object') return 'Missing data block';
        for (let i = 0; i < BACKUP_REQUIRED_TABLES.length; i++) {
            const t = BACKUP_REQUIRED_TABLES[i];
            if (payload.data[t] !== undefined && !Array.isArray(payload.data[t])) {
                return 'Invalid shape: data.' + t + ' must be array';
            }
        }
        return null;
    }

    async function exportAll(options) {
        options = options || {};
        const c = backupClient();
        if (!c) return { ok: false, error: 'Supabase not initialized' };

        try {
            const { data, error } = await c.rpc('export_all_data');
            if (error) return { ok: false, error: error.message || String(error) };
            if (!data || typeof data !== 'object') return { ok: false, error: 'Empty export payload' };

            if (options.download !== false) triggerBackupDownload(data);
            return { ok: true, data: data };
        } catch (err) {
            return { ok: false, error: (err && err.message) || 'Export failed' };
        }
    }

    async function importAll(input) {
        const c = backupClient();
        if (!c) return { ok: false, error: 'Supabase not initialized' };

        // === Parse input ===
        let payload = null;
        try {
            if (input instanceof File || input instanceof Blob) {
                payload = JSON.parse(await input.text());
            } else if (typeof input === 'string') {
                payload = JSON.parse(input);
            } else if (input && typeof input === 'object') {
                payload = input;
            } else {
                return { ok: false, error: 'Invalid input' };
            }
        } catch (e) {
            return { ok: false, error: 'JSON parse failed: ' + (e.message || e) };
        }

        // === Validate (export_version + data shape) ===
        const invalid = validateBackupPayload(payload);
        if (invalid) return { ok: false, error: invalid };

        // === Build the shape restore_full_backup expects ===
        // restore_full_backup(backup JSONB, tenant UUID) — TEK import yolu
        const data = payload.data || {};
        const backupForRpc = {
            products:       Array.isArray(data.products)       ? data.products       : [],
            sales:          Array.isArray(data.sales)          ? data.sales          : [],
            product_sales:  Array.isArray(data.product_sales)  ? data.product_sales  : [],
            expenses:       Array.isArray(data.expenses)       ? data.expenses       : [],
            purchase_items: Array.isArray(data.purchase_items) ? data.purchase_items : [],
            raw_materials:  Array.isArray(data.raw_materials)  ? data.raw_materials  : []
        };

        // === Call FIXED restore_full_backup (idempotency_key + ON CONFLICT) ===
        // tenant=null -> fonksiyon auth.uid() uzerinden tenant cozer
        try {
            const { data: rpcData, error } = await c.rpc('restore_full_backup', {
                backup: backupForRpc,
                tenant: null
            });

            // Duplicate / unique_violation hatalari fonksiyon icinde
            // skipped sayaca aktariliyor; buraya YALNIZCA gercek
            // sistem hatalari dusmeli.
            if (error) {
                // Yine de duplicate temali bir hata gelirse swallow yerine
                // raporla — kullanici sebebi gormeli.
                return {
                    ok: false,
                    error: error.message || String(error)
                };
            }

            if (!rpcData || rpcData.success !== true) {
                return { ok: false, error: 'Restore basarisiz: bos yanit' };
            }

            // === Build human-friendly summary ===
            const ins = rpcData.inserted || {};
            const skp = rpcData.skipped  || {};

            const insTotal =
                (ins.products || 0) +
                (ins.sales || 0) +
                (ins.product_sales || 0) +
                (ins.expenses || 0);

            const skpTotal =
                (skp.products || 0) +
                (skp.sales || 0) +
                (skp.product_sales || 0) +
                (skp.expenses || 0);

            let message =
                (ins.products || 0)      + ' urun, ' +
                (ins.sales || 0)         + ' satis, ' +
                (ins.product_sales || 0) + ' urun-satis, ' +
                (ins.expenses || 0)      + ' gider eklendi';

            if (skpTotal > 0) {
                message += ' | ' + skpTotal + ' kayit zaten mevcuttu (atlandi)';
            }

            // === Cache invalidate + event dispatch ===
            try {
                if (window.ViewCache && typeof window.ViewCache.clear === 'function') {
                    window.ViewCache.clear();
                }
                window.dispatchEvent(new Event('sales:updated'));
                window.dispatchEvent(new Event('expenses:updated'));
                window.dispatchEvent(new Event('products:updated'));
                window.dispatchEvent(new Event('dashboard:refresh'));
            } catch (e) { /* never block */ }

            return {
                ok: true,
                result: rpcData,
                inserted: ins,
                skipped: skp,
                insertedTotal: insTotal,
                skippedTotal: skpTotal,
                message: message
            };
        } catch (err) {
            return {
                ok: false,
                error: (err && err.message) || 'Import failed'
            };
        }
    }

    function pickBackupFile() {
        return new Promise(function (resolve) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.onchange = function () {
                const f = input.files && input.files[0];
                resolve(f || null);
            };
            input.click();
        });
    }

    return {
        escapeHtml,
        normalizeProductName,
        toISODate,
        readSalesExcel,
        loadActiveProducts,
        validateRowsAgainstProducts,
        importSalesRows,
        createSalesTemplate,
        restoreFromBackup,

        BACKUP_EXPORT_VERSION: BACKUP_EXPORT_VERSION,
        exportAll: exportAll,
        importAll: importAll,
        pickBackupFile: pickBackupFile,
        validateBackupPayload: validateBackupPayload
    };
})();