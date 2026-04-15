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

    async render(container) {
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
                    <button id="salesBulkExportBtn" type="button" style="
                        border:none;background:#22c55e;color:#fff;padding:12px 18px;
                        border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;
                        display:flex;align-items:center;gap:8px;
                    ">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Excel Raporu
                    </button>
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

            </section>
        `;

        this.bindEvents();
        await this.loadData(true);
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

        this._salesUpdatedHandler = function () {
            self._lastFetchKey = '';
            self.salesData = [];
            self.productSalesData = [];
            self._costMap = new Map();
            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + self._getTenantId());
            }
            self.loadData(true);
        };

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

        window.ViewCache.set(fetchKey, {
            salesData: this.salesData,
            productSalesData: this.productSalesData,
            totalCount: this.totalCount,
            totalPages: this.totalPages
        });
    },

    async loadData(forceRefresh) {
        var fetchKey = this._buildFetchKey();

        // Aynı oturum içinde tekrar render
        if (false && !forceRefresh && fetchKey === this._lastFetchKey && this.salesData.length > 0) {
            this.renderSummary();
            this.renderTable();
            if (this.totalCount > 0) {
                this.setStatus(this.totalCount + ' satış kaydı bulundu.', 'success');
            } else {
                this.setStatus('Seçili tarih aralığında satış kaydı bulunamadı.', 'info');
            }
            return;
        }

        // Gerçek cache kontrolü
        if (!forceRefresh && window.ViewCache) {
            var cached = window.ViewCache.get(fetchKey);
            if (cached) {
                await this.loadProducts();
                if (!this._isActive) return;
                this._applyCachedPayload(cached, fetchKey);
                this.renderSummary();
                this.renderTable();

                if (this.totalCount > 0) {
                    this.setStatus(this.totalCount + ' satış kaydı bulundu.', 'success');
                } else {
                    this.setStatus('Seçili tarih aralığında satış kaydı bulunamadı.', 'info');
                }
                return;
            }
        }

        try {
            await this.loadProducts();
            if (!this._isActive) return;

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

            if (!this._isActive) return;

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

            if (this.viewMode === 'daily') {
                await this.loadProductSalesForPage();
            } else {
                await this.loadProductSales();
            }

            if (!this._isActive) return;

            this._rebuildCostMap();

            this._lastFetchKey = fetchKey;
            this._saveToCache(fetchKey);

            this.renderSummary();
            this.renderTable();

            if (this.totalCount > 0) {
                this.setStatus(`${this.totalCount} satış kaydı bulundu.`, 'success');
            } else {
                this.setStatus('Seçili tarih aralığında satış kaydı bulunamadı.', 'info');
            }
        } catch (err) {
            console.error('Sales load error:', err);
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
        this.productSalesData = [];

        try {
            const { data, error } = await window.SupabaseService.query('product_sales', {
                filters: [
                    { op: 'gte', column: 'date', value: this.filterStart },
                    { op: 'lte', column: 'date', value: this.filterEnd }
                ],
                order: { column: 'date', asc: true }
            });

            if (!error && Array.isArray(data)) {
                this.productSalesData = data;
            }
        } catch (err) {
            console.error('Product sales load error:', err);
        }
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
            const cost = this.getCostBySaleId(sale.id);
            const profit = total - cost;
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
        const monthMap = {};

        for (const sale of this.salesData) {
            if (!sale.date) continue;

            const monthKey = sale.date.substring(0, 7);
            if (!monthMap[monthKey]) {
                monthMap[monthKey] = { total: 0, cost: 0 };
            }

            monthMap[monthKey].total += Number(sale.total) || 0;
            monthMap[monthKey].cost += this.getCostBySaleId(sale.id);
        }

        const months = Object.keys(monthMap).sort().reverse();
        const trMonths = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

        return months.map(key => {
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
    },

    renderSummary() {
        const el = document.getElementById('salesSummaryCards');
        if (!el) return;

        const rows = this.getDisplayRows();
        const totalRevenue = rows.reduce((s, r) => s + r.total, 0);
        const totalCost = rows.reduce((s, r) => s + r.cost, 0);
        const totalProfit = totalRevenue - totalCost;
        const avgMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

        const cards = [
            { label: 'Toplam Ciro', value: window.Formatters.currency(totalRevenue), color: '#0f172a' },
            { label: 'Toplam Maliyet', value: window.Formatters.currency(totalCost), color: '#dc2626' },
            { label: 'Toplam Kar', value: window.Formatters.currency(totalProfit), color: totalProfit >= 0 ? '#16a34a' : '#dc2626' },
            { label: 'Ort. Kar Oranı', value: `%${avgMargin.toFixed(1)}`, color: avgMargin >= 40 ? '#16a34a' : avgMargin >= 20 ? '#f59e0b' : '#dc2626' }
        ];

        el.innerHTML = cards.map(c => `
            <div style="
                background:#fff;border:1px solid #e5e7eb;border-radius:14px;
                padding:18px 20px;box-shadow:0 2px 8px rgba(15,23,42,0.04);
            ">
                <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">${c.label}</div>
                <div style="font-size:22px;font-weight:800;color:${c.color};">${c.value}</div>
            </div>
        `).join('');
    },

    renderTable() {
        const tbody = document.getElementById('salesTableBody');
        if (!tbody) return;

        const allRows = this.getDisplayRows();

        if (!allRows.length) {
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

        const confirmed = confirm('Bu satış silinsin mi?');
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
            sheet.push(['', '', '', '', '', '']);
            sheet.push(['  SATIŞ RAPORU', '', '', '', '', '']);
            sheet.push(['', '', '', '', '', '']);
            sheet.push(['  İşletme Adı', '', businessName, '', '', '']);
            sheet.push(['  Rapor Tarihi', '', dateLabel, '', '', '']);
            sheet.push(['', '', '', '', '', '']);
            sheet.push([
                '  Ürün Adı',
                'Adet',
                'Birim Fiyat (TL)',
                'Toplam Tutar (TL)',
                'Maliyeti (TL)',
                'Kar (TL)'
            ]);

            var HEADER_ROW = 6;
            var DATA_START = 7;
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

                sheet.push(['  ' + name, quantity, unitPrice, lineTotal, lineCost, lineProfit]);
            }

            var SEP_ROW = sheet.length;
            sheet.push(['  ─────────────────', '─────', '──────────', '──────────', '──────────', '──────────']);

            var TOTAL_ROW = sheet.length;
            sheet.push(['  TOPLAM', '', '', sumTutar, sumMaliyet, sumKar]);
            sheet.push(['', '', '', '', '', '']);

            var ws = XLSX.utils.aoa_to_sheet(sheet);

            for (var r = DATA_START; r < SEP_ROW; r++) {
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
                { wch: 30 },
                { wch: 10 },
                { wch: 20 },
                { wch: 22 },
                { wch: 20 },
                { wch: 18 }
            ];

            ws['!rows'] = [];
            ws['!rows'][0] = { hpt: 8 };
            ws['!rows'][1] = { hpt: 32 };
            ws['!rows'][2] = { hpt: 8 };
            ws['!rows'][5] = { hpt: 8 };
            ws['!rows'][HEADER_ROW] = { hpt: 24 };
            ws['!rows'][SEP_ROW] = { hpt: 6 };
            ws['!rows'][TOTAL_ROW] = { hpt: 24 };

            ws['!merges'] = [
                { s: { r: 1, c: 0 }, e: { r: 1, c: CC - 1 } },
                { s: { r: 3, c: 0 }, e: { r: 3, c: 1 } },
                { s: { r: 3, c: 2 }, e: { r: 3, c: CC - 1 } },
                { s: { r: 4, c: 0 }, e: { r: 4, c: 1 } },
                { s: { r: 4, c: 2 }, e: { r: 4, c: CC - 1 } }
            ];

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
            await this.loadProductSales();
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
            sheet.push(['', '', '', '', '', '']);
            sheet.push(['  İKİ TARİH ARASI SATIŞ RAPORU', '', '', '', '', '']);
            sheet.push(['', '', '', '', '', '']);
            sheet.push(['  İşletme Adı', '', businessName, '', '', '']);
            sheet.push(['  Tarih Aralığı', '', dateRange, '', '', '']);
            sheet.push(['', '', '', '', '', '']);
            sheet.push([
                '  Tarih',
                'Toplam Ciro (TL)',
                'Toplam Maliyet (TL)',
                'Toplam Kar (TL)',
                'Kar Oranı',
                'Kar Marjı'
            ]);

            var HEADER_ROW = 6;
            var DATA_START = 7;
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
                    '  ' + dateDisplay,
                    ciro,
                    maliyet,
                    kar,
                    karOraniDec,
                    karMarjiDec
                ]);
            }

            var SEP_ROW = sheet.length;
            sheet.push(['  ─────────────────', '──────────', '──────────', '──────────', '──────────', '──────────']);

            var TOTAL_ROW = sheet.length;
            var grandKarOraniDec = grandMaliyet > 0 ? (grandKar / grandMaliyet) : 0;
            var grandKarMarjiDec = grandCiro > 0 ? (grandKar / grandCiro) : 0;

            sheet.push([
                '  TOPLAM',
                grandCiro,
                grandMaliyet,
                grandKar,
                grandKarOraniDec,
                grandKarMarjiDec
            ]);

            sheet.push(['', '', '', '', '', '']);

            var ws = XLSX.utils.aoa_to_sheet(sheet);

            for (var r = DATA_START; r < SEP_ROW; r++) {
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
                { wch: 24 },
                { wch: 22 },
                { wch: 24 },
                { wch: 22 },
                { wch: 16 },
                { wch: 16 }
            ];

            ws['!rows'] = [];
            ws['!rows'][0] = { hpt: 8 };
            ws['!rows'][1] = { hpt: 32 };
            ws['!rows'][2] = { hpt: 8 };
            ws['!rows'][5] = { hpt: 8 };
            ws['!rows'][HEADER_ROW] = { hpt: 24 };
            ws['!rows'][SEP_ROW] = { hpt: 6 };
            ws['!rows'][TOTAL_ROW] = { hpt: 24 };

            ws['!merges'] = [
                { s: { r: 1, c: 0 }, e: { r: 1, c: CC - 1 } },
                { s: { r: 3, c: 0 }, e: { r: 3, c: 1 } },
                { s: { r: 3, c: 2 }, e: { r: 3, c: CC - 1 } },
                { s: { r: 4, c: 0 }, e: { r: 4, c: 1 } },
                { s: { r: 4, c: 2 }, e: { r: 4, c: CC - 1 } }
            ];

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

    setStatus(message, type) {
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
    }
};