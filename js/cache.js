/* ============================================================
   VIEW CACHE — Sayfa geçişlerinde gereksiz fetch'i engeller
   Tenant bazlı, TTL destekli, max entry sınırlı
   ============================================================ */

window.ViewCache = {
    _store: {},
    _maxEntries: 30,
    _defaultTTL: 5 * 60 * 1000, // 5 dakika

    /**
     * Cache'den veri al. TTL dolmuşsa null döner (backward compat).
     * Mevcut consumer'lar (sales/products/expenses) bu davranışı bekler:
     * stale ise null → fresh fetch yolu.
     */
    get: function (key) {
        var entry = this._store[key];
        if (!entry) return null;
        if (Date.now() - entry.time > (entry.ttl || this._defaultTTL)) {
            delete this._store[key];
            return null;
        }
        return entry.data;
    },

    /**
     * PERF (Faz 3.1): SWR-friendly getter.
     * Stale data'yi SILMEZ; consumer karar verir:
     *   - fresh → normal cache hit
     *   - stale → immediate render + background revalidate
     *
     * Mevcut get() backward compat — sadece dashboard-view şimdilik
     * getWithMeta kullanir. Diger view'lar etkilenmez.
     *
     * Return: null (entry yok) veya { data, age, ttl, stale, fresh }.
     */
    getWithMeta: function (key) {
        var entry = this._store[key];
        if (!entry) return null;
        var ttl = entry.ttl || this._defaultTTL;
        var age = Date.now() - entry.time;
        return {
            data:  entry.data,
            age:   age,
            ttl:   ttl,
            stale: age > ttl,
            fresh: age <= ttl
        };
    },

    /**
     * Cache'e veri yaz.
     */
    set: function (key, data, ttl) {
        this._store[key] = {
            data: data,
            time: Date.now(),
            ttl: ttl || this._defaultTTL
        };
        this._cleanup();
    },

    /**
     * Prefix ile eşleşen tüm kayıtları sil.
     * Prefix verilmezse tüm cache temizlenir.
     */
    clear: function () {
        this._store = {};
    },

    invalidate: function (prefix) {
        if (!prefix) {
            this._store = {};
            return;
        }
        var keys = Object.keys(this._store);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf(prefix) === 0) {
                delete this._store[keys[i]];
            }
        }
    },

    /**
     * Max entry aşılırsa en eskiyi sil.
     */
    _cleanup: function () {
        var keys = Object.keys(this._store);
        if (keys.length <= this._maxEntries) return;
        var entries = [];
        for (var i = 0; i < keys.length; i++) {
            entries.push({ key: keys[i], time: this._store[keys[i]].time });
        }
        entries.sort(function (a, b) { return a.time - b.time; });
        var removeCount = keys.length - this._maxEntries;
        for (var j = 0; j < removeCount; j++) {
            delete this._store[entries[j].key];
        }
    }
};

/* ============================================================
   DEBOUNCE — Filtre / buton spam engelleme
   ============================================================ */

window.debounce = function (fn, delay) {
    var timer = null;
    return function () {
        var ctx = this, args = arguments;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
            timer = null;
            fn.apply(ctx, args);
        }, delay || 300);
    };
};
