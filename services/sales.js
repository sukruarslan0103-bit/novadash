/* ============================================================
   SALES SERVICE — CRUD Operations
   Safe sale + product_sales write flow
   + COST SNAPSHOT (KRİTİK)
   ============================================================ */

window.SalesService = (function() {
    'use strict';

    // 048: idempotency_key DB tarafında üretilir.
    // create_sales_atomic NULL geldiğinde aynı formülle (md5
    // tenant|date|total|cash|card|notes) fallback hash üretir.
    // Eski client-side _md5 helper bu nedenle kaldırıldı.
    // İstisna: utils/import-export.js Excel toplu importunda kendi
    // deterministic key'ini gönderir; o yol aynen korunur.

    function getTenantId() {
        return window.STATE?.tenant?.id || null;
    }

    function toNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function normalizeDate(value) {
        if (!value) return '';
        return String(value).slice(0, 10);
    }

    function extractProductLines(sale) {
        if (!sale || typeof sale !== 'object') return [];

        const candidates = [
            sale.product_sales,
            sale.productSales,
            sale.products,
            sale.items,
            sale.lines
        ];

        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return candidate.filter(Boolean);
            }
        }

        return [];
    }

    function buildSalePayload(sale) {
        const payload = { ...(sale || {}) };

        delete payload.product_sales;
        delete payload.productSales;
        delete payload.products;
        delete payload.items;
        delete payload.lines;

        return payload;
    }

    // 046: product_sales.cost artik DB tarafindan products.cost'tan snapshot
    // alinir. Frontend cost gondermez. loadProductCostMap + buildProductSalesPayload
    // dead-code oldugu icin kaldirildi.

    async function getAll(options = {}) {
        var baseFilters = [
            { op: 'eq', column: 'is_deleted', value: false }
        ];

        if (Array.isArray(options.filters)) {
            baseFilters = baseFilters.concat(options.filters);
        }

        return await window.SupabaseService.query('sales', {
            ...options,
            filters: baseFilters,
            order: { column: 'date', asc: false },
            select: options.select || 'id,date,total,cash,card,created_at'
        });
    }

    function computeEndExclusive(endStr) {
        if (!endStr) return '';
        var d = new Date(endStr + 'T00:00:00Z');
        if (isNaN(d.getTime())) return endStr;
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
    }

    async function getByDateRange(startDate, endDate, options = {}) {
        var startStr = normalizeDate(startDate);
        var endStr   = normalizeDate(endDate);

        var page = Number(options.page) > 0 ? Number(options.page) : 1;
        // Sayfa belirtilmediyse büyük limit (toplu görünüm/export için)
        var pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 5000;
        var offset = (page - 1) * pageSize;

        try {
            var client = window.SupabaseService.getClient();
            if (!client) {
                return { data: [], count: 0, error: { message: 'Supabase not initialized' }, totalPages: 0, page: page, pageSize: pageSize, from: 0, to: 0 };
            }

            var res = await client.rpc('get_sales_paginated', {
                p_start: startStr || null,
                p_end:   endStr   || null,
                p_limit: pageSize,
                p_offset: offset
            });

            if (res.error) {
                return { data: [], count: 0, error: res.error, totalPages: 0, page: page, pageSize: pageSize, from: 0, to: 0 };
            }

            var rows = Array.isArray(res.data) ? res.data : [];
            var totalCount = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;
            // total_count alanını dış katmanlardan gizle (RPC artifact)
            var data = rows.map(function (r) {
                return {
                    id: r.id,
                    date: r.date,
                    total: r.total,
                    cash: r.cash,
                    card: r.card,
                    cost: r.cost,
                    profit: r.profit,
                    created_at: r.created_at
                };
            });

            var totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;
            var fromIdx = totalCount > 0 ? offset + 1 : 0;
            var toIdx   = totalCount > 0 ? Math.min(offset + data.length, totalCount) : 0;

            return {
                data: data,
                count: totalCount,
                error: null,
                totalPages: totalPages,
                page: page,
                pageSize: pageSize,
                from: fromIdx,
                to: toIdx
            };
        } catch (err) {
            return { data: [], count: 0, error: err, totalPages: 0, page: page, pageSize: pageSize, from: 0, to: 0 };
        }
    }

    async function getAllByDateRange(startDate, endDate) {
        const PAGE_SIZE = 1000;
        let page = 1;
        let all = [];
        let total = 0;

        var startStr = normalizeDate(startDate);
        var endStr   = normalizeDate(endDate);
        var endExclusive = computeEndExclusive(endStr);

        var baseFilters = [
            { op: 'eq', column: 'is_deleted', value: false }
        ];
        if (startStr) baseFilters.push({ op: 'gte', column: 'date', value: startStr });
        if (endExclusive) baseFilters.push({ op: 'lt',  column: 'date', value: endExclusive });

        while (true) {
            const res = await window.SupabaseService.query('sales', {
                filters: baseFilters,
                order: { column: 'date', asc: false },
                select: 'id,date,total,cash,card,created_at',
                page: page,
                pageSize: PAGE_SIZE,
                count: true
            });

            if (res.error) return { data: [], error: res.error, count: 0 };

            const chunk = Array.isArray(res.data) ? res.data : [];
            all = all.concat(chunk);
            total = Number(res.count || 0);

            if (chunk.length < PAGE_SIZE || all.length >= total) break;
            page++;
        }

        return { data: all, error: null, count: total };
    }

    // 046: cost alani RPC payload'da YOK. DB-side snapshot create_sales_atomic
    // tarafindan products.cost'tan alinir. Frontend cost authority degildir.
    function buildProductsForRpc(lines) {
        return lines
            .map(function (line) {
                const quantity = toNumber(line.quantity ?? line.qty ?? line.adet);
                const unitPrice = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
                const total = toNumber(line.total ?? line.line_total ?? line.lineTotal ?? (quantity * unitPrice));
                const productId = line.product_id ?? line.productId ?? line.id ?? null;

                if (!productId || quantity <= 0) return null;

                return {
                    product_id: productId,
                    quantity: quantity,
                    unit_price: unitPrice,
                    total: total
                };
            })
            .filter(Boolean);
    }

    async function create(sale) {
        const tenantId = getTenantId();

        if (!tenantId) {
            return { data: null, error: 'Tenant bulunamadı' };
        }

        const salePayload = buildSalePayload(sale);
        const lines = extractProductLines(sale);

        let computedTotal = 0;
        lines.forEach(line => {
            const q = toNumber(line.quantity ?? line.qty ?? line.adet);
            const p = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
            computedTotal += q * p;
        });

        if (computedTotal > 0) {
            salePayload.total = computedTotal;
        }

        // 048: idempotency_key artık DB tarafında üretilir (server fallback).
        // Caller (örn. utils/import-export.js Excel batch) explicit key
        // göndermişse onu passthrough yap; aksi halde NULL gönder.
        const _saleIdemKey = salePayload.idempotency_key || null;

        // 047: Tek canonical write path — create_sales_atomic.
        // Urunsuz satis (lines = []) icin de ayni RPC kullanilir; DB
        // tarafinda products bos -> sales header yazilir, product_sales
        // bos kalir. create_sale_empty artik frontend'den cagirilmaz.
        // 046: costMap kaldirildi. Cost authority DB tarafinda.
        const products = buildProductsForRpc(lines);

        const client = window.SupabaseService.getClient();
        if (!client || typeof client.rpc !== 'function') {
            return { data: null, error: 'Supabase RPC client yok' };
        }

        try {
            // 047: p_tenant_id payload'da YOK. Tenant DB tarafinda
            // auth.uid() -> users.tenant_id ile resolve edilir.
            const { data, error } = await client.rpc('create_sales_atomic', {
                p_sales: [{
                    date: normalizeDate(salePayload.date),
                    total: toNumber(salePayload.total),
                    cash: toNumber(salePayload.cash),
                    card: toNumber(salePayload.card),
                    notes: salePayload.notes || null,
                    idempotency_key: _saleIdemKey,
                    products: products
                }]
            });

            if (error) {
                return { data: null, error: error.message || error };
            }

            // 047: create_sales_atomic batch'teki tum satislar duplicate
            // ise '[]' (bos array) doner. UI bunu basari gibi gosteriyordu
            // (yanlis feedback). Caller'in ayirt edebilmesi icin
            // `duplicate` field'i ekleniyor (backward-compat: opsiyonel).
            const isDuplicate = Array.isArray(data) && data.length === 0;
            const result = Array.isArray(data) ? data[0] : data;

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + tenantId);
                window.ViewCache.invalidate('dashboard:' + tenantId);
            }

            window.dispatchEvent(new Event('sales:updated'));

            return { data: result || null, error: null, duplicate: isDuplicate };
        } catch (err) {
            return { data: null, error: err?.message || 'Satış oluşturulurken hata oluştu' };
        }
    }

    async function update(id, updates) {
        const client = window.SupabaseService.getClient();
        if (!client || typeof client.rpc !== 'function') {
            return { data: null, error: 'Supabase RPC client yok' };
        }
        const res = await client.rpc('update_sale', {
            p_id: id,
            p_updates: updates || {}
        });
        if (res.error) {
            return { data: null, error: res.error.message || res.error };
        }
        return { data: res.data, error: null };
    }

    async function remove(id) {
        const client = window.SupabaseService.getClient();
        if (!client || typeof client.rpc !== 'function') {
            return { data: null, error: 'Supabase RPC client yok' };
        }
        const res = await client.rpc('soft_delete_sale', { p_id: id });
        if (res.error) {
            return { data: null, error: res.error.message || res.error };
        }
        return { data: res.data, error: null };
    }

    async function getFullBackup() {
        const tenantId = getTenantId();

        if (!tenantId) {
            return { ok: false, message: 'Tenant bulunamadı' };
        }

        try {
            const salesResult = await window.SupabaseService.query('sales', {
                filters: [{ op: 'eq', column: 'is_deleted', value: false }]
            });

            const productSalesResult = await window.SupabaseService.query('product_sales', {
                filters: []
            });

            const expensesResult = await window.SupabaseService.query('expenses', {
                filters: []
            });

            const productsResult = await window.SupabaseService.query('products', {
                filters: []
            });

            if (salesResult.error || productSalesResult.error || expensesResult.error || productsResult.error) {
                return { ok: false, message: 'Veri çekilemedi' };
            }

            return {
                ok: true,
                data: {
                    sales: salesResult.data || [],
                    product_sales: productSalesResult.data || [],
                    expenses: expensesResult.data || [],
                    products: productsResult.data || []
                }
            };

        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    async function restoreFromBackup(backupData) {
        const tenantId = getTenantId();

        if (!tenantId) {
            return { ok: false, message: 'Tenant bulunamadı' };
        }

        if (!backupData || typeof backupData !== 'object') {
            return { ok: false, message: 'Geçersiz backup dosyası' };
        }

        const client = window.SupabaseService.getClient();
        if (!client) {
            return { ok: false, message: 'Supabase client yok' };
        }

        try {
            const { data, error } = await client.rpc('restore_full_backup', {
                backup: backupData,
                tenant: tenantId
            });

            if (error) {
                return { ok: false, message: error.message };
            }

            if (!data || data.success !== true) {
                return { ok: false, message: 'Restore başarısız' };
            }

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + tenantId);
                window.ViewCache.invalidate('dashboard:' + tenantId);
            }

            window.dispatchEvent(new Event('sales:updated'));
            window.dispatchEvent(new Event('expenses:updated'));
            window.dispatchEvent(new Event('products:updated'));
            window.dispatchEvent(new Event('dashboard:refresh'));

            var ins = data.inserted || {};
            var skp = data.skipped || {};
            var msg = (ins.products || 0) + ' ürün, ' +
                      (ins.sales || 0) + ' satış, ' +
                      (ins.product_sales || 0) + ' ürün-satış, ' +
                      (ins.expenses || 0) + ' gider eklendi';
            var skTotal = (skp.products || 0) + (skp.sales || 0) + (skp.product_sales || 0) + (skp.expenses || 0);
            if (skTotal > 0) {
                msg += ' | ' + skTotal + ' kayıt zaten mevcuttu (atlandı)';
            }

            return {
                ok: true,
                message: msg
            };

        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    return {
        getAll,
        getByDateRange,
        getAllByDateRange,
        create,
        update, 
        remove,
        getFullBackup,
        restoreFromBackup
    };
})();