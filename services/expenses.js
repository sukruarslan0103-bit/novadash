/* ============================================================
   EXPENSES SERVICE — CRUD Operations
   Gider listeleme + kategori join + tarih filtreleme + pagination
   ============================================================ */

window.ExpensesService = (function () {
    'use strict';

    function tenantId() {
        if (!window.STATE || !window.STATE.tenant || !window.STATE.tenant.id) {
            throw new Error('Tenant bulunamadı');
        }
        return window.STATE.tenant.id;
    }

    function normalizeDate(value) {
        if (!value) return null;
        return value;
    }

    async function getAll(options = {}) {
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

        return res;
    }

    async function getByDateRange(startDate, endDate, options = {}) {
        const {
            page = 1,
            pageSize = 20,
            ascending = false
        } = options;

        const filters = [];
        const safeStart = normalizeDate(startDate);
        const safeEnd = normalizeDate(endDate);

        if (safeStart) {
            filters.push({ op: 'gte', column: 'date', value: safeStart });
        }

        if (safeEnd) {
            filters.push({ op: 'lte', column: 'date', value: safeEnd });
        }

        const res = await window.SupabaseService.query('expenses', {
            select: `
                id,
                tenant_id,
                date,
                amount,
                description,
                category_id,
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

        return res;
    }

    async function getRecent(limit = 20) {
        const res = await window.SupabaseService.query('expenses', {
            select: `
                id,
                tenant_id,
                date,
                amount,
                description,
                category_id,
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

        return res;
    }

    async function create(expense) {
        const payload = {
            tenant_id: tenantId(),
            date: expense.date,
            amount: Number(expense.amount || 0),
            description: expense.description || '',
            category_id: expense.category_id || null
        };

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

        const res = await window.SupabaseService.update('expenses', id, payload);

        if (res.error) {
            throw new Error(res.error.message || 'Gider kaydı güncellenemedi');
        }

        return res;
    }

    async function remove(id) {
        const res = await window.SupabaseService.softDelete('expenses', id);

        if (res.error) {
            throw new Error(res.error.message || 'Gider kaydı silinemedi');
        }

        return res;
    }

    return {
        getAll,
        getByDateRange,
        getRecent,
        create,
        update,
        remove
    };
})();