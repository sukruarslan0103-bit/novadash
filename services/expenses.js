/* ============================================================
   EXPENSES SERVICE — CRUD Operations
   WRITE PATH → RPC-ONLY (update_expense, soft_delete_expense)
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

        // ViewCache'i de temizle — dashboard ve expenses view'i stale veri gostermesin
        if (window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
            try {
                window.ViewCache.invalidate('expenses-view:');
                window.ViewCache.invalidate('dashboard:');
            } catch (e) { /* noop */ }
        }
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
        // 048 + 049: insert_expense RPC canonical write path.
        // - tenant_id DB-side (auth.uid -> users.tenant_id)
        // - idempotency_key NULL gonderilir, server fallback hash uretir
        //   (md5 tenant|date|amount|category_id|category_name|description)
        // - ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        // - duplicate ise hard error YOK; {duplicate:true, message} doner
        const client = window.SupabaseService.getClient();
        if (!client || typeof client.rpc !== 'function') {
            throw new Error('Supabase RPC client yok');
        }

        clearCache();

        const { data, error } = await client.rpc('insert_expense', {
            p_date:            expense.date,
            p_amount:          Number(expense.amount || 0),
            p_category_id:    (expense.category_id   || null),
            p_category_name:  (expense.category_name || null),
            p_description:    (expense.description   || ''),
            p_idempotency_key: null
        });

        if (error) {
            throw new Error(error.message || 'Gider kaydı oluşturulamadı');
        }

        // RPC JSONB shape: { success, id, duplicate, idempotency_key, message? }
        const result = data || {};
        return {
            data: result,
            error: null,
            duplicate: !!result.duplicate,
            message: result.message || null
        };
    }

    async function update(id, updates) {
        if (!id) throw new Error('Gider ID gerekli');

        const client = window.SupabaseService.getClient();
        if (!client) throw new Error('Supabase client yok');

        const p_updates = {};
        if (updates.date !== undefined) p_updates.date = updates.date;
        if (updates.amount !== undefined) p_updates.amount = Number(updates.amount || 0);
        if (updates.description !== undefined) p_updates.description = updates.description || '';
        if (updates.category_id !== undefined) p_updates.category_id = updates.category_id || null;
        if (updates.category_name !== undefined) p_updates.category_name = updates.category_name || null;

        clearCache();

        const { data, error } = await client.rpc('update_expense', {
            p_id: id,
            p_updates: p_updates
        });

        if (error) {
            throw new Error(error.message || 'Gider kaydı güncellenemedi');
        }

        return { data: data?.data || null, error: null };
    }

    async function remove(id) {
        if (!id) throw new Error('Gider ID gerekli');

        const client = window.SupabaseService.getClient();
        if (!client) throw new Error('Supabase client yok');

        clearCache();

        const { data, error } = await client.rpc('soft_delete_expense', {
            p_id: id
        });

        if (error) {
            throw new Error(error.message || 'Gider kaydı silinemedi');
        }

        return { data: data, error: null };
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
