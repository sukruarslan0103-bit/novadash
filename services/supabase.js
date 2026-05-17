/* ============================================================
   SUPABASE SERVICE
   Production-ready connection layer
   Uses config.js for credentials
   Features:
   - softDelete support
   - real pagination / range support
   - onAuthStateChange cache invalidation

   NOTE: Client is tenant-agnostic.
   tenant_id filtreleme ve enjeksiyonu TAMAMEN backend'dedir
   (RLS + RPC + auth.uid()). Bu dosya hiçbir yerde tenant_id
   göndermez veya filtrelemez.
   ============================================================ */

/* ============================================================
   FETCH INTERCEPTOR — sadece purchase_items için raw body log
   Kapatmak için: window.__PURCHASE_FETCH_TRACE = false
   ============================================================ */
(function () {
    if (window.__purchaseFetchTraceInstalled) return;
    window.__purchaseFetchTraceInstalled = true;
    // Default OFF — açmak için console: window.__PURCHASE_FETCH_TRACE = true
    if (typeof window.__PURCHASE_FETCH_TRACE === 'undefined') {
        window.__PURCHASE_FETCH_TRACE = false;
    }
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        try {
            if (window.__PURCHASE_FETCH_TRACE) {
                var url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.indexOf('/rest/v1/purchase_items') !== -1) {
                    var method = (init && init.method) || (input && input.method) || 'GET';
                    var body = init && init.body ? init.body : null;
                    if(window.__DEBUG__)console.log('[FETCH→supabase] ' + method + ' ' + url);
                    if (body) {
                        if(window.__DEBUG__)console.log('[FETCH→supabase] RAW BODY:', body);
                        try { if(window.__DEBUG__)console.log('[FETCH→supabase] PARSED:', JSON.parse(body)); } catch (e) {}
                    }
                }
            }
        } catch (e) {}
        return origFetch(input, init);
    };
})();

