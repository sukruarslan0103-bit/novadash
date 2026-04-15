/* ============================================================
   SUPABASE SERVICE
   Production-ready connection layer
   Uses config.js for credentials
   Features:
   - Tenant ID caching (no repeat HTTP per CRUD)
   - softDelete support
   - real pagination / range support
   - onAuthStateChange cache invalidation
   ============================================================ */

window.SupabaseService = (function () {
    'use strict';

    let client = null;

    /* ============================================================
       TENANT CACHE
       Bootstrap sırasında bir kere çözümlenir.
       Tüm sorgular cache'ten okur.
       Auth state değiştiğinde invalidate olur.
    ============================================================ */
    let cachedTenantId = null;
    let cacheReady = false;

    const QUERY_TIMEOUT_MS = 15000;
    let _lastQueryId = {};

    /* ============================================================
       INIT
    ============================================================ */
    function init() {
        if (!window.APP_CONFIG) {
            console.error('APP_CONFIG not found. config.js missing.');
            return;
        }

        const url = window.APP_CONFIG.SUPABASE_URL;
        const key = window.APP_CONFIG.SUPABASE_ANON_KEY;

        if (!url || !key) {
            console.error('Supabase config missing');
            return;
        }

        client = supabase.createClient(url, key);

        // Auth state değiştiğinde tenant cache'i invalidate et
        client.auth.onAuthStateChange(function (event) {
            if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
                invalidateTenantCache();
            }

            if (event === 'SIGNED_OUT') {
                window.STATE.authenticated = false;
                window.STATE.tenant.id = null;
                window.STATE.tenant.name = '';
                window.STATE.user.id = null;
                window.STATE.user.email = null;
                window.STATE.user.name = '';

                // Login'e yönlendir
                if (window.location.hash !== '#login') {
                    window.location.hash = '#login';
                }
            }
        });

        console.log('✅ Supabase initialized');
    }

    function getClient() {
        return client;
    }

    function isConnected() {
        return client !== null;
    }

    /* ============================================================
       AUTH
    ============================================================ */

    async function getCurrentUser() {
        if (!client) return null;

        const { data, error } = await client.auth.getUser();
        if (error) return null;

        return data?.user || null;
    }

    /* ============================================================
       TENANT CACHE OPERATIONS
    ============================================================ */

    /**
     * Bootstrap sırasında çağrılır.
     * Tenant ID'yi cache'e yazar.
     */
    function setTenantCache(tenantId) {
        cachedTenantId = tenantId || null;
        cacheReady = true;
    }

    /**
     * Cache'i temizler. Sonraki getTenantId() yeniden çözümler.
     */
    function invalidateTenantCache() {
        cachedTenantId = null;
        cacheReady = false;
    }

    /* ============================================================
       TENANT
    ============================================================ */

    async function getTenantId() {
        if (!client) return null;

        // Cache hazırsa doğrudan dön
        if (cacheReady && cachedTenantId) {
            return cachedTenantId;
        }

        // Cache hazır ama tenant yok
        if (cacheReady && !cachedTenantId) {
            return null;
        }

        // Cache henüz yazılmamış — bootstrap henüz çalışmamış
        // STATE'ten oku (bootstrap yazıyorsa orada olmalı)
        var stateId = window.STATE?.tenant?.id || null;
        if (stateId) {
            setTenantCache(stateId);
            return stateId;
        }

        // Hiçbir kaynak yok
        return null;
    }

    /* ============================================================
       QUERY HELPERS
    ============================================================ */

    function normalizePage(page) {
        const value = Number(page);
        if (!Number.isFinite(value) || value < 1) return 1;
        return Math.floor(value);
    }

    function normalizePageSize(pageSize) {
        const value = Number(pageSize);
        if (!Number.isFinite(value) || value < 1) return null;
        return Math.floor(value);
    }

    function buildRangeMeta(count, from, to, page, pageSize) {
        const safeCount = Number.isFinite(count) ? count : 0;
        const safeFrom = Number.isFinite(from) ? from : 0;
        const safeTo = Number.isFinite(to) ? to : -1;
        const safePage = normalizePage(page || 1);
        const safePageSize = normalizePageSize(pageSize) || 0;

        return {
            count: safeCount,
            page: safePage,
            pageSize: safePageSize,
            totalPages: safePageSize > 0 ? Math.ceil(safeCount / safePageSize) : 1,
            from: safeCount > 0 ? safeFrom + 1 : 0,
            to: safeCount > 0 ? safeTo + 1 : 0
        };
    }

    /* ============================================================
       GENERIC QUERY
       options:
       - select
       - filters: [{ op, column, value }]
       - order: { column, asc }
       - limit
       - page
       - pageSize
       - range: { from, to }
       - count: true/false
    ============================================================ */

    async function query(table, options = {}) {
        if (!client) {
            return {
                data: [],
                error: 'Supabase not initialized',
                count: 0,
                page: 1,
                pageSize: 0,
                totalPages: 0,
                from: 0,
                to: 0
            };
        }

        const tenantId = await getTenantId();

        if (!tenantId) {
            return {
                data: [],
                error: 'Tenant not found',
                count: 0,
                page: 1,
                pageSize: 0,
                totalPages: 0,
                from: 0,
                to: 0
            };
        }

        const queryId = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const queryKey = table + ':' + (options.select || '*');
        _lastQueryId[queryKey] = queryId;

        try {
            const wantsCount =
                options.count === true ||
                options.pageSize ||
                options.page ||
                options.range;

            let q = client
                .from(table)
                .select(options.select || '*', wantsCount ? { count: 'exact' } : undefined)
                .eq('tenant_id', tenantId);

            if (Array.isArray(options.filters)) {
                options.filters.forEach((f) => {
                    if (!f || !f.op || !f.column) return;
                    if (typeof q[f.op] === 'function') {
                        q = q[f.op](f.column, f.value);
                    }
                });
            }

            if (options.order && options.order.column) {
                q = q.order(options.order.column, {
                    ascending: options.order.asc ?? false
                });
            }

            let from = null;
            let to = null;
            let page = 1;
            let pageSize = 0;

            if (options.range && Number.isFinite(options.range.from) && Number.isFinite(options.range.to)) {
                from = Math.max(0, Math.floor(options.range.from));
                to = Math.max(from, Math.floor(options.range.to));
                pageSize = (to - from) + 1;
                page = pageSize > 0 ? Math.floor(from / pageSize) + 1 : 1;
                q = q.range(from, to);
            } else if (options.pageSize) {
                page = normalizePage(options.page || 1);
                pageSize = normalizePageSize(options.pageSize) || 10;
                from = (page - 1) * pageSize;
                to = from + pageSize - 1;
                q = q.range(from, to);
            } else if (options.limit) {
                q = q.limit(options.limit);
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(function () { controller.abort(); }, QUERY_TIMEOUT_MS);

            let result;
            try {
                result = await Promise.race([
                    q,
                    new Promise(function (_, reject) {
                        controller.signal.addEventListener('abort', function () {
                            reject(new DOMException('Request timeout', 'AbortError'));
                        });
                    })
                ]);
            } finally {
                clearTimeout(timeoutId);
            }

            if (_lastQueryId[queryKey] !== queryId) {
                return {
                    data: [],
                    error: null,
                    count: 0,
                    page: 1,
                    pageSize: 0,
                    totalPages: 0,
                    from: 0,
                    to: 0,
                    _stale: true
                };
            }

            const data = Array.isArray(result.data) ? result.data : [];
            const error = result.error || null;
            const count = Number.isFinite(result.count) ? result.count : data.length;

            if (error) {
                return {
                    data: [],
                    error,
                    count: 0,
                    page: 1,
                    pageSize: pageSize || data.length || 0,
                    totalPages: 0,
                    from: 0,
                    to: 0
                };
            }

            if (from !== null && to !== null) {
                const meta = buildRangeMeta(count, from, from + data.length - 1, page, pageSize);
                return {
                    data,
                    error: null,
                    count: meta.count,
                    page: meta.page,
                    pageSize: meta.pageSize,
                    totalPages: meta.totalPages,
                    from: meta.from,
                    to: meta.to
                };
            }

            return {
                data,
                error: null,
                count,
                page: 1,
                pageSize: data.length,
                totalPages: 1,
                from: data.length ? 1 : 0,
                to: data.length
            };
        } catch (err) {
            if (err && err.name === 'AbortError') {
                return {
                    data: [],
                    error: 'Request timeout',
                    count: 0,
                    page: 1,
                    pageSize: 0,
                    totalPages: 0,
                    from: 0,
                    to: 0
                };
            }

            return {
                data: [],
                error: err?.message || err || 'Unknown query error',
                count: 0,
                page: 1,
                pageSize: 0,
                totalPages: 0,
                from: 0,
                to: 0
            };
        }
    }

    /* ============================================================
       INSERT
    ============================================================ */

    async function insert(table, record) {
        if (!client) return { data: null, error: 'Supabase not initialized' };

        const tenantId = await getTenantId();
        if (!tenantId) return { data: null, error: 'Tenant not found' };

        const payload = {
            ...record,
            tenant_id: tenantId
        };

        return await client
            .from(table)
            .insert(payload)
            .select()
            .single();
    }

    /* ============================================================
       UPDATE
    ============================================================ */

    async function update(table, id, updates) {
        if (!client) return { data: null, error: 'Supabase not initialized' };

        const tenantId = await getTenantId();
        if (!tenantId) return { data: null, error: 'Tenant not found' };

        return await client
            .from(table)
            .update(updates)
            .eq('id', id)
            .eq('tenant_id', tenantId)
            .select()
            .single();
    }

    /* ============================================================
       DELETE
    ============================================================ */

    async function remove(table, id) {
        if (!client) return { error: 'Supabase not initialized' };

        const tenantId = await getTenantId();
        if (!tenantId) return { error: 'Tenant not found' };

        return await client
            .from(table)
            .delete()
            .eq('id', id)
            .eq('tenant_id', tenantId);
    }

    async function softDelete(table, id) {
        if (!client) return { data: null, error: 'Supabase not initialized' };

        try {
            const { data, error } = await client.rpc('soft_delete_record', {
                p_table: table,
                p_id: id
            });

            if (error) {
                return {
                    data: null,
                    error: error.message || error
                };
            }

            return {
                data: data,
                error: null
            };
        } catch (err) {
            return {
                data: null,
                error: err?.message || 'Soft delete failed'
            };
        }
    }

    /* ============================================================
       AUTH HELPERS (Login / Logout)
    ============================================================ */

    async function signInWithEmail(email, password) {
        if (!client) return { data: null, error: 'Supabase not initialized' };

        var result = await client.auth.signInWithPassword({
            email: email,
            password: password
        });

        return result;
    }

    async function signOut() {
        if (!client) return;

        invalidateTenantCache();
        await client.auth.signOut();
    }

    /* ============================================================
       SYSTEM LOG — kritik hatalari DB'ye yaz
       Asla ana islemi bloklama, fire-and-forget
    ============================================================ */
    function logEvent(action, status, message, metadata) {
        if (!client) return;
        try {
            client.rpc('log_client_event', {
                p_action: action || 'unknown',
                p_status: status || 'info',
                p_message: message || null,
                p_metadata: metadata || {}
            }).then(function () {}).catch(function () {});
        } catch (e) { /* never block */ }
    }

    return {
        init,
        getClient,
        isConnected,
        getCurrentUser,
        getTenantId,
        setTenantCache,
        invalidateTenantCache,
        query,
        insert,
        update,
        remove,
        softDelete,
        signInWithEmail,
        signOut,
        logEvent
    };

})();
