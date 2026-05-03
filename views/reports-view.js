/* ============================================================
   REPORTS VIEW
   Sekmeli UI (Gider Analizi / Ürün Karlılık / Maliyet Değişim / Aylık Yorum)
   Gider Analizi → 4 seçilebilir KPI kartı (her biri kendi tarih filtresiyle)
   Chart.js premium render (mode toggle: Günlük / Aylık / Kategori)
   ============================================================ */

window.ReportsView = {

    /* ============================================================
       SABİTLER
       ============================================================ */
    TABS: [
        { key: 'gider',     label: 'Gider Analizi',   icon: '📊' },
        { key: 'karlilik',  label: 'Ürün Karlılık',   icon: '💹' },
        { key: 'maliyet',   label: 'Maliyet Değişim', icon: '📈' },
        { key: 'yorum',     label: 'Aylık Yorum',     icon: '🧠' }
    ],

    // Sekmeye göre dinamik KPI listesi
    TAB_KPIS: {
        gider: [
            { key: 'total',        label: 'Gider Sağlık Raporu' },
            { key: 'biggest',      label: 'En Büyük Gider' },
            { key: 'charts',       label: 'Gider Grafikleri' }
        ],
        karlilik: [
            { key: 'topProfit',    label: 'En Karlı Ürün' },
            { key: 'lowMargin',    label: 'Zayıf Marj Listesi' },
            { key: 'netProfit',    label: 'Net Kar Toplamı' }
        ],
        maliyet: [
            { key: 'costUp',       label: 'En Çok Artan' },
            { key: 'costDown',     label: 'En Çok Azalan' },
            { key: 'overallShift', label: 'Genel Maliyet Değişim' }
        ],
        yorum: []  // sadece insight/summary metni
    },

    // Geriye uyumluluk için (eski referanslar)
    KPIS: [
        { key: 'total',        label: 'Gider Sağlık Raporu' },
        { key: 'biggest',      label: 'En Büyük Gider' },
        { key: 'charts',       label: 'Gider Grafikleri' }
    ],

    PALETTE: {
        primary:   '#6366f1',
        primary2:  '#8b5cf6',
        secondary: '#3b82f6',
        accent:    '#f97316',
        positive:  '#10b981',
        danger:    '#ef4444',
        grid:      'rgba(148, 163, 184, 0.18)',
        text:      '#475569',
        muted:     '#94a3b8',
        cats: ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4']
    },

    /* ============================================================
       STATE
       ============================================================ */
    state: {
        activeTab: 'gider',
        activeKpi: 'total',
        filters: {
            total:        { startDate: '', endDate: '', category: '' },
            biggest:      { startDate: '', endDate: '' },
            charts:       { startDate: '', endDate: '', mode: 'daily' },
            distribution: { startDate: '', endDate: '' }
        },
        kpiSummary: {
            total:        { amount: 0, count: 0 },
            biggest:      { amount: 0, label: '' },
            charts:       { amount: 0, count: 0 },
            distribution: { count: 0, top: '' }
        },
        // decision state artık kullanılmıyor — strip kpiSummary'den okuyor
        decision: {},
        categories: [],
        charts: { chart: null, pie: null }
    },

    /* ============================================================
       Chart.js LAZY LOADER
       ============================================================ */
    _ensureChart: function () {
        return new Promise(function (resolve, reject) {
            if (typeof window.Chart !== 'undefined') return resolve(window.Chart);
            var existing = document.getElementById('chartjs-cdn');
            if (existing) {
                existing.addEventListener('load', function () { resolve(window.Chart); });
                existing.addEventListener('error', reject);
                return;
            }
            var s = document.createElement('script');
            s.id = 'chartjs-cdn';
            s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
            s.onload = function () { resolve(window.Chart); };
            s.onerror = reject;
            document.head.appendChild(s);
        });
    },

    /* ============================================================
       RENDER (entry)
       ============================================================ */
    render: function (container) {
        var def = this._defaultRange();
        var f = this.state.filters;
        ['total','biggest','charts','distribution'].forEach(function (k) {
            if (!f[k].startDate) f[k].startDate = def.start;
            if (!f[k].endDate)   f[k].endDate   = def.end;
        });

        // === INVALIDATION LISTENERS (sadece bir kez bağlanır) ===
        // Mutation olunca timestamp sıfırlanır + Reports sayfasındaysak ANINDA refresh
        if (!this._invalidationBound) {
            this._invalidationBound = true;
            var selfBind = this;
            var bust = function () {
                selfBind._summariesLoadedAt = 0;
                selfBind._decisionLoadedAt = 0;
                // Reports view DOM'da hâlâ duruyorsa hemen yenile (tek fetch, çift repaint)
                if (document.getElementById('reportsKpiCards') ||
                    document.getElementById('reportsDecisionStrip')) {
                    selfBind._summariesLoadedAt = Date.now();
                    selfBind._decisionLoadedAt = Date.now();
                    selfBind.loadKpiSummaries();
                }
            };
            window.addEventListener('sales:updated',    bust);
            window.addEventListener('expenses:updated', bust);
            window.addEventListener('products:updated', bust);
        }

        // Shell her zaman re-paint (router DOM'u temizliyor; inline onclick'ler sayesinde event re-bind gereksiz)
        container.innerHTML = this.renderShell();

        // === FIRST-LOAD / STALE GUARANTEE ===
        // Tek kanonik fetch: loadKpiSummaries — tamamlanınca KPI kartları + strip
        // birlikte repaint edilir (loadKpiSummaries tail'inde mevcut).
        // _summariesLoadedAt yoksa (ilk açılış) veya 60s'den eskiyse fresh fetch.
        var nowFL = Date.now();
        var summariesStale = !this._summariesLoadedAt
            || (nowFL - this._summariesLoadedAt) >= 60 * 1000;
        if (summariesStale) {
            this._summariesLoadedAt = nowFL;
            this._decisionLoadedAt = nowFL;
            this.loadKpiSummaries();   // tail: hem reportsKpiCards hem reportsDecisionStrip outerHTML
        }

        var self = this;

        // Categories — sadece boşsa fetch (cache reuse)
        if (!this.state.categories || !this.state.categories.length) {
            this._loadCategories().then(function () { self._renderCategoryOptions(); });
        } else {
            self._renderCategoryOptions();
        }

        this._ensureChart().then(function () { self._installValueLabelPlugin(); });

        // Aktif KPI panelini her zaman render et (DOM yeni)
        this.loadActiveKpi();

        // Tek path: yukarıdaki summariesStale check tüm fetch davranışını yönetiyor.
        // renderShell zaten state.kpiSummary'in mevcut snapshot'ıyla painted —
        // loadKpiSummaries tamamlanınca kartlar + strip kendi outerHTML'leri ile repaint olur.
    },

    /* ============================================================
       SHELL
       ============================================================ */
    renderShell: function () {
        return ''
            + '<div class="reports-view" style="padding:24px; max-width:1400px; margin:0 auto;">'
            +   this.renderHeader()
            +   this.renderDecisionStrip()
            +   this.renderTabBar()
            +   this.renderContent()
            + '</div>';
    },

    /* ============================================================
       BIG HEADER
       ============================================================ */
    renderHeader: function () {
        return ''
            + '<div style="margin:0 0 22px 0;">'
            + '  <h1 style="margin:0; font-size:30px; font-weight:800; color:#0f172a; letter-spacing:-0.025em;">Raporlar</h1>'
            + '  <p style="margin:6px 0 0 0; font-size:14px; color:#64748b;">İşletmenin güncel sağlık göstergeleri ve kategori bazlı analiz.</p>'
            + '</div>';
    },

    /* ============================================================
       DECISION STRIP — 3 karar-odaklı kart
       Tek kaynak: state.kpiSummary (loadKpiSummaries doldurur)
       ============================================================ */
    renderDecisionStrip: function () {
        // Sadece Gider Analizi tab'ında göster
        if (this.state.activeTab !== 'gider') {
            return '<div id="reportsDecisionStrip" style="display:none;"></div>';
        }
        var s = this.state.kpiSummary || {};
        var self = this;

        var card = function (title, big, sub, color, bg, icon) {
            return ''
                + '<div style="flex:1; min-width:240px; padding:18px 20px; border-radius:14px; '
                + '            background:' + bg + '; border:1px solid #e2e8f0; '
                + '            box-shadow:0 1px 3px rgba(15,23,42,0.04); transition:transform .15s ease, box-shadow .15s ease;" '
                + '     onmouseover="this.style.transform=\'translateY(-2px)\';this.style.boxShadow=\'0 8px 20px rgba(15,23,42,0.08)\';" '
                + '     onmouseout="this.style.transform=\'translateY(0)\';this.style.boxShadow=\'0 1px 3px rgba(15,23,42,0.04)\';">'
                + '  <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">'
                + '    <span style="font-size:18px;">' + icon + '</span>'
                + '    <span style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.05em;">' + title + '</span>'
                + '  </div>'
                + '  <div style="font-size:22px; font-weight:800; color:' + color + '; letter-spacing:-0.02em; line-height:1.1;">' + big + '</div>'
                + '  <div style="margin-top:6px; font-size:12px; color:#64748b; line-height:1.4;">' + sub + '</div>'
                + '</div>';
        };

        // 1) Toplam Gider — kpiSummary.total
        var t = s.total || { amount: 0, count: 0 };
        var totalBig = this._money(Number(t.amount || 0));
        var totalSub = (Number(t.count || 0) > 0)
            ? (Number(t.count) + ' işlem')
            : 'Veri yok';

        // 2) En Büyük Gider — kpiSummary.biggest
        var b = s.biggest || { amount: 0, label: '' };
        var bigVal = Number(b.amount || 0);
        var biggestBig = this._money(bigVal);
        var biggestSub = (bigVal > 0)
            ? (b.label ? this._esc(b.label) : 'Tek kalem')
            : 'Veri yok';
        // Renk: en büyük gider toplamın >%30'u ise risk göstergesi
        var bigShare = (Number(t.amount) > 0) ? (bigVal / Number(t.amount)) * 100 : 0;
        var biggestColor = bigShare > 30 ? '#dc2626' : (bigShare > 15 ? '#d97706' : '#0f172a');
        var biggestBg    = bigShare > 30 ? 'linear-gradient(135deg,#fef2f2 0%,#fff 60%)' : '#ffffff';

        // 3) Kayıt / Aktivite — kpiSummary.charts
        var c = s.charts || { amount: 0, count: 0 };
        var actBig = Number(c.count || 0) + ' kayıt';
        var actSub = Number(c.amount || 0) > 0
            ? this._money(Number(c.amount)) + ' toplam hareket'
            : 'Hareket yok';

        return ''
            + '<div id="reportsDecisionStrip" style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:20px;">'
            +   card('Toplam Gider',     totalBig,   totalSub,   '#0f172a',     '#ffffff', '💸')
            +   card('En Büyük Gider',   biggestBig, biggestSub, biggestColor,  biggestBg, '⚠️')
            +   card('Aktivite',         actBig,     actSub,     '#0f172a',     '#ffffff', '📊')
            + '</div>';
    },

    /* ============================================================
       DECISION STRIP — DATA LOAD
       Kendi fetch'i YOK. loadKpiSummaries'i çağırır, sonra repaint.
       Single source of truth: state.kpiSummary
       ============================================================ */
    loadDecisionStrip: async function () {
        try {
            // KPI özetleri zaten yüklü değilse yükle (aynı kaynak, çift fetch yok)
            await this.loadKpiSummaries();
            // Strip repaint
            var host = document.getElementById('reportsDecisionStrip');
            if (host) host.outerHTML = this.renderDecisionStrip();
        } catch (e) {
            console.warn('[reports] loadDecisionStrip hata', e);
            try {
                var hostErr = document.getElementById('reportsDecisionStrip');
                if (hostErr) hostErr.outerHTML = this.renderDecisionStrip();
            } catch (eRepaint) {}
        }
    },

    /* ============================================================
       TAB BAR
       ============================================================ */
    renderTabBar: function () {
        var active = this.state.activeTab;
        var html = ''
            + '<div id="reportsTabBar" style="display:flex; justify-content:center; gap:6px; '
            + '            border-bottom:1px solid #e2e8f0; margin:8px 0 28px 0; flex-wrap:wrap;">';
        this.TABS.forEach(function (t) {
            var on = (t.key === active);
            html += '<button type="button" onclick="window.ReportsView.setActiveTab(\'' + t.key + '\')" '
                  + 'style="position:relative; padding:14px 22px; background:' + (on ? '#eef2ff' : 'transparent') + '; border:none; '
                  + 'border-radius:10px 10px 0 0; '
                  + 'border-bottom:3px solid ' + (on ? '#6366f1' : 'transparent') + '; '
                  + 'color:' + (on ? '#0f172a' : '#64748b') + '; '
                  + 'font-weight:' + (on ? '800' : '600') + '; font-size:14px; cursor:pointer; '
                  + 'letter-spacing:' + (on ? '0.01em' : '0') + '; '
                  + 'transition:background 0.15s, color 0.15s, border-color 0.15s;">'
                  + '<span style="margin-right:8px;">' + t.icon + '</span>' + t.label
                  + '</button>';
        });
        html += '</div>';
        return html;
    },

    setActiveTab: function (key) {
        if (this.state.activeTab === key) return;
        this.state.activeTab = key;
        // Tab değişti → o tab'ın ilk KPI'sına otomatik geç
        var list = (this.TAB_KPIS && this.TAB_KPIS[key]) || [];
        if (list.length && !list.some(function (k) { return k.key === window.ReportsView.state.activeKpi; })) {
            this.state.activeKpi = list[0].key;
        }
        // İçerik tarafını yeniden çiz
        var container = document.getElementById('viewContainer');
        if (container) {
            container.innerHTML = this.renderShell();
            // Sadece gider tab'ında veri çek
            if (key === 'gider') {
                this.loadActiveKpi();
                this.loadKpiSummaries();
                this._renderCategoryOptions();
            }
        }
    },

    /* ============================================================
       CONTENT (tab dispatcher)
       ============================================================ */
    renderContent: function () {
        var tab = this.state.activeTab;
        var kpiCards = this.renderKpiCards();   // tab'a göre dinamik (yorum'da boş)
        var body = '';
        switch (tab) {
            case 'gider':
                body = '<div id="expenseActiveContent" style="margin-top:20px;">'
                     +   this.renderActiveExpenseView()
                     + '</div>';
                break;
            case 'karlilik':
                body = this._comingSoon('Ürün Karlılık', 'Ürün bazlı net kâr ve marj analizleri yakında.');
                break;
            case 'maliyet':
                body = this._comingSoon('Maliyet Değişim', 'Hammadde ve ürün maliyeti zaman serisi yakında.');
                break;
            case 'yorum':
                body = this._comingSoon('Aylık Yorum', 'AI destekli aylık işletme yorumu yakında.');
                break;
            default:
                body = this._comingSoon('Bilinmeyen sekme', '');
        }
        return '<div id="reportsTabContent">' + kpiCards + body + '</div>';
    },

    /* ============================================================
       KPI CARDS — 4 yatay seçilebilir kart
       ============================================================ */
    renderKpiCards: function () {
        var self = this;
        var tab = this.state.activeTab || 'gider';
        var list = (this.TAB_KPIS && this.TAB_KPIS[tab]) || [];

        // Yorum tab'ında KPI yok → boş container (DOM placeholder yerinde dursun)
        if (!list.length) {
            return '<div id="reportsKpiCards" style="display:none;"></div>';
        }

        var active = this.state.activeKpi;
        // Aktif KPI mevcut tab'da yoksa ilkine düş
        if (!list.some(function (k) { return k.key === active; })) {
            this.state.activeKpi = list[0].key;
            active = list[0].key;
        }

        var s = this.state.kpiSummary || {};
        var cards = list.map(function (k) {
            var on = (k.key === active);
            var sub = '';
            // GİDER tab'ı veri sub'ları
            if (k.key === 'total')        sub = self._money(s.total ? s.total.amount : 0) + ' · ' + (s.total ? s.total.count : 0) + ' işlem';
            else if (k.key === 'biggest') sub = self._money(s.biggest ? s.biggest.amount : 0) + (s.biggest && s.biggest.label ? ' · ' + self._esc(s.biggest.label) : '');
            else if (k.key === 'charts')  sub = self._money(s.charts ? s.charts.amount : 0) + ' · ' + (s.charts ? s.charts.count : 0) + ' kayıt';
            // Diğer tab'lar — gerçek veri henüz yok, "yakında" göster
            else                          sub = 'Yakında';

            return ''
                + '<button type="button" onclick="window.ReportsView.setActiveKpi(\'' + k.key + '\')" '
                + 'style="flex:1; min-width:200px; text-align:left; cursor:pointer; '
                + 'background:' + (on ? 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)' : '#fff') + '; '
                + 'border:1px solid ' + (on ? 'transparent' : '#e2e8f0') + '; '
                + 'border-radius:14px; padding:16px 18px; '
                + 'box-shadow:' + (on ? '0 8px 20px rgba(99,102,241,0.25)' : '0 1px 3px rgba(15,23,42,0.04)') + '; '
                + 'transition:all 0.15s; font-family:inherit;">'
                + '  <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; '
                + '              color:' + (on ? 'rgba(255,255,255,0.9)' : '#94a3b8') + '; margin-bottom:6px;">'
                +    k.label
                + '  </div>'
                + '  <div style="font-size:13px; font-weight:600; color:' + (on ? '#fff' : '#0f172a') + ';">'
                +    sub
                + '  </div>'
                + '</button>';
        }).join('');

        return '<div id="reportsKpiCards" style="display:flex; gap:12px; flex-wrap:wrap;">' + cards + '</div>';
    },

    setActiveKpi: function (key) {
        if (this.state.activeKpi === key) return;
        this.state.activeKpi = key;
        // Kartları yenile
        var host = document.getElementById('reportsKpiCards');
        if (host && host.parentElement) {
            host.outerHTML = this.renderKpiCards();
        }
        // Aktif paneli yenile
        var panel = document.getElementById('expenseActiveContent');
        if (panel) panel.innerHTML = this.renderActiveExpenseView();
        this._renderCategoryOptions();
        this.loadActiveKpi();
    },

    /* ============================================================
       ACTIVE EXPENSE VIEW (KPI detay paneli)
       ============================================================ */
    renderActiveExpenseView: function () {
        var k = this.state.activeKpi;
        switch (k) {
            case 'total':        return this._panelTotal();
            case 'biggest':      return this._panelBiggest();
            case 'charts':       return this._panelCharts();
        }
        return '';
    },

    _panelTotal: function () {
        return ''
            + '<div class="kpi-panel" style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:20px;">'
            + '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">'
            + '    <h3 style="margin:0; font-size:15px; font-weight:700; color:#0f172a;">Gider Sağlık Raporu</h3>'
            + '  </div>'
            +    this._filterBar('total', { withCategory: true })
            + '  <div id="repKpiTotal" style="margin-top:14px; min-height:80px;"></div>'
            + '</div>';
    },

    _panelBiggest: function () {
        return ''
            + '<div class="kpi-panel" style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:20px;">'
            + '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">'
            + '    <h3 style="margin:0; font-size:15px; font-weight:700; color:#0f172a;">En Büyük Gider</h3>'
            + '  </div>'
            +    this._filterBar('biggest', {})
            + '  <div id="repKpiBiggest" style="margin-top:14px; min-height:80px;"></div>'
            + '</div>';
    },

    _panelCharts: function () {
        return ''
            + '<div class="kpi-panel" style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:20px; box-shadow:0 4px 12px rgba(15,23,42,0.04);">'
            + '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:12px;">'
            + '    <h3 style="margin:0; font-size:15px; font-weight:700; color:#0f172a;">Gider Grafikleri</h3>'
            + '    <div id="repChartModeToggle">' + this._modeToggleInner() + '</div>'
            + '  </div>'
            +    this._filterBar('charts', {})
            + '  <div id="repKpiChartStatus" style="margin-top:8px; font-size:13px; color:#64748b;"></div>'
            + '  <canvas id="expenseChart" style="display:block; width:100% !important; height:340px !important; max-height:340px; margin-top:14px;"></canvas>'
            + '</div>';
    },

    _panelDistribution: function () {
        return ''
            + '<div class="kpi-panel" style="background:#fff; border:1px solid #e2e8f0; border-radius:16px; padding:20px; box-shadow:0 4px 12px rgba(15,23,42,0.04); overflow:hidden;">'
            + '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">'
            + '    <h3 style="margin:0; font-size:15px; font-weight:700; color:#0f172a;">Kategori Dağılımı</h3>'
            + '  </div>'
            +    this._filterBar('distribution', {})
            + '  <div id="repKpiPieStatus" style="margin-top:8px; font-size:13px; color:#64748b;"></div>'
            + '  <div style="display:flex; flex-wrap:wrap; gap:20px; margin-top:14px; align-items:center; overflow:hidden;">'
            + '    <div style="flex:0 0 240px;">'
            + '      <canvas id="repPieCanvas" style="display:block; width:100% !important; height:240px !important; max-height:240px;"></canvas>'
            + '    </div>'
            + '    <div id="repPieLegend" style="flex:1; min-width:260px; max-width:100%; font-size:13px;"></div>'
            + '  </div>'
            + '</div>';
    },

    _comingSoon: function (title, msg) {
        return ''
            + '<div style="background:#fff; border:1px dashed #cbd5e1; border-radius:16px; padding:48px 24px; text-align:center;">'
            + '  <div style="font-size:32px; margin-bottom:12px;">🚧</div>'
            + '  <h3 style="margin:0 0 6px 0; font-size:18px; color:#0f172a;">' + this._esc(title) + '</h3>'
            + '  <p style="margin:0; color:#64748b; font-size:14px;">' + this._esc(msg) + '</p>'
            + '</div>';
    },

    /* ============================================================
       MODE TOGGLE (charts paneli için)
       ============================================================ */
    _modeToggleInner: function () {
        var m = this.state.filters.charts.mode;
        var btn = function (key, label) {
            var on = (m === key);
            return '<button type="button" onclick="window.ReportsView.setChartMode(\'' + key + '\')" '
                + 'style="padding:6px 14px; font-size:12px; font-weight:600; border:none; cursor:pointer; '
                + 'background:' + (on ? 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)' : '#f1f5f9') + '; '
                + 'color:' + (on ? '#fff' : '#475569') + '; transition:all 0.2s;">' + label + '</button>';
        };
        return ''
            + '<div style="display:inline-flex; border-radius:10px; overflow:hidden; border:1px solid #e2e8f0;">'
            +   btn('daily',    'Günlük')
            +   btn('monthly',  'Aylık')
            +   btn('category', 'Kategori')
            + '</div>';
    },

    setChartMode: function (mode) {
        if (['daily','monthly','category'].indexOf(mode) === -1) return;
        if(window.__DEBUG__)console.log('[reports] setChartMode →', mode);
        this.state.filters.charts.mode = mode;
        var host = document.getElementById('repChartModeToggle');
        if (host) host.innerHTML = this._modeToggleInner();
        this.loadChart();
    },

    /* ============================================================
       FILTER BAR
       ============================================================ */
    _filterBar: function (key, opts) {
        var f = this.state.filters[key];
        var html = ''
            + '<div style="display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end;">'
            + '  <div>'
            + '    <label style="display:block; font-size:11px; color:#64748b; font-weight:600; margin-bottom:4px;">Başlangıç</label>'
            + '    <input type="date" value="' + this._esc(f.startDate) + '" '
            + '           onchange="window.ReportsView.handleFilterChange(\'' + key + '\', \'startDate\', this.value)" '
            + '           style="padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; background:#f8fafc;">'
            + '  </div>'
            + '  <div>'
            + '    <label style="display:block; font-size:11px; color:#64748b; font-weight:600; margin-bottom:4px;">Bitiş</label>'
            + '    <input type="date" value="' + this._esc(f.endDate) + '" '
            + '           onchange="window.ReportsView.handleFilterChange(\'' + key + '\', \'endDate\', this.value)" '
            + '           style="padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; background:#f8fafc;">'
            + '  </div>';

        if (opts && opts.withCategory) {
            html += ''
                + '  <div style="flex:1; min-width:140px;">'
                + '    <label style="display:block; font-size:11px; color:#64748b; font-weight:600; margin-bottom:4px;">Kategori</label>'
                + '    <select id="repCatSelect_' + key + '" '
                + '            onchange="window.ReportsView.handleFilterChange(\'' + key + '\', \'category\', this.value)" '
                + '            style="width:100%; padding:7px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:13px; font-family:inherit; background:#f8fafc;">'
                + '      <option value="">Tümü</option>'
                + '    </select>'
                + '  </div>';
        }

        html += '</div>';
        return html;
    },

    handleFilterChange: function (key, field, value) {
        if (!this.state.filters[key]) return;
        this.state.filters[key][field] = value || '';
        this.loadKpi(key);

        // Decision strip total filter'a bağlı — total değiştiğinde stripi de yenile
        if (key === 'total' && (field === 'startDate' || field === 'endDate')) {
            this._decisionLoadedAt = 0;
            this.loadDecisionStrip();
            this._decisionLoadedAt = Date.now();
        }
    },

    /* ============================================================
       KPI LOAD DISPATCHER
       ============================================================ */
    loadActiveKpi: function () {
        this.loadKpi(this.state.activeKpi);
    },

    loadKpi: function (key) {
        switch (key) {
            case 'total':        this.loadTotal(); break;
            case 'biggest':      this.loadBiggest(); break;
            case 'charts':       this.loadChart(); break;
            case 'distribution': this.loadPie(); break;
        }
    },

    // Üst kartların özetlerini doldur
    loadKpiSummaries: async function () {
        var self = this;
        try {
            var f = this.state.filters;

            // total — önce hepsini çek, sonra client-side kategori filtresi
            var totalAll = (await this._fetchExpenses(f.total.startDate, f.total.endDate)).data;
            if(window.__DEBUG__)console.log('KPI total rows:', totalAll.length);
            var totalRows = totalAll;
            if (f.total.category) totalRows = totalAll.filter(function (r) { return r.category_id === f.total.category; });
            this.state.kpiSummary.total = {
                amount: totalRows.reduce(function (s, r) { return s + Number(r.amount || 0); }, 0),
                count: totalRows.length
            };

            // biggest
            var bigRows = (await this._fetchExpenses(f.biggest.startDate, f.biggest.endDate)).data;
            var top = bigRows.slice().sort(function (a, b) { return Number(b.amount || 0) - Number(a.amount || 0); })[0];
            this.state.kpiSummary.biggest = top ? {
                amount: Number(top.amount || 0),
                label: top.description || ((top.categories && top.categories.name) || top.category_name || '')
            } : { amount: 0, label: '' };

            // charts
            var chartRows = (await this._fetchExpenses(f.charts.startDate, f.charts.endDate)).data;
            this.state.kpiSummary.charts = {
                amount: chartRows.reduce(function (s, r) { return s + Number(r.amount || 0); }, 0),
                count: chartRows.length
            };

            // distribution
            var distRows = (await this._fetchExpenses(f.distribution.startDate, f.distribution.endDate)).data;
            var byCat = {};
            distRows.forEach(function (r) {
                var name = (r.categories && r.categories.name) || r.category_name || 'Diğer';
                byCat[name] = (byCat[name] || 0) + Number(r.amount || 0);
            });
            var keys = Object.keys(byCat);
            var topCat = keys.sort(function (a, b) { return byCat[b] - byCat[a]; })[0] || '';
            this.state.kpiSummary.distribution = { count: keys.length, top: topCat };

            // Kartları yenile (KPI cards + decision strip — aynı kaynaktan)
            var host = document.getElementById('reportsKpiCards');
            if (host) host.outerHTML = this.renderKpiCards();
            var stripHost = document.getElementById('reportsDecisionStrip');
            if (stripHost) stripHost.outerHTML = this.renderDecisionStrip();
        } catch (e) {
            console.error('[reports] loadKpiSummaries hata', e);
        }
    },

    /* ============================================================
       CATEGORIES
       ============================================================ */
    _loadCategories: async function () {
        try {
            var client = window.SupabaseService && window.SupabaseService.getClient && window.SupabaseService.getClient();
            if (!client) { this.state.categories = []; return; }
            var res = await client.from('categories').select('id, name, color, type').order('name', { ascending: true });
            if (res.error) { this.state.categories = []; return; }
            this.state.categories = (res.data || []).filter(function (c) {
                return !c.type || c.type === 'expense' || c.type === 'gider';
            });
        } catch (e) { this.state.categories = []; }
    },

    _renderCategoryOptions: function () {
        var sel = document.getElementById('repCatSelect_total');
        if (!sel) return;
        var current = this.state.filters.total.category || '';
        var html = '<option value="">Tümü</option>';
        (this.state.categories || []).forEach(function (c) {
            html += '<option value="' + this._esc(c.id) + '"' + (current === c.id ? ' selected' : '') + '>' + this._esc(c.name) + '</option>';
        }, this);
        sel.innerHTML = html;
    },

    _fetchExpenses: async function (startDate, endDate) {
        if (!window.ExpensesService || typeof window.ExpensesService.getByDateRange !== 'function') {
            console.warn('[reports] ExpensesService.getByDateRange yok');
            return { data: [], count: 0 };
        }
        // SADECE tarih + sayfalama gönderilir. Kategori parametresi ASLA gönderilmez.
        if(window.__DEBUG__)console.log('[reports] _fetchExpenses → start=' + startDate + ' end=' + endDate);
        var res = await window.ExpensesService.getByDateRange(startDate, endDate, {
            page: 1, pageSize: 1000, ascending: true
        });
        var data = res && res.data ? res.data : [];
        if(window.__DEBUG__)console.log('[reports] _fetchExpenses ← rows=' + data.length);
        return { data: data, count: res.count || data.length };
    },

    /* ============================================================
       KPI 1 — TOPLAM
       ============================================================ */
    loadTotal: async function () {
        var f = this.state.filters.total;
        var box = document.getElementById('repKpiTotal');
        if (!box) return;
        box.innerHTML = '<div style="color:#94a3b8; font-size:13px;">Yükleniyor...</div>';
        try {
            // 1) Gider — TÜM veriyi çek, kategori parametresi gönderilmez
            var allRows = (await this._fetchExpenses(f.startDate, f.endDate)).data;
            if(window.__DEBUG__)console.log('KPI total rows:', allRows.length);

            // 2) Kategori filtresi SADECE client-side
            var rows = allRows;
            if (f.category) {
                rows = allRows.filter(function (r) { return r.category_id === f.category; });
                if(window.__DEBUG__)console.log('KPI total rows after category filter:', rows.length, 'cat=', f.category);
            }
            if(window.__DEBUG__)console.log('TOTAL ROWS:', rows.length);

            // 3) Satış verisi — sağlık skorunda oran için
            var sales = await this._fetchSales(f.startDate, f.endDate);
            if(window.__DEBUG__)console.log('SALES ROWS:', sales.length);

            // 4) Davranış skor analizi
            var hr = this._computeHealthReport(rows, sales);

            // 5) Render — sağlık raporu + akıllı kategori önerisi + işlem tablosu
            box.innerHTML = this._renderHealthReport(hr)
                          + this._renderCategorySuggestions(rows)
                          + this._renderTotalTable(rows);

            this.state.kpiSummary.total = { amount: hr.totalExpense, count: rows.length };
            var host = document.getElementById('reportsKpiCards');
            if (host) host.outerHTML = this.renderKpiCards();
        } catch (e) {
            console.error('[reports] loadTotal hata', e);
            box.innerHTML = '<div style="color:#dc2626; font-size:13px;">Hata: ' + this._esc(e.message || e) + '</div>';
        }
    },

    /* ============================================================
       SATIŞ FETCH (Sağlık Skoru için)
       ============================================================ */
    _fetchSales: async function (startDate, endDate) {
        try {
            if (!window.SalesService || typeof window.SalesService.getByDateRange !== 'function') {
                console.warn('[reports] SalesService.getByDateRange yok');
                return [];
            }
            var res = await window.SalesService.getByDateRange(startDate, endDate, {
                page: 1, pageSize: 1000, ascending: true
            });
            return (res && res.data) ? res.data : [];
        } catch (e) {
            console.warn('[reports] _fetchSales hata', e);
            return [];
        }
    },

    /* ============================================================
       SAĞLIK RAPORU — davranış analizi
       ============================================================ */
    _computeHealthReport: function (rows, sales) {
        var num = function (x) { return Number(x || 0); };

        // Temel toplam
        var totalExpense = rows.reduce(function (s, r) { return s + num(r.amount); }, 0);
        var totalRevenue = sales.reduce(function (s, r) {
            return s + num(r.total_amount != null ? r.total_amount : (r.amount != null ? r.amount : (r.total != null ? r.total : 0)));
        }, 0);
        var expenseRatio = totalRevenue > 0 ? (totalExpense / totalRevenue) : (totalExpense > 0 ? 1.5 : 0);

        // Günlük seriler
        var byDay = {};
        rows.forEach(function (r) {
            var d = String(r.date || '').slice(0, 10);
            if (!d) return;
            byDay[d] = (byDay[d] || 0) + num(r.amount);
        });

        var today = new Date();
        var dayKey = function (offset) {
            var d = new Date(today);
            d.setDate(d.getDate() - offset);
            var y = d.getFullYear();
            var m = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            return y + '-' + m + '-' + dd;
        };
        var seriesFor = function (start, end) {
            var arr = [];
            for (var i = start; i < end; i++) arr.push(byDay[dayKey(i)] || 0);
            return arr;
        };
        var sum = function (a) { return a.reduce(function (s, v) { return s + v; }, 0); };
        var mean = function (a) { return a.length ? sum(a) / a.length : 0; };
        var stddev = function (a) {
            if (a.length < 2) return 0;
            var m = mean(a);
            var v = a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length;
            return Math.sqrt(v);
        };

        var last7Arr = seriesFor(0, 7);
        var prev7Arr = seriesFor(7, 14);
        var last30Arr = seriesFor(0, 30);

        var last7 = sum(last7Arr);
        var prev7 = sum(prev7Arr);
        var avg30 = mean(last30Arr);
        var avgLast7 = mean(last7Arr);

        // Trend (son 7 vs önceki 7) — % değişim
        var trendPct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : (last7 > 0 ? 100 : 0);

        // Volatility (std / mean)
        var sd30 = stddev(last30Arr);
        var cv = avg30 > 0 ? (sd30 / avg30) : 0;

        // Consistency: son 7 ortalaması vs 30 günlük ortalama
        var consistencyDev = avg30 > 0 ? Math.abs(avgLast7 - avg30) / avg30 : 0;

        // Kategori yoğunlaşma
        var cs = this._categorySummary(rows);
        var topCat = cs.list[0] || { name: '-', total: 0, pct: 0, color: '#94a3b8' };

        // ----- RİSK PUANLARI -----
        var ratioRisk = Math.max(0, Math.min(40, expenseRatio * 40)); // 100% → 40 puan
        var trendRisk = 0;
        if (trendPct > 0) {
            trendRisk = Math.min(20, (trendPct / 50) * 20); // %50 artış → 20 puan
        }
        var volatilityRisk = Math.min(15, cv * 15); // cv=1 → 15 puan
        var concentrationRisk = 0;
        if (topCat.pct > 70) concentrationRisk = 15;
        else if (topCat.pct > 50) concentrationRisk = 8;
        else if (topCat.pct > 35) concentrationRisk = 4;

        var score = 100 - ratioRisk - trendRisk - volatilityRisk - concentrationRisk;
        score = Math.max(0, Math.min(100, Math.round(score)));

        var level, levelColor, levelBg;
        if (score < 40)      { level = 'KRİTİK'; levelColor = '#dc2626'; levelBg = '#fef2f2'; }
        else if (score < 70) { level = 'ORTA';   levelColor = '#d97706'; levelBg = '#fffbeb'; }
        else                 { level = 'İYİ';    levelColor = '#059669'; levelBg = '#ecfdf5'; }

        // ----- AKILLI YORUM -----
        var notes = [];
        if (expenseRatio > 0.7)      notes.push('Giderlerin ciroya oranı sağlıksız seviyede (≈ ' + Math.round(expenseRatio * 100) + '%). Kâr marjı baskı altında.');
        else if (expenseRatio > 0.5) notes.push('Gider/ciro oranı (≈ ' + Math.round(expenseRatio * 100) + '%) izlenmesi gereken seviyede.');

        if (trendPct > 25)           notes.push('Son 7 günde gider artışı hızlanmış (önceki haftaya göre +' + Math.round(trendPct) + '%).');
        else if (trendPct > 10)      notes.push('Son haftada gider hafif yükselişte (+' + Math.round(trendPct) + '%).');
        else if (trendPct < -10)     notes.push('Son haftada gider düşüşte (' + Math.round(trendPct) + '%) — pozitif sinyal.');

        if (cv > 0.8)                notes.push('Günlük giderlerde yüksek dalgalanma var, kontrol zor.');
        else if (cv > 0.5)           notes.push('Gider akışında orta düzey dalgalanma görülüyor.');

        if (topCat.pct > 70)         notes.push('Giderler tek kategoriye (' + topCat.name + ', %' + Math.round(topCat.pct) + ') bağımlı — risk yüksek.');
        else if (topCat.pct > 50)    notes.push('Giderlerin yarıdan fazlası "' + topCat.name + '" kategorisinde yoğunlaşmış.');

        if (consistencyDev > 0.4)    notes.push('Son haftanın ortalaması, 30 günlük ortalamadan belirgin sapıyor.');

        if (notes.length === 0)      notes.push('Gider yapısı dengeli ve kontrol altında. Trend, dağılım ve istikrar göstergeleri sağlıklı.');

        return {
            score: score,
            level: level,
            levelColor: levelColor,
            levelBg: levelBg,
            totalExpense: totalExpense,
            totalRevenue: totalRevenue,
            expenseRatio: expenseRatio,
            last7: last7,
            prev7: prev7,
            trendPct: trendPct,
            avg30: avg30,
            cv: cv,
            consistencyDev: consistencyDev,
            topCat: topCat,
            risks: {
                ratio: ratioRisk, trend: trendRisk,
                volatility: volatilityRisk, concentration: concentrationRisk
            },
            notes: notes
        };
    },

    _renderHealthReport: function (hr) {
        var trendArrow = hr.trendPct > 1 ? '▲' : (hr.trendPct < -1 ? '▼' : '■');
        var trendColor = hr.trendPct > 10 ? '#dc2626' : (hr.trendPct < -10 ? '#059669' : '#64748b');
        var concColor  = hr.topCat.pct > 70 ? '#dc2626' : (hr.topCat.pct > 50 ? '#d97706' : '#059669');
        var ratioColor = hr.expenseRatio > 0.7 ? '#dc2626' : (hr.expenseRatio > 0.5 ? '#d97706' : '#059669');

        var ratioPct = (hr.expenseRatio * 100);
        var ratioTxt = isFinite(ratioPct) ? Math.round(ratioPct) + '%' : '-';

        var notesHtml = '';
        hr.notes.forEach(function (n) {
            notesHtml += '<div style="display:flex; gap:8px; margin-bottom:6px; align-items:flex-start;">'
                       + '  <span style="color:#6366f1; font-weight:800; line-height:1.4;">›</span>'
                       + '  <span style="flex:1; color:#334155; line-height:1.5;">' + this._esc(n) + '</span>'
                       + '</div>';
        }, this);

        return ''
            // ÜST — skor + durum
            + '<div style="display:flex; gap:20px; align-items:center; flex-wrap:wrap; padding:18px 20px; '
            + '            background:linear-gradient(135deg,' + hr.levelBg + ' 0%,#ffffff 100%); '
            + '            border:1px solid #e2e8f0; border-radius:14px; margin-bottom:14px;">'
            + '  <div style="flex:0 0 auto; width:120px; height:120px; border-radius:50%; '
            + '              background:conic-gradient(' + hr.levelColor + ' ' + (hr.score * 3.6) + 'deg, #f1f5f9 0deg); '
            + '              display:flex; align-items:center; justify-content:center; position:relative;">'
            + '    <div style="width:96px; height:96px; border-radius:50%; background:#fff; '
            + '                display:flex; flex-direction:column; align-items:center; justify-content:center;">'
            + '      <div style="font-size:34px; font-weight:800; color:#0f172a; line-height:1;">' + hr.score + '</div>'
            + '      <div style="font-size:10px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.08em; margin-top:2px;">SKOR</div>'
            + '    </div>'
            + '  </div>'
            + '  <div style="flex:1; min-width:200px;">'
            + '    <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em;">Durum</div>'
            + '    <div style="display:inline-block; margin-top:4px; padding:6px 14px; border-radius:8px; '
            + '                background:' + hr.levelColor + '; color:#fff; font-weight:800; font-size:14px; letter-spacing:0.05em;">'
            + '      ' + hr.level
            + '    </div>'
            + '    <div style="margin-top:10px; font-size:13px; color:#475569; line-height:1.5;">'
            + '      Toplam gider <b style="color:#0f172a;">' + this._money(hr.totalExpense) + '</b>'
            + (hr.totalRevenue > 0 ? ' · Ciro <b style="color:#0f172a;">' + this._money(hr.totalRevenue) + '</b>' : ' · Ciro verisi yok')
            + '    </div>'
            + '  </div>'
            + '</div>'

            // ALT — 3 metrik
            + '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:14px;">'
            + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">'
            + '    <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">Gider/Ciro Oranı</div>'
            + '    <div style="font-size:22px; font-weight:800; color:' + ratioColor + ';">' + ratioTxt + '</div>'
            + '    <div style="font-size:11px; color:#64748b; margin-top:2px;">' + (hr.totalRevenue > 0 ? 'Cironun yüzdesi' : 'Ciro verisi yok') + '</div>'
            + '  </div>'
            + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">'
            + '    <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">Trend (7g → 7g)</div>'
            + '    <div style="font-size:22px; font-weight:800; color:' + trendColor + ';">'
            + '      <span style="margin-right:4px;">' + trendArrow + '</span>'
            + '      ' + (isFinite(hr.trendPct) ? (hr.trendPct > 0 ? '+' : '') + Math.round(hr.trendPct) + '%' : '-')
            + '    </div>'
            + '    <div style="font-size:11px; color:#64748b; margin-top:2px;">Önceki haftaya göre değişim</div>'
            + '  </div>'
            + '  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">'
            + '    <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px;">Yoğunlaşma</div>'
            + '    <div style="font-size:22px; font-weight:800; color:' + concColor + ';">' + Math.round(hr.topCat.pct) + '%</div>'
            + '    <div style="font-size:11px; color:#64748b; margin-top:2px;">En büyük kategori: ' + this._esc(hr.topCat.name) + '</div>'
            + '  </div>'
            + '</div>'

            // AKILLI YORUM
            + '<div style="background:linear-gradient(135deg,#f8fafc 0%,#fff 100%); border:1px solid #e2e8f0; border-radius:14px; padding:16px 18px;">'
            + '  <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">'
            + '    <span style="font-size:14px;">🧠</span>'
            + '    <span style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; letter-spacing:0.05em;">Akıllı Yorum</span>'
            + '  </div>'
            +    notesHtml
            + '</div>';
    },

    /* ============================================================
       AKILLI KATEGORİ ÖNERİ SİSTEMİ — sadece KPI 1 için
       "Diğer" kategorisindeki gider description'larını analiz edip
       uygun kategori önerisi sunar
       ============================================================ */
    _SUGGEST_KEYWORDS: {
        'internet':  'İnternet',
        'wifi':      'İnternet',
        'su':        'Su',
        'elektrik':  'Elektrik',
        'doğalgaz':  'Doğalgaz',
        'dogalgaz':  'Doğalgaz',
        'maaş':      'Personel',
        'maas':      'Personel',
        'personel':  'Personel',
        'reklam':    'Pazarlama',
        'facebook':  'Pazarlama',
        'instagram': 'Pazarlama',
        'tamir':     'Bakım',
        'onarım':    'Bakım',
        'onarim':    'Bakım',
        'kira':      'Kira'
    },

    _generateCategorySuggestions: function (rows) {
        if (!rows || !rows.length) return [];
        // Performans guard
        var data = rows.length > 1000 ? rows.slice(0, 1000) : rows;

        // Sadece "Diğer" kategorisindekileri al
        var others = data.filter(function (r) {
            var name = (r && r.categories && r.categories.name) || (r && r.category_name) || '';
            return String(name).toLowerCase() === 'diğer' || String(name).toLowerCase() === 'diger';
        });
        if (!others.length) return [];

        var map = this._SUGGEST_KEYWORDS;
        var keys = Object.keys(map);
        var groups = {};

        others.forEach(function (r) {
            if (!r) return;
            var desc = String(r.description == null ? '' : r.description).toLowerCase();
            if (!desc) return;
            for (var i = 0; i < keys.length; i++) {
                var kw = keys[i];
                if (desc.indexOf(kw) !== -1) {
                    var cat = map[kw];
                    if (!groups[cat]) groups[cat] = { name: cat, count: 0, total: 0 };
                    groups[cat].count += 1;
                    groups[cat].total += Number(r.amount || 0);
                    break; // ilk eşleşmede dur
                }
            }
        });

        return Object.keys(groups)
            .map(function (k) { return groups[k]; })
            .sort(function (a, b) { return b.total - a.total; });
    },

    moveToCategory: function (catName) {
        // Şimdilik sadece log — ileride gerçek taşıma akışı bağlanacak
        if(window.__DEBUG__)console.log('[reports] moveToCategory →', catName);
        try {
            if (window.toast && typeof window.toast.info === 'function') {
                window.toast.info('"' + catName + '" kategorisine taşıma yakında.');
            }
        } catch (e) {}
    },

    _renderCategorySuggestions: function (rows) {
        // Sadece "Diğer" pay > %50 ise göster
        var cs = this._categorySummary(rows);
        var diger = (cs.list || []).filter(function (c) {
            return String(c.name).toLowerCase() === 'diğer' || String(c.name).toLowerCase() === 'diger';
        })[0];
        if (!diger || diger.pct < 50) return '';

        var sug = this._generateCategorySuggestions(rows);
        if (!sug.length) return '';

        var self = this;
        var items = sug.map(function (s) {
            var safeName = self._esc(s.name).replace(/'/g, '&#39;');
            return ''
                + '<div style="display:flex; align-items:center; gap:12px; padding:12px 14px; '
                + '            border:1px solid #e2e8f0; border-radius:10px; background:#fff; margin-bottom:8px;">'
                + '  <div style="flex:1; min-width:0;">'
                + '    <div style="font-size:14px; font-weight:700; color:#0f172a;">' + self._esc(s.name) + '</div>'
                + '    <div style="font-size:12px; color:#64748b; margin-top:2px;">'
                + '      ' + s.count + ' kayıt · ' + self._money(s.total)
                + '    </div>'
                + '  </div>'
                + '  <button type="button" '
                + '          onclick="window.ReportsView.moveToCategory(\'' + safeName + '\')" '
                + '          style="padding:8px 14px; background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%); '
                + '                 color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:700; '
                + '                 cursor:pointer; font-family:inherit; white-space:nowrap;">'
                + '    Kategoriye Taşı'
                + '  </button>'
                + '</div>';
        }).join('');

        return ''
            + '<div style="background:linear-gradient(135deg,#fef3c7 0%,#fff 100%); '
            + '            border:1px solid #fcd34d; border-radius:14px; padding:16px 18px; margin-top:14px;">'
            + '  <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">'
            + '    <span style="font-size:16px;">🧠</span>'
            + '    <span style="font-size:13px; font-weight:800; color:#92400e; text-transform:uppercase; letter-spacing:0.05em;">'
            + '      Akıllı Kategori Önerisi'
            + '    </span>'
            + '  </div>'
            + '  <div style="font-size:12px; color:#78350f; margin-bottom:12px; line-height:1.5;">'
            + '    "Diğer" kategorisi giderlerin %' + Math.round(diger.pct) + '\'ini oluşturuyor. '
            + '    Açıklamalardan ' + sug.length + ' olası kategori tespit edildi:'
            + '  </div>'
            +    items
            + '</div>';
    },

    /* ============================================================
       KPI 2 — EN BÜYÜK
       ============================================================ */
    loadBiggest: async function () {
        var f = this.state.filters.biggest;
        var box = document.getElementById('repKpiBiggest');
        if (!box) return;
        box.innerHTML = '<div style="color:#94a3b8; font-size:13px;">Yükleniyor...</div>';
        try {
            var rows = (await this._fetchExpenses(f.startDate, f.endDate)).data;
            if(window.__DEBUG__)console.log('BIGGEST ROWS:', rows.length);
            if (!rows.length) {
                box.innerHTML = '<div style="color:#94a3b8; font-size:13px;">Bu aralıkta kayıt yok.</div>';
                this.state.kpiSummary.biggest = { amount: 0, label: '' };
                return;
            }
            var sorted = this._sortByAmountDesc(rows);
            var top = sorted[0];
            var top5 = sorted.slice(0, 5);
            var catSum = this._categorySummary(rows);
            var top3Cats = catSum.list.slice(0, 3);
            var self = this;

            var topCatName = (top.categories && top.categories.name) || top.category_name || '-';
            var grandTotal = catSum.total || rows.reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);
            var topShare = grandTotal > 0 ? (Number(top.amount || 0) / grandTotal) * 100 : 0;

            // === HERO CARD ===
            var heroHtml = ''
                + '<div style="position:relative; display:flex; align-items:center; gap:24px; flex-wrap:wrap; '
                + '            padding:28px 32px; border-radius:18px; '
                + '            background:linear-gradient(135deg,#312e81 0%,#6366f1 55%,#8b5cf6 100%); '
                + '            box-shadow:0 18px 40px rgba(99,102,241,0.30), 0 4px 12px rgba(15,23,42,0.10); '
                + '            color:#fff; overflow:hidden;">'
                + '  <div style="position:absolute; top:-60px; right:-60px; width:220px; height:220px; '
                + '              background:radial-gradient(circle, rgba(255,255,255,0.18) 0%, transparent 70%); '
                + '              pointer-events:none;"></div>'
                + '  <div style="flex:1; min-width:240px; position:relative;">'
                + '    <div style="font-size:11px; font-weight:700; color:rgba(255,255,255,0.7); '
                + '                text-transform:uppercase; letter-spacing:0.08em; margin-bottom:8px;">En Büyük Tek Gider</div>'
                + '    <div style="font-size:42px; font-weight:800; line-height:1.1; letter-spacing:-0.02em; margin-bottom:10px;">'
                + '      ' + this._money(top.amount)
                + '    </div>'
                + '    <div style="font-size:15px; font-weight:600; color:#fff; margin-bottom:8px; line-height:1.4;">'
                + '      ' + this._esc(top.description || '(Açıklama yok)')
                + '    </div>'
                + '    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">'
                + '      <span style="background:rgba(255,255,255,0.18); backdrop-filter:blur(6px); '
                + '                   padding:5px 12px; border-radius:20px; font-size:12px; font-weight:600;">'
                + '        ' + this._esc(topCatName)
                + '      </span>'
                + '      <span style="color:rgba(255,255,255,0.75); font-size:12px;">' + this._esc(this._formatDate(top.date)) + '</span>'
                + '    </div>'
                + '  </div>'
                + '  <div style="flex:0 0 auto; position:relative;">'
                + '    <div style="width:130px; height:130px; border-radius:50%; '
                + '                background:conic-gradient(#fff ' + (topShare * 3.6) + 'deg, rgba(255,255,255,0.18) 0deg); '
                + '                display:flex; align-items:center; justify-content:center;">'
                + '      <div style="width:104px; height:104px; border-radius:50%; '
                + '                  background:linear-gradient(135deg,#312e81 0%,#6366f1 100%); '
                + '                  display:flex; flex-direction:column; align-items:center; justify-content:center;">'
                + '        <div style="font-size:24px; font-weight:800; line-height:1;">' + topShare.toFixed(1) + '%</div>'
                + '        <div style="font-size:9px; font-weight:700; color:rgba(255,255,255,0.7); '
                + '                    text-transform:uppercase; letter-spacing:0.1em; margin-top:4px;">PAY</div>'
                + '      </div>'
                + '    </div>'
                + '  </div>'
                + '</div>'
                // Micro detail
                + '<div style="margin-top:12px; padding:0 4px; font-size:13px; color:#64748b;">'
                + '  Toplam giderin <b style="color:#0f172a;">%' + topShare.toFixed(1) + '</b>\'i bu kalemden geliyor.'
                + '</div>';

            // === TOP 5 — MODERN CARD LIST ===
            var top5Html = ''
                + '<div style="margin-top:28px;">'
                + '  <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; '
                + '              letter-spacing:0.06em; margin-bottom:12px;">Top 5 Gider</div>';
            top5.forEach(function (r, i) {
                var cn = (r.categories && r.categories.name) || r.category_name || '-';
                var ccolor = (r.categories && r.categories.color) || self.PALETTE.cats[i % self.PALETTE.cats.length];
                top5Html += ''
                    + '<div onmouseover="this.style.transform=\'translateY(-2px)\'; this.style.boxShadow=\'0 12px 28px rgba(15,23,42,0.10)\';" '
                    + '     onmouseout="this.style.transform=\'translateY(0)\'; this.style.boxShadow=\'0 1px 3px rgba(15,23,42,0.04)\';" '
                    + '     style="display:flex; align-items:center; gap:14px; padding:16px 18px; margin-bottom:10px; '
                    + '            background:#fff; border-radius:14px; box-shadow:0 1px 3px rgba(15,23,42,0.04); '
                    + '            transition:transform 0.18s ease, box-shadow 0.18s ease; cursor:default;">'
                    + '  <div style="flex:0 0 4px; align-self:stretch; background:' + ccolor + '; border-radius:4px;"></div>'
                    + '  <div style="flex:1; min-width:0;">'
                    + '    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">'
                    + '      <span style="background:' + ccolor + '15; color:' + ccolor + '; '
                    + '                   padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">'
                    + '        ' + self._esc(cn)
                    + '      </span>'
                    + '      <span style="font-size:14px; color:#0f172a; font-weight:600; flex:1; min-width:0; '
                    + '                   overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">'
                    + '        ' + self._esc(r.description || '(Açıklama yok)')
                    + '      </span>'
                    + '    </div>'
                    + '    <div style="font-size:11px; color:#94a3b8; font-weight:500;">'
                    + '      ' + self._esc(self._formatDate(r.date))
                    + '    </div>'
                    + '  </div>'
                    + '  <div style="flex:0 0 auto; font-size:18px; font-weight:800; color:#dc2626; letter-spacing:-0.01em;">'
                    + '    ' + self._money(r.amount)
                    + '  </div>'
                    + '</div>';
            });
            top5Html += '</div>';

            // === İLK 3 KATEGORİ — VISUAL CARDS ===
            var top3Html = ''
                + '<div style="margin-top:28px;">'
                + '  <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; '
                + '              letter-spacing:0.06em; margin-bottom:12px;">İlk 3 Kategori</div>'
                + '  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px;">';
            top3Cats.forEach(function (c) {
                var pctW = Math.max(2, c.pct).toFixed(1);
                top3Html += ''
                    + '<div style="position:relative; padding:18px 20px; border-radius:16px; '
                    + '            background:linear-gradient(135deg,' + c.color + '12 0%,#ffffff 60%); '
                    + '            box-shadow:0 4px 14px rgba(15,23,42,0.05); overflow:hidden;">'
                    + '  <div style="position:absolute; top:0; left:0; width:4px; height:100%; '
                    + '              background:linear-gradient(180deg,' + c.color + ' 0%, transparent 100%);"></div>'
                    + '  <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">'
                    + '    <span style="width:10px; height:10px; border-radius:50%; background:' + c.color + '; '
                    + '                 box-shadow:0 0 0 3px ' + c.color + '22;"></span>'
                    + '    <span style="font-size:13px; font-weight:700; color:#0f172a;">' + self._esc(c.name) + '</span>'
                    + '  </div>'
                    + '  <div style="font-size:24px; font-weight:800; color:#0f172a; letter-spacing:-0.02em; margin-bottom:10px;">'
                    + '    ' + self._money(c.total)
                    + '  </div>'
                    + '  <div style="height:6px; background:#f1f5f9; border-radius:6px; overflow:hidden; margin-bottom:6px;">'
                    + '    <div style="width:' + pctW + '%; height:100%; '
                    + '                background:linear-gradient(90deg,' + c.color + ' 0%,' + c.color + 'cc 100%); '
                    + '                border-radius:6px; transition:width 0.6s ease;"></div>'
                    + '  </div>'
                    + '  <div style="font-size:11px; font-weight:600; color:#64748b;">' + c.pct.toFixed(1) + '% pay</div>'
                    + '</div>';
            });
            top3Html += '</div></div>';

            // === KATEGORİ ÖZETİ — PREMIUM PROGRESS ===
            var barHtml = ''
                + '<div style="margin-top:28px;">'
                + '  <div style="font-size:12px; font-weight:800; color:#475569; text-transform:uppercase; '
                + '              letter-spacing:0.06em; margin-bottom:12px;">Kategori Özeti</div>'
                + '  <div style="background:#fff; padding:18px 20px; border-radius:14px; box-shadow:0 1px 3px rgba(15,23,42,0.04);">';
            catSum.list.forEach(function (c) {
                var pctW = Math.max(2, c.pct).toFixed(1);
                barHtml += ''
                    + '<div style="margin-bottom:14px;">'
                    + '  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">'
                    + '    <div style="display:flex; align-items:center; gap:8px;">'
                    + '      <span style="width:10px; height:10px; border-radius:50%; background:' + c.color + '; '
                    + '                   box-shadow:0 0 0 3px ' + c.color + '22;"></span>'
                    + '      <span style="font-size:13px; font-weight:700; color:#0f172a;">' + self._esc(c.name) + '</span>'
                    + '    </div>'
                    + '    <div style="font-size:13px; color:#0f172a; font-weight:700;">'
                    + '      ' + self._money(c.total)
                    + '      <span style="color:#94a3b8; font-weight:600; margin-left:6px;">(' + c.pct.toFixed(1) + '%)</span>'
                    + '    </div>'
                    + '  </div>'
                    + '  <div style="height:10px; background:#f1f5f9; border-radius:8px; overflow:hidden; '
                    + '              box-shadow:inset 0 1px 2px rgba(15,23,42,0.05);">'
                    + '    <div style="width:' + pctW + '%; height:100%; '
                    + '                background:linear-gradient(90deg,' + c.color + ' 0%,' + c.color + 'aa 100%); '
                    + '                border-radius:8px; box-shadow:0 1px 4px ' + c.color + '55; '
                    + '                transition:width 0.7s cubic-bezier(0.4,0,0.2,1);"></div>'
                    + '  </div>'
                    + '</div>';
            });
            barHtml += '</div></div>';

            box.innerHTML = heroHtml + top5Html + top3Html + barHtml;

            this.state.kpiSummary.biggest = { amount: Number(top.amount || 0), label: top.description || topCatName };
            var host = document.getElementById('reportsKpiCards');
            if (host) host.outerHTML = this.renderKpiCards();
        } catch (e) {
            box.innerHTML = '<div style="color:#dc2626; font-size:13px;">Hata: ' + this._esc(e.message || e) + '</div>';
        }
    },

    /* ============================================================
       KPI 3 — CHART
       ============================================================ */
    loadChart: async function () {
        var f = this.state.filters.charts;
        var status = document.getElementById('repKpiChartStatus');
        if (!status) return; // panel açık değil
        status.textContent = 'Yükleniyor...';
        if(window.__DEBUG__)console.log('MODE:', f.mode);

        try {
            await this._ensureChart();
            var canvas = document.getElementById('expenseChart');
            if (!canvas) { status.textContent = 'Grafik canvas bulunamadı'; return; }
            if (typeof window.Chart === 'undefined') { status.textContent = 'Chart.js yüklenmedi'; return; }

            var rows = (await this._fetchExpenses(f.startDate, f.endDate)).data;
            if(window.__DEBUG__)console.log('[reports] loadChart mode=' + f.mode + ' rows=' + rows.length);

            if (f.mode === 'monthly') {
                var byMonth = {};
                rows.forEach(function (r) {
                    var d = String(r.date || '').slice(0, 7);
                    if (!d) return;
                    byMonth[d] = (byMonth[d] || 0) + Number(r.amount || 0);
                });
                var labels = Object.keys(byMonth).sort();
                var values = labels.map(function (l) { return byMonth[l]; });
                var pretty = labels.map(this._prettyMonth.bind(this));
                status.textContent = labels.length === 0
                    ? 'Bu aralıkta kayıt yok.'
                    : labels.length + ' ay, toplam ' + this._money(values.reduce(function (s, v) { return s + v; }, 0));
                this._renderMonthlyBar(pretty, values);

            } else if (f.mode === 'category') {
                var byCat = {};
                rows.forEach(function (r) {
                    var name = (r.categories && r.categories.name) || r.category_name || 'Diğer';
                    var color = (r.categories && r.categories.color) || null;
                    if (!byCat[name]) byCat[name] = { total: 0, color: color };
                    byCat[name].total += Number(r.amount || 0);
                });
                var labels = Object.keys(byCat).sort(function (a, b) { return byCat[b].total - byCat[a].total; });
                var values = labels.map(function (l) { return byCat[l].total; });
                var colors = labels.map(function (l, i) {
                    return byCat[l].color || this.PALETTE.cats[i % this.PALETTE.cats.length];
                }, this);
                status.textContent = labels.length === 0
                    ? 'Bu aralıkta kayıt yok.'
                    : labels.length + ' kategori, toplam ' + this._money(values.reduce(function (s, v) { return s + v; }, 0));
                this._renderCategoryBar(labels, values, colors);

            } else {
                var byDay = {};
                rows.forEach(function (r) {
                    var d = String(r.date || '').slice(0, 10);
                    if (!d) return;
                    byDay[d] = (byDay[d] || 0) + Number(r.amount || 0);
                });
                var labels = Object.keys(byDay).sort();
                var values = labels.map(function (l) { return byDay[l]; });
                var pretty = labels.map(this._prettyDay.bind(this));
                status.textContent = labels.length === 0
                    ? 'Bu aralıkta kayıt yok.'
                    : labels.length + ' gün, toplam ' + this._money(values.reduce(function (s, v) { return s + v; }, 0));
                this._renderDailyLine(pretty, values);
            }

            this.state.kpiSummary.charts = {
                amount: rows.reduce(function (s, r) { return s + Number(r.amount || 0); }, 0),
                count: rows.length
            };
            var host = document.getElementById('reportsKpiCards');
            if (host) host.outerHTML = this.renderKpiCards();
        } catch (e) {
            console.error('[reports] loadChart hata', e);
            if (status) status.textContent = 'Hata: ' + (e.message || e);
        }
    },

    /* ============================================================
       KPI 4 — PASTA
       ============================================================ */
    loadPie: async function () {
        var f = this.state.filters.distribution;
        var status = document.getElementById('repKpiPieStatus');
        if (!status) return;
        status.textContent = 'Yükleniyor...';
        try {
            await this._ensureChart();
            var rows = (await this._fetchExpenses(f.startDate, f.endDate)).data;
            var byCat = {};
            rows.forEach(function (r) {
                var name = (r.categories && r.categories.name) || r.category_name || 'Diğer';
                var color = (r.categories && r.categories.color) || null;
                if (!byCat[name]) byCat[name] = { total: 0, color: color };
                byCat[name].total += Number(r.amount || 0);
            });
            var labels = Object.keys(byCat);
            var values = labels.map(function (l) { return byCat[l].total; });
            var colors = labels.map(function (l, i) {
                return byCat[l].color || this.PALETTE.cats[i % this.PALETTE.cats.length];
            }, this);
            var grandTotal = values.reduce(function (s, v) { return s + v; }, 0);
            status.textContent = labels.length === 0
                ? 'Bu aralıkta kayıt yok.'
                : labels.length + ' kategori, toplam ' + this._money(grandTotal);
            this._renderPieChart(labels, values, colors);

            var legend = document.getElementById('repPieLegend');
            if (legend) {
                var html = '';
                labels.forEach(function (lbl, i) {
                    var pct = grandTotal > 0 ? ((values[i] / grandTotal) * 100).toFixed(1) : '0.0';
                    html += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">'
                          + '  <span style="width:12px; height:12px; background:' + colors[i] + '; border-radius:3px; display:inline-block;"></span>'
                          + '  <span style="flex:1; color:#0f172a; font-weight:600;">' + this._esc(lbl) + '</span>'
                          + '  <span style="color:#64748b;">' + this._money(values[i]) + ' <span style="color:#94a3b8;">(' + pct + '%)</span></span>'
                          + '</div>';
                }, this);
                legend.innerHTML = html || '<div style="color:#94a3b8;">-</div>';
            }

            var topCat = labels.slice().sort(function (a, b) { return byCat[b].total - byCat[a].total; })[0] || '';
            this.state.kpiSummary.distribution = { count: labels.length, top: topCat };
            var host = document.getElementById('reportsKpiCards');
            if (host) host.outerHTML = this.renderKpiCards();
        } catch (e) {
            console.error('[reports] loadPie hata', e);
            if (status) status.textContent = 'Hata: ' + (e.message || e);
        }
    },

    /* ============================================================
       VALUE-LABEL PLUGIN
       ============================================================ */
    _installValueLabelPlugin: function () {
        if (typeof Chart === 'undefined') return;
        if (Chart.__valueLabelInstalled) return;
        Chart.__valueLabelInstalled = true;
        var plugin = {
            id: 'valueLabel',
            afterDatasetsDraw: function (chart, args, opts) {
                if (!opts || !opts.enabled) return;
                var ctx = chart.ctx;
                ctx.save();
                ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
                ctx.fillStyle = '#475569';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                chart.data.datasets.forEach(function (ds, di) {
                    var meta = chart.getDatasetMeta(di);
                    if (meta.hidden) return;
                    meta.data.forEach(function (el, i) {
                        var v = ds.data[i];
                        if (v == null || v === 0) return;
                        var pos = el.tooltipPosition ? el.tooltipPosition() : { x: el.x, y: el.y };
                        var txt = (v >= 1000) ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : Math.round(v).toString();
                        ctx.fillText(txt, pos.x, pos.y - 6);
                    });
                });
                ctx.restore();
            }
        };
        Chart.register(plugin);
    },

    _baseOptions: function () {
        var P = this.PALETTE;
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            animation: { duration: 750, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    padding: 12, cornerRadius: 10,
                    titleFont: { size: 12, weight: '600', family: 'Plus Jakarta Sans' },
                    bodyFont:  { size: 13, weight: '700', family: 'Plus Jakarta Sans' },
                    titleColor: '#cbd5e1', bodyColor: '#fff',
                    displayColors: true, boxWidth: 8, boxHeight: 8,
                    callbacks: {
                        label: function (ctx) {
                            var v = Number(ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed);
                            var prefix = ctx.dataset.label || ctx.label || '';
                            return prefix + ': ' + v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
                        }
                    }
                },
                valueLabel: { enabled: true }
            },
            scales: {
                x: { grid: { display: false, drawBorder: false }, ticks: { color: P.text, font: { size: 11, weight: '500', family: 'Plus Jakarta Sans' } } },
                y: {
                    beginAtZero: true,
                    grid: { color: P.grid, drawBorder: false },
                    border: { display: false },
                    ticks: {
                        color: P.muted,
                        font: { size: 11, family: 'Plus Jakarta Sans' },
                        callback: function (v) { if (v >= 1000) return (v / 1000).toFixed(0) + 'K'; return v.toLocaleString('tr-TR'); }
                    }
                }
            }
        };
    },

    _destroyChart: function () {
        if (this.state.charts.chart) {
            try { this.state.charts.chart.destroy(); } catch (e) {}
            this.state.charts.chart = null;
        }
    },

    /* ============================================================
       AYLIK BAR — gradient
       ============================================================ */
    _renderMonthlyBar: function (labels, values) {
        var canvas = document.getElementById('expenseChart');
        if (!canvas || typeof Chart === 'undefined') return;
        this._destroyChart();
        var ctx = canvas.getContext('2d');
        var H = canvas.height || 340;
        var grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, '#6366f1');
        grad.addColorStop(1, '#8b5cf6');
        var hover = ctx.createLinearGradient(0, 0, 0, H);
        hover.addColorStop(0, '#f97316');
        hover.addColorStop(1, '#8b5cf6');
        if(window.__DEBUG__)console.log('[render] MONTHLY bar — points=' + values.length);
        this.state.charts.chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Aylık Gider',
                    data: values,
                    backgroundColor: grad,
                    hoverBackgroundColor: hover,
                    borderRadius: 12,
                    borderSkipped: false,
                    barThickness: 'flex',
                    maxBarThickness: 56
                }]
            },
            options: this._baseOptions()
        });
    },

    /* ============================================================
       GÜNLÜK LINE — smooth + fill
       ============================================================ */
    _renderDailyLine: function (labels, values) {
        var canvas = document.getElementById('expenseChart');
        if (!canvas || typeof Chart === 'undefined') return;
        this._destroyChart();
        var ctx = canvas.getContext('2d');
        var H = canvas.height || 340;
        var fillGrad = ctx.createLinearGradient(0, 0, 0, H);
        fillGrad.addColorStop(0, 'rgba(99,102,241,0.35)');
        fillGrad.addColorStop(1, 'rgba(99,102,241,0.02)');
        var opts = this._baseOptions();
        opts.plugins.valueLabel = { enabled: false };
        if(window.__DEBUG__)console.log('[render] DAILY line — tension=0.4 fill=true points=' + values.length);
        this.state.charts.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Günlük Gider',
                    data: values,
                    borderColor: '#6366f1',
                    borderWidth: 2.5,
                    tension: 0.4,
                    fill: true,
                    backgroundColor: fillGrad,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    pointBackgroundColor: '#fff',
                    pointBorderColor: '#6366f1',
                    pointBorderWidth: 2,
                    pointHoverBackgroundColor: '#f97316',
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2
                }]
            },
            options: opts
        });
    },

    /* ============================================================
       KATEGORİ BAR — multi color
       ============================================================ */
    _renderCategoryBar: function (labels, values, colors) {
        var canvas = document.getElementById('expenseChart');
        if (!canvas || typeof Chart === 'undefined') return;
        this._destroyChart();
        var ctx = canvas.getContext('2d');
        if(window.__DEBUG__)console.log('[render] CATEGORY bar — n=' + labels.length);
        this.state.charts.chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Kategori Gideri',
                    data: values,
                    backgroundColor: colors,
                    hoverBackgroundColor: colors,
                    borderRadius: 10,
                    borderSkipped: false,
                    barThickness: 'flex',
                    maxBarThickness: 32
                }]
            },
            options: this._baseOptions()
        });
    },

    /* ============================================================
       PASTA
       ============================================================ */
    _renderPieChart: function (labels, values, colors) {
        var canvas = document.getElementById('repPieCanvas');
        if (!canvas || typeof Chart === 'undefined') return;
        if (this.state.charts.pie) {
            try { this.state.charts.pie.destroy(); } catch (e) {}
            this.state.charts.pie = null;
        }
        this.state.charts.pie = new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors,
                    borderWidth: 3,
                    borderColor: '#fff',
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 750, easing: 'easeOutQuart' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.95)',
                        padding: 12, cornerRadius: 10,
                        titleFont: { size: 12, weight: '600', family: 'Plus Jakarta Sans' },
                        bodyFont:  { size: 13, weight: '700', family: 'Plus Jakarta Sans' },
                        titleColor: '#cbd5e1', bodyColor: '#fff',
                        callbacks: {
                            label: function (ctx) {
                                var v = Number(ctx.parsed || 0);
                                var total = ctx.dataset.data.reduce(function (s, x) { return s + Number(x || 0); }, 0);
                                var pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
                                return ctx.label + ': ' + v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL (' + pct + '%)';
                            }
                        }
                    }
                },
                cutout: '60%'
            }
        });
    },

    /* ============================================================
       HELPERS — sort, summary, table render
       ============================================================ */
    _sortByAmountDesc: function (rows) {
        return (rows || []).slice().sort(function (a, b) {
            return Number(b.amount || 0) - Number(a.amount || 0);
        });
    },

    _categorySummary: function (rows) {
        var byCat = {};
        (rows || []).forEach(function (r) {
            var name = (r.categories && r.categories.name) || r.category_name || 'Diğer';
            var color = (r.categories && r.categories.color) || null;
            if (!byCat[name]) byCat[name] = { total: 0, color: color };
            byCat[name].total += Number(r.amount || 0);
        });
        var total = 0;
        var keys = Object.keys(byCat);
        keys.forEach(function (k) { total += byCat[k].total; });
        var pal = this.PALETTE.cats;
        var list = keys.sort(function (a, b) { return byCat[b].total - byCat[a].total; })
            .map(function (k, i) {
                var pct = total > 0 ? (byCat[k].total / total) * 100 : 0;
                return {
                    name: k,
                    total: byCat[k].total,
                    pct: pct,
                    color: byCat[k].color || pal[i % pal.length]
                };
            });
        return { list: list, total: total };
    },

    _renderTotalTable: function (rows) {
        if (!rows || !rows.length) return '';
        var top = this._sortByAmountDesc(rows).slice(0, 10);
        var self = this;
        var html = ''
            + '<div style="margin-top:18px;">'
            + '  <div style="font-size:12px; font-weight:700; color:#475569; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px;">Son İşlemler (Top 10)</div>'
            + '  <div style="overflow:hidden; border:1px solid #e2e8f0; border-radius:10px;">'
            + '  <table style="width:100%; border-collapse:collapse; font-size:13px;">'
            + '    <thead><tr style="background:#f8fafc;">'
            + '      <th style="text-align:left; padding:10px 12px; color:#64748b; font-weight:700; font-size:11px; text-transform:uppercase;">Tarih</th>'
            + '      <th style="text-align:left; padding:10px 12px; color:#64748b; font-weight:700; font-size:11px; text-transform:uppercase;">Kategori</th>'
            + '      <th style="text-align:left; padding:10px 12px; color:#64748b; font-weight:700; font-size:11px; text-transform:uppercase;">Açıklama</th>'
            + '      <th style="text-align:right; padding:10px 12px; color:#64748b; font-weight:700; font-size:11px; text-transform:uppercase;">Tutar</th>'
            + '    </tr></thead><tbody>';
        top.forEach(function (r) {
            var cn = (r.categories && r.categories.name) || r.category_name || '-';
            html += '<tr style="border-top:1px solid #f1f5f9;">'
                + '<td style="padding:10px 12px; color:#475569;">' + self._esc(self._formatDate(r.date)) + '</td>'
                + '<td style="padding:10px 12px;"><span style="background:#f1f5f9; padding:2px 8px; border-radius:6px; font-size:12px; color:#475569;">' + self._esc(cn) + '</span></td>'
                + '<td style="padding:10px 12px; color:#0f172a;">' + self._esc(r.description || '-') + '</td>'
                + '<td style="padding:10px 12px; text-align:right; font-weight:700; color:#dc2626;">' + self._money(r.amount) + '</td>'
                + '</tr>';
        });
        html += '</tbody></table></div></div>';
        return html;
    },

    /* ============================================================
       UTILS
       ============================================================ */
    _defaultRange: function () {
        var end = new Date();
        var start = new Date();
        start.setDate(start.getDate() - 30);
        return { start: this._isoDate(start), end: this._isoDate(end) };
    },
    _isoDate: function (d) {
        var y = d.getFullYear();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + dd;
    },
    _prettyDay: function (s) {
        if (!s) return '';
        try { var d = new Date(s); if (isNaN(d.getTime())) return s; return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }); }
        catch (e) { return s; }
    },
    _prettyMonth: function (s) {
        if (!s) return '';
        try { var p = s.split('-'); var d = new Date(Number(p[0]), Number(p[1]) - 1, 1); return d.toLocaleDateString('tr-TR', { month: 'short', year: 'numeric' }); }
        catch (e) { return s; }
    },
    _formatDate: function (s) {
        if (!s) return '-';
        try { var d = new Date(s); if (isNaN(d.getTime())) return String(s); return d.toLocaleDateString('tr-TR'); }
        catch (e) { return String(s); }
    },
    _money: function (v) {
        var n = Number(v || 0);
        return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
    },
    _esc: function (v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
};
