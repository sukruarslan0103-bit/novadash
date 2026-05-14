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

            self._on(window, 'sales:updated', handleUpdate);
            self._on(window, 'expenses:updated', handleUpdate);
            self._on(window, 'products:updated', handleUpdate);
            self._on(window, 'dashboard:refresh', handleUpdate);
        }

        var tenantId = (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || '';
        var start = window.STATE?.filters?.startDate || '';
        var end = window.STATE?.filters?.endDate || '';

        var cacheKey = 'dashboard:' + tenantId + ':' + start + ':' + end;

        // FORCE: ViewCache invalidate + cache hit'i atla
        if (force && window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
            try { window.ViewCache.invalidate(cacheKey); } catch (e) { /* noop */ }
        }

        var cached = (!force && window.ViewCache) ? window.ViewCache.get(cacheKey) : null;

        if (cached) {
            self.cachedData = cached;
            self.renderDashboard(container, cached);
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

            '<div class="bottom-grid">' +
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
                            return '<tr>' +
                                '<td><span class="' + rankCls + '">' + p.rank + '</span></td>' +
                                '<td>' + window.Formatters.escapeHtml(p.name) + '</td>' +
                                '<td>' + self.formatNumber(p.sales) + ' adet</td>' +
                                '<td>' + self.formatCurrency(p.profit) + '</td>' +
                            '</tr>';
                        }).join('') +
                    '</tbody></table>' +
                '</div>' +
            '</div>' +

            // R7: Nabiz Intelligence Layer — score header refinement (ring + typography),
            // subtitle typo fix ("Isletme" → "İşletme"), insight grid CSS refine.
            '<div class="card" style="cursor:pointer;" onclick="window.location.hash=\'#health\'">' +
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

        self.bindGlobalKpiToggle();
        self.renderSalesChart(data);
        self.renderExpenseChart(data);
        self.updateHeaderWidgets(data);
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

        toggle.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
            self._on(btn, 'click', function () {
                var p = this.dataset.period;
                if (p === 'monthly' || p === 'daily') {
                    self.setKpiPeriod(p);
                }
            });
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

        // Same-data guard: ayni dataset → recreate ETME
        var sig = JSON.stringify(weekly.map(function (s) { return [s.day, s.amount]; }));
        if (window.STATE.charts.salesChart && this._lastSalesSig === sig) {
            return;
        }
        this._lastSalesSig = sig;

        window.destroyChart('salesChart');

        var values = weekly.map(function (s) { return Number(s.amount) || 0; });
        var nonZero = values.filter(function (v) { return v > 0; });
        var avg = nonZero.length
            ? nonZero.reduce(function (a, b) { return a + b; }, 0) / nonZero.length
            : 0;

        // R4: Area gradient fill — top emerald 0.18 → bottom transparent.
        // Mockup ~0.40+ idi; B disiplini ile %35 dial-down.
        function areaGradient(context) {
            var chart = context.chart;
            var area = chart.chartArea;
            if (!area) return 'rgba(16, 185, 129, 0.10)';
            var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, 'rgba(16, 185, 129, 0.18)');
            g.addColorStop(1, 'rgba(16, 185, 129, 0)');
            return g;
        }

        // V1.2: Average line plugin — dashed neutral reference, dominant degil.
        var avgLinePlugin = {
            id: 'avgLine',
            afterDatasetsDraw: function (chart) {
                if (!avg || avg <= 0) return;
                var area = chart.chartArea;
                var yScale = chart.scales.y;
                if (!area || !yScale) return;
                var y = yScale.getPixelForValue(avg);
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
                c.fillText('Ort. ' + Math.round(avg).toLocaleString('tr-TR'), area.right - 4, y - 3);
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

        window.destroyChart('expenseChart');

        // V1.3: Sort by amount desc → en buyuk kategori index 0 = brand renk.
        // Visual hierarchy upstream'e dokunmadan burada uygulanir.
        var sorted = cats.slice().sort(function (a, b) {
            return (Number(b.amount) || 0) - (Number(a.amount) || 0);
        });

        var total = sorted.reduce(function (s, c) {
            return s + (Number(c.amount) || 0);
        }, 0);

        // V1.3: Brand-aligned palette — random c.color yerine sequential
        // brand+slate. Largest = brand emerald, geri kalanlar slate cool.
        // Stripe/Linear pattern: hero category visual anchor, digerleri receder.
        var palette = ['#10B981', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0'];
        var colors = sorted.map(function (c, i) { return palette[i % palette.length]; });

        // V1.3: Center hero plugin — chart center'inda toplam + label.
        // Cutout %68 ile yer acildi.
        var centerHeroPlugin = {
            id: 'centerHero',
            afterDraw: function (chart) {
                var area = chart.chartArea;
                if (!area) return;
                var cx = (area.left + area.right) / 2;
                var cy = (area.top + area.bottom) / 2;
                var c = chart.ctx;

                c.save();
                c.textAlign = 'center';
                c.textBaseline = 'middle';

                // Toplam tutar — buyuk, weight 800, primary text color
                c.font = '800 22px Inter, system-ui, sans-serif';
                c.fillStyle = '#0F172A';
                c.fillText('₺' + Math.round(total).toLocaleString('tr-TR'), cx, cy - 8);

                // Label — UPPERCASE, sakin secondary
                // R5: 10px → 11px, fillStyle muted → secondary (R3.1 hierarchy ile uyum)
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

    destroy() {
        this._isActive = false;
        this._removeAllListeners();
        this._eventsBound = false;
        this.cachedData = null;
        this.isRendering = false;
        this._pendingRefresh = false;
        this.container = null;
    }
};
