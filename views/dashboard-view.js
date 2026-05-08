/* ============================================================
   DASHBOARD VIEW — Full featured
   AnalyticsService üzerinden veri alır.
   KPI toggle, alerts list, analysis, health score, top products dahil.
   ============================================================ */

window.DashboardView = {
    kpiPeriods: { ciro: 'monthly', gider: 'monthly', kar: 'monthly', trend: 'monthly' },
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
        var monthly = data.monthly;

        container.innerHTML =
            '<div class="kpi-grid">' +
                self.buildKpiCard('ciro', 'CİRO', monthly.ciro, monthly.ciroChange, 'geçen aya göre') +
                self.buildKpiCard('gider', 'GİDER', monthly.gider, monthly.giderChange, 'geçen aya göre') +
                self.buildKpiCard('kar', 'KAR-ZARAR', monthly.kar, monthly.karChange, 'geçen aya göre') +
                self.buildKpiCard('trend', 'SATIŞ TREND', monthly.trend, monthly.trendChange, 'geçen aya göre', true) +
            '</div>' +

            '<div class="charts-row">' +
                '<div class="card">' +
                    '<div class="card-header">' +
                        '<div><div class="card-title">7 Günlük Satış Trendi</div><div class="card-subtitle">Günlük ciro dağılımı</div></div>' +
                        '<div class="card-actions">' +
                            '<button class="card-action-btn active" type="button">7 Gün</button>' +
                            '<button class="card-action-btn" type="button" disabled>30 Gün</button>' +
                        '</div>' +
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
                            return '<div class="alert-item ' + window.Formatters.escapeHtml(a.type) + '"><div class="alert-dot"></div><span>' + window.Formatters.escapeHtml(a.text) + '</span></div>';
                        }).join('') +
                    '</div>' +
                '</div>' +
                '<div class="card">' +
                    '<div class="card-header"><div class="card-title">En Çok Satan 5 Ürün</div><span class="card-subtitle">Bu ay</span></div>' +
                    '<table class="product-table"><thead><tr><th>#</th><th>Ürün</th><th>Satış</th><th>Kâr</th></tr></thead><tbody>' +
                        data.topProducts.map(function (p) {
                            return '<tr>' +
                                '<td><span class="product-rank">' + p.rank + '</span></td>' +
                                '<td>' + window.Formatters.escapeHtml(p.name) + '</td>' +
                                '<td>' + self.formatNumber(p.sales) + ' adet</td>' +
                                '<td>' + self.formatCurrency(p.profit) + '</td>' +
                            '</tr>';
                        }).join('') +
                    '</tbody></table>' +
                '</div>' +
            '</div>' +

            '<div class="card" style="cursor:pointer;" onclick="window.location.hash=\'#health\'">' +
                '<div class="card-header">' +
                    '<div><div class="card-title">Nabız</div><span class="card-subtitle">Isletme performans skoru</span></div>' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                        '<div style="position:relative;width:44px;height:44px;">' +
                            '<svg viewBox="0 0 36 36" style="width:44px;height:44px;transform:rotate(-90deg);">' +
                                '<circle cx="18" cy="18" r="16" fill="none" stroke="#e2e8f0" stroke-width="3"></circle>' +
                                '<circle cx="18" cy="18" r="16" fill="none" stroke="#059669" stroke-width="3" stroke-dasharray="' + (data.healthScore || 0) + ', 100" stroke-linecap="round" class="health-fill"></circle>' +
                            '</svg>' +
                            '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#0f172a;" class="health-value">' + (data.healthScore || 0) + '</div>' +
                        '</div>' +
                        '<span style="font-size:22px;font-weight:800;color:#0f172a;">' + (data.healthScore || 0) + '<span style="font-size:13px;color:#94a3b8;font-weight:600;"> / 100</span></span>' +
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

        self.bindKpiToggles();
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

        return '<div class="kpi-card" id="kpi-' + key + '">' +
            '<div class="kpi-header">' +
                '<span class="kpi-title">' + title + '</span>' +
                '<div class="kpi-toggle-group">' +
                    '<button class="kpi-toggle-btn active" data-kpi="' + key + '" data-period="monthly" type="button">Aylık</button>' +
                    '<button class="kpi-toggle-btn" data-kpi="' + key + '" data-period="daily" type="button">Günlük</button>' +
                '</div>' +
            '</div>' +
            '<div class="kpi-value" id="kpi-value-' + key + '">' + displayValue + '</div>' +
            '<div class="kpi-footer">' +
                '<span class="kpi-trend ' + trendClass + '" id="kpi-trend-' + key + '">' + arrow + self.formatPercent(change) + '</span>' +
                '<span class="kpi-trend-label" id="kpi-label-' + key + '">' + label + '</span>' +
            '</div>' +
        '</div>';
    },

    bindKpiToggles() {
        var self = window.DashboardView;

        document.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
            self._on(btn, 'click', function () {
                self.toggleKpi(this.dataset.kpi, this.dataset.period);
            });
        });
    },

    toggleKpi(kpiKey, period) {
        var self = window.DashboardView;
        if (!self.cachedData) return;

        self.kpiPeriods[kpiKey] = period;

        var data = self.cachedData;
        var source = period === 'daily' ? data.daily : data.monthly;
        var label = period === 'daily' ? 'düne göre' : 'geçen aya göre';

        var isPercent = (kpiKey === 'trend');
        var value, change;

        if (kpiKey === 'ciro') {
            value = source.ciro;
            change = source.ciroChange;
        } else if (kpiKey === 'gider') {
            value = source.gider;
            change = source.giderChange;
        } else if (kpiKey === 'kar') {
            value = source.kar;
            change = source.karChange;
        } else if (kpiKey === 'trend') {
            value = source.trend;
            change = source.trendChange;
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

        var card = document.getElementById('kpi-' + kpiKey);
        if (card) {
            card.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
                btn.classList.toggle('active', btn.dataset.period === period);
            });
        }
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

        // V1.2: Static bar gradient — top a tik dogun, bottom a tik acik.
        // Canvas gradient sadece chartArea hesaplandiktan sonra olusur;
        // ilk render'da chartArea yoksa fallback solid renk.
        function barGradient(context) {
            var chart = context.chart;
            var area = chart.chartArea;
            if (!area) return 'rgba(52, 199, 89, 0.85)';
            var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            g.addColorStop(0, 'rgba(52, 199, 89, 0.95)');
            g.addColorStop(1, 'rgba(52, 199, 89, 0.65)');
            return g;
        }

        // V1.2: Average line plugin — dashed neutral reference,
        // dominant degil, sadece "iyi gun mu kotu gun mu" anchor'i.
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
                c.strokeStyle = 'rgba(15, 23, 42, 0.22)';
                c.setLineDash([4, 4]);
                c.lineWidth = 1;
                c.beginPath();
                c.moveTo(area.left, y);
                c.lineTo(area.right, y);
                c.stroke();
                c.setLineDash([]);

                // Sag uca kucuk "Ort." etiketi
                c.font = '600 10px Inter, system-ui, sans-serif';
                c.fillStyle = 'rgba(15, 23, 42, 0.45)';
                c.textAlign = 'right';
                c.textBaseline = 'bottom';
                c.fillText('Ort. ' + Math.round(avg).toLocaleString('tr-TR'), area.right - 4, y - 3);
                c.restore();
            }
        };

        window.STATE.charts.salesChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: weekly.map(function (s) { return s.day; }),
                datasets: [{
                    label: 'Ciro',
                    data: values,
                    backgroundColor: barGradient,
                    hoverBackgroundColor: barGradient,
                    borderRadius: 8,
                    borderSkipped: false,
                    maxBarThickness: 56
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 600,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    legend: { display: false },
                    // V1.2: Dark premium tooltip
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
                            color: 'rgba(15, 23, 42, 0.05)',
                            drawTicks: false
                        },
                        ticks: {
                            callback: function (val) { return '₺' + val.toLocaleString('tr-TR'); },
                            font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: '500' },
                            color: '#94A3B8',
                            padding: 8
                        }
                    },
                    x: {
                        // V1.2: Visible baseline → bos gunler "kirik chart" hissi vermiyor.
                        border: { color: 'rgba(15, 23, 42, 0.10)', width: 1 },
                        grid: { display: false },
                        ticks: {
                            font: { family: 'Inter, system-ui, sans-serif', size: 11, weight: '600' },
                            color: '#64748B',
                            padding: 6
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

                // Label — UPPERCASE, kucuk, muted
                c.font = '700 10px Inter, system-ui, sans-serif';
                c.fillStyle = '#94A3B8';
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
                    borderWidth: 2,
                    hoverBorderColor: '#FFFFFF',
                    hoverBorderWidth: 2,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
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
