/* ============================================================
   PRODUCTS SERVICE — CRUD Operations + Performance Analytics
   Client-side tenant kullanimi YOK.
   tenant_id backend'de (SupabaseService + RPC + RLS) resolve edilir.
   ============================================================ */

window.ProductsService = (function () {
    'use strict';

    function toNumber(value) {
        var n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function normalizeDate(value) {
        if (!value) return '';
        return String(value).slice(0, 10);
    }

    function clearPerformanceCache() {
        _perfCache.key = null;
        _perfCache.data = null;
        _perfCache.ts = 0;
    }

    var _perfCache = {
        key: null,
        data: null,
        ts: 0
    };

    var CACHE_TTL = 10000;

    async function getAll(options) {
        options = options || {};

        var defaults = {
            filters: [
                { op: 'eq', column: 'is_deleted', value: false }
            ],
            order: { column: 'name', asc: true },
            select: options.select || 'id,name,price,cost,category_id,category_name,is_active'
        };

        if (options.filters && Array.isArray(options.filters)) {
            defaults.filters = defaults.filters.concat(options.filters);
            delete options.filters;
        }

        return await window.SupabaseService.query('products', Object.assign(defaults, options));
    }

    async function getPerformanceSummary(options) {
        options = options || {};

        var cacheKey = [
            normalizeDate(options.startDate),
            normalizeDate(options.endDate)
        ].join('|');

        var now = Date.now();

        if (_perfCache.key === cacheKey && (now - _perfCache.ts) < CACHE_TTL) {
            return {
                data: _perfCache.data,
                error: null
            };
        }

        var client = window.SupabaseService && typeof window.SupabaseService.getClient === 'function'
            ? window.SupabaseService.getClient()
            : null;

        if (!client) {
            return {
                data: [],
                error: 'Supabase client bulunamadı'
            };
        }

        try {
            var res = await client.rpc('get_product_performance_summary', {
                p_start: normalizeDate(options.startDate) || null,
                p_end: normalizeDate(options.endDate) || null
            });

            if (res.error) {
                return {
                    data: [],
                    error: res.error.message || res.error
                };
            }

            var data = Array.isArray(res.data) ? res.data : [];

            _perfCache.key = cacheKey;
            _perfCache.data = data;
            _perfCache.ts = now;

            return {
                data: data,
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
        clearPerformanceCache();
        return await window.SupabaseService.insert('products', product);
    }

    async function update(id, updates) {
        clearPerformanceCache();
        return await window.SupabaseService.update('products', id, updates);
    }

    async function remove(id) {
        clearPerformanceCache();
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
