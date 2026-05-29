/* ============================================================
   RPC LATENCY OBSERVER (Faz 0 Adim 2)
   In-memory ring buffer + slow query auto-log to DB.

   Mevcut hicbir RPC cagrisi degismez; SupabaseService.init()
   icindeki monkey-patch wrapper otomatik olcum yapar.

   Kullanim (console):
     window.RpcObserver.summary()    // p50 / p95 / p99 tablosu
     window.RpcObserver.clear()      // ring buffer temizle
     window.__rpcStats               // raw entries (debug)

   Production-safe:
     - logEvent fire-and-forget; ana flow'u bloklamaz
     - try/catch RPC error path da korunur
     - SLOW_THRESHOLD_MS'in altinda DB log yok (system_logs sismez)
     - Ring buffer MAX_LEN ile memory cap
   ============================================================ */
(function () {
    'use strict';

    var MAX_LEN = 500;
    var SLOW_THRESHOLD_MS = 500;

    window.__rpcStats = [];

    function nowMs() {
        return (window.performance && performance.now) ? performance.now() : Date.now();
    }

    function pushEntry(entry) {
        window.__rpcStats.push(entry);
        if (window.__rpcStats.length > MAX_LEN) {
            window.__rpcStats.shift();
        }
    }

    function currentTenantId() {
        return (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || null;
    }

    window.RpcObserver = {

        /**
         * RPC tamamlanmasi sonrasi entry yaz.
         * supabase.js monkey-patch wrapper bunu cagiriyor.
         */
        record: function (name, duration_ms, success, error_message) {
            pushEntry({
                t: Date.now(),
                kind: 'rpc',
                name: name,
                duration_ms: duration_ms,
                success: !!success,
                error: error_message || null,
                tenant_id: currentTenantId()
            });

            // Slow RPC (>500ms) -> DB log (system_logs uzerine)
            // metadata'ya rpc_name eklendi (system_logs.message kolonuna
            // bagimli olmayalim diye — view kolon-bagimsiz okuyor).
            if (duration_ms > SLOW_THRESHOLD_MS &&
                window.SupabaseService &&
                typeof window.SupabaseService.logEvent === 'function') {
                try {
                    window.SupabaseService.logEvent(
                        'rpc_slow',
                        success ? 'warn' : 'error',
                        name + ' took ' + duration_ms + 'ms',
                        {
                            rpc_name: name,
                            duration_ms: duration_ms,
                            error: error_message || null
                        }
                    );
                } catch (e) { /* never block */ }
            }
        },

        /**
         * View render timing'i — Router veya view kendi cagirir.
         * Kullanim:
         *   var m = window.RpcObserver.markRender('dashboard');
         *   ... render ...
         *   m.end(true);
         */
        markRender: function (viewName) {
            var t0 = nowMs();
            return {
                end: function (success) {
                    var dt = Math.round(nowMs() - t0);
                    pushEntry({
                        t: Date.now(),
                        kind: 'render',
                        name: 'view:' + viewName,
                        duration_ms: dt,
                        success: success !== false,
                        error: null,
                        tenant_id: currentTenantId()
                    });
                    return dt;
                }
            };
        },

        /**
         * p50 / p95 / p99 / max ozeti. RPC ve render entry'lerini
         * ayri sutunlarda gosterir (kind ile gruplanir).
         * Sirali: en yavasalar ustte (p95 desc).
         */
        summary: function () {
            var bucket = {};
            window.__rpcStats.forEach(function (e) {
                var key = (e.kind || 'rpc') + '|' + e.name;
                if (!bucket[key]) {
                    bucket[key] = { kind: e.kind || 'rpc', name: e.name, ok: [], fail: 0 };
                }
                if (e.success) bucket[key].ok.push(e.duration_ms);
                else bucket[key].fail++;
            });

            var rows = [];
            Object.keys(bucket).forEach(function (key) {
                var b = bucket[key];
                var arr = b.ok.slice().sort(function (a, b) { return a - b; });
                var n = arr.length;
                if (n === 0) {
                    rows.push({ kind: b.kind, name: b.name, count: 0, fail: b.fail });
                    return;
                }
                rows.push({
                    kind: b.kind,
                    name: b.name,
                    count: n,
                    fail: b.fail,
                    p50: arr[Math.floor(n * 0.5)],
                    p95: arr[Math.max(0, Math.floor(n * 0.95) - 1)],
                    p99: arr[Math.max(0, Math.floor(n * 0.99) - 1)],
                    max: arr[n - 1]
                });
            });

            rows.sort(function (a, b) { return (b.p95 || 0) - (a.p95 || 0); });
            console.table(rows);
            return rows;
        },

        /**
         * Ring buffer'i komple temizle (yeni profiling oturumu icin).
         */
        clear: function () {
            window.__rpcStats = [];
        },

        /**
         * Mevcut config (debug icin).
         */
        config: function () {
            return {
                max_buffer: MAX_LEN,
                slow_threshold_ms: SLOW_THRESHOLD_MS,
                current_size: window.__rpcStats.length
            };
        }
    };
})();


/* ============================================================
   NOVA_DEBUG — Observability Foundation (Faz O1-A)
   Developer-only runtime visibility. Disabled by default.
   Activation:
     - URL ?debug=1
     - localStorage.NOVA_DEBUG = '1'
     - Ctrl+Shift+D hotkey (runtime toggle)
   Production-safe: disabled mode overhead ~0 (boolean check + early return).
   Panel UI: FAZ O1-B'de (ayri commit).
   ============================================================ */
(function () {
    'use strict';

    if (window.NOVA_DEBUG) return;   // idempotent (script multi-load koruma)

    window.NOVA_DEBUG = {
        version: 'O1-A',
        enabled: false,

        // ─── CORE ─────────────────────────────────────────────
        enable: function () {
            this.enabled = true;
            try { localStorage.setItem('NOVA_DEBUG', '1'); } catch (e) { /* noop */ }
        },
        disable: function () {
            this.enabled = false;
            try { localStorage.removeItem('NOVA_DEBUG'); } catch (e) { /* noop */ }
        },
        toggle: function () {
            if (this.enabled) this.disable(); else this.enable();
            return this.enabled;
        },

        // ─── RPC (backward-compat bridge) ─────────────────────
        // window.RpcObserver yukarida mevcut; alias.
        rpc: window.RpcObserver || null,

        // ─── CACHE ────────────────────────────────────────────
        cache: {
            hits: 0,
            misses: 0,
            staleHits: 0,
            sets: 0,
            invalidates: 0,
            reset: function () {
                this.hits = 0;
                this.misses = 0;
                this.staleHits = 0;
                this.sets = 0;
                this.invalidates = 0;
            },
            snapshot: function () {
                var total = this.hits + this.misses + this.staleHits;
                return {
                    hits:        this.hits,
                    misses:      this.misses,
                    staleHits:   this.staleHits,
                    sets:        this.sets,
                    invalidates: this.invalidates,
                    ratio:       total > 0 ? Math.round((this.hits + this.staleHits) / total * 100) / 100 : 0,
                    activeKeys:  (window.ViewCache && window.ViewCache._store)
                                    ? Object.keys(window.ViewCache._store).length : 0
                };
            }
        },

        // ─── VIEW ─────────────────────────────────────────────
        view: {
            renders: {},
            active:  null,
            track: function (name) {
                // KRITIK: disabled mode'da bu fn cagrilir ama erken donus.
                if (!window.NOVA_DEBUG.enabled) return;
                if (!name) return;
                this.renders[name] = (this.renders[name] || 0) + 1;
                this.active = name;
            },
            reset: function () {
                this.renders = {};
                this.active = null;
            },
            snapshot: function () {
                var total = 0;
                var keys = Object.keys(this.renders);
                for (var i = 0; i < keys.length; i++) total += this.renders[keys[i]];
                return {
                    renders: Object.assign({}, this.renders),
                    active:  this.active,
                    total:   total
                };
            }
        }
    };

    // ─── AUTO-ENABLE FROM SOURCES ────────────────────────────
    try {
        // 1) URL ?debug=1
        if (typeof window.location !== 'undefined') {
            var qs = window.location.search || '';
            if (qs.indexOf('debug=1') !== -1) {
                window.NOVA_DEBUG.enabled = true;
            }
        }
        // 2) localStorage flag
        if (!window.NOVA_DEBUG.enabled) {
            try {
                if (localStorage.getItem('NOVA_DEBUG') === '1') {
                    window.NOVA_DEBUG.enabled = true;
                }
            } catch (e) { /* private mode etc */ }
        }
    } catch (e) { /* never throw at load */ }

    // ─── HOTKEY: Ctrl+Shift+D ────────────────────────────────
    // Production-safe: kullanici hotkey bilmedikce panel acilmaz.
    // FAZ O1-A: sadece toggle enable; panel UI FAZ O1-B'de eklenecek.
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('keydown', function (e) {
            if (e.ctrlKey && e.shiftKey && (e.code === 'KeyD' || e.keyCode === 68)) {
                e.preventDefault();
                window.NOVA_DEBUG.toggle();
                // Console feedback (panel olmadan kullanici durumunu gorsun)
                if (window.console && console.log) {
                    console.log('[NOVA_DEBUG] ' + (window.NOVA_DEBUG.enabled ? 'ENABLED' : 'DISABLED'));
                }
            }
        }, false);
    }
})();