window.SupabaseService = (function () {
    'use strict';

    let client = null;

    /* ============================================================
       TENANT CACHE (compat shim)
       Eski cagirilari kirmamak icin korunuyor.
       Ancak query / insert / update / delete hic kullanmiyor.
    ============================================================ */
    let cachedTenantId = null;
    let cacheReady = false;

    const QUERY_TIMEOUT_MS = 15000;
    let _lastQueryId = {};

    /* ============================================================
       INIT
    ============================================================ */
    function init() {
        const url = "https://czbovdurwdjpdxgpobqn.supabase.co";
        const key = "sb_publishable_4SYCpNuY_ftBkWS4Sn-5Qg_cQW2sR9p";

        client = supabase.createClient(url, key);

        // Global expose — window.supabase ile direkt erisim (debug/legacy uyumluluk)
        try { window.supabase = client; } catch (e) { /* noop */ }

        // Auth state değiştiğinde tenant cache'i invalidate et
        client.auth.onAuthStateChange(function (event, session) {
            if (window.ViewCache && typeof window.ViewCache.clear === 'function') {
                window.ViewCache.clear();
            }

            if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') {
                invalidateTenantCache();
            }

            // GLOBAL LISTENER — SIGNED_IN
            // KRITIK: authenticated bayragini BURADAN set etme.
            // Tek source-of-truth AppBootstrap.bootstrap() — tenant satiri
            // cekilmeden authenticated=true olmamali. bootstrap idempotent;
            // initApp / handleLogin / SIGNED_IN ayni anda tetiklense bile
            // tek bir hydrate calisir.
            if (event === 'SIGNED_IN' && session) {
                if (window.AppBootstrap && typeof window.AppBootstrap.bootstrap === 'function') {
                    window.AppBootstrap.bootstrap()
                        .then(function (ok) {
                            if (ok && typeof window.safeNavigateToDashboard === 'function') {
                                window.safeNavigateToDashboard();
                            }
                        })
                        .catch(function () { /* bootstrap kendi redirectToLogin'ini yapiyor */ });
                }
            }

            if (event === 'SIGNED_OUT') {
                window.STATE.authenticated = false;
                window.STATE.tenantReady = false;
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

        if(window.__DEBUG__)console.log('✅ Supabase initialized');
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
       TENANT CACHE OPERATIONS (compat only)
       query/insert/update/delete ARTIK KULLANMIYOR.
    ============================================================ */

    function setTenantCache(tenantId) {
        cachedTenantId = tenantId || null;
        cacheReady = true;
    }

    function invalidateTenantCache() {
        cachedTenantId = null;
        cacheReady = false;
    }

    /**
     * KEPT FOR COMPATIBILITY ONLY.
     * Yeni kodda kullanma. Tenant backend'de resolve edilir.
     */
    async function getTenantId() {
        if (!client) return null;

        if (cacheReady && cachedTenantId) {
            return cachedTenantId;
        }

        if (cacheReady && !cachedTenantId) {
            return null;
        }

        try {
            var user = await getCurrentUser();
            if (!user || !user.id) {
                setTenantCache(null);
                return null;
            }

            var res = await client
                .from('users')
                .select('tenant_id')
                .eq('id', user.id)
                .single();

            if (res.error || !res.data || !res.data.tenant_id) {
                setTenantCache(null);
                return null;
            }

            setTenantCache(res.data.tenant_id);
            return res.data.tenant_id;
        } catch (err) {
            console.warn('[supabase] getTenantId resolve failed:', err && err.message ? err.message : err);
            setTenantCache(null);
            return null;
        }
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

       Tenant filtresi YOK — RLS halleder.
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
                .select(options.select || '*', wantsCount ? { count: 'exact' } : undefined);

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
       tenant_id enjekte edilmez — DB trigger / DEFAULT halleder.
    ============================================================ */

    async function insert(table, record) {
        if (!client) return { data: null, error: 'Supabase not initialized' };

        // Payload'ı OLDUĞU GİBİ gönder — hiçbir field filtrelenmesin
        const res = await client
            .from(table)
            .insert(record)
            .select();

        if (res && res.error) {
            return { data: null, error: res.error };
        }
        // Tek satır insert — geriye uyumluluk için ilk eleman
        const data = Array.isArray(res && res.data) ? (res.data[0] || null) : (res && res.data) || null;
        return { data: data, error: null };
    }

    /* ============================================================
       UPDATE
       tenant filtresi YOK — RLS halleder.
    ============================================================ */

    async function update(table, id, updates) {
        if (!client) return { data: null, error: 'Supabase not initialized' };

        return await client
            .from(table)
            .update(updates)
            .eq('id', id)
            .select()
            .single();
    }

    /* ============================================================
       DELETE
       tenant filtresi YOK — RLS halleder.
    ============================================================ */

    async function remove(table, id) {
        if (!client) return { error: 'Supabase not initialized' };

        return await client
            .from(table)
            .delete()
            .eq('id', id);
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
       AUTH RECOVERY HARDENING (frontend-only)

       Amac: token gecersizlestiginde (manuel clear, cross-tab signOut,
       expire+refresh fail, admin revoke) frontend stale state'i guvenle
       toparlamak.

       Strict pattern matching:
         - false-positive logout YASAK
         - validation / RLS / rate-limit / network hatasi tetiklemez
    ============================================================ */

    // Auth-only error pattern detection
    function detectAuthError(error) {
        if (!error) return false;

        var status = String(error.status || error.code || '');
        if (status === '401' || status === 'PGRST301') return true;

        var msg = String(error.message || error.error_description || error.error || '');
        if (!msg) return false;

        if (msg.indexOf('Unauthorized: no authenticated user')          !== -1) return true;
        if (msg.indexOf('Unauthorized: tenant not found or user disabled') !== -1) return true;
        if (msg.indexOf('JWT expired')                                   !== -1) return true;
        if (msg.indexOf('JWT invalid')                                   !== -1) return true;
        if (msg.indexOf('Auth session missing')                          !== -1) return true;
        if (msg.indexOf('invalid_grant')                                 !== -1) return true;

        return false;
    }

    // Re-entrancy guard (5 saniye lock)
    var _forceLogoutInProgress = false;

    function forceLogout(reason) {
        if (_forceLogoutInProgress) return;
        _forceLogoutInProgress = true;

        try {
            if (window.__DEBUG__) console.warn('[auth] forceLogout reason=', reason);

            // Canonical cleanup (state + cache invalidate + #login redirect)
            if (window.AppBootstrap && typeof window.AppBootstrap.redirectToLogin === 'function') {
                window.AppBootstrap.redirectToLogin();
            }

            // Defensive ViewCache clear (redirectToLogin coverage'i pekistir)
            if (window.ViewCache && typeof window.ViewCache.clear === 'function') {
                try { window.ViewCache.clear(); } catch (e) { /* noop */ }
            }

            // Supabase JS in-memory session temizligi (fire-and-forget)
            if (client) {
                try {
                    client.auth.signOut().catch(function () { /* silent */ });
                } catch (e) { /* silent */ }
            }

            // Kullaniciya bilgi
            try {
                if (window.Toast && typeof window.Toast.show === 'function') {
                    window.Toast.show('Oturumunuz sona erdi, lütfen tekrar giriş yapın', 'warning');
                } else if (typeof window.alert === 'function') {
                    // Alert intrusive; sadece Toast yoksa
                    setTimeout(function () {
                        window.alert('Oturumunuz sona erdi, lütfen tekrar giriş yapın');
                    }, 100);
                }
            } catch (e) { /* noop */ }
        } finally {
            // 5 saniye sonra tekrar tetiklenebilir hale gel
            setTimeout(function () {
                _forceLogoutInProgress = false;
            }, 5000);
        }
    }

    // Cross-tab + manual localStorage clear secondary defense.
    // Storage event AYNI tab'da fire ETMEZ — manuel clear icin RPC error
    // detection (sales/expenses/purchases service'lerinde) primary defense.
    function _bindStorageAuthListener() {
        if (typeof window === 'undefined' || !window.addEventListener) return;
        try {
            window.addEventListener('storage', function (e) {
                if (!e || !e.key) return;
                // Supabase auth token key formati: sb-<project-ref>-auth-token
                if (e.key.indexOf('sb-') !== 0 || e.key.indexOf('auth-token') === -1) return;
                // Sadece silme/bosaltma case'i; cross-tab signin (yeni token) tetiklemez
                if (e.newValue !== null && e.newValue !== '') return;
                if (window.STATE && window.STATE.authenticated) {
                    forceLogout('storage_event_token_removed');
                }
            });
        } catch (e) { /* noop */ }
    }
    _bindStorageAuthListener();

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
        logEvent,
        detectAuthError,
        forceLogout
    };

})();
