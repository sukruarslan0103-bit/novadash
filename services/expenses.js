/* ============================================================
   EXPENSES SERVICE — CRUD Operations
   Client-side tenant kullanimi YOK.
   tenant_id backend'de (SupabaseService + RPC + RLS) resolve edilir.
   ============================================================ */

window.ExpensesService = (function () {
    'use strict';

    function normalizeDate(value) {
        if (!value) return null;
        return value;
    }

    function clearCache() {
        _cache.key = null;
        _cache.data = null;
        _cache.ts = 0;
    }

    var _cache = {
        key: null,
        data: null,
        ts: 0
    };

    var CACHE_TTL = 10000;

    function buildKey(type, params) {
        return type + '|' + JSON.stringify(params || {});
    }

    async function getAll(options = {}) {
        const key = buildKey('all', options);
        const now = Date.now();

        if (_cache.key === key && (now - _cache.ts) < CACHE_TTL) {
            return _cache.data;
        }

        const {
            page = 1,
            pageSize = 20,
            ascending = false
        } = options;

        const res = await window.SupabaseService.query('expenses', {
            select: `
                id,
                tenant_id,
                date,
                amount,
                description,
                category_id,
                category_name,
                created_at,
                updated_at,
                categories (
                    id,
                    name,
                    color,
                    type
                )
            `,
            order: { column: 'date', asc: ascending },
            page: page,
            pageSize: pageSize,
            count: true
        });

        if (res.error) {
            throw new Error(res.error.message || res.error || 'Gider listesi alınamadı');
        }

        _cache.key = key;
        _cache.data = res;
        _cache.ts = now;

        return res;
    }

    async function getByDateRange(startDate, endDate, options = {}) {
        const key = buildKey('range', { startDate, endDate, options });
        const now = Date.now();

        if (_cache.key === key && (now - _cache.ts) < CACHE_TTL) {
            return _cache.data;
        }

        const {
            page = 1,
            pageSize = 20,
            ascending = false
        } = options;

        const filters = [];
        const safeStart = normalizeDate(startDate);
        const safeEnd = normalizeDate(endDate);

        if (safeStart) filters.push({ op: 'gte', column: 'date', value: safeStart });
        if (safeEnd) filters.push({ op: 'lte', column: 'date', value: safeEnd });

        const res = await window.SupabaseService.query('expenses', {
            select: `
                id,
                tenant_id,
                date,
                amount,
                description,
                category_id,
                category_name,
                created_at,
                updated_at,
                categories (
                    id,
                    name,
                    color,
                    type
                )
            `,
            filters: filters,
            order: { column: 'date', asc: ascending },
            page: page,
            pageSize: pageSize,
            count: true
        });

        if (res.error) {
            throw new Error(res.error.message || res.error || 'Tarih aralığındaki giderler alınamadı');
        }

        _cache.key = key;
        _cache.data = res;
        _cache.ts = now;

        return res;
    }

    async function getRecent(limit = 20) {
        const key = buildKey('recent', { limit });
        const now = Date.now();

        if (_cache.key === key && (now - _cache.ts) < CACHE_TTL) {
            return _cache.data;
        }

        const res = await window.SupabaseService.query('expenses', {
            select: `
                id,
                tenant_id,
                date,
                amount,
                description,
                category_id,
                category_name,
                created_at,
                updated_at,
                categories (
                    id,
                    name,
                    color,
                    type
                )
            `,
            order: { column: 'date', asc: false },
            limit: Number(limit || 20),
            count: true
        });

        if (res.error) {
            throw new Error(res.error.message || res.error || 'Son gider kayıtları alınamadı');
        }

        _cache.key = key;
        _cache.data = res;
        _cache.ts = now;

        return res;
    }

    async function create(expense) {
        const payload = {
            date: expense.date,
            amount: Number(expense.amount || 0),
            description: expense.description || '',
            category_id: expense.category_id || null,
            category_name: expense.category_name || null
        };

        clearCache();

        const res = await window.SupabaseService.insert('expenses', payload);

        if (res.error) {
            throw new Error(res.error.message || 'Gider kaydı oluşturulamadı');
        }

        return res;
    }

    async function update(id, updates) {
        const payload = {};

        if (updates.date !== undefined) payload.date = updates.date;
        if (updates.amount !== undefined) payload.amount = Number(updates.amount || 0);
        if (updates.description !== undefined) payload.description = updates.description || '';
        if (updates.category_id !== undefined) payload.category_id = updates.category_id || null;
        if (updates.category_name !== undefined) payload.category_name = updates.category_name || null;

        clearCache();

        const res = await window.SupabaseService.update('expenses', id, payload);

        if (res.error) {
            throw new Error(res.error.message || 'Gider kaydı güncellenemedi');
        }

        return res;
    }

    async function remove(id) {
        clearCache();

        const res = await window.SupabaseService.softDelete('expenses', id);

        if (res.error) {
            throw new Error(res.error.message || 'Gider kaydı silinemedi');
        }

        return res;
    }

    async function getMonthlySummary(page, pageSize) {
        const client = window.SupabaseService.getClient();
        if (!client) throw new Error('Supabase client yok');

        const { data, error } = await client.rpc('get_monthly_expense_summary', {
            p_page: page || 1,
            p_page_size: pageSize || 10
        });

        if (error) throw new Error(error.message || 'Aylık gider özeti alınamadı');

        return {
            data: data?.data || [],
            count: data?.count || 0
        };
    }

    return {
        getAll,
        getByDateRange,
        getRecent,
        create,
        update,
        remove,
        getMonthlySummary
    };
})();
