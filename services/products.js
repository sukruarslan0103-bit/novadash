/* ============================================================
   PRODUCTS SERVICE — CRUD Operations + Performance Analytics
   ============================================================ */

window.ProductsService = (function () {
    'use strict';

    function getTenantId() {
        return window.STATE && window.STATE.tenant ? window.STATE.tenant.id : null;
    }

    function toNumber(value) {
        var n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function normalizeDate(value) {
        if (!value) return '';
        return String(value).slice(0, 10);
    }

    async function getAll(options) {
        options = options || {};

        var tenantId = getTenantId();

        if (!tenantId) {
            return {
                data: null,
                error: 'Tenant bulunamadı'
            };
        }

        var defaults = {
            filters: [
                { op: 'eq', column: 'is_deleted', value: false }
            ],
            order: { column: 'name', asc: true }
        };

        // Kullanıcı ekstra filtre verirse mevcut filtrelere ekle
        if (options.filters && Array.isArray(options.filters)) {
            defaults.filters = defaults.filters.concat(options.filters);
            delete options.filters;
        }

        return await window.SupabaseService.query('products', Object.assign(defaults, options));
    }

    async function getPerformanceSummary(options) {
        options = options || {};

        var tenantId = getTenantId();

        if (!tenantId) {
            return {
                data: [],
                error: 'Tenant bulunamadı'
            };
        }

        if (!window.AnalyticsService || typeof window.AnalyticsService.getProductPerformanceSummary !== 'function') {
            return {
                data: [],
                error: 'AnalyticsService ürün performans motoru bulunamadı'
            };
        }

        try {
            var summaries = await window.AnalyticsService.getProductPerformanceSummary(
                normalizeDate(options.startDate),
                normalizeDate(options.endDate)
            );

            return {
                data: Array.isArray(summaries) ? summaries : [],
                error: null
            };
        } catch (error) {
            return {
                data: [],
                error: error && error.message ? error.message : error
            };
        }
    }

    async function getTopSelling(limit, options) {
        limit = Number(limit) || 5;
        options = options || {};

        var tenantId = getTenantId();

        if (!tenantId) {
            return {
                data: [],
                error: 'Tenant bulunamadı'
            };
        }

        var perfResult = await getPerformanceSummary(options);

        if (perfResult.error) {
            return {
                data: [],
                error: perfResult.error
            };
        }

        var summaries = Array.isArray(perfResult.data) ? perfResult.data : [];

        var result = summaries.map(function (item) {
            return {
                product_id: item.product_id,
                name: item.name || '(Bilinmeyen Ürün)',
                price: toNumber(item.price),
                cost: toNumber(item.cost),
                category_id: item.category_id || null,
                is_active: typeof item.is_active !== 'undefined' ? item.is_active : true,
                quantity: toNumber(item.quantity),
                total: toNumber(item.revenue),
                revenue: toNumber(item.revenue),
                estimated_profit: toNumber(item.estimated_profit),
                row_count: toNumber(item.row_count),
                last_sale_date: item.last_sale_date || ''
            };
        });

        result.sort(function (a, b) {
            if (b.quantity !== a.quantity) {
                return b.quantity - a.quantity;
            }
            return b.revenue - a.revenue;
        });

        return {
            data: result.slice(0, Math.max(1, limit)),
            error: null
        };
    }

    async function create(product) {
        var tenantId = getTenantId();

        if (!tenantId) {
            return {
                data: null,
                error: 'Tenant bulunamadı'
            };
        }

        return await window.SupabaseService.insert('products', product);
    }

    async function update(id, updates) {
        return await window.SupabaseService.update('products', id, updates);
    }

    async function remove(id) {
        // Soft delete: is_deleted = true, is_active = false
        // Tarihsel satış verileri (product_sales) korunur
        return await window.SupabaseService.update('products', id, {
            is_deleted: true,
            is_active: false
        });
    }

    return {
        getAll: getAll,
        getPerformanceSummary: getPerformanceSummary,
        getTopSelling: getTopSelling,
        create: create,
        update: update,
        remove: remove
    };
})();