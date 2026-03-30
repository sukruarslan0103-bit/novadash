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

                // 🔥 COST SNAPSHOT — birim maliyet (unit cost)
                const cost = toNumber(costMap.get(productId) || 0);

                return {
                    sale_id: saleId,
                    date: saleDate,
                    product_id: productId,
                    quantity,
                    unit_price: unitPrice,
                    total,
                    cost   // 🔥 BİRİM MALİYET — çarpım analytics tarafında yapılır
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
            order: { column: 'date', asc: false }
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
            order: { column: 'date', asc: false }
        });
    }

    /**
     * Ürün satırlarından RPC'ye gönderilecek products dizisini oluşturur.
     * Cost snapshot burada yapılır — birim maliyet yazılır.
     */
    function buildProductsForRpc(lines, costMap) {
        return lines
            .map(function (line) {
                const quantity = toNumber(line.quantity ?? line.qty ?? line.adet);
                const unitPrice = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
                const total = toNumber(line.total ?? line.line_total ?? line.lineTotal ?? (quantity * unitPrice));
                const productId = line.product_id ?? line.productId ?? line.id ?? null;

                if (!productId || quantity <= 0) return null;

                // 🔥 COST SNAPSHOT — birim maliyet (unit cost)
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

        // TOTAL HESAP
        let computedTotal = 0;
        lines.forEach(line => {
            const q = toNumber(line.quantity ?? line.qty ?? line.adet);
            const p = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
            computedTotal += q * p;
        });

        if (computedTotal > 0) {
            salePayload.total = computedTotal;
        }

        // Ürün satırı yoksa → basit insert (transaction gereksiz)
        if (!lines.length) {
            return await window.SupabaseService.insert('sales', salePayload);
        }

        // 🔥 COST MAP LOAD
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

        // 🔥 ATOMIC: sale + product_sales tek transaction
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

            // RPC returns array — tek satış için ilk elemanı al
            const result = Array.isArray(data) ? data[0] : data;
            return { data: result || null, error: null };
        } catch (err) {
            return { data: null, error: err?.message || 'Satış oluşturulurken hata oluştu' };
        }
    }

    async function update(id, updates) {
        return await window.SupabaseService.update('sales', id, updates);
    }

    async function remove(id) {
        // Soft delete: is_deleted = true
        // product_sales CASCADE üzerinden korunur (sale silinmiyor)
        return await window.SupabaseService.update('sales', id, {
            is_deleted: true
        });
    }

    return { getAll, getByDateRange, create, update, remove };
})();