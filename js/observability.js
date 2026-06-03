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
            // FAZ O1-B: panel button mount (enabled iken görünür)
            if (this.panel && typeof this.panel._mountButton === 'function') {
                this.panel._mountButton();
            }
        },
        disable: function () {
            this.enabled = false;
            try { localStorage.removeItem('NOVA_DEBUG'); } catch (e) { /* noop */ }
            // FAZ O1-B: panel + button unmount (timer cleanup dahil)
            if (this.panel && typeof this.panel._unmountAll === 'function') {
                this.panel._unmountAll();
            }
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

            // ─── MOUNT TIMING (Faz P0-A) ──────────────────────
            // Router.navigate() recordTiming() ile besler. Disabled mode'da
            // recordTiming erken doner → overhead ~0. Davranis DEGISMEZ;
            // sadece sure olcumu. "render" = senkron mount maliyeti (DOM
            // build); async veri fetch'i BURADA degil, RpcObserver p95'te.
            _timings:     {},   // name -> { count, sumMs, maxMs, lastMs, lastDestroyMs, lastRenderMs }
            lastMountMs:  0,    // son mount toplam suresi (global)
            _globalCount: 0,
            _globalSum:   0,
            _globalMax:   0,

            track: function (name) {
                // KRITIK: disabled mode'da bu fn cagrilir ama erken donus.
                if (!window.NOVA_DEBUG.enabled) return;
                if (!name) return;
                this.renders[name] = (this.renders[name] || 0) + 1;
                this.active = name;
            },

            // Router navigate timing kaydi. metrics: { destroy, render, total } (ms)
            recordTiming: function (name, metrics) {
                if (!window.NOVA_DEBUG.enabled) return;
                if (!name || !metrics) return;
                var total   = Number(metrics.total)   || 0;
                var destroy = Number(metrics.destroy) || 0;
                var render  = Number(metrics.render)  || 0;

                var t = this._timings[name] || {
                    count: 0, sumMs: 0, maxMs: 0, lastMs: 0,
                    lastDestroyMs: 0, lastRenderMs: 0
                };
                t.count        += 1;
                t.sumMs        += total;
                t.lastMs        = total;
                if (total > t.maxMs) t.maxMs = total;
                t.lastDestroyMs = destroy;
                t.lastRenderMs  = render;
                this._timings[name] = t;

                this.lastMountMs   = total;
                this._globalCount += 1;
                this._globalSum   += total;
                if (total > this._globalMax) this._globalMax = total;
            },

            // Internal: timing ozetini hesapla (console side-effect YOK).
            _computeTimings: function () {
                var perView = {};
                var keys = Object.keys(this._timings);
                for (var i = 0; i < keys.length; i++) {
                    var t = this._timings[keys[i]];
                    perView[keys[i]] = {
                        count:         t.count,
                        lastMs:        Math.round(t.lastMs),
                        avgMs:         t.count ? Math.round(t.sumMs / t.count) : 0,
                        maxMs:         Math.round(t.maxMs),
                        lastDestroyMs: Math.round(t.lastDestroyMs),
                        lastRenderMs:  Math.round(t.lastRenderMs)
                    };
                }
                return {
                    lastMountMs: Math.round(this.lastMountMs),
                    avgMountMs:  this._globalCount ? Math.round(this._globalSum / this._globalCount) : 0,
                    maxMountMs:  Math.round(this._globalMax),
                    perView:     perView
                };
            },

            // Console-friendly: per-view tabloyu basar + ozeti dondurur.
            timings: function () {
                var out = this._computeTimings();
                if (window.console && console.table) {
                    try { console.table(out.perView); } catch (e) { /* noop */ }
                }
                return out;
            },

            reset: function () {
                this.renders = {};
                this.active = null;
                this._timings = {};
                this.lastMountMs = 0;
                this._globalCount = 0;
                this._globalSum = 0;
                this._globalMax = 0;
            },

            snapshot: function () {
                var total = 0;
                var keys = Object.keys(this.renders);
                for (var i = 0; i < keys.length; i++) total += this.renders[keys[i]];
                return {
                    renders: Object.assign({}, this.renders),
                    active:  this.active,
                    total:   total,
                    timings: this._computeTimings()
                };
            }
        },

        // ─── PANEL (FAZ O1-B) ─────────────────────────────────
        // Disabled iken DOM = 0, timer = 0. Sadece enabled + open'da
        // resource tutar.
        panel: null   // Faz O1-B IIFE'de doldurulacak
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
                // Console feedback
                if (window.console && console.log) {
                    console.log('[NOVA_DEBUG] ' + (window.NOVA_DEBUG.enabled ? 'ENABLED' : 'DISABLED'));
                }
            }
        }, false);
    }
})();


