/* ============================================================
   SALES SERVICE — CRUD Operations
   Safe sale + product_sales write flow
   + COST SNAPSHOT (KRİTİK)
   ============================================================ */

window.SalesService = (function() {
    'use strict';

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

    async function loadProductCostMap() {
        const { data, error } = await window.ProductsService.getAll();
        if (error || !Array.isArray(data)) return new Map();

        const map = new Map();
        data.forEach(p => {
            map.set(p.id, toNumber(p.cost));
        });

        return map;
    }

    function buildProductSalesPayload(lines, saleRecord, costMap) {
        const saleDate = normalizeDate(saleRecord?.date);
        const saleId = saleRecord?.id || null;

        return lines
            .map((line) => {
                const quantity = toNumber(
                    line.quantity ?? line.qty ?? line.adet
                );

                const unitPrice = toNumber(
                    line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat
                );

                const total = toNumber(
                    line.total ?? line.line_total ?? line.lineTotal ?? (quantity * unitPrice)
                );

                const productId =
                    line.product_id ??
                    line.productId ??
                    line.id ??
                    null;

                if (!productId || quantity <= 0 || !saleId) {
                    return null;
                }

                const cost = toNumber(costMap.get(productId) || 0);

                return {
                    sale_id: saleId,
                    date: saleDate,
                    product_id: productId,
                    quantity,
                    unit_price: unitPrice,
                    total,
                    cost
                };
            })
            .filter(Boolean);
    }

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

    async function getByDateRange(startDate, endDate, options = {}) {
        var baseFilters = [
            { op: 'eq', column: 'is_deleted', value: false },
            { op: 'gte', column: 'date', value: startDate },
            { op: 'lte', column: 'date', value: endDate }
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

    function buildProductsForRpc(lines, costMap) {
        return lines
            .map(function (line) {
                const quantity = toNumber(line.quantity ?? line.qty ?? line.adet);
                const unitPrice = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
                const total = toNumber(line.total ?? line.line_total ?? line.lineTotal ?? (quantity * unitPrice));
                const productId = line.product_id ?? line.productId ?? line.id ?? null;

                if (!productId || quantity <= 0) return null;

                const cost = toNumber(costMap.get(productId) || 0);

                return {
                    product_id: productId,
                    quantity: quantity,
                    unit_price: unitPrice,
                    total: total,
                    cost: cost
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

        if (!lines.length) {
            const insertResult = await window.SupabaseService.insert('sales', salePayload);

            if (!insertResult.error) {
                if (window.ViewCache) {
                    window.ViewCache.invalidate('sales:' + tenantId);
                    window.ViewCache.invalidate('dashboard:' + tenantId);
                }

                window.dispatchEvent(new Event('sales:updated'));
            }

            return insertResult;
        }

        let costMap;
        try {
            costMap = await loadProductCostMap();
        } catch (e) {
            return { data: null, error: 'Ürün maliyet verisi yüklenemedi' };
        }

        const products = buildProductsForRpc(lines, costMap);

        if (!products.length) {
            return { data: null, error: 'Geçerli ürün satırı bulunamadı' };
        }

        const client = window.SupabaseService.getClient();
        if (!client) {
            return { data: null, error: 'Supabase client bulunamadı' };
        }

        try {
            const { data, error } = await client.rpc('create_sales_atomic', {
                p_tenant_id: tenantId,
                p_sales: [{
                    date: normalizeDate(salePayload.date),
                    total: toNumber(salePayload.total),
                    cash: toNumber(salePayload.cash),
                    card: toNumber(salePayload.card),
                    notes: salePayload.notes || null,
                    created_by: salePayload.created_by || null,
                    products: products
                }]
            });

            if (error) {
                return { data: null, error: error.message || error };
            }

            const result = Array.isArray(data) ? data[0] : data;

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + tenantId);
                window.ViewCache.invalidate('dashboard:' + tenantId);
            }

            window.dispatchEvent(new Event('sales:updated'));

            return { data: result || null, error: null };
        } catch (err) {
            return { data: null, error: err?.message || 'Satış oluşturulurken hata oluştu' };
        }
    }

    async function update(id, updates) {
        return await window.SupabaseService.update('sales', id, updates);
    }

    async function remove(id) {
        return await window.SupabaseService.update('sales', id, {
            is_deleted: true
        });
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
        create, 
        update, 
        remove,
        getFullBackup,
        restoreFromBackup
    };
})();