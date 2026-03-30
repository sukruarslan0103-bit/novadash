/* ============================================================
   DASHBOARD VIEW — Full featured
   AnalyticsService üzerinden veri alır.
   KPI toggle, alerts, analysis, health score, top products dahil.
   ============================================================ */

window.DashboardView = {
    kpiPeriods: { ciro: 'monthly', gider: 'monthly', kar: 'monthly', trend: 'monthly' },
    cachedData: null,

    async render(container) {
        var self = window.DashboardView;
        self.container = container;

        container.innerHTML =
            '<div class="card">' +
                '<div class="card-header">' +
                    '<div class="card-title">Dashboard yükleniyor</div>' +
                    '<div class="card-subtitle">Veriler hazırlanıyor...</div>' +
                '</div>' +
            '</div>';

        try {
            var data = await window.AnalyticsService.getDashboardAnalytics();
            self.cachedData = data;
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
    },

    /* ============================================================
       RENDER DASHBOARD — Tam layout
    ============================================================ */

    renderDashboard(container, data) {
        var self = window.DashboardView;
        var monthly = data.monthly;

        container.innerHTML =

            /* ---- KPI GRID ---- */
            '<div class="kpi-grid">' +
                self.buildKpiCard('ciro', 'CİRO', monthly.ciro, monthly.ciroChange, 'geçen aya göre') +
                self.buildKpiCard('gider', 'GİDER', monthly.gider, monthly.giderChange, 'geçen aya göre') +
                self.buildKpiCard('kar', 'KAR-ZARAR', monthly.kar, monthly.karChange, 'geçen aya göre') +
                self.buildKpiCard('trend', 'SATIŞ TREND', monthly.trend, monthly.trendChange, 'geçen aya göre', true) +
            '</div>' +

            /* ---- CHARTS ROW ---- */
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

            /* ---- BOTTOM GRID: Alerts + Top Products ---- */
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

            /* ---- ANALYSIS ---- */
            '<div class="card">' +
                '<div class="card-header"><div class="card-title">Akıllı Analiz</div><span class="card-subtitle">Otomatik yorumlar</span></div>' +
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

    /* ============================================================
       KPI CARD BUILDER
    ============================================================ */

    buildKpiCard(key, title, value, change, label, isPercent) {
        var self = window.DashboardView;

        var displayValue = isPercent
            ? ('%' + self.safeFixed(value))
            : self.formatCurrency(value);

        var trendClass = change >= 0 ? 'up' : 'down';
        // Gider için ters mantık: gider artışı = kötü
        if (key === 'gider') trendClass = change >= 0 ? 'down' : 'up';

        var arrow = change >= 0 ? '↑' : '↓';

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
                '<span class="kpi-trend ' + trendClass + '" id="kpi-trend-' + key + '">' + arrow + ' ' + self.formatPercent(change) + '</span>' +
                '<span class="kpi-trend-label" id="kpi-label-' + key + '">' + label + '</span>' +
            '</div>' +
        '</div>';
    },

    /* ============================================================
       KPI TOGGLE — Aylık / Günlük geçiş
    ============================================================ */

    bindKpiToggles() {
        var self = window.DashboardView;

        document.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
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

        var trendClass = change >= 0 ? 'up' : 'down';
        if (kpiKey === 'gider') trendClass = change >= 0 ? 'down' : 'up';

        var arrow = change >= 0 ? '↑' : '↓';

        var valueEl = document.getElementById('kpi-value-' + kpiKey);
        var trendEl = document.getElementById('kpi-trend-' + kpiKey);
        var labelEl = document.getElementById('kpi-label-' + kpiKey);

        if (valueEl) valueEl.textContent = displayValue;
        if (trendEl) {
            trendEl.textContent = arrow + ' ' + self.formatPercent(change);
            trendEl.className = 'kpi-trend ' + trendClass;
        }
        if (labelEl) labelEl.textContent = label;

        // Toggle button active state
        var card = document.getElementById('kpi-' + kpiKey);
        if (card) {
            card.querySelectorAll('.kpi-toggle-btn').forEach(function (btn) {
                btn.classList.toggle('active', btn.dataset.period === period);
            });
        }
    },

    /* ============================================================
       CHARTS
    ============================================================ */

    renderSalesChart(data) {
        window.destroyChart('salesChart');

        var ctx = document.getElementById('salesChart');
        if (!ctx) return;

        var weekly = data.weeklySales || [];

        window.STATE.charts.salesChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: weekly.map(function (s) { return s.day; }),
                datasets: [{
                    label: 'Ciro',
                    data: weekly.map(function (s) { return s.amount; }),
                    backgroundColor: 'rgba(52, 199, 89, 0.85)',
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function (val) { return '₺' + val.toLocaleString('tr-TR'); }
                        }
                    }
                }
            }
        });
    },

    renderExpenseChart(data) {
        window.destroyChart('expenseChart');

        var ctx = document.getElementById('expenseChart');
        if (!ctx) return;

        var cats = data.expenseCategories || [];

        if (cats.length === 0) {
            // Boş state
            ctx.parentElement.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:#94a3b8;font-size:14px;">Gider verisi bulunamadı</div>';
            return;
        }

        window.STATE.charts.expenseChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: cats.map(function (c) { return c.name; }),
                datasets: [{
                    data: cats.map(function (c) { return c.amount; }),
                    backgroundColor: cats.map(function (c) { return c.color || '#9CA3AF'; }),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, usePointStyle: true }
                    }
                }
            }
        });
    },

    /* ============================================================
       HEADER WIDGETS — Health Score + Task Count
    ============================================================ */

    updateHeaderWidgets(data) {
        // Health Score
        var healthValue = document.querySelector('.health-value');
        var healthFill = document.querySelector('.health-fill');

        if (healthValue) {
            healthValue.textContent = data.healthScore || 0;
        }

        if (healthFill) {
            healthFill.setAttribute('stroke-dasharray', (data.healthScore || 0) + ', 100');
        }

        // Task Count
        var taskCountEl = document.getElementById('taskCount');
        if (taskCountEl) {
            var count = data.taskCount || 0;
            taskCountEl.textContent = count + ' görev';
        }
    },

    /* ============================================================
       FORMAT HELPERS
    ============================================================ */

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
        var fmt = window.Formatters;
        if (fmt && typeof fmt.percent === 'function') {
            // Formatters.percent + işareti ekliyor, sadece mutlak değer istiyoruz
            return Math.abs(Number(value || 0)).toFixed(1) + '%';
        }
        return Math.abs(Number(value || 0)).toFixed(1) + '%';
    },

    safeFixed(value) {
        return Number(value || 0).toFixed(1);
    }
};