/* ============================================================
   NOVA_DEBUG.panel — Minimal Debug Panel UI (Faz O1-B)
   Floating button (sağ alt) + collapsible 3-tab drawer.
   Disabled iken DOM=0, timer=0.
   ============================================================ */
(function () {
    'use strict';

    if (!window.NOVA_DEBUG) return;
    if (window.NOVA_DEBUG.panel && typeof window.NOVA_DEBUG.panel._mountButton === 'function') return; // idempotent

    var panel = {
        // ─── STATE ────────────────────────────────────────────
        _button:      null,       // floating debug button DOM
        _drawer:      null,       // expanded panel DOM
        _refreshTimer: null,      // setInterval handle
        _activeTab:   'cache',    // 'cache' | 'view' | 'rpc'
        isOpen:       false,

        // ─── PUBLIC API ───────────────────────────────────────
        open: function () {
            if (!window.NOVA_DEBUG.enabled) return;
            if (this.isOpen) return;
            this._mountDrawer();
            this.isOpen = true;
            this._startRefresh();
            this._render();
        },
        close: function () {
            if (!this.isOpen) return;
            this._stopRefresh();
            this._unmountDrawer();
            this.isOpen = false;
        },
        toggle: function () {
            if (this.isOpen) this.close(); else this.open();
        },

        // ─── INTERNAL: BUTTON LIFECYCLE ───────────────────────
        _mountButton: function () {
            if (this._button) return;
            var btn = document.createElement('div');
            btn.id = 'nova-debug-button';
            btn.textContent = '⚙ DEBUG';
            btn.style.cssText = [
                'position:fixed', 'bottom:20px', 'right:20px',
                'z-index:2147483646', 'padding:8px 14px',
                'background:#0f172a', 'color:#e2e8f0',
                'border:1px solid #334155', 'border-radius:8px',
                'font:600 11px/1 ui-monospace,Consolas,Menlo,monospace',
                'cursor:pointer', 'user-select:none',
                'letter-spacing:.05em',
                'box-shadow:0 4px 12px rgba(0,0,0,.3)',
                'transition:transform .15s ease'
            ].join(';');
            btn.addEventListener('click', function () { panel.toggle(); });
            btn.addEventListener('mouseenter', function () { btn.style.transform = 'translateY(-2px)'; });
            btn.addEventListener('mouseleave', function () { btn.style.transform = 'translateY(0)'; });
            document.body.appendChild(btn);
            this._button = btn;
        },

        _unmountButton: function () {
            if (this._button && this._button.parentNode) {
                this._button.parentNode.removeChild(this._button);
            }
            this._button = null;
        },

        _unmountAll: function () {
            this.close();
            this._unmountButton();
        },

        // ─── INTERNAL: DRAWER LIFECYCLE ───────────────────────
        _mountDrawer: function () {
            if (this._drawer) return;
            var d = document.createElement('div');
            d.id = 'nova-debug-drawer';
            d.style.cssText = [
                'position:fixed', 'bottom:60px', 'right:20px',
                'z-index:2147483647', 'width:380px', 'max-width:calc(100vw - 40px)',
                'max-height:60vh', 'background:#0f172a', 'color:#e2e8f0',
                'border:1px solid #334155', 'border-radius:10px',
                'font:11px/1.5 ui-monospace,Consolas,Menlo,monospace',
                'box-shadow:0 8px 32px rgba(0,0,0,.5)',
                'overflow:hidden', 'display:flex', 'flex-direction:column'
            ].join(';');
            d.innerHTML =
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #1e293b;background:#020617;">' +
                    '<div style="font-weight:700;letter-spacing:.08em;color:#10b981;">NOVA_DEBUG · O1-B</div>' +
                    '<div id="nova-debug-close" style="cursor:pointer;color:#64748b;font-size:14px;padding:0 4px;">✕</div>' +
                '</div>' +
                '<div style="display:flex;border-bottom:1px solid #1e293b;background:#020617;">' +
                    '<div data-tab="cache" class="nd-tab" style="flex:1;padding:8px;text-align:center;cursor:pointer;border-right:1px solid #1e293b;">CACHE</div>' +
                    '<div data-tab="view" class="nd-tab" style="flex:1;padding:8px;text-align:center;cursor:pointer;border-right:1px solid #1e293b;">VIEW</div>' +
                    '<div data-tab="rpc" class="nd-tab" style="flex:1;padding:8px;text-align:center;cursor:pointer;">RPC</div>' +
                '</div>' +
                '<div id="nova-debug-body" style="flex:1;overflow-y:auto;padding:12px;"></div>' +
                '<div style="padding:6px 12px;font-size:10px;color:#475569;border-top:1px solid #1e293b;background:#020617;">' +
                    'refresh: 1s · disable: Ctrl+Shift+D' +
                '</div>';

            // Tab click handlers
            var tabs = d.querySelectorAll('.nd-tab');
            for (var i = 0; i < tabs.length; i++) {
                (function (tab) {
                    tab.addEventListener('click', function () {
                        panel._activeTab = tab.getAttribute('data-tab');
                        panel._render();
                    });
                })(tabs[i]);
            }

            // Close button
            d.querySelector('#nova-debug-close').addEventListener('click', function () {
                panel.close();
            });

            document.body.appendChild(d);
            this._drawer = d;
        },

        _unmountDrawer: function () {
            if (this._drawer && this._drawer.parentNode) {
                this._drawer.parentNode.removeChild(this._drawer);
            }
            this._drawer = null;
        },

        // ─── INTERNAL: TIMER ──────────────────────────────────
        _startRefresh: function () {
            if (this._refreshTimer) return;
            var self = this;
            this._refreshTimer = setInterval(function () {
                if (!self.isOpen || !window.NOVA_DEBUG.enabled) {
                    self._stopRefresh();
                    return;
                }
                self._render();
            }, 1000);
        },

        _stopRefresh: function () {
            if (this._refreshTimer) {
                clearInterval(this._refreshTimer);
                this._refreshTimer = null;
            }
        },

        // ─── INTERNAL: RENDER ─────────────────────────────────
        _render: function () {
            if (!this._drawer) return;
            var body = this._drawer.querySelector('#nova-debug-body');
            if (!body) return;

            // Tab active style
            var tabs = this._drawer.querySelectorAll('.nd-tab');
            for (var i = 0; i < tabs.length; i++) {
                var isActive = tabs[i].getAttribute('data-tab') === this._activeTab;
                tabs[i].style.background = isActive ? '#1e293b' : 'transparent';
                tabs[i].style.color      = isActive ? '#10b981' : '#94a3b8';
                tabs[i].style.fontWeight = isActive ? '700' : '500';
            }

            if (this._activeTab === 'cache') {
                body.innerHTML = this._renderCacheTab();
            } else if (this._activeTab === 'view') {
                body.innerHTML = this._renderViewTab();
            } else if (this._activeTab === 'rpc') {
                body.innerHTML = this._renderRpcTab();
            }
        },

        _escape: function (s) {
            return String(s).replace(/[&<>"]/g, function (c) {
                return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
            });
        },

        _row: function (label, value, valueColor) {
            return '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e293b;">' +
                '<span style="color:#64748b;">' + this._escape(label) + '</span>' +
                '<span style="color:' + (valueColor || '#e2e8f0') + ';font-weight:600;">' + this._escape(value) + '</span>' +
                '</div>';
        },

        _renderCacheTab: function () {
            var snap = window.NOVA_DEBUG.cache.snapshot();
            var total = snap.hits + snap.misses + snap.staleHits;
            var ratioPct = total > 0 ? Math.round(snap.ratio * 100) : 0;
            var ratioColor = ratioPct >= 70 ? '#10b981' : ratioPct >= 40 ? '#f59e0b' : '#ef4444';
            return '' +
                this._row('Hits',        snap.hits) +
                this._row('Misses',      snap.misses) +
                this._row('Stale Hits',  snap.staleHits) +
                this._row('Hit Ratio',   ratioPct + '%', ratioColor) +
                this._row('Sets',        snap.sets) +
                this._row('Invalidates', snap.invalidates) +
                this._row('Active Keys', snap.activeKeys);
        },

        _renderViewTab: function () {
            var snap = window.NOVA_DEBUG.view.snapshot();
            var html = '' +
                this._row('Active View',   snap.active || '—', '#10b981') +
                this._row('Total Renders', snap.total) +
                '<div style="margin-top:10px;color:#475569;font-size:10px;letter-spacing:.05em;">PER-VIEW</div>';

            var keys = Object.keys(snap.renders);
            if (keys.length === 0) {
                return html + '<div style="color:#475569;padding:4px 0;">(henüz render yok)</div>';
            }
            keys.sort(function (a, b) { return snap.renders[b] - snap.renders[a]; });
            for (var i = 0; i < keys.length; i++) {
                html += this._row(keys[i], snap.renders[keys[i]]);
            }
            return html;
        },

        _renderRpcTab: function () {
            // Mevcut RpcObserver.summary() console.table çıktısı + array döner.
            // Burada array'i alıp top-N render edeceğiz.
            // Direkt __rpcStats'tan bucket compute — summary console'a basıyor; bypass.
            if (!window.__rpcStats || window.__rpcStats.length === 0) {
                return '<div style="color:#475569;">(henüz RPC kaydı yok)</div>';
            }

            var bucket = {};
            for (var i = 0; i < window.__rpcStats.length; i++) {
                var e = window.__rpcStats[i];
                if ((e.kind || 'rpc') !== 'rpc') continue;
                if (!bucket[e.name]) bucket[e.name] = { ok: [], fail: 0 };
                if (e.success) bucket[e.name].ok.push(e.duration_ms);
                else bucket[e.name].fail++;
            }

            var rows = [];
            var names = Object.keys(bucket);
            for (var j = 0; j < names.length; j++) {
                var name = names[j];
                var arr = bucket[name].ok.slice().sort(function (a, b) { return a - b; });
                var n = arr.length;
                rows.push({
                    name:  name,
                    count: n,
                    fail:  bucket[name].fail,
                    p95:   n > 0 ? arr[Math.max(0, Math.floor(n * 0.95) - 1)] : 0,
                    p50:   n > 0 ? arr[Math.floor(n * 0.5)] : 0
                });
            }
            rows.sort(function (a, b) { return b.count - a.count; });

            var html = '<div style="display:flex;color:#475569;font-size:10px;letter-spacing:.05em;padding:4px 0;border-bottom:1px solid #1e293b;">' +
                '<div style="flex:1;">NAME</div>' +
                '<div style="width:50px;text-align:right;">COUNT</div>' +
                '<div style="width:55px;text-align:right;">P50</div>' +
                '<div style="width:55px;text-align:right;">P95</div>' +
                '</div>';

            var limit = Math.min(rows.length, 12);
            for (var k = 0; k < limit; k++) {
                var r = rows[k];
                var p95color = r.p95 >= 500 ? '#ef4444' : r.p95 >= 250 ? '#f59e0b' : '#10b981';
                var shortName = r.name.length > 30 ? r.name.substring(0, 28) + '..' : r.name;
                html += '<div style="display:flex;padding:4px 0;border-bottom:1px solid #1e293b;">' +
                    '<div style="flex:1;color:#e2e8f0;" title="' + this._escape(r.name) + '">' + this._escape(shortName) + '</div>' +
                    '<div style="width:50px;text-align:right;color:#e2e8f0;font-weight:600;">' + r.count + '</div>' +
                    '<div style="width:55px;text-align:right;color:#94a3b8;">' + r.p50 + 'ms</div>' +
                    '<div style="width:55px;text-align:right;color:' + p95color + ';font-weight:600;">' + r.p95 + 'ms</div>' +
                    '</div>';
            }

            if (rows.length > limit) {
                html += '<div style="color:#475569;font-size:10px;padding:6px 0 0 0;">+' + (rows.length - limit) + ' more RPC</div>';
            }
            return html;
        }
    };

    // NOVA_DEBUG.panel'a assign
    window.NOVA_DEBUG.panel = panel;

    // Eger sayfa load'da zaten enabled ise button mount et
    if (window.NOVA_DEBUG.enabled) {
        // DOM hazır olmali — defensive
        if (document.body) {
            panel._mountButton();
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                if (window.NOVA_DEBUG.enabled) panel._mountButton();
            });
        }
    }
})();
