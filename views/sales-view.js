/* ============================================================
   SALES VIEW — Professional SaaS Sales Report Screen
   DB-driven | Date filter | Pagination | Daily/Monthly
   Detail modal | Single + bulk Excel export
   FIXED: sale bazlı maliyet / detay / tekil export
   CACHE: ViewCache entegrasyonu eklendi
   ============================================================ */

window.SalesView = {
    salesData: [],
    productSalesData: [],
    productsMap: new Map(),
    _costMap: new Map(),
    currentPage: 1,
    pageSize: 10,
    totalCount: 0,
    totalPages: 1,
    viewMode: 'daily',
    filterStart: '',
    filterEnd: '',
    _eventsBound: false,
    _lastFetchKey: '',
    _salesUpdatedHandler: null,
    _listeners: [],
    _isActive: false,
    // STABILIZE (Faz S-A): inflight token — eszamanli loadData cagrilarinda
    // sadece en yeni cagri state commit eder (stale overwrite / last-finisher
    // -wins korumasi).
    _loadToken: 0,
    // PERF (Faz P2-A): SWR background-revalidate guard. Stale cache render
    // edildikten sonra arkada TEK fresh fetch calissin (duplicate engeli).
    _revalidating: false,

    async render(container) {
        // NOVA_DEBUG (Faz O1-A): view render tracker
        if (window.NOVA_DEBUG && window.NOVA_DEBUG.view) window.NOVA_DEBUG.view.track('sales');
        this._isActive = true;

        const fmt = window.Formatters;
        if (!this.filterStart) this.filterStart = fmt.monthStart();
        if (!this.filterEnd) this.filterEnd = fmt.today();
        this.currentPage = 1;
        this._eventsBound = false;
        this._lastFetchKey = '';
        this.salesData = [];
        this.productSalesData = [];
        this._costMap = new Map();

        container.innerHTML = `
            <section class="sales-page">

                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:4px 0 18px 0;">
                    <div>
                        <h2 style="margin:0 0 6px 0;font-size:28px;font-weight:800;color:#0f172a;">Satışlar</h2>
                        <p style="margin:0;color:#64748b;font-size:14px;">Günlük ve aylık satış raporları</p>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        <button id="quickSaleBtn" type="button" style="
                            border:none;background:#0f172a;color:#fff;padding:12px 18px;
                            border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;
                            display:inline-flex;align-items:center;gap:8px;
                        ">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Hızlı Satış Gir
                        </button>
                        <button id="salesReportsBtn" type="button" style="
                            border:1px solid #e5e7eb;background:#ffffff;color:#0f172a;padding:12px 18px;
                            border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;
                            display:inline-flex;align-items:center;gap:8px;
                        ">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>
                            Satış Raporları
                        </button>
                        <button id="salesBulkExportBtn" type="button" style="
                            border:none;background:#22c55e;color:#fff;padding:12px 18px;
                            border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;
                            display:inline-flex;align-items:center;gap:8px;
                        ">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Excel Raporu
                        </button>
                    </div>
                </div>

                <div style="
                    background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;
                    padding:20px;margin-bottom:16px;
                    box-shadow:0 4px 12px rgba(15,23,42,0.04);
                ">
                    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">

                        <div style="
                            display:flex;background:#f1f5f9;border-radius:10px;padding:3px;
                        ">
                            <button id="switchDaily" type="button" style="
                                border:none;padding:8px 16px;border-radius:8px;font-weight:700;
                                font-size:13px;cursor:pointer;transition:all .2s;
                                ${this.viewMode === 'daily' ? 'background:#0f172a;color:#fff;' : 'background:transparent;color:#64748b;'}
                            ">Günlük</button>
                            <button id="switchMonthly" type="button" style="
                                border:none;padding:8px 16px;border-radius:8px;font-weight:700;
                                font-size:13px;cursor:pointer;transition:all .2s;
                                ${this.viewMode === 'monthly' ? 'background:#0f172a;color:#fff;' : 'background:transparent;color:#64748b;'}
                            ">Aylık</button>
                        </div>

                        <div style="width:1px;height:28px;background:#e5e7eb;"></div>

                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <label style="font-size:13px;font-weight:600;color:#475569;">Başlangıç</label>
                            <input type="date" id="salesFilterStart" value="${this.escapeAttr(this.filterStart)}" style="
                                padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;
                                font-size:13px;color:#0f172a;background:#fff;
                            ">
                            <label style="font-size:13px;font-weight:600;color:#475569;">Bitiş</label>
                            <input type="date" id="salesFilterEnd" value="${this.escapeAttr(this.filterEnd)}" style="
                                padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;
                                font-size:13px;color:#0f172a;background:#fff;
                            ">
                            <button id="salesFilterBtn" type="button" style="
                                border:none;background:#0f172a;color:#fff;padding:8px 16px;
                                border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;
                            ">Filtrele</button>
                            <button id="salesClearBtn" type="button" style="
                                border:1px solid #d1d5db;background:#fff;color:#475569;padding:8px 16px;
                                border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;
                            ">Temizle</button>
                        </div>
                    </div>
                </div>

                <div id="salesStatus" style="margin-bottom:16px;"></div>

                <div id="salesSummaryCards" style="
                    display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
                    gap:12px;margin-bottom:16px;
                "></div>

                <div style="
                    background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;
                    overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.04);
                ">
                    <div style="overflow-x:auto;">
                        <table style="width:100%;border-collapse:collapse;">
                            <thead>
                                <tr style="background:#f8fafc;">
                                    <th style="padding:14px 16px;text-align:left;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Tarih</th>
                                    <th style="padding:14px 16px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Toplam Ciro</th>
                                    <th style="padding:14px 16px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Maliyet</th>
                                    <th style="padding:14px 16px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Kar</th>
                                    <th style="padding:14px 16px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Kar Oranı</th>
                                    <th style="padding:14px 16px;text-align:center;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Aksiyonlar</th>
                                </tr>
                            </thead>
                            <tbody id="salesTableBody">
                                <tr><td colspan="6" style="text-align:center;padding:32px;color:#94a3b8;font-size:14px;">Yükleniyor...</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div id="salesPagination" style="
                        display:flex;align-items:center;justify-content:space-between;
                        padding:14px 16px;border-top:1px solid #e5e7eb;background:#f8fafc;
                        flex-wrap:wrap;gap:12px;
                    "></div>
                </div>

                <div id="salesDetailModal" style="
                    display:none;position:fixed;top:0;left:0;width:100%;height:100%;
                    background:rgba(15,23,42,0.5);z-index:9999;
                    align-items:center;justify-content:center;
                ">
                    <div style="
                        background:#fff;border-radius:20px;padding:28px;
                        max-width:720px;width:90%;max-height:80vh;overflow-y:auto;
                        box-shadow:0 20px 60px rgba(15,23,42,0.3);
                    ">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
                            <h3 id="modalTitle" style="margin:0;font-size:18px;font-weight:800;color:#0f172a;"></h3>
                            <button id="modalCloseBtn" type="button" style="
                                border:none;background:#f1f5f9;color:#475569;width:36px;height:36px;
                                border-radius:10px;cursor:pointer;font-size:18px;font-weight:700;
                                display:flex;align-items:center;justify-content:center;
                            ">&times;</button>
                        </div>
                        <div id="modalBody"></div>
                    </div>
                </div>

                <!-- HIZLI SATIŞ MODAL -->
                <div id="quickSaleModal" style="
                    display:none;position:fixed;inset:0;background:rgba(15,23,42,0.55);
                    z-index:10000;align-items:center;justify-content:center;padding:20px;
                    backdrop-filter:blur(4px);
                ">
                    <div style="
                        background:#ffffff;border-radius:18px;padding:24px 26px;max-width:460px;width:100%;
                        box-shadow:0 25px 80px rgba(15,23,42,0.22);
                    ">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                            <h3 style="margin:0;font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">Hızlı Satış Gir</h3>
                            <button id="quickSaleCloseBtn" type="button" style="border:none;background:#f1f5f9;color:#475569;width:34px;height:34px;border-radius:10px;cursor:pointer;font-size:18px;font-weight:700;">&times;</button>
                        </div>
                        <p style="margin:0 0 18px 0;color:#64748b;font-size:13px;line-height:1.5;">Ürün/maliyet seçimi olmadan hızlıca toplam ciro kaydı oluşturur.</p>

                        <div style="margin-bottom:14px;">
                            <label style="display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;">Tarih</label>
                            <input id="quickSaleDate" type="date" style="width:100%;padding:11px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;font-family:inherit;">
                        </div>

                        <div style="margin-bottom:14px;">
                            <label style="display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;">Toplam Satış (KDV Dahil, ₺)</label>
                            <input id="quickSaleTotal" type="number" min="0" step="0.01" placeholder="0,00" style="width:100%;padding:11px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;font-family:inherit;">
                        </div>

                        <div style="margin-bottom:18px;">
                            <label style="display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;">Not (opsiyonel)</label>
                            <textarea id="quickSaleNotes" rows="2" placeholder="Açıklama..." style="width:100%;padding:11px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;font-family:inherit;resize:vertical;"></textarea>
                        </div>

                        <div style="display:flex;justify-content:flex-end;gap:10px;">
                            <button id="quickSaleCancelBtn" type="button" style="padding:10px 18px;border:1px solid #e5e7eb;background:#fff;color:#475569;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;">İptal</button>
                            <button id="quickSaleSaveBtn" type="button" style="padding:10px 18px;border:none;background:#0f172a;color:#fff;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">Kaydet</button>
                        </div>
                    </div>
                </div>

                <!-- SATIŞ RAPORLARI MODAL -->
                <div id="salesReportsModal" style="
                    display:none;position:fixed;inset:0;background:rgba(15,23,42,0.55);
                    z-index:10000;align-items:center;justify-content:center;padding:20px;
                    backdrop-filter:blur(4px);
                ">
                    <div style="
                        background:#ffffff;border-radius:18px;padding:24px 26px;max-width:820px;width:100%;
                        box-shadow:0 25px 80px rgba(15,23,42,0.22);max-height:85vh;overflow-y:auto;
                    ">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                            <h3 style="margin:0;font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">Satış Raporları</h3>
                            <button id="salesReportsCloseBtn" type="button" style="border:none;background:#f1f5f9;color:#475569;width:34px;height:34px;border-radius:10px;cursor:pointer;font-size:18px;font-weight:700;">&times;</button>
                        </div>
                        <p style="margin:0 0 18px 0;color:#64748b;font-size:13px;line-height:1.5;">Aktif filtre ve bugün için özet rakamlar.</p>
                        <div id="salesReportsBody"></div>
                    </div>
                </div>

            </section>
        `;

        this.bindEvents();
        // PERF (Faz 2.4): Cache-aware enter — force=false. Onceden render()
        // her cagrisinda force=true ile cache bypass ediyordu → sekme her
        // acilisinda RPC. Cache hit (60sn TTL icinde + same fetchKey) ise
        // ~30-100ms instant render; cache miss eski RPC akisi.
        // sales:updated event listener'i cache invalidate ediyor → fresh
        // data garantisi mutation sonrasi korunuyor.
        await this.loadData(false);
        if (!this._isActive) return;
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
        this._salesUpdatedHandler = null;
        this._lastFetchKey = '';
        this.salesData = [];
        this.productSalesData = [];
        this._costMap = new Map();
        // PERF (Faz 2.3): Render guard'lari resetle. DOM gidiyor, sig'ler
        // anlamsiz. Bir sonraki render fresh, kpi mount yeniden gerekir.
        this._kpiMounted = false;
        this._lastTableSig = null;
        this._monthlyRowsCache = null;
        this._monthlyRowsCacheRev = -1;
        this._salesRev = 0;
        // PERF (Faz P2-A): SWR revalidate guard'i sifirla — yeni mount fresh.
        this._revalidating = false;
    },

    bindEvents() {
        this._removeAllListeners();
        this._eventsBound = true;

        var self = this;
        var debouncedFilter = window.debounce(function () { self.applyFilter(); }, 300);

        var filterBtn = document.getElementById('salesFilterBtn');
        var clearBtn = document.getElementById('salesClearBtn');
        var switchDaily = document.getElementById('switchDaily');
        var switchMonthly = document.getElementById('switchMonthly');
        var bulkExport = document.getElementById('salesBulkExportBtn');
        var modalClose = document.getElementById('modalCloseBtn');
        var modal = document.getElementById('salesDetailModal');

        this._on(filterBtn, 'click', debouncedFilter);
        this._on(clearBtn, 'click', function () { self.clearFilter(); });
        this._on(switchDaily, 'click', function () { self.setViewMode('daily'); });
        this._on(switchMonthly, 'click', function () { self.setViewMode('monthly'); });
        this._on(bulkExport, 'click', function () { self.exportBulkExcel(); });
        this._on(modalClose, 'click', function () { self.closeModal(); });
        this._on(modal, 'click', function (e) {
            if (e.target === modal) self.closeModal();
        });

        // Quick Sale modal
        var quickBtn        = document.getElementById('quickSaleBtn');
        var quickModal      = document.getElementById('quickSaleModal');
        var quickClose      = document.getElementById('quickSaleCloseBtn');
        var quickCancel     = document.getElementById('quickSaleCancelBtn');
        var quickSave       = document.getElementById('quickSaleSaveBtn');

        this._on(quickBtn, 'click', function () { self.openQuickSale(); });
        this._on(quickClose, 'click', function () { self.closeQuickSale(); });
        this._on(quickCancel, 'click', function () { self.closeQuickSale(); });
        this._on(quickModal, 'click', function (e) { if (e.target === quickModal) self.closeQuickSale(); });
        this._on(quickSave, 'click', function () { self.saveQuickSale(); });

        // Reports modal
        var reportsBtn   = document.getElementById('salesReportsBtn');
        var reportsModal = document.getElementById('salesReportsModal');
        var reportsClose = document.getElementById('salesReportsCloseBtn');

        this._on(reportsBtn, 'click', function () { self.openReports(); });
        this._on(reportsClose, 'click', function () { self.closeReports(); });
        this._on(reportsModal, 'click', function (e) { if (e.target === reportsModal) self.closeReports(); });

        var salesUpdatedRaw = function () {
            self._lastFetchKey = '';
            self.salesData = [];
            self.productSalesData = [];
            self._costMap = new Map();
            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + self._getTenantId());
            }
            self.loadData(true);
        };
        // STABILIZE (Faz S-A): event debounce. restore_full_backup ve hizli
        // ardisik mutation'lar cok sayida sales:updated fire edebilir; 300ms
        // penceresinde TEK loadData'ya merge edilir (dashboard-view idiom).
        // loadData icindeki inflight token, manuel loadData (filtre) ile
        // yarisi da guvene alir.
        this._salesUpdatedHandler = (typeof window.debounce === 'function')
            ? window.debounce(salesUpdatedRaw, 300)
            : salesUpdatedRaw;

        this._on(window, 'sales:updated', this._salesUpdatedHandler);
    },

    _getTenantId() {
        return (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || '';
    },

    _buildFetchKey() {
        var tenantId = this._getTenantId();
        return 'sales:' + tenantId + ':' + this.filterStart + ':' + this.filterEnd + ':' +
               this.viewMode + ':' + this.currentPage + ':' + this.pageSize;
    },

    _buildProductsCacheKey() {
        return 'sales:products:' + this._getTenantId();
    },

    _rebuildCostMap() {
        this._costMap = new Map();

        for (const ps of this.productSalesData) {
            const saleId = ps.sale_id;
            if (!saleId) continue;

            const prev = this._costMap.get(saleId) || 0;
            const cost = (Number(ps.quantity) || 0) * (Number(ps.cost) || 0);
            this._costMap.set(saleId, prev + cost);
        }
    },

    _applyCachedPayload(payload, fetchKey) {
        this.salesData = Array.isArray(payload.salesData) ? payload.salesData : [];
        this.productSalesData = Array.isArray(payload.productSalesData) ? payload.productSalesData : [];
        this.totalCount = payload.totalCount || this.salesData.length || 0;
        this.totalPages = payload.totalPages || 1;
        this._lastFetchKey = fetchKey;
        this._rebuildCostMap();
    },

    _saveToCache(fetchKey) {
        if (!window.ViewCache) return;

        // PERF (Faz 2.4): TTL 60sn — products-view ile uyumlu. ViewCache
        // default 5dk; sales icin daha kisa stale window guvenli.
        // sales:updated event listener cache'i invalidate ediyor zaten;
        // TTL sadece "kullanici 60sn sonra geri donerse fresh fetch"
        // upper bound olarak gorev yapar.
        window.ViewCache.set(fetchKey, {
            salesData: this.salesData,
            productSalesData: this.productSalesData,
            totalCount: this.totalCount,
            totalPages: this.totalPages
        }, 60 * 1000);
    },

    async loadData(forceRefresh) {
        var fetchKey = this._buildFetchKey();
        // STABILIZE (Faz S-A): inflight token. Her loadData monotonik bir
        // token alir; await sonrasi token degismisse (daha yeni load basladi)
        // eski load state COMMIT ETMEZ → stale overwrite cozulur.
        var token = ++this._loadToken;

        // PERF (Faz P2-A): SWR — getWithMeta stale data'yi SILMEZ (get() siler).
        //   fresh → cache hit (eski davranis, loading flash yok)
        //   stale → INSTANT render + arkada sessiz revalidate (loading yok)
        //   yok   → cold path (asagidaki try → ilk gercek yukleme)
        if (!forceRefresh && window.ViewCache && window.ViewCache.getWithMeta) {
            var meta = window.ViewCache.getWithMeta(fetchKey);
            if (meta && meta.data) {
                await this.loadProducts();
                if (!this._isActive || token !== this._loadToken) return;
                this._applyCachedPayload(meta.data, fetchKey);
                // PERF (Faz 2.3): Data versiyonu artir — render guard'lar
                // (renderTable sig, getMonthlyRows memo) bunu okuyor.
                this._salesRev = (this._salesRev || 0) + 1;
                this.renderSummary();
                this.renderTable();

                this.clearStatus();

                // Stale ise: arkada TEK sessiz fresh fetch. Stale data zaten
                // ekranda; yeni veri gelince renderTable sig-guard ile in-place
                // degisir. loadData(true) S-A inflight token + _isActive
                // korumali → user filtre/pagination yaparsa stale revalidate
                // commit etmez (token mismatch).
                if (meta.stale && !this._revalidating) {
                    this._revalidating = true;
                    var selfSwr = this;
                    Promise.resolve()
                        .then(function () { return selfSwr.loadData(true); })
                        .then(function () { selfSwr._revalidating = false; })
                        .catch(function () { selfSwr._revalidating = false; });
                }
                return;
            }
        }

        try {
            await this.loadProducts();
            if (!this._isActive || token !== this._loadToken) return;

            var result;

            if (this.viewMode === 'daily') {
                result = await window.SalesService.getByDateRange(
                    this.filterStart, this.filterEnd,
                    { page: this.currentPage, pageSize: this.pageSize }
                );
            } else {
                result = await window.SalesService.getByDateRange(
                    this.filterStart, this.filterEnd
                );
            }

            if (!this._isActive || token !== this._loadToken) return;

            if (result.error) {
                this.salesData = [];
                this.productSalesData = [];
                this.totalCount = 0;
                this.totalPages = 0;
                this._costMap = new Map();
                this.setStatus(this.getErrorMessage(result.error, 'Satış verileri yüklenemedi.'), 'error');
                this.renderTable();
                return;
            }

            this.salesData = Array.isArray(result.data) ? result.data : [];
            this.totalCount = result.count || this.salesData.length;
            this.totalPages = result.totalPages || 1;

            // Cost/profit artık RPC (get_sales_paginated) tarafından satır başına dönüyor.
            // Eski product_sales fetch + _costMap rebuild'e ihtiyaç yok — getDailyRows direkt sale.cost / sale.profit okuyor.
            // Geriye uyumluluk için _costMap boş kalır; getCostBySaleId fallback'i 0 döner ama RPC değerleri kullanılır.

            if (!this._isActive || token !== this._loadToken) return;

            if (this.viewMode === 'daily') {
                await this.loadKpiTotals();
                if (!this._isActive || token !== this._loadToken) return;
            } else {
                this._kpiTotals = null;
            }

            this._lastFetchKey = fetchKey;
            this._saveToCache(fetchKey);

            // PERF (Faz 2.3): Data versiyonu artir — fresh fetch sonrasi.
            this._salesRev = (this._salesRev || 0) + 1;

            this.renderSummary();
            this.renderTable();

            this.clearStatus();
        } catch (err) {
            console.error('Sales load error:', err);
            // STABILIZE (Faz S-A): stale/iptal edilmis load'in hata state'i
            // taze veriyi ezmesin.
            if (!this._isActive || token !== this._loadToken) return;
            this.salesData = [];
            this.productSalesData = [];
            this.totalCount = 0;
            this.totalPages = 0;
            this._costMap = new Map();
            this.setStatus('Satışlar yüklenirken beklenmeyen hata oluştu.', 'error');
            this.renderTable();
        }
    },

    async loadProducts() {
        this.productsMap = new Map();

        var cacheKey = this._buildProductsCacheKey();

        if (window.ViewCache) {
            var cachedProducts = window.ViewCache.get(cacheKey);
            if (Array.isArray(cachedProducts)) {
                for (const p of cachedProducts) {
                    if (p && p.id) {
                        this.productsMap.set(p.id, {
                            name: p.name || '',
                            cost: Number(p.cost) || 0,
                            price: Number(p.price) || 0
                        });
                    }
                }
                return;
            }
        }

        try {
            const { data, error } = await window.ProductsService.getAll();
            if (error || !Array.isArray(data)) return;

            var productsForCache = [];

            for (const p of data) {
                if (p && p.id) {
                    var normalized = {
                        id: p.id,
                        name: p.name || '',
                        cost: Number(p.cost) || 0,
                        price: Number(p.price) || 0
                    };

                    this.productsMap.set(normalized.id, {
                        name: normalized.name,
                        cost: normalized.cost,
                        price: normalized.price
                    });

                    productsForCache.push(normalized);
                }
            }

            if (window.ViewCache) {
                window.ViewCache.set(cacheKey, productsForCache);
            }
        } catch (err) {
            console.error('Products load error:', err);
        }
    },

    async loadProductSales() {
        return this.loadProductSalesForPage();
    },

    async loadProductSalesForPage() {
        this.productSalesData = [];

        var saleIds = this.salesData.map(function (s) { return s.id; }).filter(Boolean);
        if (!saleIds.length) return;

        try {
            var result = await window.SupabaseService.query('product_sales', {
                filters: [
                    { op: 'in', column: 'sale_id', value: saleIds }
                ]
            });

            if (!result.error && Array.isArray(result.data)) {
                this.productSalesData = result.data;
            }
        } catch (err) {
            console.error('Product sales page load error:', err);
        }
    },

    getCostBySaleId(saleId) {
        return this._costMap.get(saleId) || 0;
    },

    getProductSalesBySaleId(saleId) {
        return this.productSalesData.filter(ps => ps.sale_id === saleId);
    },

    getDisplayRows() {
        if (this.viewMode === 'monthly') {
            return this.getMonthlyRows();
        }
        return this.getDailyRows();
    },

    getDailyRows() {
        const sorted = [...this.salesData].sort((a, b) => {
            const dateCompare = (b.date || '').localeCompare(a.date || '');
            if (dateCompare !== 0) return dateCompare;
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });

        return sorted.map(sale => {
            const total = Number(sale.total) || 0;
            // Cost: önce row üstünde geliyorsa onu kullan, yoksa _costMap (product_sales agregatı)
            const cost = (sale.cost != null) ? Number(sale.cost) : this.getCostBySaleId(sale.id);
            const profit = (sale.profit != null) ? Number(sale.profit) : (total - cost);
            const margin = total > 0 ? (profit / total) * 100 : 0;

            return {
                key: sale.id,
                date: sale.date,
                label: window.Formatters.date(sale.date),
                total,
                cost,
                profit,
                margin,
                saleId: sale.id
            };
        });
    },

    getMonthlyRows() {
        // PERF (Faz 2.3): Memoize. salesData O(n) grouping aylik view'da
        // her renderSummary + renderTable cagrisinda recompute oluyordu.
        // 5000 satis: ~10-30ms × 2 = ~60ms. _salesRev artmadigi surece
        // ayni grouping sonucu reuse edilir.
        if (this._monthlyRowsCache && this._monthlyRowsCacheRev === this._salesRev) {
            return this._monthlyRowsCache;
        }

        const monthMap = {};

        for (const sale of this.salesData) {
            if (!sale.date) continue;

            const monthKey = sale.date.substring(0, 7);
            if (!monthMap[monthKey]) {
                monthMap[monthKey] = { total: 0, cost: 0 };
            }

            monthMap[monthKey].total += Number(sale.total) || 0;
            // RPC cost varsa direkt kullan, yoksa eski yola düş
            monthMap[monthKey].cost += (sale.cost != null) ? (Number(sale.cost) || 0) : this.getCostBySaleId(sale.id);
        }

        const months = Object.keys(monthMap).sort().reverse();
        const trMonths = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

        const result = months.map(key => {
            const total = monthMap[key].total;
            const cost = monthMap[key].cost;
            const profit = total - cost;
            const margin = total > 0 ? (profit / total) * 100 : 0;

            const parts = key.split('-');
            const year = parts[0];
            const month = parts[1];
            const monthName = trMonths[parseInt(month, 10) - 1] || month;

            return {
                key,
                date: key,
                label: `${monthName} ${year}`,
                total,
                cost,
                profit,
                margin,
                saleId: null
            };
        });

        this._monthlyRowsCache = result;
        this._monthlyRowsCacheRev = this._salesRev || 0;
        return result;
    },

    async loadKpiTotals() {
        this._kpiTotals = null;

        try {
            const salesRes = await window.SalesService.getAllByDateRange(
                this.filterStart, this.filterEnd
            );

            if (salesRes.error || !Array.isArray(salesRes.data)) return;

            const allSales = salesRes.data;
            const saleIds = allSales.map(s => s.id).filter(Boolean);

            let totalRevenue = 0;
            for (const s of allSales) {
                totalRevenue += Number(s.total) || 0;
            }

            let totalCost = 0;
            if (saleIds.length) {
                const CHUNK = 500;
                for (let i = 0; i < saleIds.length; i += CHUNK) {
                    const slice = saleIds.slice(i, i + CHUNK);
                    let p = 1;
                    while (true) {
                        const psRes = await window.SupabaseService.query('product_sales', {
                            filters: [{ op: 'in', column: 'sale_id', value: slice }],
                            pageSize: 1000,
                            page: p,
                            count: true
                        });
                        if (psRes.error || !Array.isArray(psRes.data)) break;
                        for (const ps of psRes.data) {
                            const qty = Number(ps.quantity) || 0;
                            const cost = Number(ps.cost) || 0;
                            totalCost += qty * cost;
                        }
                        const psTotal = Number(psRes.count || 0);
                        if (psRes.data.length < 1000 || p * 1000 >= psTotal) break;
                        p++;
                    }
                }
            }

            this._kpiTotals = { totalRevenue, totalCost };
        } catch (err) {
            console.error('KPI totals load error:', err);
            this._kpiTotals = null;
        }
    },

    renderSummary() {
        const el = document.getElementById('salesSummaryCards');
        if (!el) return;

        let totalRevenue = 0;
        let totalCost = 0;

        if (this.viewMode === 'daily' && this._kpiTotals) {
            totalRevenue = this._kpiTotals.totalRevenue || 0;
            totalCost = this._kpiTotals.totalCost || 0;
        } else {
            const rows = this.getDisplayRows();
            totalRevenue = rows.reduce((s, r) => s + r.total, 0);
            totalCost = rows.reduce((s, r) => s + r.cost, 0);
        }

        const totalProfit = totalRevenue - totalCost;
        const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

        // PERF (Faz 2.3): KPI persistence. Ilk mount'ta full HTML (skeleton),
        // sonraki update'lerde sadece text/color (text node mutation). Expenses
        // view'in _softUpdate pattern'i ile birebir. Mevcut innerHTML rebuild
        // her renderSummary'de 4 card recreate ediyordu (paint cost).
        const revColor = '#0f172a';
        const costColor = '#dc2626';
        const profitColor = totalProfit >= 0 ? '#16a34a' : '#dc2626';
        const marginColor = avgMargin >= 40 ? '#16a34a' : avgMargin >= 20 ? '#f59e0b' : '#dc2626';

        const revText = window.Formatters.currency(totalRevenue);
        const costText = window.Formatters.currency(totalCost);
        const profitText = window.Formatters.currency(totalProfit);
        const marginText = '%' + avgMargin.toFixed(1);

        // First mount: skeleton HTML ile ID'li node'lar yarat
        if (!this._kpiMounted || !document.getElementById('sv-kpi-rev-v')) {
            const card = (id, label) =>
                `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;box-shadow:0 2px 8px rgba(15,23,42,0.04);">` +
                    `<div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${label}</div>` +
                    `<div id="sv-kpi-${id}-v" style="font-size:22px;font-weight:800;"></div>` +
                `</div>`;
            el.innerHTML =
                card('rev',    'Toplam Ciro') +
                card('cost',   'Toplam Maliyet') +
                card('profit', 'Toplam Kar') +
                card('margin', 'Ort. Kar Oranı');
            this._kpiMounted = true;
        }

        // Soft update: text + color (paint sadece bu node'lar uzerinde)
        const setKpi = (id, text, color) => {
            const node = document.getElementById('sv-kpi-' + id + '-v');
            if (!node) return;
            if (node.textContent !== text) node.textContent = text;
            if (node.style.color !== color) node.style.color = color;
        };
        setKpi('rev',    revText,    revColor);
        setKpi('cost',   costText,   costColor);
        setKpi('profit', profitText, profitColor);
        setKpi('margin', marginText, marginColor);
    },

    renderTable() {
        const tbody = document.getElementById('salesTableBody');
        if (!tbody) return;

        const allRows = this.getDisplayRows();

        if (!allRows.length) {
            // Empty state: sig'i temizle (yeni data gelirse rebuild garantili)
            this._lastTableSig = null;
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:#94a3b8;font-size:14px;">Kayıt bulunamadı.</td></tr>`;
            this.renderPagination(0, 0);
            return;
        }

        var pageRows, totalItems, totalPages;

        if (this.viewMode === 'daily') {
            pageRows = allRows;
            totalItems = this.totalCount;
            totalPages = this.totalPages;
        } else {
            totalItems = allRows.length;
            totalPages = Math.ceil(totalItems / this.pageSize);
            if (this.currentPage > totalPages) this.currentPage = totalPages;
            if (this.currentPage < 1) this.currentPage = 1;
            var start = (this.currentPage - 1) * this.pageSize;
            pageRows = allRows.slice(start, start + this.pageSize);
        }

        // PERF (Faz 2.3): tbody same-sig SKIP. _salesRev her loadData success/
        // cache-hit'inde artar — same data + same page + same viewMode +
        // same pageSize + same pageRows.length kombinasyonu icin rebuild
        // yapilmaz. Sales detail/delete sonrasi loadData(true) cagriliyor →
        // _salesRev artiyor → sig invalidate → fresh render.
        var tableSig = (this._salesRev || 0) + '|' +
                       this.viewMode + '|' +
                       this.currentPage + '/' +
                       this.pageSize + '#' +
                       pageRows.length + ':' + totalItems;
        if (this._lastTableSig === tableSig && tbody.children && tbody.children.length > 0) {
            // Pagination yine de cagrilsin (totalPages degisikligi icin guvenli)
            this.renderPagination(totalItems, totalPages);
            return;
        }
        this._lastTableSig = tableSig;

        tbody.innerHTML = pageRows.map(row => {
            const profitColor = row.profit >= 0 ? '#16a34a' : '#dc2626';
            const marginColor = row.margin >= 60 ? '#16a34a' : row.margin >= 40 ? '#f59e0b' : '#dc2626';

            const isDaily = this.viewMode === 'daily';
            const viewBtn = isDaily ? `<button onclick="window.SalesView.showDetailById('${this.escapeAttr(row.saleId)}')" style="
                border:none;background:#f0f9ff;color:#0284c7;padding:6px 12px;
                border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;margin-right:6px;
            ">Detay</button>` : '';

            const excelBtn = isDaily ? `<button onclick="window.SalesView.exportSaleExcel('${this.escapeAttr(row.saleId)}')" style="
                border:none;background:#f0fdf4;color:#16a34a;padding:6px 12px;
                border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;
            ">Excel</button>` : '';

            const deleteBtn = isDaily ? `<button onclick="window.SalesView.deleteSale('${this.escapeAttr(row.saleId)}')" style="
                border:none;background:#fef2f2;color:#dc2626;padding:6px 12px;
                border-radius:8px;font-weight:600;font-size:12px;cursor:pointer;margin-left:6px;
            ">Sil</button>` : '';

            return `
                <tr style="transition:background .15s;" onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background='#fff'">
                    <td style="padding:14px 16px;font-size:14px;font-weight:600;color:#0f172a;border-bottom:1px solid #f1f5f9;">${this.escapeHtml(row.label)}</td>
                    <td style="padding:14px 16px;text-align:right;font-size:14px;font-weight:700;color:#0f172a;border-bottom:1px solid #f1f5f9;">${window.Formatters.currency(row.total)}</td>
                    <td style="padding:14px 16px;text-align:right;font-size:14px;font-weight:600;color:#64748b;border-bottom:1px solid #f1f5f9;">${window.Formatters.currency(row.cost)}</td>
                    <td style="padding:14px 16px;text-align:right;font-size:14px;font-weight:700;color:${profitColor};border-bottom:1px solid #f1f5f9;">${window.Formatters.currency(row.profit)}</td>
                    <td style="padding:14px 16px;text-align:right;font-size:14px;font-weight:700;color:${marginColor};border-bottom:1px solid #f1f5f9;">%${row.margin.toFixed(1)}</td>
                    <td style="padding:14px 16px;text-align:center;border-bottom:1px solid #f1f5f9;white-space:nowrap;">${viewBtn}${excelBtn}${deleteBtn}${!isDaily ? '<span style="color:#94a3b8;font-size:12px;">—</span>' : ''}</td>
                </tr>
            `;
        }).join('');

        this.renderPagination(totalItems, totalPages);
    },

    renderPagination(totalItems, totalPages) {
        const el = document.getElementById('salesPagination');
        if (!el) return;

        if (!totalItems) {
            el.innerHTML = '';
            return;
        }

        const start = (this.currentPage - 1) * this.pageSize + 1;
        const end = Math.min(this.currentPage * this.pageSize, totalItems);

        const pageSizeOptions = [10, 20, 30];

        let pageButtons = '';
        if (totalPages > 1) {
            const prevDisabled = this.currentPage <= 1;
            const nextDisabled = this.currentPage >= totalPages;

            pageButtons = `
                <button onclick="window.SalesView.goToPage(${this.currentPage - 1})" ${prevDisabled ? 'disabled' : ''} style="
                    border:1px solid #d1d5db;background:#fff;color:${prevDisabled ? '#d1d5db' : '#0f172a'};
                    padding:6px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:${prevDisabled ? 'default' : 'pointer'};
                ">&laquo;</button>
                <span style="font-size:13px;font-weight:600;color:#475569;padding:0 8px;">
                    ${this.currentPage} / ${totalPages}
                </span>
                <button onclick="window.SalesView.goToPage(${this.currentPage + 1})" ${nextDisabled ? 'disabled' : ''} style="
                    border:1px solid #d1d5db;background:#fff;color:${nextDisabled ? '#d1d5db' : '#0f172a'};
                    padding:6px 10px;border-radius:6px;font-size:12px;font-weight:600;cursor:${nextDisabled ? 'default' : 'pointer'};
                ">&raquo;</button>
            `;
        }

        el.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:13px;color:#64748b;">Sayfa başına:</span>
                <select id="salesPageSize" onchange="window.SalesView.changePageSize(this.value)" style="
                    padding:4px 8px;border:1px solid #d1d5db;border-radius:6px;
                    font-size:13px;color:#0f172a;background:#fff;cursor:pointer;
                ">
                    ${pageSizeOptions.map(s => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <span style="font-size:13px;color:#64748b;margin-left:8px;">
                    ${start}-${end} / ${totalItems} kayıt
                </span>
            </div>
            <div style="display:flex;align-items:center;gap:4px;">
                ${pageButtons}
            </div>
        `;
    },

    goToPage(page) {
        if (this.viewMode === 'daily') {
            if (page < 1 || page > this.totalPages) return;
            this.currentPage = page;
            this.loadData();
        } else {
            var allRows = this.getDisplayRows();
            var totalPages = Math.ceil(allRows.length / this.pageSize);
            if (page < 1 || page > totalPages) return;
            this.currentPage = page;
            this.renderTable();
        }
    },

    changePageSize(value) {
        this.pageSize = parseInt(value, 10) || 10;
        this.currentPage = 1;
        this._lastFetchKey = '';
        if (this.viewMode === 'daily') {
            this.loadData();
        } else {
            this.renderTable();
        }
    },

    applyFilter() {
        const startEl = document.getElementById('salesFilterStart');
        const endEl = document.getElementById('salesFilterEnd');

        this.filterStart = startEl ? startEl.value : '';
        this.filterEnd = endEl ? endEl.value : '';

        if (!this.filterStart || !this.filterEnd) {
            this.setStatus('Başlangıç ve bitiş tarihlerini seçin.', 'error');
            return;
        }

        if (this.filterStart > this.filterEnd) {
            this.setStatus('Başlangıç tarihi, bitiş tarihinden sonra olamaz.', 'error');
            return;
        }

        this.currentPage = 1;
        this._lastFetchKey = '';
        this.loadData();
    },

    clearFilter() {
        const fmt = window.Formatters;
        this.filterStart = fmt.monthStart();
        this.filterEnd = fmt.today();
        this.currentPage = 1;
        this._lastFetchKey = '';

        const startEl = document.getElementById('salesFilterStart');
        const endEl = document.getElementById('salesFilterEnd');
        if (startEl) startEl.value = this.filterStart;
        if (endEl) endEl.value = this.filterEnd;

        this.loadData();
    },

    setViewMode(mode) {
        this.viewMode = mode;
        this.currentPage = 1;
        this._lastFetchKey = '';

        const dailyBtn = document.getElementById('switchDaily');
        const monthlyBtn = document.getElementById('switchMonthly');

        if (dailyBtn) {
            dailyBtn.style.background = mode === 'daily' ? '#0f172a' : 'transparent';
            dailyBtn.style.color = mode === 'daily' ? '#fff' : '#64748b';
        }
        if (monthlyBtn) {
            monthlyBtn.style.background = mode === 'monthly' ? '#0f172a' : 'transparent';
            monthlyBtn.style.color = mode === 'monthly' ? '#fff' : '#64748b';
        }

        this.loadData();
    },

    async showDetailById(saleId) {
        if (!this.productSalesData.length) {
            await this.loadProductSalesForPage();
        }

        const modal = document.getElementById('salesDetailModal');
        const title = document.getElementById('modalTitle');
        const body = document.getElementById('modalBody');
        if (!modal || !title || !body) return;

        const sale = this.salesData.find(s => s.id === saleId);
        if (!sale) {
            body.innerHTML = '<div style="text-align:center;padding:24px;color:#dc2626;">Satış kaydı bulunamadı.</div>';
            modal.style.display = 'flex';
            return;
        }

        title.textContent = `Satış Detayı — ${window.Formatters.date(sale.date)}`;
        body.innerHTML = '<div style="text-align:center;padding:24px;color:#94a3b8;">Yükleniyor...</div>';
        modal.style.display = 'flex';

        try {
            const saleProductSales = this.getProductSalesBySaleId(saleId);

            if (!saleProductSales.length) {
                body.innerHTML = '<div style="text-align:center;padding:24px;color:#94a3b8;">Bu satışa ait ürün detayı bulunamadı.</div>';
                return;
            }

            let totalRevenue = 0;
            let totalCost = 0;

            const rows = saleProductSales.map(ps => {
                const product = this.productsMap.get(ps.product_id);
                const name = product ? product.name : '(Bilinmeyen Ürün)';
                const quantity = Number(ps.quantity) || 0;
                const unitPrice = Number(ps.unit_price) || 0;
                const lineTotal = Number(ps.total) || 0;
                const unitCost = Number(ps.cost) || 0;
                const lineCost = quantity * unitCost;

                totalRevenue += lineTotal;
                totalCost += lineCost;

                return { name, quantity, unitPrice, lineTotal, unitCost, lineCost };
            });

            const totalProfit = totalRevenue - totalCost;
            const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

            body.innerHTML = `
                <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
                        <thead>
                            <tr style="background:#f8fafc;">
                                <th style="padding:12px 14px;text-align:left;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;">Ürün</th>
                                <th style="padding:12px 14px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;">Adet</th>
                                <th style="padding:12px 14px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;">Birim Fiyat</th>
                                <th style="padding:12px 14px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;">Toplam</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(r => `
                                <tr>
                                    <td style="padding:12px 14px;font-size:14px;font-weight:600;color:#0f172a;border-bottom:1px solid #f1f5f9;">${this.escapeHtml(r.name)}</td>
                                    <td style="padding:12px 14px;text-align:right;font-size:14px;color:#475569;border-bottom:1px solid #f1f5f9;">${r.quantity}</td>
                                    <td style="padding:12px 14px;text-align:right;font-size:14px;color:#475569;border-bottom:1px solid #f1f5f9;">${window.Formatters.currencyDetail(r.unitPrice)}</td>
                                    <td style="padding:12px 14px;text-align:right;font-size:14px;font-weight:700;color:#0f172a;border-bottom:1px solid #f1f5f9;">${window.Formatters.currency(r.lineTotal)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    <div style="text-align:right;font-size:11px;color:#94a3b8;margin-top:6px;font-style:italic;">Tüm tutarlar KDV dahildir.</div>
                </div>
                <div style="
                    display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
                    gap:10px;padding:16px;background:#f8fafc;border-radius:12px;
                ">
                    <div>
                        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Ciro</div>
                        <div style="font-size:18px;font-weight:800;color:#0f172a;">${window.Formatters.currency(totalRevenue)}</div>
                    </div>
                    <div>
                        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Maliyet</div>
                        <div style="font-size:18px;font-weight:800;color:#dc2626;">${window.Formatters.currency(totalCost)}</div>
                    </div>
                    <div>
                        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Kar</div>
                        <div style="font-size:18px;font-weight:800;color:${totalProfit >= 0 ? '#16a34a' : '#dc2626'};">${window.Formatters.currency(totalProfit)}</div>
                    </div>
                    <div>
                        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Kar Oranı</div>
                        <div style="font-size:18px;font-weight:800;color:${margin >= 40 ? '#16a34a' : '#f59e0b'};">%${margin.toFixed(1)}</div>
                    </div>
                </div>
            `;
        } catch (err) {
            console.error('Detail load error:', err);
            body.innerHTML = '<div style="text-align:center;padding:24px;color:#dc2626;">Detay yüklenirken hata oluştu.</div>';
        }
    },

    closeModal() {
        const modal = document.getElementById('salesDetailModal');
        if (modal) modal.style.display = 'none';
    },

    async deleteSale(saleId) {
        if (!saleId) return;

        const sale = this.salesData.find(s => s.id === saleId);
        const itemCount = this.getProductSalesBySaleId(saleId).length;
        const summary = {
            date: sale ? sale.date : null,
            total: sale ? Number(sale.total) || 0 : 0,
            itemCount: itemCount
        };

        const confirmed = await this._confirmDeleteSale(summary);
        if (!confirmed) return;

        try {
            const result = await window.SalesService.remove(saleId);
            if (!this._isActive) return;

            if (result.error) {
                this.setStatus(this.getErrorMessage(result.error, 'Satış silinemedi.'), 'error');
                return;
            }

            this.setStatus('Satış başarıyla silindi.', 'success');
            this._lastFetchKey = '';

            if (window.ViewCache) {
                window.ViewCache.invalidate('dashboard:');
                window.ViewCache.invalidate('sales:' + this._getTenantId());
            }

            await this.loadData(true);
            if (!this._isActive) return;
        } catch (err) {
            console.error('Delete sale error:', err);
            this.setStatus('Satış silinirken beklenmeyen hata oluştu.', 'error');
        }
    },

    _xlsxCellRef(r, c) {
        return XLSX.utils.encode_cell({ r: r, c: c });
    },

    _xlsxSetFormat(ws, r, c, fmt) {
        var ref = this._xlsxCellRef(r, c);
        if (ws[ref] && ws[ref].t === 'n') {
            ws[ref].z = fmt;
        }
    },

    _xlsxFormatCurrency() {
        return '#,##0.00" TL"';
    },

    _xlsxFormatInteger() {
        return '#,##0';
    },

    _xlsxFormatPercent() {
        return '0.0%';
    },

    /* ============================================================
       XLSX PREMIUM STYLING
       Note: SheetJS CE (xlsx.full.min.js) cell .s renderlamaz.
       .s set'leri xlsx-js-style yüklenirse otomatik aktifleşir.
       CE tarafında: alignment.horizontal, merges, widths, heights,
       freeze panes, format kodları çalışır.
    ============================================================ */

    _xlsxColors() {
        return {
            green:    { rgb: '16A34A' },   // NovaDash green
            greenDk:  { rgb: '0D7A38' },   // header darker
            navy:     { rgb: '0F172A' },   // total background
            white:    { rgb: 'FFFFFF' },
            text:     { rgb: '0F172A' },
            muted:    { rgb: '64748B' },
            zebra:    { rgb: 'F8FAFC' },   // very light gray
            metaBg:   { rgb: 'F1F5F9' },
            border:   { rgb: 'E5E7EB' }
        };
    },

    _xlsxBorder(color) {
        var c = color || this._xlsxColors().border;
        return {
            top:    { style: 'thin', color: c },
            bottom: { style: 'thin', color: c },
            left:   { style: 'thin', color: c },
            right:  { style: 'thin', color: c }
        };
    },

    _xlsxCellAt(ws, r, c) {
        var ref = XLSX.utils.encode_cell({ r: r, c: c });
        if (!ws[ref]) ws[ref] = { t: 's', v: '' };
        return ws[ref];
    },

    _xlsxApplyStyle(ws, r, c, style) {
        var cell = this._xlsxCellAt(ws, r, c);
        cell.s = Object.assign({}, cell.s || {}, style);
    },

    _xlsxStylize(ws, layout) {
        var COLS = this._xlsxColors();
        var cc   = layout.colCount;

        // === TITLE ROW (row 0) ===
        for (var c = 0; c < cc; c++) {
            this._xlsxApplyStyle(ws, 0, c, {
                font:      { bold: true, sz: 16, color: COLS.white, name: 'Calibri' },
                fill:      { fgColor: COLS.green, patternType: 'solid' },
                alignment: { horizontal: 'center', vertical: 'center' },
                border:    this._xlsxBorder(COLS.green)
            });
        }

        // === META ROWS (rows 1, 2) ===
        for (var mr = 1; mr <= 2; mr++) {
            for (var mc = 0; mc < cc; mc++) {
                this._xlsxApplyStyle(ws, mr, mc, {
                    font:      { bold: mc === 0, sz: 11, color: COLS.text, name: 'Calibri' },
                    fill:      { fgColor: COLS.metaBg, patternType: 'solid' },
                    alignment: { horizontal: mc === 0 ? 'left' : 'left', vertical: 'center', indent: 1 },
                    border:    this._xlsxBorder()
                });
            }
        }

        // === HEADER ROW ===
        var hr = layout.headerRow;
        for (var hc = 0; hc < cc; hc++) {
            var headerAlign = (layout.alignments && layout.alignments[hc]) || 'center';
            this._xlsxApplyStyle(ws, hr, hc, {
                font:      { bold: true, sz: 11, color: COLS.white, name: 'Calibri' },
                fill:      { fgColor: COLS.greenDk, patternType: 'solid' },
                alignment: { horizontal: 'center', vertical: 'center' },
                border:    this._xlsxBorder(COLS.greenDk)
            });
        }

        // === DATA ROWS (zebra) ===
        for (var dr = layout.dataStart; dr < layout.totalRow; dr++) {
            var isOdd = ((dr - layout.dataStart) % 2) === 1;
            for (var dc = 0; dc < cc; dc++) {
                var align = (layout.alignments && layout.alignments[dc]) || 'left';
                this._xlsxApplyStyle(ws, dr, dc, {
                    font:      { sz: 11, color: COLS.text, name: 'Calibri' },
                    fill:      { fgColor: isOdd ? COLS.zebra : COLS.white, patternType: 'solid' },
                    alignment: { horizontal: align, vertical: 'center', indent: dc === 0 ? 1 : 0 },
                    border:    this._xlsxBorder()
                });
            }
        }

        // === TOTAL ROW ===
        var tr = layout.totalRow;
        for (var tc = 0; tc < cc; tc++) {
            var totalAlign = (layout.alignments && layout.alignments[tc]) || 'right';
            this._xlsxApplyStyle(ws, tr, tc, {
                font:      { bold: true, sz: 12, color: COLS.white, name: 'Calibri' },
                fill:      { fgColor: COLS.navy, patternType: 'solid' },
                alignment: { horizontal: tc === 0 ? 'left' : totalAlign, vertical: 'center', indent: tc === 0 ? 1 : 0 },
                border:    this._xlsxBorder(COLS.navy)
            });
        }

        // === FREEZE PANES (header sabit) ===
        ws['!freeze'] = { xSplit: 0, ySplit: layout.dataStart };
        if (!ws['!sheetView']) ws['!sheetView'] = [];
        ws['!sheetView'][0] = { state: 'frozen', xSplit: 0, ySplit: layout.dataStart };
    },

    exportSaleExcel(saleId) {
        try {
            if (typeof XLSX === 'undefined') {
                this.setStatus('Excel kütüphanesi yüklenemedi.', 'error');
                return;
            }

            const sale = this.salesData.find(s => s.id === saleId);
            if (!sale) {
                this.setStatus('Satış kaydı bulunamadı.', 'error');
                return;
            }

            const saleProductSales = this.getProductSalesBySaleId(saleId);

            if (!saleProductSales.length) {
                this.setStatus('Bu satışa ait ürün satış detayı bulunamadı.', 'error');
                return;
            }

            var businessName = (window.STATE && window.STATE.tenant && window.STATE.tenant.name) || 'İşletme';
            var dateLabel = window.Formatters.date(sale.date);
            var CC = 6;
            var FMT_TL = this._xlsxFormatCurrency();
            var FMT_INT = this._xlsxFormatInteger();

            var sheet = [];
            sheet.push(['SATIŞ RAPORU', '', '', '', '', '']);
            sheet.push(['İşletme', businessName, '', '', '', '']);
            sheet.push(['Rapor Tarihi', dateLabel, '', '', '', '']);
            sheet.push([
                'Ürün Adı',
                'Adet',
                'Birim Fiyat',
                'Toplam',
                'Maliyet',
                'Kâr'
            ]);

            var HEADER_ROW = 3;
            var DATA_START = 4;
            var sumTutar = 0, sumMaliyet = 0, sumKar = 0;

            for (var i = 0; i < saleProductSales.length; i++) {
                var ps = saleProductSales[i];
                var product = this.productsMap.get(ps.product_id);
                var name = product ? product.name : '(Bilinmeyen Ürün)';
                var quantity = Number(ps.quantity) || 0;
                var unitPrice = Number(ps.unit_price) || 0;
                var lineTotal = Number(ps.total) || 0;
                var unitCost = Number(ps.cost) || 0;
                var lineCost = quantity * unitCost;
                var lineProfit = lineTotal - lineCost;

                sumTutar += lineTotal;
                sumMaliyet += lineCost;
                sumKar += lineProfit;

                sheet.push([name, quantity, unitPrice, lineTotal, lineCost, lineProfit]);
            }

            var TOTAL_ROW = sheet.length;
            sheet.push(['TOPLAM', '', '', sumTutar, sumMaliyet, sumKar]);

            var ws = XLSX.utils.aoa_to_sheet(sheet);

            for (var r = DATA_START; r < TOTAL_ROW; r++) {
                this._xlsxSetFormat(ws, r, 1, FMT_INT);
                this._xlsxSetFormat(ws, r, 2, FMT_TL);
                this._xlsxSetFormat(ws, r, 3, FMT_TL);
                this._xlsxSetFormat(ws, r, 4, FMT_TL);
                this._xlsxSetFormat(ws, r, 5, FMT_TL);
            }

            this._xlsxSetFormat(ws, TOTAL_ROW, 3, FMT_TL);
            this._xlsxSetFormat(ws, TOTAL_ROW, 4, FMT_TL);
            this._xlsxSetFormat(ws, TOTAL_ROW, 5, FMT_TL);

            ws['!cols'] = [
                { wch: 32 },
                { wch: 10 },
                { wch: 16 },
                { wch: 18 },
                { wch: 16 },
                { wch: 16 }
            ];

            ws['!rows'] = [];
            ws['!rows'][0] = { hpt: 30 };
            ws['!rows'][1] = { hpt: 20 };
            ws['!rows'][2] = { hpt: 20 };
            ws['!rows'][HEADER_ROW] = { hpt: 22 };
            ws['!rows'][TOTAL_ROW]  = { hpt: 22 };

            ws['!merges'] = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: CC - 1 } },
                { s: { r: 1, c: 1 }, e: { r: 1, c: CC - 1 } },
                { s: { r: 2, c: 1 }, e: { r: 2, c: CC - 1 } },
                { s: { r: TOTAL_ROW, c: 0 }, e: { r: TOTAL_ROW, c: 2 } }
            ];

            this._xlsxStylize(ws, {
                colCount:   CC,
                headerRow:  HEADER_ROW,
                dataStart:  DATA_START,
                totalRow:   TOTAL_ROW,
                alignments: ['left', 'center', 'right', 'right', 'right', 'right']
            });

            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Satış Raporu');
            XLSX.writeFile(wb, 'satis_' + sale.date + '_' + saleId.slice(0, 8) + '.xlsx');

            this.setStatus(dateLabel + ' satış raporu indirildi.', 'success');
        } catch (err) {
            console.error('Sale export error:', err);
            this.setStatus('Excel dosyası oluşturulurken hata oluştu.', 'error');
        }
    },

    async exportBulkExcel() {
        var savedSales = this.salesData;
        var savedProductSales = this.productSalesData;

        try {
            if (typeof XLSX === 'undefined') {
                this.setStatus('Excel kütüphanesi yüklenemedi.', 'error');
                return;
            }

            this.setStatus('Excel raporu hazırlanıyor...', 'info');

            var exportResult = await window.SalesService.getByDateRange(
                this.filterStart, this.filterEnd
            );
            if (!this._isActive) return;

            if (exportResult.error || !exportResult.data || !exportResult.data.length) {
                this.setStatus('Dışa aktarılacak satış verisi bulunamadı.', 'error');
                return;
            }

            this.salesData = exportResult.data;
            await this.loadProductSalesForPage();
            if (!this._isActive) return;
            this._rebuildCostMap();

            var businessName = (window.STATE && window.STATE.tenant && window.STATE.tenant.name) || 'İşletme';
            var startLabel = window.Formatters.date(this.filterStart);
            var endLabel = window.Formatters.date(this.filterEnd);
            var dateRange = startLabel + '  —  ' + endLabel;
            var CC = 6;
            var FMT_TL = this._xlsxFormatCurrency();
            var FMT_PCT = this._xlsxFormatPercent();

            var sheet = [];
            sheet.push(['SATIŞ ÖZET RAPORU', '', '', '', '', '']);
            sheet.push(['İşletme', businessName, '', '', '', '']);
            sheet.push(['Tarih Aralığı', dateRange, '', '', '', '']);
            sheet.push([
                'Tarih',
                'Toplam Ciro',
                'Toplam Maliyet',
                'Toplam Kâr',
                'Kâr Oranı',
                'Kâr Marjı'
            ]);

            var HEADER_ROW = 3;
            var DATA_START = 4;
            var grandCiro = 0, grandMaliyet = 0, grandKar = 0;

            var rows = this.getDailyRows().slice().sort(function(a, b) {
                const dateCompare = (a.date || '').localeCompare(b.date || '');
                if (dateCompare !== 0) return dateCompare;
                return String(a.saleId || '').localeCompare(String(b.saleId || ''));
            });

            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var ciro = Number(row.total) || 0;
                var maliyet = Number(row.cost) || 0;
                var kar = ciro - maliyet;

                var karOraniDec = maliyet > 0 ? (kar / maliyet) : 0;
                var karMarjiDec = ciro > 0 ? (kar / ciro) : 0;

                grandCiro += ciro;
                grandMaliyet += maliyet;
                grandKar += kar;

                var dateDisplay = window.Formatters.date(row.date);

                sheet.push([
                    dateDisplay,
                    ciro,
                    maliyet,
                    kar,
                    karOraniDec,
                    karMarjiDec
                ]);
            }

            var TOTAL_ROW = sheet.length;
            var grandKarOraniDec = grandMaliyet > 0 ? (grandKar / grandMaliyet) : 0;
            var grandKarMarjiDec = grandCiro > 0 ? (grandKar / grandCiro) : 0;

            sheet.push([
                'TOPLAM',
                grandCiro,
                grandMaliyet,
                grandKar,
                grandKarOraniDec,
                grandKarMarjiDec
            ]);

            var ws = XLSX.utils.aoa_to_sheet(sheet);

            for (var r = DATA_START; r < TOTAL_ROW; r++) {
                this._xlsxSetFormat(ws, r, 1, FMT_TL);
                this._xlsxSetFormat(ws, r, 2, FMT_TL);
                this._xlsxSetFormat(ws, r, 3, FMT_TL);
                this._xlsxSetFormat(ws, r, 4, FMT_PCT);
                this._xlsxSetFormat(ws, r, 5, FMT_PCT);
            }

            this._xlsxSetFormat(ws, TOTAL_ROW, 1, FMT_TL);
            this._xlsxSetFormat(ws, TOTAL_ROW, 2, FMT_TL);
            this._xlsxSetFormat(ws, TOTAL_ROW, 3, FMT_TL);
            this._xlsxSetFormat(ws, TOTAL_ROW, 4, FMT_PCT);
            this._xlsxSetFormat(ws, TOTAL_ROW, 5, FMT_PCT);

            ws['!cols'] = [
                { wch: 22 },
                { wch: 18 },
                { wch: 18 },
                { wch: 18 },
                { wch: 14 },
                { wch: 14 }
            ];

            ws['!rows'] = [];
            ws['!rows'][0] = { hpt: 30 };
            ws['!rows'][1] = { hpt: 20 };
            ws['!rows'][2] = { hpt: 20 };
            ws['!rows'][HEADER_ROW] = { hpt: 22 };
            ws['!rows'][TOTAL_ROW]  = { hpt: 22 };

            ws['!merges'] = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: CC - 1 } },
                { s: { r: 1, c: 1 }, e: { r: 1, c: CC - 1 } },
                { s: { r: 2, c: 1 }, e: { r: 2, c: CC - 1 } }
            ];

            this._xlsxStylize(ws, {
                colCount:   CC,
                headerRow:  HEADER_ROW,
                dataStart:  DATA_START,
                totalRow:   TOTAL_ROW,
                alignments: ['center', 'right', 'right', 'right', 'center', 'center']
            });

            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Satış Özet Raporu');

            var fileName = 'satis_ozet_' + this.filterStart + '_' + this.filterEnd + '.xlsx';
            XLSX.writeFile(wb, fileName);

            this.setStatus(startLabel + ' — ' + endLabel + ' arası satış özet raporu indirildi.', 'success');
        } catch (err) {
            console.error('Bulk export error:', err);
            this.setStatus('Excel dosyası oluşturulurken hata oluştu.', 'error');
        } finally {
            this.salesData = savedSales;
            this.productSalesData = savedProductSales;
            this._rebuildCostMap();
        }
    },

    /* ============================================================
       QUICK SALE
    ============================================================ */

    openQuickSale() {
        var modal = document.getElementById('quickSaleModal');
        if (!modal) return;
        var dateEl   = document.getElementById('quickSaleDate');
        var totalEl  = document.getElementById('quickSaleTotal');
        var notesEl  = document.getElementById('quickSaleNotes');
        if (dateEl)  dateEl.value  = (window.Formatters && window.Formatters.today) ? window.Formatters.today() : new Date().toISOString().slice(0,10);
        if (totalEl) totalEl.value = '';
        if (notesEl) notesEl.value = '';
        modal.style.display = 'flex';
        if (totalEl) setTimeout(function () { totalEl.focus(); }, 30);
    },

    closeQuickSale() {
        var modal = document.getElementById('quickSaleModal');
        if (modal) modal.style.display = 'none';
    },

    async saveQuickSale() {
        var dateEl  = document.getElementById('quickSaleDate');
        var totalEl = document.getElementById('quickSaleTotal');
        var notesEl = document.getElementById('quickSaleNotes');
        var saveBtn = document.getElementById('quickSaleSaveBtn');

        var date  = dateEl  ? dateEl.value  : '';
        var total = totalEl ? Number(totalEl.value || 0) : 0;
        var notes = notesEl ? String(notesEl.value || '').trim() : '';

        if (!date) { this.setStatus('Tarih zorunludur.', 'error'); return; }
        if (!total || total <= 0) { this.setStatus('Tutar 0\'dan büyük olmalı.', 'error'); return; }
        if (!window.SalesService || typeof window.SalesService.create !== 'function') {
            this.setStatus('Satış servisi yüklenemedi.', 'error');
            return;
        }

        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Kaydediliyor...'; }
        try {
            var res = await window.SalesService.create({
                date: date,
                total: total,
                cash: 0,
                card: 0,
                notes: notes || null
            });

            if (res && res.error) {
                this.setStatus(this.getErrorMessage(res.error, 'Satış kaydedilemedi.'), 'error');
                return;
            }

            // 047: aynı idempotency_key ile ikinci çağrıda DB duplicate
            // skip yapıyor (yeni kayıt YOK). Kullanıcıya net mesaj göster.
            // NOT: setStatus loadData(true) SONRASINA konuldu çünkü
            // loadData başarı yolunda clearStatus() çağırıp mesajı
            // siliyor (line 450). Aynı sıra success branch'te de.
            if (res && res.duplicate) {
                this.closeQuickSale();
                this._lastFetchKey = '';
                if (window.ViewCache) {
                    window.ViewCache.invalidate('sales:' + this._getTenantId());
                    window.ViewCache.invalidate('dashboard:');
                }
                await this.loadData(true);
                this.setStatus('Bu satış zaten kayıtlı.', 'error', 10000);
                return;
            }

            this.closeQuickSale();

            // refresh sales list + invalidate caches
            this._lastFetchKey = '';
            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + this._getTenantId());
                window.ViewCache.invalidate('dashboard:');
            }
            await this.loadData(true);
            this.setStatus('Satış kaydı eklendi.', 'success', 10000);
            try { window.dispatchEvent(new Event('sales:updated')); } catch (e) { /* noop */ }
        } catch (err) {
            this.setStatus(this.getErrorMessage(err, 'Satış kaydedilemedi.'), 'error');
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Kaydet'; }
        }
    },

    /* ============================================================
       REPORTS PANEL
    ============================================================ */

    openReports() {
        var modal = document.getElementById('salesReportsModal');
        var body  = document.getElementById('salesReportsBody');
        if (!modal || !body) return;

        body.innerHTML = this._buildReportsHtml();
        modal.style.display = 'flex';
    },

    closeReports() {
        var modal = document.getElementById('salesReportsModal');
        if (modal) modal.style.display = 'none';
    },

    _buildReportsHtml() {
        var rows = (typeof this.getDailyRows === 'function') ? this.getDailyRows() : [];

        if (!rows || !rows.length) {
            return '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:14px;font-weight:600;">Bu rapor için yeterli veri yok</div>' +
                this._renderInsightsHtml(this._buildInsights([], ''));
        }

        var todayIso = (window.Formatters && window.Formatters.today) ? window.Formatters.today() : new Date().toISOString().slice(0,10);

        var rangeCiro = 0, rangeCost = 0;
        var todayCiro = 0, todayCost = 0;

        rows.forEach(function (r) {
            var ciro = Number(r.total || 0);
            var cost = Number(r.cost  || 0);
            rangeCiro += ciro;
            rangeCost += cost;
            if (r.date === todayIso) {
                todayCiro += ciro;
                todayCost += cost;
            }
        });

        var rangeProfit = rangeCiro - rangeCost;
        var todayProfit = todayCiro - todayCost;
        var rangeMargin = rangeCiro > 0 ? (rangeProfit / rangeCiro) * 100 : 0;
        var todayMargin = todayCiro > 0 ? (todayProfit / todayCiro) * 100 : 0;

        var fmt = window.Formatters;
        var c   = function (v) { return fmt && fmt.currency ? fmt.currency(v) : ('₺' + Number(v||0).toLocaleString('tr-TR')); };
        var pct = function (v) { return Number(v||0).toFixed(1) + '%'; };
        var d   = function (v) { return fmt && fmt.date ? fmt.date(v) : v; };

        var startLabel = d(this.filterStart);
        var endLabel   = d(this.filterEnd);

        var section = function (title, subtitle, items) {
            var inner = items.map(function (it) {
                return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9;">' +
                    '<span style="font-size:13px;color:#64748b;font-weight:600;">' + it[0] + '</span>' +
                    '<span style="font-size:14px;color:#0f172a;font-weight:700;">' + it[1] + '</span>' +
                '</div>';
            }).join('');

            return '<div style="padding:16px 18px;border:1px solid #e5e7eb;border-radius:14px;background:#f8fafc;height:100%;box-sizing:border-box;">' +
                '<div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px;">' + title + '</div>' +
                (subtitle ? '<div style="font-size:13px;color:#475569;margin-bottom:10px;">' + subtitle + '</div>' : '<div style="height:8px;"></div>') +
                inner +
            '</div>';
        };

        var todayCard = section('Bugün (' + d(todayIso) + ')', '', [
            ['Toplam Satış',  c(todayCiro)],
            ['Toplam Maliyet', c(todayCost)],
            ['Toplam Kâr',     c(todayProfit)],
            ['Kâr Oranı',      pct(todayMargin)]
        ]);
        var rangeCard = section('Tarih Aralığı', startLabel + ' — ' + endLabel, [
            ['Toplam Satış',  c(rangeCiro)],
            ['Toplam Maliyet', c(rangeCost)],
            ['Toplam Kâr',     c(rangeProfit)],
            ['Kâr Oranı',      pct(rangeMargin)]
        ]);

        var html =
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:16px;">' +
                todayCard +
                rangeCard +
            '</div>';

        html += this._renderInsightsHtml(this._buildInsights(rows, todayIso));

        return html;
    },

    /* ============================================================
       AKILLI İÇGÖRÜLER
       Gerçek veriden üretilir. Fake/placeholder yok.
    ============================================================ */

    _buildInsights(rows, todayIso) {
        var insights = [];

        if (!rows || !rows.length) {
            insights.push({
                type: 'info',
                text: 'Analiz için yeterli veri bulunamadı.'
            });
            return insights;
        }

        // 1) Bugün vs 7-gün ortalaması
        var sorted = rows.slice().sort(function (a, b) {
            return String(a.date || '').localeCompare(String(b.date || ''));
        });

        var byDate = {};
        sorted.forEach(function (r) {
            var d = r.date || '';
            if (!byDate[d]) byDate[d] = { total: 0, cost: 0 };
            byDate[d].total += Number(r.total || 0);
            byDate[d].cost  += Number(r.cost  || 0);
        });

        var todayCiro = (byDate[todayIso] && byDate[todayIso].total) || 0;

        // last 7 days excluding today
        var dayKeys = Object.keys(byDate).sort();
        var lastSeven = dayKeys.filter(function (d) { return d !== todayIso; }).slice(-7);

        if (lastSeven.length >= 2 && todayCiro > 0) {
            var sum7 = lastSeven.reduce(function (s, d) { return s + byDate[d].total; }, 0);
            var avg7 = sum7 / lastSeven.length;
            if (avg7 > 0 && todayCiro > avg7 * 1.05) {
                insights.push({
                    type: 'good',
                    text: 'Bugünkü satış performansı son 7 gün ortalamasının üzerinde.'
                });
            } else if (avg7 > 0 && todayCiro < avg7 * 0.7) {
                insights.push({
                    type: 'warn',
                    text: 'Bugünkü satış son 7 gün ortalamasının belirgin altında.'
                });
            }
        }

        // 2) Yüksek kâr oranı + maliyet eksik olabilir
        var totalCiro = 0, totalCost = 0;
        sorted.forEach(function (r) {
            totalCiro += Number(r.total || 0);
            totalCost += Number(r.cost  || 0);
        });
        var marginPct = totalCiro > 0 ? ((totalCiro - totalCost) / totalCiro) * 100 : 0;
        var costRatio = totalCiro > 0 ? (totalCost / totalCiro) * 100 : 0;

        if (totalCiro > 0 && marginPct >= 80 && costRatio < 5) {
            insights.push({
                type: 'warn',
                text: 'Kâr oranı yüksek görünüyor. Ürün maliyet verileri eksik olabilir.'
            });
        }

        // 3) Trend — range'in son yarısı vs ilk yarısı
        if (dayKeys.length >= 4) {
            var mid = Math.floor(dayKeys.length / 2);
            var firstHalf  = dayKeys.slice(0, mid);
            var secondHalf = dayKeys.slice(mid);

            var sumFirst  = firstHalf.reduce(function (s, d)  { return s + byDate[d].total; }, 0);
            var sumSecond = secondHalf.reduce(function (s, d) { return s + byDate[d].total; }, 0);

            var avgFirst  = firstHalf.length  ? sumFirst  / firstHalf.length  : 0;
            var avgSecond = secondHalf.length ? sumSecond / secondHalf.length : 0;

            if (avgFirst > 0) {
                if (avgSecond > avgFirst * 1.1) {
                    insights.push({
                        type: 'good',
                        text: 'Satış trendi olumlu ilerliyor.'
                    });
                } else if (avgSecond < avgFirst * 0.85) {
                    insights.push({
                        type: 'warn',
                        text: 'Satış trendi son dönemde zayıflıyor.'
                    });
                }
            }
        }

        // 4) Negatif kâr
        if (totalCiro > 0 && (totalCiro - totalCost) < 0) {
            insights.push({
                type: 'warn',
                text: 'Bu dönemde toplam kâr negatif. Maliyet kontrolü gerekebilir.'
            });
        }

        if (!insights.length) {
            insights.push({
                type: 'info',
                text: 'Veriler stabil. Belirgin bir uyarı tespit edilmedi.'
            });
        }

        return insights;
    },

    _renderInsightsHtml(insights) {
        if (!insights || !insights.length) return '';

        var palette = {
            good: { bar: '#16a34a', icon: '#16a34a', bg: '#f0fdf4' },
            warn: { bar: '#d97706', icon: '#b45309', bg: '#fffbeb' },
            info: { bar: '#0ea5e9', icon: '#0369a1', bg: '#f0f9ff' }
        };

        var iconSvg = function (type) {
            if (type === 'good') {
                return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            }
            if (type === 'warn') {
                return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
            }
            return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
        };

        var items = insights.map(function (it) {
            var p = palette[it.type] || palette.info;
            return '<div style="' +
                'display:flex;align-items:flex-start;gap:10px;padding:11px 14px;' +
                'border:1px solid #e5e7eb;border-left:3px solid ' + p.bar + ';' +
                'border-radius:10px;background:' + p.bg + ';margin-bottom:8px;' +
                '">' +
                '<span style="display:inline-flex;align-items:center;justify-content:center;color:' + p.icon + ';margin-top:1px;flex-shrink:0;">' + iconSvg(it.type) + '</span>' +
                '<span style="font-size:13px;color:#0f172a;line-height:1.5;">' + it.text + '</span>' +
            '</div>';
        }).join('');

        return '<div style="margin-top:4px;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z"/></svg>' +
                '<span style="font-size:13px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">Akıllı İçgörüler</span>' +
            '</div>' +
            items +
        '</div>';
    },

    clearStatus() {
        // Sticky lock: ttl ile set edilen mesaj suresince clearStatus no-op.
        if (this._statusLockUntil && Date.now() < this._statusLockUntil) return;
        const el = document.getElementById('salesStatus');
        if (el) el.innerHTML = '';
    },

    setStatus(message, type, ttlMs) {
        const el = document.getElementById('salesStatus');
        if (!el) return;

        const styles = {
            success: 'background:#ecfdf5;border:1px solid #86efac;color:#166534;',
            error: 'background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;',
            info: 'background:#f0f9ff;border:1px solid #93c5fd;color:#1e40af;'
        };

        const style = styles[type] || styles.info;

        el.innerHTML = `
            <div style="
                padding:14px 16px;border-radius:14px;
                font-size:14px;font-weight:600;
                ${style}
            ">
                ${this.escapeHtml(message)}
            </div>
        `;

        // Onceki timer'i iptal et
        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }
        this._statusLockUntil = 0;

        // ttlMs verildiyse: belirtilen sure sonunda otomatik temizle.
        // Bu sure boyunca clearStatus (loadData vb.) cagrisi mesaji silemez.
        if (ttlMs && ttlMs > 0) {
            this._statusLockUntil = Date.now() + ttlMs;
            this._statusTimer = setTimeout(() => {
                const el2 = document.getElementById('salesStatus');
                if (el2) el2.innerHTML = '';
                this._statusLockUntil = 0;
                this._statusTimer = null;
            }, ttlMs);
        }
    },

    getErrorMessage(error, fallback) {
        if (!error) return fallback || 'Bilinmeyen hata oluştu.';
        if (typeof error === 'string') return error;
        if (typeof error.message === 'string' && error.message.trim()) return error.message;
        if (typeof error.details === 'string' && error.details.trim()) return error.details;
        if (typeof error.hint === 'string' && error.hint.trim()) return error.hint;
        try { return JSON.stringify(error); } catch (_) { return fallback || 'Bilinmeyen hata oluştu.'; }
    },

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /* ============================================================
       SATIS SIL — CONFIRMATION MODAL
       Native confirm() yerine premium modal. Promise<boolean> doner.
       Enter = sil DEGIL (yanlis silme onleme).
       ESC / backdrop / Iptal = false. Sadece "Satisi Sil" tiklamasi true.
       ============================================================ */
    _confirmDeleteSale(summary) {
        return new Promise((resolve) => {
            // Daha onceki bir modal kaldiysa temizle
            const prev = document.getElementById('salesDeleteOverlay');
            if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

            const dateText = summary && summary.date
                ? (window.Formatters && window.Formatters.date ? window.Formatters.date(summary.date) : String(summary.date))
                : '—';
            const totalText = summary
                ? (window.Formatters && window.Formatters.currency ? window.Formatters.currency(summary.total || 0) : ('₺' + (summary.total || 0)))
                : '—';
            const itemText = summary && summary.itemCount > 0
                ? (summary.itemCount + ' satır')
                : 'Detay yok';

            const overlay = document.createElement('div');
            overlay.id = 'salesDeleteOverlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.45);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity 150ms ease;';

            overlay.innerHTML =
                '<div id="salesDeleteSheet" style="width:100%;max-width:420px;background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(15,23,42,0.30), 0 10px 30px rgba(15,23,42,0.12);border:1px solid #e2e8f0;overflow:hidden;transform:scale(0.96);opacity:0;transition:transform 150ms ease, opacity 150ms ease;">' +
                    '<div style="padding:24px 24px 18px 24px; text-align:center;">' +
                        '<div style="width:48px;height:48px;margin:0 auto 14px;border-radius:14px;background:#fffbeb;border:1px solid #fde68a;display:flex;align-items:center;justify-content:center;color:#d97706;">' +
                            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
                        '</div>' +
                        '<div style="font-size:17px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;line-height:1.3;">Bu satış kaydı silinecek</div>' +
                        '<div style="margin-top:6px;font-size:13.5px;color:#64748b;line-height:1.5;">Devam etmek istediğine emin misin?</div>' +
                    '</div>' +

                    '<div style="margin:0 20px 14px 20px; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px;">' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;">' +
                            '<span style="font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.04em;text-transform:uppercase;">Tarih</span>' +
                            '<span style="font-size:13.5px;font-weight:700;color:#0f172a;">' + this.escapeHtml(dateText) + '</span>' +
                        '</div>' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid #eef2f7;">' +
                            '<span style="font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.04em;text-transform:uppercase;">Tutar</span>' +
                            '<span style="font-size:14px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">' + this.escapeHtml(totalText) + '</span>' +
                        '</div>' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid #eef2f7;">' +
                            '<span style="font-size:12px;font-weight:700;color:#94a3b8;letter-spacing:0.04em;text-transform:uppercase;">Ürün</span>' +
                            '<span style="font-size:13.5px;font-weight:700;color:#0f172a;">' + this.escapeHtml(itemText) + '</span>' +
                        '</div>' +
                    '</div>' +

                    '<div style="margin:0 20px 18px 20px; padding:10px 14px; background:#fffbeb; border:1px solid #fde68a; border-radius:10px; display:flex; align-items:center; gap:10px;">' +
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
                        '<span style="font-size:12.5px;font-weight:600;color:#92400e;line-height:1.4;">Bu işlem geri alınamaz.</span>' +
                    '</div>' +

                    '<div style="padding:14px 20px;border-top:1px solid #e2e8f0;background:#ffffff;display:flex;gap:10px;">' +
                        '<button type="button" id="salesDeleteCancelBtn" style="flex:1;padding:12px 18px;border:1px solid #e2e8f0;background:#fff;color:#0f172a;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;transition:background .12s, border-color .12s;">İptal</button>' +
                        '<button type="button" id="salesDeleteConfirmBtn" style="flex:1;padding:12px 18px;border:none;background:#dc2626;color:#fff;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;transition:background .12s, transform .08s;">Satışı Sil</button>' +
                    '</div>' +
                '</div>';

            document.body.appendChild(overlay);

            const sheet = overlay.querySelector('#salesDeleteSheet');
            const cancelBtn = overlay.querySelector('#salesDeleteCancelBtn');
            const confirmBtn = overlay.querySelector('#salesDeleteConfirmBtn');

            // Hover styles (inline element delegation)
            cancelBtn.addEventListener('mouseover', () => { cancelBtn.style.background = '#f8fafc'; cancelBtn.style.borderColor = '#cbd5e1'; });
            cancelBtn.addEventListener('mouseout', () => { cancelBtn.style.background = '#fff'; cancelBtn.style.borderColor = '#e2e8f0'; });
            confirmBtn.addEventListener('mouseover', () => { confirmBtn.style.background = '#b91c1c'; });
            confirmBtn.addEventListener('mouseout', () => { confirmBtn.style.background = '#dc2626'; });
            confirmBtn.addEventListener('mousedown', () => { confirmBtn.style.transform = 'translateY(1px)'; });
            confirmBtn.addEventListener('mouseup', () => { confirmBtn.style.transform = ''; });

            // Animate in
            requestAnimationFrame(() => {
                overlay.style.opacity = '1';
                if (sheet) {
                    sheet.style.transform = 'scale(1)';
                    sheet.style.opacity = '1';
                }
            });

            const previouslyFocused = document.activeElement;
            // Default focus to Cancel — Enter Cancel'e gider, asla Sil'e DEGIL
            setTimeout(() => { try { cancelBtn.focus(); } catch (e) {} }, 50);

            const cleanup = (result) => {
                document.removeEventListener('keydown', onKey, true);
                overlay.style.opacity = '0';
                if (sheet) {
                    sheet.style.transform = 'scale(0.96)';
                    sheet.style.opacity = '0';
                }
                setTimeout(() => {
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    try { if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); } catch (e) {}
                    resolve(result);
                }, 150);
            };

            const onKey = (ev) => {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    cleanup(false);
                } else if (ev.key === 'Enter') {
                    // KRITIK: Enter sadece Cancel'i tetikler (yanlis silme onleme).
                    // Confirm butonu odaktayken bile Enter cancel'lar.
                    if (document.activeElement === confirmBtn) {
                        ev.preventDefault();
                    }
                }
            };

            document.addEventListener('keydown', onKey, true);

            overlay.addEventListener('click', (ev) => {
                if (ev.target === overlay) cleanup(false);
            });

            cancelBtn.addEventListener('click', () => cleanup(false));
            confirmBtn.addEventListener('click', () => {
                // Loading state
                confirmBtn.disabled = true;
                cancelBtn.disabled = true;
                confirmBtn.style.cursor = 'wait';
                confirmBtn.style.opacity = '0.85';
                confirmBtn.textContent = 'Siliniyor...';
                cleanup(true);
            });
        });
    }
};