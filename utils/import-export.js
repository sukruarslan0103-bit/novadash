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

    return {
        escapeHtml,
        normalizeProductName,
        toISODate,
        readSalesExcel,
        loadActiveProducts,
        validateRowsAgainstProducts,
        importSalesRows,
        createSalesTemplate,
        restoreFromBackup
    };
})();