/* ============================================================
   PRODUCTS VIEW — Product management + product performance
   + Recipe Editor (product_recipes / raw_materials)
   ============================================================ */

window.ProductsView = {
    categories: [],
    products: [],
    filteredProducts: [],
    performanceMap: new Map(),
    editingId: null,
    _listeners: [],
    _isActive: false,

    filters: {
        search: '',
        categoryId: '',
        sortBy: 'name',
        sortDir: 'asc'
    },

    pagination: {
        page: 1,
        pageSize: 10
    },

    modalState: {
        open: false,
        type: '',
        title: '',
        message: '',
        inputLabel: '',
        inputValue: '',
        confirmText: 'Tamam',
        cancelText: 'İptal',
        onConfirm: null
    },

    recipeState: {
        open: false,
        productId: null,
        productName: '',
        recipes: [],        // [{id, raw_material_id, quantity, raw_material:{name,unit,cost}}]
        rawMaterials: [],   // [{id, name, unit, cost}]
        loading: false,
        saving: false,
        error: ''
    },

    async render(container) {
        this._isActive = true;

        container.innerHTML = `
            <div class="page-header">
                <h2 class="page-title">Ürünler</h2>
                <button class="btn btn-primary" onclick="window.ProductsView.toggleForm()">
                    + Yeni Ürün Ekle
                </button>
				<button class="btn btn-secondary" id="openPurchaseModal">
                    + Alış Gir
                </button>
            </div>

            <div class="form-card" id="productForm" style="display:none;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px;">
                    <h3 id="productFormTitle" style="margin:0; font-size:1rem; font-weight:700;">Ürün Ekle</h3>
                    <div style="display:flex; gap:8px;">
                        <button class="btn btn-secondary" type="button" onclick="window.ProductsView.openCategoryModal()">
                            + Kategori Ekle
                        </button>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">Ürün Adı</label>
                        <input type="text" class="form-input" id="productName" placeholder="Ürün adı">
                    </div>

                    <div class="form-group">
                        <label class="form-label">Kategori</label>
                        <select class="form-select" id="productCategory">
                            <option value="">Kategoriler yükleniyor...</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Satış Tutarı (₺)</label>
                        <input type="number" class="form-input" id="productPrice" placeholder="0.00" step="0.01" min="0">
                    </div>

                    <div class="form-group">
                        <label class="form-label">Maliyet (₺) — reçeteden türetilir</label>
                        <div style="display:flex; gap:8px; align-items:stretch;">
                            <input type="text" class="form-input" id="productCostInfo" value="—" readonly style="flex:1; background:#f8fafc; color:#475569; font-weight:700;">
                            <button
                                type="button"
                                class="btn btn-secondary"
                                id="productOpenRecipeBtn"
                                onclick="window.ProductsView.openRecipeForCurrentEditing()"
                                disabled
                                style="white-space:nowrap; opacity:0.55; cursor:not-allowed;"
                                title="Önce ürünü kaydet, sonra reçete düzenleyebilirsin."
                            >🧪 Reçeteyi Düzenle</button>
                        </div>
                        <div style="margin-top:6px; font-size:12px; color:#64748b;">
                            Maliyet manuel girilmez — ham madde reçetesinden otomatik hesaplanır.
                        </div>
                    </div>
                </div>

                <div style="margin-top:16px; display:flex; gap:10px;">
                    <button class="btn btn-primary" onclick="window.ProductsView.save()">Kaydet</button>
                    <button class="btn btn-secondary" onclick="window.ProductsView.cancelForm()">İptal</button>
                </div>
            </div>

            <div class="form-card" style="margin-top:16px;">
                <div style="
                    display:grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap:12px;
                    align-items:end;
                ">
                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Ürün Ara</label>
                        <input
                            type="text"
                            class="form-input"
                            id="productSearch"
                            placeholder="Ürün adına göre ara"
                            oninput="window.ProductsView.handleSearch(this.value)"
                        >
                    </div>

                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Kategori Filtre</label>
                        <select class="form-select" id="productCategoryFilter" onchange="window.ProductsView.handleCategoryFilter(this.value)">
                            <option value="">Tüm kategoriler</option>
                        </select>
                    </div>

                    <div class="form-group" style="margin-bottom:0;">
                        <label class="form-label">Sıralama</label>
                        <select class="form-select" id="productSort" onchange="window.ProductsView.handleSortSelect(this.value)">
                            <option value="name-asc">Ürün A→Z</option>
                            <option value="name-desc">Ürün Z→A</option>
                            <option value="price-desc">Satış Tutarı Yüksek→Düşük</option>
                            <option value="price-asc">Satış Tutarı Düşük→Yüksek</option>
                            <option value="cost-desc">Maliyet Yüksek→Düşük</option>
                            <option value="cost-asc">Maliyet Düşük→Yüksek</option>
                            <option value="margin_amount-desc">Kar Marjı Yüksek→Düşük</option>
                            <option value="margin_amount-asc">Kar Marjı Düşük→Yüksek</option>
                            <option value="margin_rate-desc">Kar Oranı Yüksek→Düşük</option>
                            <option value="margin_rate-asc">Kar Oranı Düşük→Yüksek</option>
                            <option value="sales_qty-desc">Satış Adedi Yüksek→Düşük</option>
                            <option value="sales_qty-asc">Satış Adedi Düşük→Yüksek</option>
                            <option value="revenue-desc">Ciro Yüksek→Düşük</option>
                            <option value="revenue-asc">Ciro Düşük→Yüksek</option>
                            <option value="profit_est-desc">Tahmini Kar Yüksek→Düşük</option>
                            <option value="profit_est-asc">Tahmini Kar Düşük→Yüksek</option>
                        </select>
                    </div>
                </div>
            </div>

            <div id="productsStatus" style="margin:16px 0;"></div>

            <div class="data-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('name')">Ürün</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('category')">Kategori</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('price')">Satış Tutarı</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('cost')">Maliyet</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('margin_amount')">Kar Marjı</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('margin_rate')">Kar Oranı</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('sales_qty')">Satış Adedi</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('revenue')">Ciro</th>
                            <th style="cursor:pointer;" onclick="window.ProductsView.setSort('profit_est')">Tahmini Kar</th>
                            <th>Performans</th>
                            <th>Durum</th>
                            <th>İşlemler</th>
                        </tr>
                    </thead>
                    <tbody id="productsTableBody">
                        <tr>
                            <td colspan="12" style="text-align:center; padding:24px;">Yükleniyor...</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div id="productsPagination" style="margin-top:16px;"></div>

            <div
                id="productsModalOverlay"
                onclick="window.ProductsView.handleOverlayClick(event)"
                style="
                    display:none;
                    position:fixed;
                    inset:0;
                    background:rgba(15, 23, 42, 0.45);
                    z-index:9999;
                    align-items:center;
                    justify-content:center;
                    padding:20px;
                "
            >
                <div
                    onclick="event.stopPropagation()"
                    style="
                        width:100%;
                        max-width:520px;
                        background:#ffffff;
                        border-radius:20px;
                        box-shadow:0 24px 80px rgba(15, 23, 42, 0.22);
                        border:1px solid #e2e8f0;
                        overflow:hidden;
                    "
                >
                    <div style="padding:22px 22px 14px 22px; border-bottom:1px solid #e2e8f0;">
                        <div id="productsModalTitle" style="font-size:18px; font-weight:800; color:#0f172a;">İşlem</div>
                        <div id="productsModalMessage" style="margin-top:8px; font-size:14px; line-height:1.55; color:#475569;"></div>
                    </div>

                    <div id="productsModalBody" style="padding:18px 22px 0 22px; display:none;">
                        <label id="productsModalInputLabel" style="display:block; font-size:13px; font-weight:700; color:#334155; margin-bottom:8px;">
                            Değer
                        </label>
                        <input
                            id="productsModalInput"
                            type="text"
                            class="form-input"
                            style="width:100%;"
                            placeholder=""
                        >
                        <div id="productsModalError" style="margin-top:8px; color:#b91c1c; font-size:13px; display:none;"></div>
                    </div>

                    <div style="padding:22px; display:flex; justify-content:flex-end; gap:10px;">
                        <button class="btn btn-secondary" type="button" id="productsModalCancelBtn" onclick="window.ProductsView.closeModal()">
                            İptal
                        </button>
                        <button class="btn btn-primary" type="button" id="productsModalConfirmBtn" onclick="window.ProductsView.confirmModal()">
                            Tamam
                        </button>
                    </div>
                </div>
            </div>

            <!-- =========================================
                 RECIPE EDITOR MODAL
                 ========================================= -->
            <div
                id="productsRecipeOverlay"
                onclick="window.ProductsView.handleRecipeOverlayClick(event)"
                style="
                    display:none;
                    position:fixed;
                    inset:0;
                    background:rgba(15, 23, 42, 0.45);
                    z-index:9999;
                    align-items:center;
                    justify-content:center;
                    padding:20px;
                "
            >
                <div
                    onclick="event.stopPropagation()"
                    style="
                        width:100%;
                        max-width:720px;
                        max-height:90vh;
                        background:#ffffff;
                        border-radius:20px;
                        box-shadow:0 24px 80px rgba(15, 23, 42, 0.22);
                        border:1px solid #e2e8f0;
                        overflow:hidden;
                        display:flex;
                        flex-direction:column;
                    "
                >
                    <div style="padding:22px 22px 14px 22px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
                        <div>
                            <div style="font-size:18px; font-weight:800; color:#0f172a;">Reçete Düzenle</div>
                            <div id="productsRecipeSubtitle" style="margin-top:6px; font-size:14px; color:#475569;"></div>
                        </div>
                        <button class="btn btn-secondary" type="button" onclick="window.ProductsView.closeRecipeModal()" style="padding:6px 12px;">Kapat</button>
                    </div>

                    <div id="productsRecipeError" style="margin:12px 22px 0 22px; padding:10px 12px; border-radius:10px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:13px; font-weight:600; display:none;"></div>

                    <div style="padding:18px 22px; overflow-y:auto; flex:1;">
                        <div style="font-size:13px; font-weight:700; color:#334155; margin-bottom:8px;">Mevcut Reçete</div>
                        <div id="productsRecipeList" style="border:1px solid #e2e8f0; border-radius:12px; overflow:hidden;">
                            <div style="padding:16px; text-align:center; color:#64748b; font-size:13px;">Yükleniyor...</div>
                        </div>

                        <div style="margin-top:18px; padding-top:16px; border-top:1px dashed #e2e8f0;">
                            <div style="font-size:13px; font-weight:700; color:#334155; margin-bottom:8px;">Ham Madde Ekle</div>
                            <div style="display:grid; grid-template-columns: 2fr 1fr auto; gap:10px; align-items:end;">
                                <div class="form-group" style="margin-bottom:0;">
                                    <label class="form-label">Ham Madde</label>
                                    <select class="form-select" id="productsRecipeAddMaterial">
                                        <option value="">Yükleniyor...</option>
                                    </select>
                                </div>
                                <div class="form-group" style="margin-bottom:0;">
                                    <label class="form-label">Miktar</label>
                                    <input type="number" class="form-input" id="productsRecipeAddQty" placeholder="0" step="0.0001" min="0">
                                </div>
                                <div>
                                    <button class="btn btn-primary" type="button" id="productsRecipeAddBtn" onclick="window.ProductsView.addRecipeLine()">+ Ekle</button>
                                </div>
                            </div>
                            <div id="productsRecipeAddHint" style="margin-top:6px; font-size:12px; color:#64748b;"></div>
                        </div>
                    </div>

                    <div id="productsRecipeTotals" style="padding:14px 22px; border-top:1px solid #e2e8f0; background:#f8fafc; font-size:13px; color:#334155; display:flex; justify-content:space-between; align-items:center;">
                        <span>Toplam Maliyet</span>
                        <span id="productsRecipeTotalCost" style="font-weight:800; color:#0f172a;">₺0</span>
                    </div>
                </div>
            </div>
        `;

        await this.loadCategories();
        if (!this._isActive) return;
        await this.loadProducts();
        if (!this._isActive) return;
        this.initPurchase();

        var self = this;
        this._on(window, 'products:updated', async function () {
            if (!self._isActive) return;
            await self.loadProducts();
            if (!self._isActive) return;
        });
    },

    toggleForm: function (forceOpen) {
        var form = document.getElementById('productForm');
        if (!form) return;

        if (typeof forceOpen === 'boolean') {
            form.style.display = forceOpen ? 'block' : 'none';
            return;
        }

        form.style.display = form.style.display === 'none' ? 'block' : 'none';
    },

    cancelForm: function () {
        this.editingId = null;
        this.clearForm();
        this.setFormTitle();
        this.toggleForm(false);
    },

    setFormTitle: function () {
        var title = document.getElementById('productFormTitle');
        if (!title) return;
        title.textContent = this.editingId ? 'Ürün Düzenle' : 'Ürün Ekle';
    },

    loadCategories: async function () {
        var select = document.getElementById('productCategory');
        var filterSelect = document.getElementById('productCategoryFilter');

        try {
            var result = await window.SupabaseService.query('categories', {
                filters: [
                    { op: 'eq', column: 'type', value: 'product' }
                ],
                order: { column: 'name', asc: true }
            });
            if (!this._isActive) return;

            if (result.error) {
                this.categories = [];
                if (select) select.innerHTML = '<option value="">Kategori yüklenemedi</option>';
                if (filterSelect) filterSelect.innerHTML = '<option value="">Tüm kategoriler</option>';
                return;
            }

            this.categories = Array.isArray(result.data) ? result.data : [];

            if (this.categories.length === 0) {
                if (select) select.innerHTML = '<option value="">Henuz kategori yok — once kategori olustur</option>';
                if (filterSelect) filterSelect.innerHTML = '<option value="">Tum kategoriler</option>';
                return;
            }

            var optionsHtml = this.categories.map(function (category) {
                return '<option value="' + window.ProductsView.escapeHtml(category.id) + '">' + window.ProductsView.escapeHtml(category.name) + '</option>';
            }).join('');

            if (select) {
                select.innerHTML = '<option value="">Seciniz</option>' + optionsHtml;
            }

            if (filterSelect) {
                filterSelect.innerHTML = '<option value="">Tum kategoriler</option>' + optionsHtml;
            }
        } catch (error) {
            this.categories = [];
            if (select) select.innerHTML = '<option value="">Kategori yüklenemedi</option>';
            if (filterSelect) filterSelect.innerHTML = '<option value="">Tüm kategoriler</option>';
        }
    },

    loadProducts: async function () {
        var tbody = document.getElementById('productsTableBody');
        if (!tbody) return;

        try {
            if (!window.ProductsService || typeof window.ProductsService.getAll !== 'function') {
                tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:24px; color:#dc2626;">ProductsService yüklenemedi.</td></tr>';
                this.setStatus('ProductsService yüklenemedi.', 'error');
                return;
            }

            var perfStart = window.Formatters && typeof window.Formatters.monthStart === 'function'
                ? window.Formatters.monthStart() : null;
            var perfEnd = window.Formatters && typeof window.Formatters.today === 'function'
                ? window.Formatters.today() : null;

            var perfPromise;
            if (window.AnalyticsService && typeof window.AnalyticsService.getProductPerformanceSummary === 'function') {
                perfPromise = window.AnalyticsService.getProductPerformanceSummary(perfStart, perfEnd)
                    .then(function (data) { return { data: data, error: null }; })
                    .catch(function (err) { return { data: [], error: err }; });
            } else {
                perfPromise = Promise.resolve({ data: [], error: null });
            }

            var results = await Promise.all([
                window.ProductsService.getAll(),
                perfPromise
            ]);
            if (!this._isActive) return;

            var productResult = results[0];
            var performanceResult = results[1];

            if (productResult.error) {
                tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:24px; color:#dc2626;">Ürünler yüklenirken hata oluştu.</td></tr>';
                this.setStatus(this.getErrorMessage(productResult.error, 'Products tablosu okunamadı.'), 'error');
                return;
            }

            this.products = Array.isArray(productResult.data) ? productResult.data : [];
            this.performanceMap = new Map();

            if (!performanceResult.error && Array.isArray(performanceResult.data)) {
                for (var i = 0; i < performanceResult.data.length; i++) {
                    var item = performanceResult.data[i];
                    if (item && item.product_id) {
                        this.performanceMap.set(String(item.product_id), item);
                    }
                }
            }

            this.pagination.page = 1;
            this.applyFiltersAndRender();
            this.setStatus(this.products.length + ' ürün DB\'den yüklendi.', 'success');
        } catch (error) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata oluştu.</td></tr>';
            this.setStatus(this.getErrorMessage(error, 'Ürünler yüklenirken beklenmeyen hata oluştu.'), 'error');
        }
    },

    applyFiltersAndRender: function () {
        var rows = this.products.slice();

        if (this.filters.search) {
            var searchValue = this.normalizeName(this.filters.search);
            rows = rows.filter(function (product) {
                return window.ProductsView.normalizeName(product.name).indexOf(searchValue) !== -1;
            });
        }

        if (this.filters.categoryId) {
            rows = rows.filter(function (product) {
                return String(product.category_id || '') === String(window.ProductsView.filters.categoryId);
            });
        }

        var self = this;
        rows.sort(function (a, b) {
            return self.compareProducts(a, b);
        });

        this.filteredProducts = rows;
        this.ensurePageInRange();
        this.renderTable();
        this.renderPagination();
    },

    renderTable: function () {
        var tbody = document.getElementById('productsTableBody');
        if (!tbody) return;

        if (!this.filteredProducts.length) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:24px; color:#64748b;">Filtreye uygun ürün bulunamadı.</td></tr>';
            return;
        }

        var pageRows = this.getCurrentPageRows();

        tbody.innerHTML = pageRows.map(function (product) {
            var metrics = window.ProductsView.getProductMetrics(product);
            var name = window.ProductsView.escapeHtml(product.name || '-');
            var category = window.ProductsView.escapeHtml(window.ProductsView.getCategoryLabel(product.category_id, product));
            var price = window.ProductsView.formatMoney(product.price);
            var cost = window.ProductsView.formatMoney(product.cost);

            var marginAmount = window.ProductsView.calculateMarginAmount(product.price, product.cost);
            var marginRate = window.ProductsView.calculateMarginRate(product.price, product.cost);

            var isActive = product.is_active !== false;
            var rowStyle = isActive ? '' : 'style="opacity:0.55; background:#f8fafc;"';

            var statusBadge = isActive
                ? '<span style="padding:6px 10px; border-radius:999px; background:#ecfdf5; color:#166534; font-size:12px; font-weight:700;">Aktif</span>'
                : '<span style="padding:6px 10px; border-radius:999px; background:#f1f5f9; color:#475569; font-size:12px; font-weight:700;">Pasif</span>';

            var performanceBadge = window.ProductsView.renderPerformanceBadge(metrics);

            return '' +
                '<tr ' + rowStyle + '>' +
                    '<td>' + name + '</td>' +
                    '<td>' + category + '</td>' +
                    '<td>' + price + '</td>' +
                    '<td>' + cost + '</td>' +
                    '<td style="font-weight:700; color:' + marginAmount.color + ';">' + marginAmount.text + '</td>' +
                    '<td style="font-weight:700; color:' + marginRate.color + ';">' + marginRate.text + '</td>' +
                    '<td style="font-weight:700; color:#0f172a;">' + window.ProductsView.formatInteger(metrics.quantity) + '</td>' +
                    '<td style="font-weight:700; color:#0f172a;">' + window.ProductsView.formatMoney(metrics.revenue) + '</td>' +
                    '<td style="font-weight:700; color:' + (metrics.estimatedProfit >= 0 ? '#16a34a' : '#dc2626') + ';">' + window.ProductsView.formatMoney(metrics.estimatedProfit) + '</td>' +
                    '<td>' + performanceBadge + '</td>' +
                    '<td>' + statusBadge + '</td>' +
                    '<td>' +
                        '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
                            '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="window.ProductsView.editProduct(\'' + window.ProductsView.escapeHtml(product.id) + '\')">📌 Düzenle</button>' +
                            '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="window.ProductsView.openRecipeModal(\'' + window.ProductsView.escapeHtml(product.id) + '\')">🧪 Reçete</button>' +
                            '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="window.ProductsView.openToggleActiveModal(\'' + window.ProductsView.escapeHtml(product.id) + '\')">' + (isActive ? '📌 Pasif Yap' : '📌 Aktif Yap') + '</button>' +
                            '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px; color:#b91c1c;" onclick="window.ProductsView.openDeleteModal(\'' + window.ProductsView.escapeHtml(product.id) + '\')">📌 Sil</button>' +
                        '</div>' +
                    '</td>' +
                '</tr>';
        }).join('');
    },

    renderPagination: function () {
        var el = document.getElementById('productsPagination');
        if (!el) return;

        var total = this.filteredProducts.length;
        var pageSize = this.pagination.pageSize;
        var page = this.pagination.page;
        var totalPages = this.getTotalPages();
        var start = total === 0 ? 0 : ((page - 1) * pageSize) + 1;
        var end = Math.min(page * pageSize, total);

        el.innerHTML = '' +
            '<div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px; border:1px solid #e2e8f0; border-radius:16px; background:#ffffff;">' +
                '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
                    '<span style="font-size:13px; color:#475569; font-weight:600;">Sayfa başı kayıt</span>' +
                    '<select class="form-select" style="width:auto; min-width:110px;" onchange="window.ProductsView.changePageSize(this.value)">' +
                        '<option value="10" ' + (pageSize === 10 ? 'selected' : '') + '>10</option>' +
                        '<option value="30" ' + (pageSize === 30 ? 'selected' : '') + '>30</option>' +
                        '<option value="50" ' + (pageSize === 50 ? 'selected' : '') + '>50</option>' +
                        '<option value="100" ' + (pageSize === 100 ? 'selected' : '') + '>100</option>' +
                    '</select>' +
                '</div>' +
                '<div style="font-size:13px; color:#64748b; font-weight:600;">' + start + '-' + end + ' / ' + total + ' kayıt</div>' +
                '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">' +
                    '<button class="btn btn-secondary" type="button" onclick="window.ProductsView.prevPage()" ' + (page <= 1 ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : '') + '>Önceki</button>' +
                    '<span style="min-width:90px; text-align:center; font-size:13px; font-weight:700; color:#334155;">Sayfa ' + page + ' / ' + totalPages + '</span>' +
                    '<button class="btn btn-secondary" type="button" onclick="window.ProductsView.nextPage()" ' + (page >= totalPages ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : '') + '>Sonraki</button>' +
                '</div>' +
            '</div>';
    },

    getCurrentPageRows: function () {
        var start = (this.pagination.page - 1) * this.pagination.pageSize;
        var end = start + this.pagination.pageSize;
        return this.filteredProducts.slice(start, end);
    },

    getTotalPages: function () {
        var total = this.filteredProducts.length || 0;
        return Math.max(1, Math.ceil(total / this.pagination.pageSize));
    },

    ensurePageInRange: function () {
        var totalPages = this.getTotalPages();
        if (this.pagination.page > totalPages) this.pagination.page = totalPages;
        if (this.pagination.page < 1) this.pagination.page = 1;
    },

    changePageSize: function (value) {
        this.pagination.pageSize = Number(value) || 10;
        this.pagination.page = 1;
        this.renderTable();
        this.renderPagination();
    },

    prevPage: function () {
        if (this.pagination.page <= 1) return;
        this.pagination.page -= 1;
        this.renderTable();
        this.renderPagination();
    },

    nextPage: function () {
        var totalPages = this.getTotalPages();
        if (this.pagination.page >= totalPages) return;
        this.pagination.page += 1;
        this.renderTable();
        this.renderPagination();
    },

    compareProducts: function (a, b) {
        var dir = this.filters.sortDir === 'desc' ? -1 : 1;
        var sortBy = this.filters.sortBy;

        if (sortBy === 'name') {
            return this.normalizeName(a.name).localeCompare(this.normalizeName(b.name), 'tr') * dir;
        }

        if (sortBy === 'category') {
            return this.normalizeName(this.getCategoryLabel(a.category_id)).localeCompare(this.normalizeName(this.getCategoryLabel(b.category_id)), 'tr') * dir;
        }

        if (sortBy === 'price') {
            return ((Number(a.price) || 0) - (Number(b.price) || 0)) * dir;
        }

        if (sortBy === 'cost') {
            return ((Number(a.cost) || 0) - (Number(b.cost) || 0)) * dir;
        }

        if (sortBy === 'margin_amount') {
            return (this.getMarginAmountValue(a) - this.getMarginAmountValue(b)) * dir;
        }

        if (sortBy === 'margin_rate') {
            return (this.getMarginRateValue(a) - this.getMarginRateValue(b)) * dir;
        }

        if (sortBy === 'sales_qty') {
            return (this.getProductMetrics(a).quantity - this.getProductMetrics(b).quantity) * dir;
        }

        if (sortBy === 'revenue') {
            return (this.getProductMetrics(a).revenue - this.getProductMetrics(b).revenue) * dir;
        }

        if (sortBy === 'profit_est') {
            return (this.getProductMetrics(a).estimatedProfit - this.getProductMetrics(b).estimatedProfit) * dir;
        }

        return 0;
    },

    handleSearch: function (value) {
        this.filters.search = value || '';
        this.pagination.page = 1;
        this.applyFiltersAndRender();
    },

    handleCategoryFilter: function (categoryId) {
        this.filters.categoryId = categoryId || '';
        this.pagination.page = 1;
        this.applyFiltersAndRender();
    },

    handleSortSelect: function (value) {
        var parts = String(value || 'name-asc').split('-');
        this.filters.sortBy = parts[0] || 'name';
        this.filters.sortDir = parts[1] || 'asc';
        this.pagination.page = 1;
        this.applyFiltersAndRender();
    },

    setSort: function (column) {
        if (this.filters.sortBy === column) {
            this.filters.sortDir = this.filters.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.filters.sortBy = column;
            this.filters.sortDir = (column === 'name' || column === 'category') ? 'asc' : 'desc';
        }

        var sortSelect = document.getElementById('productSort');
        if (sortSelect) {
            sortSelect.value = this.filters.sortBy + '-' + this.filters.sortDir;
        }

        this.pagination.page = 1;
        this.applyFiltersAndRender();
    },

    getProductMetrics: function (product) {
        // Reads directly from the get_product_performance_summary RPC payload.
        // No manual client-side aggregation — the RPC already returns
        // quantity, revenue and estimated_profit using the historical cost
        // snapshot stored on product_sales.cost (not the current product.cost).
        var item = this.performanceMap.get(String(product && product.id ? product.id : '')) || null;
        var quantity = Number(item && item.quantity) || 0;
        var revenue = Number(item && item.revenue) || 0;
        var estimatedProfit = Number(item && item.estimated_profit) || 0;

        return {
            quantity: quantity,
            revenue: revenue,
            estimatedProfit: estimatedProfit
        };
    },

    renderPerformanceBadge: function (metrics) {
        if (metrics.quantity <= 0) {
            return '<span style="padding:6px 10px; border-radius:999px; background:#f8fafc; color:#64748b; font-size:12px; font-weight:700;">Satış Yok</span>';
        }

        if (metrics.quantity >= 20 && metrics.estimatedProfit <= 0) {
            return '<span style="padding:6px 10px; border-radius:999px; background:#fef2f2; color:#991b1b; font-size:12px; font-weight:700;">Çok Satıyor / Zayıf Kar</span>';
        }

        if (metrics.quantity <= 5 && metrics.estimatedProfit > 0) {
            return '<span style="padding:6px 10px; border-radius:999px; background:#eff6ff; color:#1d4ed8; font-size:12px; font-weight:700;">Az Satıyor / Güçlü Kar</span>';
        }

        if (metrics.estimatedProfit > 0) {
            return '<span style="padding:6px 10px; border-radius:999px; background:#ecfdf5; color:#166534; font-size:12px; font-weight:700;">Sağlıklı</span>';
        }

        return '<span style="padding:6px 10px; border-radius:999px; background:#fff7ed; color:#c2410c; font-size:12px; font-weight:700;">İzlenmeli</span>';
    },

    openCategoryModal: function () {
        this.openModal({
            type: 'input',
            title: 'Yeni Kategori Ekle',
            message: 'Ürün kategorisini girin.',
            inputLabel: 'Kategori Adı',
            inputValue: '',
            confirmText: 'Kaydet',
            cancelText: 'Vazgeç',
            onConfirm: async function (value) {
                var cleanedName = String(value || '').trim();

                if (!cleanedName) {
                    window.ProductsView.setModalError('Kategori adı boş olamaz.');
                    return false;
                }

                var exists = window.ProductsView.categories.some(function (category) {
                    return window.ProductsView.normalizeName(category.name) === window.ProductsView.normalizeName(cleanedName);
                });

                if (exists) {
                    window.ProductsView.setModalError('Bu kategori zaten var.');
                    return false;
                }

                var payload = {
                    name: cleanedName,
                    type: 'product'
                };

                var result = await window.SupabaseService.insert('categories', payload);
                if (!window.ProductsView._isActive) return false;

                if (result.error) {
                    window.ProductsView.setModalError(window.ProductsView.getErrorMessage(result.error, 'Kategori eklenemedi.'));
                    return false;
                }

                await window.ProductsView.loadCategories();
                if (!window.ProductsView._isActive) return false;
                window.ProductsView.setStatus('"' + cleanedName + '" kategorisi eklendi.', 'success');
                return true;
            }
        });
    },

    openToggleActiveModal: function (id) {
        var product = this.products.find(function (item) {
            return String(item.id) === String(id);
        });

        if (!product) {
            this.setStatus('Ürün bulunamadı.', 'error');
            return;
        }

        var nextValue = product.is_active === false;
        var title = nextValue ? 'Ürünü Aktif Yap' : 'Ürünü Pasif Yap';
        var message = nextValue
            ? '"' + product.name + '" ürünü tekrar aktif olsun mu?'
            : '"' + product.name + '" ürünü pasif yapılsın mı?';

        this.openModal({
            type: 'confirm',
            title: title,
            message: message,
            confirmText: 'Onayla',
            cancelText: 'Vazgeç',
            onConfirm: async function () {
                var result = await window.ProductsService.update(product.id, {
                    is_active: nextValue
                });
                if (!window.ProductsView._isActive) return false;

                if (result.error) {
                    window.ProductsView.setModalError(window.ProductsView.getErrorMessage(result.error, 'Ürün durumu güncellenemedi.'));
                    return false;
                }

                await window.ProductsView.loadProducts();
                if (!window.ProductsView._isActive) return false;
                window.ProductsView.setStatus('"' + product.name + '" durumu güncellendi.', 'success');
                return true;
            }
        });
    },

    openDeleteModal: function (id) {
        var product = this.products.find(function (item) {
            return String(item.id) === String(id);
        });

        if (!product) {
            this.setStatus('Ürün bulunamadı.', 'error');
            return;
        }

        this.openModal({
            type: 'confirm',
            title: 'Ürünü Sil',
            message: '"' + product.name + '" ürünü soft delete ile kaldırılacak. Devam edilsin mi?',
            confirmText: 'Sil',
            cancelText: 'Vazgeç',
            onConfirm: async function () {
                var result = await window.SupabaseService.softDelete('products', product.id);
                if (!window.ProductsView._isActive) return false;

                if (result.error) {
                    window.ProductsView.setModalError(window.ProductsView.getErrorMessage(result.error, 'Ürün silinemedi.'));
                    return false;
                }

                await window.ProductsView.loadProducts();
                if (!window.ProductsView._isActive) return false;
                window.ProductsView.setStatus('"' + product.name + '" soft delete ile kaldırıldı.', 'success');
                return true;
            }
        });
    },

    openModal: function (config) {
        this.modalState = {
            open: true,
            type: config.type || 'confirm',
            title: config.title || 'İşlem',
            message: config.message || '',
            inputLabel: config.inputLabel || '',
            inputValue: config.inputValue || '',
            confirmText: config.confirmText || 'Tamam',
            cancelText: config.cancelText || 'İptal',
            onConfirm: typeof config.onConfirm === 'function' ? config.onConfirm : null
        };

        var overlay = document.getElementById('productsModalOverlay');
        var title = document.getElementById('productsModalTitle');
        var message = document.getElementById('productsModalMessage');
        var body = document.getElementById('productsModalBody');
        var inputLabel = document.getElementById('productsModalInputLabel');
        var input = document.getElementById('productsModalInput');
        var confirmBtn = document.getElementById('productsModalConfirmBtn');
        var cancelBtn = document.getElementById('productsModalCancelBtn');
        var error = document.getElementById('productsModalError');

        if (!overlay || !title || !message || !body || !inputLabel || !input || !confirmBtn || !cancelBtn || !error) {
            return;
        }

        title.textContent = this.modalState.title;
        message.textContent = this.modalState.message;
        inputLabel.textContent = this.modalState.inputLabel || 'Değer';
        input.value = this.modalState.inputValue || '';
        confirmBtn.textContent = this.modalState.confirmText;
        cancelBtn.textContent = this.modalState.cancelText;
        error.style.display = 'none';
        error.textContent = '';

        body.style.display = this.modalState.type === 'input' ? 'block' : 'none';

        if (this.modalState.type === 'input') {
            setTimeout(function () {
                input.focus();
            }, 30);
        }

        overlay.style.display = 'flex';
    },

    closeModal: function () {
        this.modalState = {
            open: false,
            type: '',
            title: '',
            message: '',
            inputLabel: '',
            inputValue: '',
            confirmText: 'Tamam',
            cancelText: 'İptal',
            onConfirm: null
        };

        var overlay = document.getElementById('productsModalOverlay');
        var error = document.getElementById('productsModalError');
        var input = document.getElementById('productsModalInput');

        if (overlay) overlay.style.display = 'none';
        if (error) {
            error.style.display = 'none';
            error.textContent = '';
        }
        if (input) input.value = '';
    },

    handleOverlayClick: function (event) {
        var overlay = document.getElementById('productsModalOverlay');
        if (event.target === overlay) {
            this.closeModal();
        }
    },

    confirmModal: async function () {
        if (typeof this.modalState.onConfirm !== 'function') {
            this.closeModal();
            return;
        }

        var confirmBtn = document.getElementById('productsModalConfirmBtn');
        var input = document.getElementById('productsModalInput');

        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.7';
            confirmBtn.textContent = 'İşleniyor...';
        }

        try {
            var result = await this.modalState.onConfirm(
                this.modalState.type === 'input' ? (input ? input.value : '') : null
            );
            if (!this._isActive) return;

            if (result === true) {
                this.closeModal();
            }
        } catch (error) {
            this.setModalError(this.getErrorMessage(error, 'İşlem tamamlanamadı.'));
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.style.opacity = '1';
                confirmBtn.textContent = this.modalState.confirmText || 'Tamam';
            }
        }
    },

    setModalError: function (message) {
        var error = document.getElementById('productsModalError');
        if (!error) return;

        error.textContent = message || 'Bir hata oluştu.';
        error.style.display = 'block';
    },

    /* ============================================================
       RECIPE EDITOR
       ============================================================ */

    openRecipeModal: async function (id) {
        var product = this.products.find(function (item) {
            return String(item.id) === String(id);
        });

        if (!product) {
            this.setStatus('Ürün bulunamadı.', 'error');
            return;
        }

        this.recipeState = {
            open: true,
            productId: product.id,
            productName: product.name || '',
            recipes: [],
            rawMaterials: [],
            loading: true,
            saving: false,
            error: ''
        };

        var overlay = document.getElementById('productsRecipeOverlay');
        var subtitle = document.getElementById('productsRecipeSubtitle');
        if (subtitle) {
            subtitle.textContent = this.recipeState.productName;
        }
        this.setRecipeError('');
        this.renderRecipeList();
        this.renderRawMaterialSelect();

        if (overlay) overlay.style.display = 'flex';

        try {
            await this.loadRecipesAndMaterials();
        } catch (error) {
            this.setRecipeError(this.getErrorMessage(error, 'Reçete yüklenemedi.'));
        }
    },

    closeRecipeModal: function () {
        this.recipeState = {
            open: false,
            productId: null,
            productName: '',
            recipes: [],
            rawMaterials: [],
            loading: false,
            saving: false,
            error: ''
        };

        var overlay = document.getElementById('productsRecipeOverlay');
        if (overlay) overlay.style.display = 'none';

        var qty = document.getElementById('productsRecipeAddQty');
        if (qty) qty.value = '';
    },

    handleRecipeOverlayClick: function (event) {
        var overlay = document.getElementById('productsRecipeOverlay');
        if (event.target === overlay) {
            this.closeRecipeModal();
        }
    },

    loadRecipesAndMaterials: async function () {
        var productId = this.recipeState.productId;
        if (!productId) return;

        this.recipeState.loading = true;

        var results = await Promise.all([
            window.SupabaseService.query('product_recipes', {
                filters: [
                    { op: 'eq', column: 'is_deleted', value: false },
                    { op: 'eq', column: 'product_id', value: productId }
                ],
                select: 'id,product_id,raw_material_id,quantity,raw_material:raw_materials(id,name,unit,cost,is_deleted)',
                order: { column: 'created_at', asc: true }
            }),
            window.SupabaseService.query('raw_materials', {
                filters: [
                    { op: 'eq', column: 'is_deleted', value: false },
                    { op: 'eq', column: 'is_active', value: true }
                ],
                select: 'id,name,unit,cost',
                order: { column: 'name', asc: true }
            })
        ]);

        if (!this._isActive || !this.recipeState.open) return;

        var recipeResult = results[0];
        var materialResult = results[1];

        if (recipeResult.error) {
            throw recipeResult.error;
        }
        if (materialResult.error) {
            throw materialResult.error;
        }

        var recipes = Array.isArray(recipeResult.data) ? recipeResult.data : [];
        // Embed'de soft-delete edilmiş raw_material kayıtları gelirse filtrele.
        recipes = recipes.filter(function (r) {
            return !r.raw_material || r.raw_material.is_deleted !== true;
        });

        this.recipeState.recipes = recipes;
        this.recipeState.rawMaterials = Array.isArray(materialResult.data) ? materialResult.data : [];
        this.recipeState.loading = false;

        this.renderRecipeList();
        this.renderRawMaterialSelect();
    },

    renderRecipeList: function () {
        var list = document.getElementById('productsRecipeList');
        var totalEl = document.getElementById('productsRecipeTotalCost');
        if (!list) return;

        if (this.recipeState.loading) {
            list.innerHTML = '<div style="padding:16px; text-align:center; color:#64748b; font-size:13px;">Yükleniyor...</div>';
            if (totalEl) totalEl.textContent = this.formatMoney(0);
            return;
        }

        var recipes = this.recipeState.recipes || [];

        if (recipes.length === 0) {
            list.innerHTML = '<div style="padding:20px; text-align:center; color:#64748b; font-size:13px;">Bu ürün için henüz reçete satırı yok.</div>';
            if (totalEl) totalEl.textContent = this.formatMoney(0);
            return;
        }

        var total = 0;
        var self = this;

        var html = '<table class="data-table" style="margin:0;"><thead><tr>' +
            '<th>Ham Madde</th>' +
            '<th style="text-align:right;">Miktar</th>' +
            '<th style="text-align:right;">Birim Maliyet</th>' +
            '<th style="text-align:right;">Satır Maliyeti</th>' +
            '<th style="width:100px;">İşlem</th>' +
            '</tr></thead><tbody>';

        html += recipes.map(function (r) {
            var mat = r.raw_material || {};
            var quantity = Number(r.quantity) || 0;
            var unitCost = Number(mat.cost) || 0;
            var lineCost = quantity * unitCost;
            total += lineCost;

            var name = self.escapeHtml(mat.name || '(Silinmiş ham madde)');
            var unit = self.escapeHtml(mat.unit || '');
            var qtyText = self.formatQuantity(quantity) + (unit ? ' ' + unit : '');

            return '<tr>' +
                '<td>' + name + '</td>' +
                '<td style="text-align:right;">' + qtyText + '</td>' +
                '<td style="text-align:right;">' + self.formatMoney(unitCost) + '</td>' +
                '<td style="text-align:right; font-weight:700;">' + self.formatMoney(lineCost) + '</td>' +
                '<td>' +
                    '<button class="btn btn-secondary" style="padding:4px 8px; font-size:12px; color:#b91c1c;" onclick="window.ProductsView.removeRecipeLine(\'' + self.escapeHtml(r.id) + '\')">Kaldır</button>' +
                '</td>' +
                '</tr>';
        }).join('');

        html += '</tbody></table>';

        list.innerHTML = html;
        if (totalEl) totalEl.textContent = this.formatMoney(total);
    },

    renderRawMaterialSelect: function () {
        var select = document.getElementById('productsRecipeAddMaterial');
        var hint = document.getElementById('productsRecipeAddHint');
        if (!select) return;

        var materials = this.recipeState.rawMaterials || [];

        if (this.recipeState.loading) {
            select.innerHTML = '<option value="">Yükleniyor...</option>';
            if (hint) hint.textContent = '';
            return;
        }

        if (materials.length === 0) {
            select.innerHTML = '<option value="">Ham madde kaydı yok</option>';
            if (hint) hint.textContent = 'Önce "Ham Maddeler" ekranından ham madde oluşturmalısın.';
            return;
        }

        // Zaten reçetede olan ham maddeleri dropdown\'dan çıkar (unique constraint korunsun).
        var usedIds = {};
        (this.recipeState.recipes || []).forEach(function (r) {
            if (r.raw_material_id) usedIds[String(r.raw_material_id)] = true;
        });

        var self = this;
        var options = '<option value="">Seçiniz</option>';
        var availableCount = 0;

        materials.forEach(function (m) {
            if (usedIds[String(m.id)]) return;
            availableCount++;
            var label = self.escapeHtml(m.name) +
                ' (' + self.escapeHtml(m.unit || '') + ' · ' + self.formatMoney(m.cost) + ')';
            options += '<option value="' + self.escapeHtml(m.id) + '">' + label + '</option>';
        });

        select.innerHTML = options;

        if (hint) {
            hint.textContent = availableCount === 0
                ? 'Tüm aktif ham maddeler zaten bu reçetede.'
                : '';
        }
    },

    addRecipeLine: async function () {
        if (this.recipeState.saving) return;

        var productId = this.recipeState.productId;
        var selectEl = document.getElementById('productsRecipeAddMaterial');
        var qtyEl = document.getElementById('productsRecipeAddQty');
        var btn = document.getElementById('productsRecipeAddBtn');

        if (!productId || !selectEl || !qtyEl) return;

        var rawMaterialId = selectEl.value;
        var quantity = Number(qtyEl.value);

        if (!rawMaterialId) {
            this.setRecipeError('Ham madde seçmelisin.');
            return;
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            this.setRecipeError('Miktar 0\'dan büyük olmalı.');
            return;
        }

        // İstemci tarafı duplicate guard — unique index ayrıca DB\'de de koruyor.
        var duplicate = (this.recipeState.recipes || []).some(function (r) {
            return String(r.raw_material_id) === String(rawMaterialId);
        });
        if (duplicate) {
            this.setRecipeError('Bu ham madde zaten reçetede.');
            return;
        }

        this.setRecipeError('');
        this.recipeState.saving = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Ekleniyor...';
        }

        try {
            var payload = {
                product_id: productId,
                raw_material_id: rawMaterialId,
                quantity: quantity
            };

            var result = await window.SupabaseService.insert('product_recipes', payload);
            if (!this._isActive || !this.recipeState.open) return;

            if (result.error) {
                this.setRecipeError(this.getErrorMessage(result.error, 'Reçete satırı eklenemedi.'));
                return;
            }

            qtyEl.value = '';
            selectEl.value = '';

            await this.loadRecipesAndMaterials();
            if (!this._isActive || !this.recipeState.open) return;

            // Ürün listesindeki cost güncellenmiş olabilir (trigger) — tabloyu yenile.
            await this.loadProducts();
        } catch (error) {
            this.setRecipeError(this.getErrorMessage(error, 'Reçete satırı eklenemedi.'));
        } finally {
            this.recipeState.saving = false;
            if (btn) {
                btn.disabled = false;
                btn.textContent = '+ Ekle';
            }
        }
    },

    removeRecipeLine: async function (recipeId) {
        if (!recipeId || this.recipeState.saving) return;

        this.setRecipeError('');
        this.recipeState.saving = true;

        try {
            var result = await window.SupabaseService.update('product_recipes', recipeId, {
                is_deleted: true
            });
            if (!this._isActive || !this.recipeState.open) return;

            if (result.error) {
                this.setRecipeError(this.getErrorMessage(result.error, 'Reçete satırı kaldırılamadı.'));
                return;
            }

            await this.loadRecipesAndMaterials();
            if (!this._isActive || !this.recipeState.open) return;

            await this.loadProducts();
        } catch (error) {
            this.setRecipeError(this.getErrorMessage(error, 'Reçete satırı kaldırılamadı.'));
        } finally {
            this.recipeState.saving = false;
        }
    },

    setRecipeError: function (message) {
        var el = document.getElementById('productsRecipeError');
        if (!el) return;

        if (!message) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }

        el.textContent = message;
        el.style.display = 'block';
    },

    formatQuantity: function (value) {
        var number = Number(value) || 0;
        return number.toLocaleString('tr-TR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 4
        });
    },

    /* ============================================================
       PRODUCT FORM
       ============================================================ */

    editProduct: function (id) {
        var product = this.products.find(function (item) {
            return String(item.id) === String(id);
        });

        if (!product) {
            this.setStatus('Ürün bulunamadı.', 'error');
            return;
        }

        this.editingId = product.id;
        this.setFormTitle();

        var name = document.getElementById('productName');
        var category = document.getElementById('productCategory');
        var price = document.getElementById('productPrice');
        var costInfo = document.getElementById('productCostInfo');

        if (name) name.value = product.name || '';
        if (category) category.value = product.category_id || '';
        if (price) price.value = Number(product.price) || 0;
        if (costInfo) costInfo.value = this.formatMoney(product.cost);

        this.setRecipeButtonEnabled(true);

        this.toggleForm(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    openRecipeForCurrentEditing: function () {
        if (!this.editingId) {
            this.setStatus('Önce ürünü kaydet, sonra reçete düzenleyebilirsin.', 'error');
            return;
        }
        this.openRecipeModal(this.editingId);
    },

    setRecipeButtonEnabled: function (enabled) {
        var btn = document.getElementById('productOpenRecipeBtn');
        if (!btn) return;
        if (enabled) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.title = 'Bu ürünün reçetesini düzenle.';
        } else {
            btn.disabled = true;
            btn.style.opacity = '0.55';
            btn.style.cursor = 'not-allowed';
            btn.title = 'Önce ürünü kaydet, sonra reçete düzenleyebilirsin.';
        }
    },

    save: async function () {
        if (!this.categories || this.categories.length === 0) {
            this.setStatus('Kategori yukleniyor, lutfen bekleyin...', 'error');
            return;
        }

        var categoryEl = document.getElementById('productCategory');
        var categoryId = categoryEl ? (categoryEl.value || null) : null;
        var selectedCat = (this.categories || []).find(function (c) { return c.id === categoryId; });

        var payload = {
            name: document.getElementById('productName') ? document.getElementById('productName').value.trim() : '',
            category_id: categoryId,
            category_name: selectedCat ? selectedCat.name : null,
            price: parseFloat(document.getElementById('productPrice') ? document.getElementById('productPrice').value : 0) || 0
        };

        var errors = [];

        if (!payload.name) errors.push('Ürün adı zorunludur.');
        if (!payload.category_id) errors.push('Kategori seçmelisiniz.');
        if (payload.price <= 0) errors.push('Satış tutarı 0’dan büyük olmalıdır.');

        if (errors.length > 0) {
            this.setStatus(errors.join(' '), 'error');
            return;
        }

        if (!window.SupabaseService || !window.SupabaseService.isConnected()) {
            this.setStatus('Supabase bağlı değil. Ürün kaydedilemedi.', 'error');
            return;
        }

        if (!window.ProductsService || typeof window.ProductsService.create !== 'function' || typeof window.ProductsService.update !== 'function') {
            this.setStatus('ProductsService yüklenemedi.', 'error');
            return;
        }

        var duplicate = this.products.some(function (item) {
            if (window.ProductsView.editingId && String(item.id) === String(window.ProductsView.editingId)) {
                return false;
            }
            return window.ProductsView.normalizeName(item.name) === window.ProductsView.normalizeName(payload.name);
        });

        if (duplicate) {
            this.setStatus('Aynı isimde ürün zaten var.', 'error');
            return;
        }

        var response;

        if (this.editingId) {
            response = await window.ProductsService.update(this.editingId, payload);
        } else {
            response = await window.ProductsService.create(payload);
        }
        if (!this._isActive) return;

        if (response && response.error) {
            this.setStatus(this.getErrorMessage(response.error, 'Ürün kaydedilemedi.'), 'error');
            return;
        }

        this.setStatus(this.editingId ? 'Ürün güncellendi.' : 'Ürün kaydedildi.', 'success');
        this.editingId = null;
        this.clearForm();
        this.setFormTitle();
        this.toggleForm(false);
        await this.loadProducts();
        if (!this._isActive) return;
    },

    clearForm: function () {
        var name = document.getElementById('productName');
        var category = document.getElementById('productCategory');
        var price = document.getElementById('productPrice');
        var costInfo = document.getElementById('productCostInfo');

        if (name) name.value = '';
        if (category) category.value = '';
        if (price) price.value = '';
        if (costInfo) costInfo.value = '—';

        this.setRecipeButtonEnabled(false);
    },

    getCategoryLabel: function (categoryId, product) {
        if (!categoryId) return '-';
        var found = this.categories.find(function (item) {
            return String(item.id) === String(categoryId);
        });
        if (found && found.name) return found.name;
        if (product && product.category_name) return product.category_name;
        return '-';
    },

    getMarginAmountValue: function (product) {
        var price = Number(product.price) || 0;
        var cost = Number(product.cost) || 0;
        return price - cost;
    },

    getMarginRateValue: function (product) {
        var price = Number(product.price) || 0;
        var cost = Number(product.cost) || 0;
        if (price <= 0) return 0;
        return ((price - cost) / price) * 100;
    },

    calculateMarginAmount: function (price, cost) {
        var value = (Number(price) || 0) - (Number(cost) || 0);
        if (value > 0) return { text: this.formatMoney(value), color: '#16a34a' };
        if (value === 0) return { text: this.formatMoney(value), color: '#64748b' };
        return { text: this.formatMoney(value), color: '#dc2626' };
    },

    calculateMarginRate: function (price, cost) {
        var p = Number(price) || 0;
        var c = Number(cost) || 0;

        if (p <= 0) {
            return { text: '-', color: '#64748b' };
        }

        var rate = Math.round(((p - c) / p) * 100);

        if (rate >= 60) return { text: '%' + rate, color: '#16a34a' };
        if (rate >= 40) return { text: '%' + rate, color: '#f59e0b' };
        if (rate >= 0) return { text: '%' + rate, color: '#dc2626' };
        return { text: '%' + rate, color: '#991b1b' };
    },

    getErrorMessage: function (error, fallback) {
        if (!error) return fallback || 'Bilinmeyen hata oluştu.';
        if (typeof error === 'string') return error;
        if (typeof error.message === 'string' && error.message.trim()) return error.message;
        if (typeof error.error_description === 'string' && error.error_description.trim()) return error.error_description;
        if (typeof error.details === 'string' && error.details.trim()) return error.details;
        if (typeof error.hint === 'string' && error.hint.trim()) return error.hint;

        try {
            return JSON.stringify(error);
        } catch (_) {
            return fallback || 'Bilinmeyen hata oluştu.';
        }
    },

    formatMoney: function (value) {
        var number = Number(value) || 0;
        return '₺' + number.toLocaleString('tr-TR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
    },

    formatInteger: function (value) {
        var number = Number(value) || 0;
        return number.toLocaleString('tr-TR', {
            maximumFractionDigits: 0
        });
    },

    normalizeName: function (value) {
        return String(value || '')
            .trim()
            .toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i')
            .replace(/ğ/g, 'g')
            .replace(/ü/g, 'u')
            .replace(/ş/g, 's')
            .replace(/ö/g, 'o')
            .replace(/ç/g, 'c')
            .replace(/\s+/g, ' ');
    },

    setStatus: function (message, type) {
        var el = document.getElementById('productsStatus');
        if (!el) return;

        if (type === 'success') {
            el.innerHTML = '<div style="padding:14px 16px; border-radius:14px; background:#ecfdf5; border:1px solid #86efac; color:#166534; font-size:14px; font-weight:600;">' + this.escapeHtml(message) + '</div>';
            return;
        }

        el.innerHTML = '<div style="padding:14px 16px; border-radius:14px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:14px; font-weight:600;">' + this.escapeHtml(message) + '</div>';
    },

    _on: function (el, event, fn) {
        if (!el) return;
        el.addEventListener(event, fn);
        this._listeners.push({ el: el, event: event, fn: fn });
    },

    _removeAllListeners: function () {
        for (var i = 0; i < this._listeners.length; i++) {
            var l = this._listeners[i];
            l.el.removeEventListener(l.event, l.fn);
        }
        this._listeners = [];
    },

    destroy: function () {
        this._isActive = false;
        this._removeAllListeners();
        this.products = [];
        this.filteredProducts = [];
        this.categories = [];
        this.performanceMap = new Map();
        this.editingId = null;
        this.closeRecipeModal();
    },

    initPurchase: function () {
        var self = this;

        var modal = document.getElementById('purchaseModal');
        var btnOpen = document.getElementById('openPurchaseModal');

        if (!modal || !btnOpen) return;

        var productSelect = document.getElementById('purchaseProduct');
        var qtyInput = document.getElementById('purchaseQty');
        var unitInput = document.getElementById('purchaseUnit');
        var totalInput = document.getElementById('purchaseTotal');
        var vatSelect = document.getElementById('purchaseVat');

        var btnSave = document.getElementById('purchaseSave');
        var btnClose = document.getElementById('purchaseClose');

        this._on(btnOpen, 'click', async function () {
            self.currentPurchaseKey = crypto.randomUUID();
            modal.style.display = 'flex';

            var res = await window.SupabaseService.query('products', {
                filters: [
                    { op: 'eq', column: 'is_active', value: true }
                ],
                select: 'id,name'
            });
            if (!self._isActive) return;

            if (productSelect) {
                productSelect.innerHTML = '';

                ((res && res.data) || []).forEach(function (p) {
                    var opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name;
                    productSelect.appendChild(opt);
                });
            }
        });

        this._on(btnClose, 'click', function () {
            modal.style.display = 'none';
            self.currentPurchaseKey = null;
            qtyInput.value = '';
            unitInput.value = '';
            totalInput.value = '';
            updateSummary();
        });

        var summarySubtotal = document.getElementById('purchaseSummarySubtotal');
        var summaryVat = document.getElementById('purchaseSummaryVat');
        var summaryTotal = document.getElementById('purchaseSummaryTotal');

        function updateSummary() {
            var qty = Number(qtyInput.value) || 0;
            var unit = Number(unitInput.value) || 0;
            var total = Number(totalInput.value) || 0;
            var vat = Number(vatSelect.value) || 0;

            var subtotal = (qty > 0 && unit > 0) ? (qty * unit) : total;
            var vatAmount = subtotal * (vat / 100);
            var grandTotal = subtotal + vatAmount;

            if (summarySubtotal) summarySubtotal.textContent = subtotal.toFixed(2) + ' TL';
            if (summaryVat) summaryVat.textContent = vatAmount.toFixed(2) + ' TL';
            if (summaryTotal) summaryTotal.textContent = grandTotal.toFixed(2) + ' TL';
        }

        function recalculate(source) {
            var qty = Number(qtyInput.value) || 0;
            var unit = Number(unitInput.value) || 0;
            var total = Number(totalInput.value) || 0;

            if (source === 'total' && qty > 0 && total > 0) {
                unitInput.value = (total / qty).toFixed(2);
            } else if (source === 'unit' && qty > 0 && unit > 0) {
                totalInput.value = (unit * qty).toFixed(2);
            } else if (source === 'qty') {
                if (unit > 0) {
                    totalInput.value = (unit * qty).toFixed(2);
                } else if (total > 0 && qty > 0) {
                    unitInput.value = (total / qty).toFixed(2);
                }
            }

            updateSummary();
        }

        this._on(qtyInput, 'input', function () { recalculate('qty'); });
        this._on(unitInput, 'input', function () { recalculate('unit'); });
        this._on(totalInput, 'input', function () { recalculate('total'); });
        this._on(vatSelect, 'change', function () { updateSummary(); });

        var saving = false;

        this._on(btnSave, 'click', async function () {
            if (saving) return;

            var qty = Number(qtyInput.value);
            var total = Number(totalInput.value);

            if (isNaN(qty) || isNaN(total) || qty <= 0 || total <= 0) {
                window.ProductsView.setStatus('Lutfen gecerli sayisal degerler girin.', 'error');
                return;
            }

            if (!productSelect.value) {
                window.ProductsView.setStatus('Lutfen bir urun secin.', 'error');
                return;
            }

            saving = true;
            btnSave.disabled = true;
            btnSave.textContent = 'Kaydediliyor...';

            try {
                await window.PurchasesService.createPurchase({
                    product_id: productSelect.value,
                    quantity: qty,
                    total_price: total,
                    vat_rate: vatSelect.value,
                    idempotency_key: self.currentPurchaseKey
                });
                if (!self._isActive) return;

                self.currentPurchaseKey = null;
                window.ProductsView.setStatus('Alis kaydedildi.', 'success');
                modal.style.display = 'none';

                qtyInput.value = '';
                unitInput.value = '';
                totalInput.value = '';
                updateSummary();
            } catch (err) {
                if (!self._isActive) return;
                window.ProductsView.setStatus('Kayit hatasi: ' + (err && err.message ? err.message : 'Bilinmeyen hata'), 'error');
            } finally {
                saving = false;
                btnSave.disabled = false;
                btnSave.textContent = 'Kaydet';
            }
        });
    },

    escapeHtml: function (value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
};
