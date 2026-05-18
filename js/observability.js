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
