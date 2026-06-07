/* ============================================================
   DASHBOARD VIEW — Full featured
   AnalyticsService üzerinden veri alır.
   KPI toggle, alerts list, analysis, health score, top products dahil.
   ============================================================ */

window.DashboardView = {
    // V1.4: Tek global KPI period state (eskiden 4 ayri kpiPeriods).
    // Period degistirme cachedData'da zaten her ikisi (daily/monthly) bulundugu
    // icin pure client-side switch — RPC veya ViewCache invalidation gerekmez.
    kpiPeriod: 'monthly',
    cachedData: null,
    isRendering: false,
    _pendingRefresh: false,
    _listeners: [],
    _isActive: false,

    async render(container, force) {
        var self = window.DashboardView;
        // NOVA_DEBUG (Faz O1-A): view render tracker (early-return if disabled)
        if (window.NOVA_DEBUG && window.NOVA_DEBUG.view) window.NOVA_DEBUG.view.track('dashboard');
        self._isActive = true;
        force = !!force;

        if (self.isRendering) {
            self._pendingRefresh = true;
            // bekleyen refresh force ise force kalsin
            if (force) self._pendingForce = true;
            return;
        }

        self.isRendering = true;
        self.container = container;

        if (!self._eventsBound) {
            self._eventsBound = true;

            // FORCE refresh: cache bypass + view re-render
            function handleUpdate() {
                // 1) HER ZAMAN ViewCache'i invalidate et (container yoksa bile).
                //    Kullanici expenses/sales/products sayfasinda iken
                //    dashboard destroy olmus oluyor; container=null donerse
                //    cache'i yine de bosalt -> sonra dashboard'a donunce
                //    fresh veri gelir.
                if (window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
                    try { window.ViewCache.invalidate('dashboard:'); } catch (e) { /* noop */ }
                }
                self.cachedData = null;

                // 2) Container yoksa (bu sayfada degiliz) re-render gerekmez,
                //    cache zaten bos -> sonraki ziyaret fresh fetch yapar.
                if (!self.container) return;

                if (self.isRendering) {
                    self._pendingRefresh = true;
                    self._pendingForce = true;
                    return;
                }

                self.render(self.container, true);   // ← force=true
            }

            // PERF (Faz 3.4): handleUpdate debounce — multi-event cascade
            // koruması. Ardışık dispatch (sales:updated + expenses:updated +
            // products:updated, örn. restore_full_backup veya hızlı multi-
            // action) 300ms penceresi içinde TEK render'a merge edilir.
            // Eskiden N event = N render denemesi (isRendering guard ile
            // 2-4 RPC); şimdi N event = 1 RPC.
            //
            // handleUpdate body dokunulmadı. force=true / cache invalidate /
            // pendingRefresh / SWR davranışı aynen korunuyor.
            //
            // window.debounce yoksa (eski JS load order) raw fallback.
            var debouncedUpdate = (typeof window.debounce === 'function')
                ? window.debounce(handleUpdate, 300)
                : handleUpdate;

            self._on(window, 'sales:updated',     debouncedUpdate);
            self._on(window, 'expenses:updated',  debouncedUpdate);
            self._on(window, 'products:updated',  debouncedUpdate);
            self._on(window, 'dashboard:refresh', debouncedUpdate);
        }

        var tenantId = (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || '';
        var start = window.STATE?.filters?.startDate || '';
        var end = window.STATE?.filters?.endDate || '';

        var cacheKey = 'dashboard:' + tenantId + ':' + start + ':' + end;

        // FORCE: ViewCache invalidate + cache hit'i atla
        if (force && window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
            try { window.ViewCache.invalidate(cacheKey); } catch (e) { /* noop */ }
        }

        // PERF (Faz 3.1): SWR — getWithMeta stale data'yi silmez.
        // - FRESH: eski cache hit yolu (Faz 2.1)
        // - STALE: instant render + background revalidate (yeni yol)
        // force=true ise meta tamamen atlanir → fresh fetch.
        var meta = (!force && window.ViewCache && window.ViewCache.getWithMeta)
            ? window.ViewCache.getWithMeta(cacheKey)
            : null;

        if (meta && meta.fresh) {
            // ESKI YOL: fresh cache hit (Faz 2.1 davranis)
            self.cachedData = meta.data;

            var newSig = self._computeRenderSig(meta.data);
            var domStable = container.querySelector('.kpi-grid') !== null;

            if (self._lastRenderedSig === newSig && domStable) {
                // Tam skip — chart'lar zaten same-sig guard'inda no-op
                self.renderSalesChart(meta.data);
                self.renderExpenseChart(meta.data);
                self._finishRender();
                return;
            }

            self.renderDashboard(container, meta.data);
            self._lastRenderedSig = newSig;
            self._finishRender();
            return;
        }

        if (meta && meta.stale) {
            // YENI YOL (Faz 3.1): stale-while-revalidate.
            // 1) Stale data'yi INSTANT render et — "loading hissi" yok
            self.cachedData = meta.data;

            var newSigS = self._computeRenderSig(meta.data);
            var domStableS = container.querySelector('.kpi-grid') !== null;

            if (self._lastRenderedSig !== newSigS || !domStableS) {
                self.renderDashboard(container, meta.data);
                self._lastRenderedSig = newSigS;
            } else {
                // DOM zaten ayni stale data ile render edilmis — chart yeniden
                // bind (no-op olabilir, defensive)
                self.renderSalesChart(meta.data);
                self.renderExpenseChart(meta.data);
            }

            // 2) Background revalidate (fire-and-forget)
            self._revalidateInBackground(container, cacheKey);

            self._finishRender();
            return;
        }

        container.innerHTML =
            '<div class="card">' +
                '<div class="card-header">' +
                    '<div class="card-title">Dashboard yükleniyor</div>' +
                    '<div class="card-subtitle">Veriler hazırlanıyor...</div>' +
                '</div>' +
            '</div>';

        try {
            var data = await window.AnalyticsService.getDashboardAnalytics();
            if (!self._isActive) return;
            self.cachedData = data;

            if (window.ViewCache) {
                window.ViewCache.set(cacheKey, data);
            }

            self.renderDashboard(container, data);
            // PERF (Faz 2.1): Render signature track — sonraki cache hit'te
            // same-sig kontrolu icin.
            self._lastRenderedSig = self._computeRenderSig(data);

        } catch (error) {
            console.error('Dashboard render error:', error);

            container.innerHTML =
                '<div class="card">' +
                    '<div class="card-header">' +
                        '<div class="card-title">Dashboard yüklenemedi</div>' +
                        '<div class="card-subtitle">Lütfen console ekranını kontrol et.</div>' +
                    '</div>' +
                    '<div style="padding:16px;color:#DC2626;font-weight:600;">' +
                        window.Formatters.escapeHtml(error && error.message ? error.message : 'Bilinmeyen hata') +
                    '</div>' +
                '</div>';
        }

        self._finishRender();
    },

    // PERF (Faz 3.1): SWR background revalidate.
    // Stale data immediate render edildikten sonra sessizce fresh fetch.
    // _revalidating flag duplicate request engeller.
    // View destroy edilirse callback no-op.
    _revalidateInBackground: function (container, cacheKey) {
        var self = window.DashboardView;
        if (self._revalidating) return;
        self._revalidating = true;

        // Fire-and-forget — Promise hata atarsa silent fail (stale data zaten ekranda)
        window.AnalyticsService.getDashboardAnalytics()
            .then(function (fresh) {
                self._revalidating = false;

                // Defensive: view destroy edilmiş veya container değişmiş ise abort
                if (!self._isActive || self.container !== container) return;

                self.cachedData = fresh;
                if (window.ViewCache) {
                    window.ViewCache.set(cacheKey, fresh);
                }

                var newSig = self._computeRenderSig(fresh);
                if (self._lastRenderedSig !== newSig) {
                    // Data degisti → full re-render (rare case)
                    self.renderDashboard(container, fresh);
                    self._lastRenderedSig = newSig;
                } else {
                    // Data ayni → no-op (kullanici hicbir sey hissetmez)
                    // Defensive chart sync (in-place no-op)
                    self.renderSalesChart(fresh);
                    self.renderExpenseChart(fresh);
                }
            })
            .catch(function () {
                self._revalidating = false;
                // Silent fail — stale data zaten ekranda
            });
    },

    _finishRender() {
        var self = window.DashboardView;

        self.isRendering = false;

        if (self._pendingRefresh) {
            self._pendingRefresh = false;
            var wasForce = !!self._pendingForce;
            self._pendingForce = false;
            self.cachedData = null;
            if (self.container) {
                self.render(self.container, wasForce);
            }
        }
    },

    // PERF (Faz 2.1): Hafif data signature — critical değerleri "|" join'le
    // hash et. JSON.stringify pahalıydı; bu O(N) string concat ile cache hit
    // sırasında full DOM rebuild skip kararı için.
    // Same-sig + DOM stable ise render() innerHTML'i atlar; chart'lar in-place
    // update yapar (kendi same-sig guard'larıyla no-op).
    _computeRenderSig: function (data) {
        if (!data) return '';
        var d = data.daily || {};
        var m = data.monthly || {};
        var top = (data.topProducts || []).map(function (p) {
            return (p.name || '') + ':' + (p.profit || 0) + ':' + (p.sales || 0);
        }).join(',');
        var ws = (data.weeklySales || []).reduce(function (s, w) {
            return s + (Number(w.amount) || 0);
        }, 0);
        var ec = (data.expenseCategories || []).reduce(function (s, c) {
            return s + (Number(c.amount) || 0);
        }, 0);
        return [
            d.ciro, d.gider, d.kar, d.trend,
            m.ciro, m.gider, m.kar, m.trend,
            top, (data.alerts || []).length, ws, ec, data.healthScore
        ].join('|');
    },

    renderDashboard(container, data) {
        var self = window.DashboardView;
        // V1.4: Initial render artik global kpiPeriod state'ini onurlandirir.
        // Sayfa degisip geri donulurse kullanici secimi korunur.
        var period = (self.kpiPeriod === 'daily') ? 'daily' : 'monthly';
        var src = (period === 'daily') ? data.daily : data.monthly;
        var initialLabel = (period === 'daily') ? 'düne göre' : 'geçen aya göre';
        var monthlyActive = (period === 'monthly') ? ' active' : '';
        var dailyActive = (period === 'daily') ? ' active' : '';

        // R1.1: Hero hierarchy — birincil kimlik ISLETME ADI (tenant.name).
        // Kullanici adi sub-header / topbar profile chip'inde zaten gosteriliyor.
        // Sub-header'daki duplicate business-name R1.1 CSS ile globally hidden.
        var tenantName = (window.STATE && window.STATE.tenant && window.STATE.tenant.name)
            ? String(window.STATE.tenant.name)
            : 'İŞLETME';
        var safeTenant = (window.Formatters && window.Formatters.escapeHtml)
            ? window.Formatters.escapeHtml(tenantName)
            : tenantName;

        // Hero v2: sub-header'daki saglik skoru kaldirildi (bant bos kaliyordu),
        // compact intelligence chip olarak hero'nun saginda yer aliyor. Tiklanabilir,
        // #health route'a yonlendirir.
        var healthChipHtml = self._buildHealthChip(data.healthScore);

        container.innerHTML =
            '<header class="dashboard-hero">' +
                '<div class="dashboard-hero-text">' +
                    '<h1 class="dashboard-hero-title">' + safeTenant + '</h1>' +
                    '<p class="dashboard-hero-subtitle">Bugünkü operasyon özeti hazır.</p>' +
                '</div>' +
                '<div class="dashboard-hero-meta">' +
                    healthChipHtml +
                    '<div class="dashboard-hero-toolbar">' +
                        '<div class="kpi-toggle-group" id="globalKpiToggle">' +
                            '<button class="kpi-toggle-btn' + monthlyActive + '" data-period="monthly" type="button">Aylık</button>' +
                            '<button class="kpi-toggle-btn' + dailyActive + '" data-period="daily" type="button">Günlük</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</header>' +
            '<div class="kpi-grid">' +
                self.buildKpiCard('ciro', 'CİRO', src.ciro, src.ciroChange, initialLabel) +
                self.buildKpiCard('gider', 'GİDER', src.gider, src.giderChange, initialLabel) +
                self.buildKpiCard('kar', 'KAR-ZARAR', src.kar, src.karChange, initialLabel) +
                self.buildKpiCard('trend', 'SATIŞ TREND', src.trend, src.trendChange, initialLabel, true) +
            '</div>' +

            '<div class="charts-row">' +
                '<div class="card">' +
                    '<div class="card-header">' +
                        '<div><div class="card-title">7 Günlük Satış Trendi</div><div class="card-subtitle">Günlük ciro dağılımı</div></div>' +
                        // Bug-fix: 7 Gün/30 Gün toggle kaldirildi.
                        // 30 Gün hicbir zaman implement edilmemis (disabled, click handler yok).
                        // 7 Gün tek secenek olunca toggle anlamsiz; title zaten "7 Günlük..." diyor.
                    '</div>' +
                    '<div class="chart-container"><canvas id="salesChart"></canvas></div>' +
                '</div>' +
                '<div class="card">' +
                    '<div class="card-header">' +
                        '<div><div class="card-title">Gider Dağılımı</div><div class="card-subtitle">Kategoriye göre</div></div>' +
                    '</div>' +
                    '<div class="chart-container"><canvas id="expenseChart"></canvas></div>' +
                '</div>' +
            '</div>' +

            // PERF (Faz 2.1): Bottom-grid ve Nabiz section'lari ayri helper
            // fonksiyonlara extract edildi (kod organizasyonu + gelecekte
            // partial update'e hazirlik). Output byte-by-byte AYNI.
            self._buildBottomGridHtml(data) +
            self._buildNabizCardHtml(data);

        self.bindGlobalKpiToggle();
        self.updateHeaderWidgets(data);

        // PERF (Faz 3.2): Chart init defer (cold path).
        // - Warm path (chart instance VAR): in-place update sync — chart same-sig
        //   guard zaten no-op verir; rAF defer gereksiz overhead.
        // - Cold path (chart instance YOK): new Chart() init 150-300ms her biri,
        //   main thread blocking. requestIdleCallback ile defer → First Usable
        //   hemen, chart kisa sure sonra (kullanici hala dashboard'a bakiyor,
        //   chart "fade in" gibi gorunur).
        var hasCharts = window.STATE.charts.salesChart && window.STATE.charts.expenseChart;
        if (hasCharts) {
            // Warm: sync in-place
            self.renderSalesChart(data);
            self.renderExpenseChart(data);
        } else {
            // Cold: defer cold chart init.
            // requestIdleCallback varsa idle window kullan, yoksa rAF fallback.
            var deferFn = window.requestIdleCallback
                ? function (cb) { return window.requestIdleCallback(cb, { timeout: 200 }); }
                : function (cb) { return window.requestAnimationFrame(cb); };
            deferFn(function () {
                if (!self._isActive) return;
                self.renderSalesChart(data);
                self.renderExpenseChart(data);
            });
        }
    },

    // PERF (Faz 2.1): renderDashboard'dan extract — Kritik Uyarilar + En Cok
    // Satan 5 Urun kartlari. Output byte-by-byte aynı. Gelecekte selective
    // partial update icin tek noktadan rebuild yapilabilir hale getirildi.
    _buildBottomGridHtml: function (data) {
        var self = window.DashboardView;
        return '<div class="bottom-grid">' +
                '<div class="card">' +
                    '<div class="card-header"><div class="card-title">Kritik Uyarılar</div><span class="card-subtitle">' + data.alerts.length + ' uyarı</span></div>' +
                    '<div class="alert-list">' +
                        data.alerts.map(function (a) {
                            // R6: Severity-aware icon bubble + zengin text block.
                            var type = String(a.type || 'warning');
                            var icon = self._alertIconSvg(type);
                            return '<div class="alert-item ' + window.Formatters.escapeHtml(type) + '">' +
                                '<div class="alert-icon-bubble">' + icon + '</div>' +
                                '<span class="alert-text">' + window.Formatters.escapeHtml(a.text) + '</span>' +
                            '</div>';
                        }).join('') +
                    '</div>' +
                '</div>' +
                '<div class="card">' +
                    '<div class="card-header"><div class="card-title">En Çok Satan 5 Ürün</div><span class="card-subtitle">Bu ay</span></div>' +
                    '<table class="product-table"><thead><tr><th>#</th><th>Ürün</th><th>Satış</th><th>Kâr</th></tr></thead><tbody>' +
                        data.topProducts.map(function (p) {
                            // R6: Rank 1 dominant brand; 2-5 soft brand-tinted (hierarchy).
                            var rankCls = (Number(p.rank) === 1) ? 'product-rank is-leader' : 'product-rank';

                            // FAZ 1.2 Commit 2: cost_missing → Kar sutunu "—",
                            // urun adi yaninda amber pill badge. Sahte revenue=profit
                            // gosterimi yok. Backend hesaplari ve revenue alani
                            // dokunulmadi (gercek satis adet+ciro hala goruluyor).
                            var nameCell = window.Formatters.escapeHtml(p.name)
                                + (p.cost_missing
                                    ? ' <span class="badge-missing-cost" title="Bu ürünün hammadde maliyeti tanımlı değil — kâr hesabı yapılamaz">⚠ Maliyetsiz</span>'
                                    : '');

                            var profitCell = p.cost_missing
                                ? '<td style="color:#94a3b8;" title="Maliyet tanımsız — gerçek kâr bilinemez">—</td>'
                                : '<td>' + self.formatCurrency(p.profit) + '</td>';

                            return '<tr' + (p.cost_missing ? ' class="product-cost-missing"' : '') + '>' +
                                '<td><span class="' + rankCls + '">' + p.rank + '</span></td>' +
                                '<td>' + nameCell + '</td>' +
                                '<td>' + self.formatNumber(p.sales) + ' adet</td>' +
                                profitCell +
                            '</tr>';
                        }).join('') +
                    '</tbody></table>' +
                '</div>' +
            '</div>';
    },

    // PERF (Faz 2.1): renderDashboard'dan extract — Nabiz card. Output aynı.
    _buildNabizCardHtml: function (data) {
        // R7: Nabiz Intelligence Layer — score header refinement (ring + typography),
        // subtitle typo fix ("Isletme" → "İşletme"), insight grid CSS refine.
        return '<div class="card" style="cursor:pointer;" onclick="window.location.hash=\'#health\'">' +
                '<div class="card-header">' +
                    '<div><div class="card-title">Nabız</div><span class="card-subtitle">İşletme performans skoru</span></div>' +
                    '<div style="display:flex;align-items:center;gap:12px;">' +
                        '<div style="position:relative;width:40px;height:40px;">' +
                            '<svg viewBox="0 0 36 36" style="width:40px;height:40px;transform:rotate(-90deg);">' +
                                '<circle cx="18" cy="18" r="16" fill="none" stroke="#CBD5E1" stroke-width="2.5"></circle>' +
                                '<circle cx="18" cy="18" r="16" fill="none" stroke="#059669" stroke-width="2.5" stroke-dasharray="' + (data.healthScore || 0) + ', 100" stroke-linecap="round" class="health-fill"></circle>' +
                            '</svg>' +
                            '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#0f172a;" class="health-value">' + (data.healthScore || 0) + '</div>' +
                        '</div>' +
                        '<span style="font-size:24px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">' + (data.healthScore || 0) + '<span style="font-size:13px;color:#64748b;font-weight:600;letter-spacing:0;"> / 100</span></span>' +
                    '</div>' +
                '</div>' +
                '<div class="analysis-grid">' +
                    data.analysis.map(function (a) {
                        return '<div class="analysis-item">' +
                            '<div class="analysis-icon ' + window.Formatters.escapeHtml(a.iconClass) + '">' + a.icon + '</div>' +
                            '<div class="analysis-content"><h4>' + window.Formatters.escapeHtml(a.title) + '</h4><p>' + window.Formatters.escapeHtml(a.text) + '</p></div>' +
                        '</div>';
                    }).join('') +
                '</div>' +
            '</div>';
    },

    buildKpiCard(key, title, value, change, label, isPercent) {
        var self = window.DashboardView;

        var displayValue = isPercent
            ? ('%' + self.safeFixed(value))
            : self.formatCurrency(value);

        var isNew = (change === null || change === undefined);
        var trendClass = isNew ? 'up' : (change >= 0 ? 'up' : 'down');
        if (key === 'gider' && !isNew) trendClass = change >= 0 ? 'down' : 'up';

        var arrow = isNew ? '' : (change >= 0 ? '↑ ' : '↓ ');

        // R3: KPI Card V2 — semantic color class + icon bubble + content wrapper.
        // Wave layer pure CSS pseudo-element olarak ::after icinde.
        // Existing element ID'leri (kpi-value-*, kpi-trend-*, kpi-label-*)
        // korundu — _updateKpiCard() degisiklik gerektirmez.
        var iconSvg = self._kpiIconSvg(key);
        return '<div class="kpi-card kpi-' + key + '" id="kpi-' + key + '">' +
            '<div class="kpi-card-content">' +
                '<div class="kpi-header">' +
                    '<div class="kpi-icon-bubble">' + iconSvg + '</div>' +
                    '<span class="kpi-title">' + title + '</span>' +
                '</div>' +
                '<div class="kpi-value" id="kpi-value-' + key + '">' + displayValue + '</div>' +
                '<div class="kpi-footer">' +
                    '<span class="kpi-trend ' + trendClass + '" id="kpi-trend-' + key + '">' + arrow + self.formatPercent(change) + '</span>' +
                    '<span class="kpi-trend-label" id="kpi-label-' + key + '">' + label + '</span>' +
                '</div>' +
            '</div>' +
        '</div>';
    },

    // R3: SVG icons per KPI — Lucide-style stroke icons.
    // currentColor kullanir → .kpi-icon-bubble color: var(--kpi-{key}) ile renklenir.
    _kpiIconSvg(key) {
        var icons = {
            ciro:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
            gider: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
            kar:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>',
            trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>'
        };
        return icons[key] || '';
    },

    // Hero v2: Compact health score chip. Tiklanabilir <a href="#health">.
    // Score'a gore semantic state (KRITIK/IZLENMELI/NORMAL/MUKEMMEL).
    // Ring stroke-dasharray score yuzdesini gosterir.
    _buildHealthChip(rawScore) {
        var s = Math.max(0, Math.min(100, Math.round(Number(rawScore) || 0)));
        var label, stateClass, color;
        if (s >= 85) {
            label = 'MÜKEMMEL'; stateClass = 'is-good'; color = '#059669';
        } else if (s >= 70) {
            label = 'NORMAL'; stateClass = 'is-normal'; color = '#0891b2';
        } else if (s >= 50) {
            label = 'İZLENMELİ'; stateClass = 'is-watch'; color = '#d97706';
        } else {
            label = 'KRİTİK'; stateClass = 'is-critical'; color = '#dc2626';
        }
        return '<a href="#health" class="hero-health-chip ' + stateClass + '" aria-label="Nabız skoru ' + s + ', detay için tıklayın">' +
            '<span class="hero-health-chip-ring">' +
                '<svg viewBox="0 0 36 36" width="32" height="32" style="transform:rotate(-90deg);">' +
                    '<circle cx="18" cy="18" r="16" fill="none" stroke="#E2E8F0" stroke-width="3"></circle>' +
                    '<circle cx="18" cy="18" r="16" fill="none" stroke="' + color + '" stroke-width="3" stroke-dasharray="' + s + ', 100" stroke-linecap="round"></circle>' +
                '</svg>' +
            '</span>' +
            '<span class="hero-health-chip-score">' + s + '</span>' +
            '<span class="hero-health-chip-label">' + label + '</span>' +
            '<span class="hero-health-chip-arrow" aria-hidden="true">→</span>' +
        '</a>';
    },

    // R6: Severity-aware alert icons (Lucide stroke). currentColor →
    // .alert-icon-bubble semantic color'i pick eder.
    _alertIconSvg(type) {
        var icons = {
            warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            danger:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
            success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="9 12 12 15 16 10"/></svg>'
        };
        return icons[type] || icons.warning;
    },

    // V1.4: Tek global toggle binding (eskiden 4 kart × 2 button = 8 binding).
    bindGlobalKpiToggle() {
        var self = window.DashboardView;
        var toggle = document.getElementById('globalKpiToggle');
        if (!toggle) return;

        // PERF: Her renderDashboard() bu fn'i tekrar cagiriyor (line 278).
        // Eski button'lar artik DOM'da yok ama listener'lari _listeners[]'a
        // birikmis kaliyordu (destroy'a kadar). Yeni butonlara bind etmeden
        // ONCE eskileri filtrele — tag'leme ile.
        self._listeners = (self._listeners || []).filter(function (l) {
            if (l && l._tag === 'kpiToggle') {
                try { l.el.removeEventListener(l.event, l.fn); } catch (e) { /* noop */ }
                return false;
            }
            return true;
        });

        toggle.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
            var fn = function () {
                var p = this.dataset.period;
                if (p === 'monthly' || p === 'daily') {
                    self.setKpiPeriod(p);
                }
            };
            btn.addEventListener('click', fn);
            // _on() helper yerine direkt push — _tag ile filtrelenebilsin.
            // _listeners'a girdigi icin destroy() yine temizler.
            self._listeners.push({ el: btn, event: 'click', fn: fn, _tag: 'kpiToggle' });
        });
    },

    // V1.4: Global period setter — toggle button state + 4 KPI render sync.
    // Backend cagrisi YOK, cachedData zaten hem daily hem monthly icerir.
    setKpiPeriod(period) {
        var self = window.DashboardView;
        if (!self.cachedData) return;
        if (period !== 'monthly' && period !== 'daily') return;
        if (self.kpiPeriod === period) return; // no-op

        self.kpiPeriod = period;

        // Toggle button active state
        var toggle = document.getElementById('globalKpiToggle');
        if (toggle) {
            toggle.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
                btn.classList.toggle('active', btn.dataset.period === period);
            });
        }

        // 4 KPI'yi tek pas senkronla
        ['ciro', 'gider', 'kar', 'trend'].forEach(function (key) {
            self._updateKpiCard(key, period);
        });
    },

    // V1.4: Tek KPI kartinin DOM'unu gunceller (eski toggleKpi'nin orta cekirdegi).
    // Artik public surface degil — sadece setKpiPeriod tarafindan cagrilir.
    _updateKpiCard(kpiKey, period) {
        var self = window.DashboardView;
        var data = self.cachedData;
        if (!data) return;

        var source = (period === 'daily') ? data.daily : data.monthly;
        var label = (period === 'daily') ? 'düne göre' : 'geçen aya göre';
        var isPercent = (kpiKey === 'trend');
        var value, change;

        if (kpiKey === 'ciro') {
            value = source.ciro; change = source.ciroChange;
        } else if (kpiKey === 'gider') {
            value = source.gider; change = source.giderChange;
        } else if (kpiKey === 'kar') {
            value = source.kar; change = source.karChange;
        } else if (kpiKey === 'trend') {
            value = source.trend; change = source.trendChange;
        }

        var displayValue = isPercent
            ? ('%' + self.safeFixed(value))
            : self.formatCurrency(value);

        var isNew = (change === null || change === undefined);
        var trendClass = isNew ? 'up' : (change >= 0 ? 'up' : 'down');
        if (kpiKey === 'gider' && !isNew) trendClass = change >= 0 ? 'down' : 'up';
        var arrow = isNew ? '' : (change >= 0 ? '↑ ' : '↓ ');

        var valueEl = document.getElementById('kpi-value-' + kpiKey);
        var trendEl = document.getElementById('kpi-trend-' + kpiKey);
        var labelEl = document.getElementById('kpi-label-' + kpiKey);

        if (valueEl) valueEl.textContent = displayValue;
        if (trendEl) {
            trendEl.textContent = arrow + self.formatPercent(change);
            trendEl.className = 'kpi-trend ' + trendClass;
        }
        if (labelEl) labelEl.textContent = label;
    },

    renderSalesChart(data) {
        var ctx = document.getElementById('salesChart');
        if (!ctx) return;

        var weekly = data.weeklySales || [];

        // Same-data guard: ayni dataset → no-op
        var sig = JSON.stringify(weekly.map(function (s) { return [s.day, s.amount]; }));
        if (window.STATE.charts.salesChart && this._lastSalesSig === sig) {
            return;
        }
        this._lastSalesSig = sig;

        var values = weekly.map(function (s) { return Number(s.amount) || 0; });
        var labels = weekly.map(function (s) { return s.day; });
        var nonZero = values.filter(function (v) { return v > 0; });
        var avg = nonZero.length
            ? nonZero.reduce(function (a, b) { return a + b; }, 0) / nonZero.length
            : 0;

        // PERF (Faz 2.1): Chart instance varsa IN-PLACE update — destroy/create
        // 100-300ms maliyetli; data.labels + data.datasets + update() << ~10-30ms.
        // avgLinePlugin'in avg degeri artik chart.options.plugins.avgLine'dan
        // okunuyor — closure capture problemi yok, in-place uyumlu.
        var existing = window.STATE.charts.salesChart;
        if (existing && existing.config && existing.config.type === 'line') {
            existing.data.labels = labels;
            existing.data.datasets[0].data = values;
            if (existing.options && existing.options.plugins) {
                existing.options.plugins.avgLine = { avg: avg };
            }
            existing.update();
            return;
        }

        // Cold path: yeni chart yarat
        window.destroyChart('salesChart');

        // R4: Area gradient fill — top emerald 0.18 → bottom transparent.
        function areaGradient(context) {
            var chart = context.chart;
            var area = chart.chartArea;
            if (!area) return 'rgba(16, 185, 129, 0.10)';
            var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, 'rgba(16, 185, 129, 0.18)');
            g.addColorStop(1, 'rgba(16, 185, 129, 0)');
            return g;
        }

        // V1.2: Average line plugin — avg degeri chart.options.plugins.avgLine'dan
        // okunur (closure capture yerine). Boylece in-place update'lerde yeni avg
        // dogru reflect olur.
        var avgLinePlugin = {
            id: 'avgLine',
            afterDatasetsDraw: function (chart) {
                var opts = chart.options.plugins && chart.options.plugins.avgLine;
                var avgVal = opts && opts.avg;
                if (!avgVal || avgVal <= 0) return;
                var area = chart.chartArea;
                var yScale = chart.scales.y;
                if (!area || !yScale) return;
                var y = yScale.getPixelForValue(avgVal);
                if (y < area.top || y > area.bottom) return;

                var c = chart.ctx;
                c.save();
                c.strokeStyle = 'rgba(15, 23, 42, 0.20)';
                c.setLineDash([4, 4]);
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(area.left, y);
                c.lineTo(area.right, y);
                c.stroke();
                c.setLineDash([]);

                c.font = '600 10px Inter, system-ui, sans-serif';
                c.fillStyle = 'rgba(15, 23, 42, 0.45)';
                c.textAlign = 'right';
                c.textBaseline = 'bottom';
                c.fillText('Ort. ' + Math.round(avgVal).toLocaleString('tr-TR'), area.right - 4, y - 3);
                c.restore();
            }
        };

        // R4: Bar -> Line. Smooth bezier (tension 0.4) + gradient fill +
        // beyaz core dots emerald borderli. Constant glow YOK; hover'da
        // dot soft shadow (B disiplini, mockup'tan %35 asagi).
        window.STATE.charts.salesChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: weekly.map(function (s) { return s.day; }),
                datasets: [{
                    label: 'Ciro',
                    data: values,
                    borderColor: '#10B981',
                    borderWidth: 2.5,
                    backgroundColor: areaGradient,
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#FFFFFF',
                    pointBorderColor: '#10B981',
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointHoverBorderWidth: 2.5,
                    pointHoverBackgroundColor: '#FFFFFF',
                    pointHoverBorderColor: '#10B981',
                    pointHitRadius: 14,
                    spanGaps: true,
                    cubicInterpolationMode: 'monotone'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 600,
                    easing: 'easeOutQuart'
                },
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    // PERF (Faz 2.1): avgLinePlugin'in dinamik config'i burada.
                    // In-place update'lerde renderSalesChart yeni avg degerini
                    // chart.options.plugins.avgLine.avg = newAvg ile gunceller.
                    avgLine: { avg: avg },
                    legend: { display: false },
                    // R4: Tooltip — V1.2 dark dilini koru, padding/radius
                    // refine + soft shadow ekle (Chart.js native shadow yok,
                    // cornerRadius bumped + caretSize tweaked).
                    tooltip: {
                        enabled: true,
                        backgroundColor: '#0F172A',
                        titleColor: '#F8FAFC',
                        bodyColor: '#E2E8F0',
                        titleFont: { family: 'Inter, system-ui, sans-serif', size: 12, weight: '700' },
                        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 14, weight: '700' },
                        padding: { x: 14, y: 12 },
                        cornerRadius: 10,
                        displayColors: false,
                        borderColor: 'rgba(255, 255, 255, 0.06)',
                        borderWidth: 1,
                        boxPadding: 4,
                        caretPadding: 8,
                        caretSize: 6,
                        callbacks: {
                            label: function (item) {
                                return '₺' + (Number(item.parsed.y) || 0).toLocaleString('tr-TR');
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        border: { display: false },
                        grid: {
                            // R4: Daha incelikli grid — 0.05 → 0.04 alpha
                            color: 'rgba(15, 23, 42, 0.04)',
                            drawTicks: false
                        },
                        ticks: {
                            callback: function (val) { return '₺' + val.toLocaleString('tr-TR'); },
                            font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: '600' },
                            color: '#94A3B8',
                            padding: 12
                        }
                    },
                    x: {
                        // R4: Baseline daha incelikli — 0.10 → 0.08 alpha
                        border: { color: 'rgba(15, 23, 42, 0.08)', width: 1 },
                        grid: { display: false },
                        ticks: {
                            font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: '600' },
                            color: '#64748B',
                            padding: 8
                        }
                    }
                }
            },
            plugins: [avgLinePlugin]
        });
    },

    renderExpenseChart(data) {
        var ctx = document.getElementById('expenseChart');
        if (!ctx) return;

        var cats = data.expenseCategories || [];

        if (cats.length === 0) {
            ctx.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:#94a3b8;font-size:14px;">Gider verisi bulunamadı</div>';
            this._lastExpenseSig = null;
            return;
        }

        // Same-data guard
        var sig = JSON.stringify(cats.map(function (c) { return [c.name, c.amount, c.color]; }));
        if (window.STATE.charts.expenseChart && this._lastExpenseSig === sig) {
            return;
        }
        this._lastExpenseSig = sig;

        // V1.3: Sort by amount desc → en buyuk kategori index 0 = brand renk.
        var sorted = cats.slice().sort(function (a, b) {
            return (Number(b.amount) || 0) - (Number(a.amount) || 0);
        });

        var total = sorted.reduce(function (s, c) {
            return s + (Number(c.amount) || 0);
        }, 0);

        var palette = ['#10B981', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0'];
        var colors = sorted.map(function (c, i) { return palette[i % palette.length]; });
        var labels = sorted.map(function (c) { return c.name; });
        var dataVals = sorted.map(function (c) { return Number(c.amount) || 0; });

        // PERF (Faz 2.1): Chart instance varsa IN-PLACE update — destroy/create
        // pahali (100-300ms). centerHeroPlugin'in total degeri artik chart.options.
        // plugins.centerHero'dan okunuyor → in-place uyumlu.
        var existing = window.STATE.charts.expenseChart;
        if (existing && existing.config && existing.config.type === 'doughnut') {
            existing.data.labels = labels;
            existing.data.datasets[0].data = dataVals;
            existing.data.datasets[0].backgroundColor = colors;
            existing.data.datasets[0].hoverBackgroundColor = colors;
            if (existing.options && existing.options.plugins) {
                existing.options.plugins.centerHero = { total: total };
            }
            existing.update();
            return;
        }

        // Cold path: yeni chart yarat
        window.destroyChart('expenseChart');

        // V1.3: Center hero plugin — total degeri chart.options.plugins.centerHero
        // 'dan okunur (closure capture yerine). In-place chart.update() sonrasi
        // yeni total dogru reflect olur.
        var centerHeroPlugin = {
            id: 'centerHero',
            afterDraw: function (chart) {
                var opts = chart.options.plugins && chart.options.plugins.centerHero;
                var totalVal = opts && opts.total;
                if (typeof totalVal !== 'number') return;
                var area = chart.chartArea;
                if (!area) return;
                var cx = (area.left + area.right) / 2;
                var cy = (area.top + area.bottom) / 2;
                var c = chart.ctx;

                c.save();
                c.textAlign = 'center';
                c.textBaseline = 'middle';

                c.font = '800 22px Inter, system-ui, sans-serif';
                c.fillStyle = '#0F172A';
                c.fillText('₺' + Math.round(totalVal).toLocaleString('tr-TR'), cx, cy - 8);

                c.font = '700 11px Inter, system-ui, sans-serif';
                c.fillStyle = '#475569';
                c.fillText('TOPLAM GİDER', cx, cy + 14);

                c.restore();
            }
        };

        window.STATE.charts.expenseChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sorted.map(function (c) { return c.name; }),
                datasets: [{
                    data: sorted.map(function (c) { return Number(c.amount) || 0; }),
                    backgroundColor: colors,
                    hoverBackgroundColor: colors,
                    borderColor: '#FFFFFF',
                    // R5: Sakin segment ayrimi — 2 → 1.5px (less compartmentalized)
                    borderWidth: 1.5,
                    hoverBorderColor: '#FFFFFF',
                    hoverBorderWidth: 1.5,
                    // R5: Snappy → nazik hover offset — 6 → 4px
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                // R5: Ring kalinligi — 68% → 72% (ince ring = fintech; kalin = HUD/gaming)
                cutout: '72%',
                animation: {
                    duration: 600,
                    easing: 'easeOutQuart',
                    animateRotate: true,
                    animateScale: false
                },
                plugins: {
                    // PERF (Faz 2.1): centerHeroPlugin'in dinamik config'i.
                    // In-place update'lerde renderExpenseChart yeni total'i
                    // chart.options.plugins.centerHero.total = newTotal ile gunceller.
                    centerHero: { total: total },
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 14,
                            usePointStyle: true,
                            boxWidth: 8,
                            boxHeight: 8,
                            font: { family: 'Inter, system-ui, sans-serif', size: 12, weight: '600' },
                            color: '#475569',
                            // V1.3: Legend label = isim · %lik
                            generateLabels: function (chart) {
                                var d = chart.data;
                                if (!d.labels.length || !d.datasets.length) return [];
                                var ds = d.datasets[0];
                                var sum = ds.data.reduce(function (a, b) { return a + b; }, 0);
                                return d.labels.map(function (label, i) {
                                    var v = Number(ds.data[i]) || 0;
                                    var pct = sum > 0 ? Math.round(v / sum * 100) : 0;
                                    var color = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor;
                                    return {
                                        text: label + ' · %' + pct,
                                        fillStyle: color,
                                        strokeStyle: color,
                                        lineWidth: 0,
                                        pointStyle: 'circle',
                                        hidden: false,
                                        index: i
                                    };
                                });
                            }
                        }
                    },
                    // V1.3: Dark premium tooltip — bar chart ile aynı dil
                    tooltip: {
                        enabled: true,
                        backgroundColor: '#0F172A',
                        titleColor: '#F8FAFC',
                        bodyColor: '#E2E8F0',
                        titleFont: { family: 'Inter, system-ui, sans-serif', size: 12, weight: '700' },
                        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 13, weight: '600' },
                        padding: { x: 12, y: 10 },
                        cornerRadius: 8,
                        displayColors: false,
                        borderColor: 'rgba(255, 255, 255, 0.06)',
                        borderWidth: 1,
                        boxPadding: 4,
                        callbacks: {
                            label: function (item) {
                                var v = Number(item.parsed) || 0;
                                var pct = total > 0 ? Math.round(v / total * 100) : 0;
                                return '₺' + v.toLocaleString('tr-TR') + ' · %' + pct;
                            }
                        }
                    }
                }
            },
            plugins: [centerHeroPlugin]
        });
    },

    updateHeaderWidgets(data) {
        // Tek source of truth — global Nabız beacon helper
        if (window.HealthIndicator && typeof window.HealthIndicator.set === 'function') {
            var hasData = !!(data && (data.healthScore || data.monthly || data.weeklySales));
            window.HealthIndicator.set(data && data.healthScore || 0, hasData);
        }
    },

    formatCurrency(amount) {
        var fmt = window.Formatters;
        if (fmt && typeof fmt.currency === 'function') {
            return fmt.currency(amount);
        }
        return '₺' + Number(amount || 0).toLocaleString('tr-TR');
    },

    formatNumber(value) {
        var fmt = window.Formatters;
        if (fmt && typeof fmt.number === 'function') {
            return fmt.number(value);
        }
        return Number(value || 0).toLocaleString('tr-TR');
    },

    formatPercent(value) {
        if (value === null || value === undefined) return 'Yeni';
        return Math.abs(Number(value || 0)).toFixed(1) + '%';
    },

    safeFixed(value) {
        return Number(value || 0).toFixed(1);
    },

    _on(el, event, fn) {
        if (!el) return;
        el.addEventListener(event, fn);
        this._listeners.push({ el: el, event: event, fn: fn });
    },

    _removeAllListeners() {
        for (var i = 0; i < this._listeners.length; i++) {
            var l = this._listeners[i];
            l.el.removeEventListener(l.event, l.fn);
        }
        this._listeners = [];
    },

    // P1-A: KEEP-ALIVE deactivate. View detach ediliyor — DOM/state/listener
    // KORUNUR (cachedData, _eventsBound, _listeners, _lastRenderedSig dokunulmaz).
    // Yalnizca Chart.js instance'lari serbest birakilir (detached canvas Chart.js
    // sorununu onler). destroy DEGILDIR. activate'te chart'lar lazy re-init edilir.
    deactivate() {
        this._isActive = false;
        try { window.destroyChart('salesChart'); } catch (e) { /* noop */ }
        try { window.destroyChart('expenseChart'); } catch (e) { /* noop */ }
        this._lastSalesSig = null;
        this._lastExpenseSig = null;
    },

    // P1-A: KEEP-ALIVE activate. Node yeniden attach edildi; render() ÇAĞRILMAZ.
    // DOM zaten yerinde → instant. Chart'lar reattach edilen canvas uzerinde
    // cachedData'dan lazy re-init edilir (deterministik: once destroy sonra create).
    activate(container) {
        this._isActive = true;
        if (container) this.container = container;
        if (this.cachedData) {
            try { window.destroyChart('salesChart'); } catch (e) { /* noop */ }
            try { window.destroyChart('expenseChart'); } catch (e) { /* noop */ }
            this._lastSalesSig = null;
            this._lastExpenseSig = null;
            this.renderSalesChart(this.cachedData);
            this.renderExpenseChart(this.cachedData);
        }
    },

    destroy() {
        this._isActive = false;
        this._removeAllListeners();
        this._eventsBound = false;
        this.cachedData = null;
        this.isRendering = false;
        this._pendingRefresh = false;
        this.container = null;
        // PERF (Faz 2.1): View destroy edilince DOM gidiyor — sig'i de sıfırla,
        // yoksa bir sonraki render'da same-sig + (domStable=false) negatif
        // branch'e duser ama yine de gereksiz; reset deterministic.
        this._lastRenderedSig = null;
        this._lastSalesSig = null;
        this._lastExpenseSig = null;
        // PERF (Faz 3.1): SWR revalidate flag reset.
        // Background revalidate Promise hala calisirsa _isActive check ile
        // callback no-op; flag burada temizlenir ki yeni render fresh state'le
        // baslayabilsin.
        this._revalidating = false;
    }
};
