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

        // Original snapshot (DB'den gelen, immutable). Dirty check icin.
        originalRecipes: [], // [{id, raw_material_id, quantity, raw_material:{...}}]

        // Draft (kullanici duzenler, sadece Kaydet'te DB'ye yazilir)
        // [{tempId, recipeId, raw_material_id, quantity, raw_material:{name,unit,cost}, _state:'unchanged'|'new'|'modified'|'removed'}]
        draftRecipes: [],

        rawMaterials: [],
        loading: false,
        saving: false,
        error: ''
    },
    _recipeTempCounter: 0,

    _activeTab: 'products',
    _tabsRendered: { 'raw-materials': false, 'purchase': false },

    // Raw materials tab state
    rmState: {
        materials: [],
        editingId: null,
        search: '',
        page: 1,
        pageSize: 30,
        UNITS: ['gr', 'kg', 'ml', 'lt', 'cl', 'adet', 'paket'],
        // history panel
        historyOpen: false,
        historyMaterial: null,      // {id, name, unit, cost}
        historyRows: [],
        historyFilter: {
            startDate: '',
            endDate: '',
            sortBy: 'date-desc'
        }
    },

    // Purchase tab state (invoice / multi-line)
    purchaseState: {
        rawMaterials: [],
        purchases: [],          // recent (filtered+paged görünen)
        purchasesAll: [],       // recent (server'dan çekilen tam liste, filtre öncesi)
        lines: [],              // draft invoice lines: [{_k, rmId, qty, unitCost, discount, vat, total, lastEdited}]
        saving: false,
        vatIncluded: false,     // global toggle: fiyatlar KDV dahil mi?
        searchById: {},
        recipeOpen: false,
        supplierName: '',       // fatura tedarikçi (UI only)
        description: '',        // fatura açıklama (UI only)
        // Genel iskonto (fatura geneli, KDV oncesi uygulanir)
        generalDiscount: {
            type: 'amount',     // 'amount' (TL) | 'percent' (%)
            value: 0
        },
        editingItemId: null,    // (legacy) tek satır düzenleme — artık kullanılmıyor
        editingInvoiceId: null, // düzenleme modu (fatura)
        editingOriginalIds: [], // düzenlenen faturadaki orijinal item id'leri (UPDATE/DELETE için)
        recentFilter: {
            startDate: '',
            endDate: '',
            page: 1,
            pageSize: 20
        }
    },

    _puDebounceTimer: null,     // input debounce handle

    _puLineKey: 1,

    async render(container) {
        // NOVA_DEBUG (Faz O1-A): view render tracker
        if (window.NOVA_DEBUG && window.NOVA_DEBUG.view) window.NOVA_DEBUG.view.track('products');
        this._isActive = true;
        this._activeTab = 'products';
        this._tabsRendered = { 'raw-materials': false, 'purchase': false };

        container.innerHTML = `
            <div class="products-tabs" style="display:flex; gap:6px; padding:6px; background:#f1f5f9; border-radius:14px; margin-bottom:16px; width:fit-content;">
                <button type="button" data-ptab="products" onclick="window.ProductsView.switchTab('products')"
                    style="padding:10px 20px; border:none; border-radius:10px; font-size:14px; font-weight:700; cursor:pointer; background:#0f172a; color:#fff; transition:all .15s;">
                    ÜRÜNLER
                </button>
                <button type="button" data-ptab="raw-materials" onclick="window.ProductsView.switchTab('raw-materials')"
                    style="padding:10px 20px; border:none; border-radius:10px; font-size:14px; font-weight:700; cursor:pointer; background:transparent; color:#475569; transition:all .15s;">
                    HAMMADDELER
                </button>
                <button type="button" data-ptab="purchase" onclick="window.ProductsView.switchTab('purchase')"
                    style="padding:10px 20px; border:none; border-radius:10px; font-size:14px; font-weight:700; cursor:pointer; background:transparent; color:#475569; transition:all .15s;">
                    ALIŞ
                </button>
            </div>

            <div id="productsPaneRawMaterials" style="display:none;"></div>
            <div id="productsPanePurchase" style="display:none;"></div>

            <div id="productsPaneProducts">

            <div id="productsInsightsPanel" style="margin:0 0 14px 0;"></div>

            <div class="page-header">
                <h2 class="page-title">Ürünler</h2>
                <button class="btn btn-primary" onclick="window.ProductsView.toggleForm()">
                    + Yeni Ürün Ekle
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
                        <label class="form-label">Satış Fiyatı (KDV Dahil, ₺)</label>
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

            <div class="data-table-wrap products-card-mode">
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
                 RECIPE EDITOR MODAL — PREMIUM (DRAFT-BASED)
                 Two-column command palette layout
                 Sol: mevcut reçete · Sağ: arama + ekleme motoru
                 ========================================= -->
            <style>
                .recipe-modal-shell { width:100%; max-width:1040px; height:auto; max-height:calc(100dvh - 32px); background:#fff; border-radius:20px; box-shadow:0 30px 80px rgba(15,23,42,0.30), 0 10px 30px rgba(15,23,42,0.12); border:1px solid #e2e8f0; overflow:hidden; display:flex; flex-direction:column; }
                .recipe-modal-body { display:grid; grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr); gap:0; flex:1; overflow:hidden; }
                .recipe-pane { padding:20px 22px; overflow-y:auto; min-height:0; }
                .recipe-pane-left { border-right:1px solid #e2e8f0; background:#fafafa; }
                .recipe-pane-right { background:#ffffff; display:flex; flex-direction:column; }
                .recipe-section-label { font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:12px; }
                .recipe-search-input { width:100%; padding:16px 16px 16px 46px; border:1.5px solid #e2e8f0; border-radius:14px; font-size:15px; font-weight:600; color:#0f172a; background:#fff; box-sizing:border-box; font-family:inherit; outline:none; transition:border-color .15s, box-shadow .15s, background .15s; }
                .recipe-search-input:focus { border-color:#16a34a; box-shadow:0 0 0 4px rgba(22,163,74,0.12); background:#fff; }
                .recipe-result-panel { margin-top:12px; border:1px solid #e2e8f0; border-radius:14px; background:#fff; max-height:340px; overflow-y:auto; flex:1; min-height:200px; }
                .recipe-result-item { padding:12px 16px; cursor:pointer; border-bottom:1px solid #f1f5f9; transition:background 0.12s, border-color 0.12s; border-left:3px solid transparent; }
                .recipe-result-item:last-child { border-bottom:none; }
                .recipe-result-item:hover { background:#f0fdf4; }
                .recipe-result-item.is-selected { background:#ecfdf5; border-left-color:#16a34a; }
                .recipe-chip { display:inline-flex; align-items:center; gap:8px; padding:8px 14px; border-radius:999px; background:#dcfce7; border:1px solid #86efac; color:#15803d; font-size:13px; font-weight:700; max-width:100%; }
                .recipe-chip-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:200px; }
                .recipe-qty-wrap { position:relative; }
                .recipe-qty-input { width:100%; padding:14px 64px 14px 16px; border:1.5px solid #e2e8f0; border-radius:12px; font-size:16px; line-height:1.2; font-weight:700; color:#0f172a; background:#fff; box-sizing:border-box; font-family:inherit; text-align:right; outline:none; transition:border-color .15s, box-shadow .15s; font-variant-numeric:tabular-nums; -moz-appearance:textfield; }
                .recipe-qty-input::-webkit-outer-spin-button,
                .recipe-qty-input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
                .recipe-qty-input:focus { border-color:#16a34a; box-shadow:0 0 0 4px rgba(22,163,74,0.12); }
                .recipe-qty-suffix { position:absolute; right:16px; top:50%; transform:translateY(-50%); font-size:13px; font-weight:700; color:#94a3b8; pointer-events:none; line-height:1; letter-spacing:0.02em; opacity:0.85; max-width:48px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; }
                .recipe-add-cta { width:100%; padding:14px 20px; font-size:14.5px; font-weight:700; letter-spacing:0.01em; border:none; border-radius:12px; background:#0f172a; color:#fff; cursor:pointer; transition:background .15s, transform .08s, opacity .15s; }
                .recipe-add-cta:hover:not(:disabled) { background:#1e293b; }
                .recipe-add-cta:active:not(:disabled) { transform:translateY(1px); }
                .recipe-add-cta:disabled { opacity:0.45; cursor:not-allowed; }
                @media (max-width: 760px) {
                    .recipe-modal-body { grid-template-columns: 1fr; }
                    .recipe-pane-left { border-right:none; border-bottom:1px solid #e2e8f0; max-height:40dvh; }
                    .recipe-modal-shell { max-height:calc(100dvh - 16px); }
                }
            </style>
            <div
                id="productsRecipeOverlay"
                onclick="window.ProductsView.handleRecipeOverlayClick(event)"
                style="
                    display:none;
                    position:fixed;
                    inset:0;
                    background:rgba(15,23,42,0.45);
                    backdrop-filter:blur(4px);
                    -webkit-backdrop-filter:blur(4px);
                    z-index:9999;
                    align-items:center;
                    justify-content:center;
                    padding:16px;
                "
            >
                <div onclick="event.stopPropagation()" class="recipe-modal-shell">
                    <!-- HEADER -->
                    <div style="padding:18px 24px 14px 24px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:flex-start; gap:16px; background:#ffffff;">
                        <div style="min-width:0; flex:1;">
                            <div style="font-size:10.5px; font-weight:700; color:#94a3b8; letter-spacing:0.10em; text-transform:uppercase; margin-bottom:4px;">Reçete</div>
                            <div id="productsRecipeSubtitle" style="font-size:19px; font-weight:800; color:#0f172a; letter-spacing:-0.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>
                        </div>
                        <div style="display:flex; align-items:center; gap:10px; flex-shrink:0;">
                            <div style="text-align:right;">
                                <div style="font-size:10.5px; font-weight:700; color:#94a3b8; letter-spacing:0.10em; text-transform:uppercase;">Toplam</div>
                                <div id="productsRecipeTotalCost" style="font-size:20px; font-weight:800; color:#15803d; letter-spacing:-0.02em; line-height:1.1;">₺0</div>
                            </div>
                            <div id="productsRecipeDirtyBadge" style="display:none; padding:5px 10px; border-radius:999px; background:#fef3c7; border:1px solid #fbbf24; color:#92400e; font-size:10.5px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">● Kaydedilmemiş</div>
                            <button class="btn btn-secondary" type="button" onclick="window.ProductsView.cancelRecipe()" title="Kapat" style="padding:8px 12px; font-size:13px;">✕</button>
                        </div>
                    </div>

                    <!-- ERROR -->
                    <div id="productsRecipeError" style="margin:12px 24px 0 24px; padding:10px 14px; border-radius:10px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:13px; font-weight:600; display:none;"></div>

                    <!-- BODY: 2 columns -->
                    <div class="recipe-modal-body">
                        <!-- LEFT: mevcut reçete -->
                        <div class="recipe-pane recipe-pane-left">
                            <div class="recipe-section-label">Reçete · Hammaddeler</div>
                            <div id="productsRecipeList" style="display:flex; flex-direction:column; gap:8px;">
                                <div style="padding:20px; text-align:center; color:#94a3b8; font-size:13px; border:1px dashed #e2e8f0; border-radius:12px;">Yükleniyor...</div>
                            </div>
                        </div>

                        <!-- RIGHT: arama + ekleme motoru -->
                        <div class="recipe-pane recipe-pane-right">
                            <div class="recipe-section-label">Hammadde Ekle</div>

                            <!-- search -->
                            <div style="position:relative;">
                                <svg style="position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#94a3b8;pointer-events:none;" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                <input type="text" id="productsRecipeSearch" class="recipe-search-input" placeholder="Hammadde ara..." autocomplete="off"
                                    onfocus="window.ProductsView.recipeShowDropdown(true)"
                                    oninput="window.ProductsView.recipeHandleSearch(this.value)"
                                    onkeydown="window.ProductsView.recipeSearchKey(event)">
                                <input type="hidden" id="productsRecipeAddMaterial" value="">
                            </div>

                            <!-- result panel (inline, dropdown DEĞİL) -->
                            <div id="productsRecipeDropdown" class="recipe-result-panel" style="display:block;"></div>

                            <!-- selected chip -->
                            <div id="productsRecipeSelectedRow" style="display:none; margin-top:14px; padding:12px 14px; border:1px solid #bbf7d0; border-radius:12px; background:#f0fdf4;">
                                <div style="font-size:11px; font-weight:700; color:#15803d; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:8px;">Seçildi</div>
                                <div id="productsRecipeSelectedChip" class="recipe-chip">
                                    <span style="font-size:13px; line-height:1;">✓</span>
                                    <span class="recipe-chip-name"></span>
                                    <span style="opacity:0.7; font-weight:600;" data-role="unit"></span>
                                </div>
                            </div>

                            <!-- qty + cta -->
                            <div style="margin-top:14px; display:grid; grid-template-columns: 1fr; gap:10px;">
                                <div>
                                    <label style="display:block; font-size:11px; font-weight:700; color:#475569; letter-spacing:0.06em; text-transform:uppercase; margin-bottom:6px;">Miktar</label>
                                    <div class="recipe-qty-wrap">
                                        <input type="number" id="productsRecipeAddQty" class="recipe-qty-input" placeholder="0" step="0.0001" min="0"
                                            inputmode="decimal"
                                            oninput="window.ProductsView._updateRecipeAddCtaState()"
                                            onkeydown="if(event.key==='Enter'){event.preventDefault();window.ProductsView.addRecipeLine();}">
                                        <span id="productsRecipeQtyUnit" class="recipe-qty-suffix"></span>
                                    </div>
                                    <div id="productsRecipeAddHint" style="margin-top:8px; font-size:12.5px; color:#64748b; min-height:16px;"></div>
                                </div>
                                <button class="recipe-add-cta" type="button" id="productsRecipeAddBtn" onclick="window.ProductsView.addRecipeLine()">Reçeteye Ekle</button>
                            </div>
                        </div>
                    </div>

                    <!-- FOOTER -->
                    <div style="padding:14px 24px; border-top:1px solid #e2e8f0; background:#ffffff; display:flex; justify-content:flex-end; gap:10px;">
                        <button class="btn btn-secondary" type="button" id="productsRecipeCancelBtn" onclick="window.ProductsView.cancelRecipe()" style="padding:11px 22px; font-weight:600;">İptal</button>
                        <button class="btn btn-primary" type="button" id="productsRecipeSaveBtn" onclick="window.ProductsView.saveRecipe()" style="padding:11px 28px; font-weight:700; min-width:120px;">Kaydet</button>
                    </div>
                </div>
            </div>
            </div><!-- /productsPaneProducts -->
        `;

        // === CACHE INVALIDATION HANDLER (sadece bir kez bağlanır) ===
        if (!this._cacheEventsBound) {
            this._cacheEventsBound = true;
            window.addEventListener('products:updated', function () {
                if (window.ViewCache) {
                    window.ViewCache.invalidate('products-view:');
                }
            });
            // Satis olunca da cache'i invalidate et — performanceMap (revenue/profit)
            // guncel kalmali, insights canli rakamlardan beslensin.
            window.addEventListener('sales:updated', function () {
                if (window.ViewCache) {
                    window.ViewCache.invalidate('products-view:');
                }
            });
        }

        // === CACHE READ ===
        var tid = (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || '';
        var cacheKey = 'products-view:' + tid;
        var cacheUsed = false;
        if (window.ViewCache) {
            var cached = window.ViewCache.get(cacheKey);
            if (cached && Array.isArray(cached.products)) {
                try {
                    this.products = cached.products;
                    this.filteredProducts = cached.filteredProducts || cached.products;
                    this.categories = cached.categories || [];
                    this.performanceMap = new Map(cached.performanceEntries || []);
                    // PERF (Faz 2.2): Cache hit'te products array referansi
                    // degisti — sig invalidate.
                    this._productsRev = (this._productsRev || 0) + 1;
                    // Categories select'lerini cached.categories'ten doldur
                    var sel0 = document.getElementById('productCategory');
                    var fSel0 = document.getElementById('productCategoryFilter');
                    var optsHtml0 = (this.categories || []).map(function (c) {
                        return '<option value="' + window.ProductsView.escapeHtml(c.id) + '">' +
                               window.ProductsView.escapeHtml(c.name) + '</option>';
                    }).join('');
                    if (sel0)  sel0.innerHTML  = '<option value="">Seciniz</option>' + optsHtml0;
                    if (fSel0) fSel0.innerHTML = '<option value="">Tum kategoriler</option>' + optsHtml0;
                    this.renderTable();
                    this.renderPagination();
                    this.initPurchase();
                    // Cache hit'te de insights panel render edilsin
                    this._renderProductInsights();
                    cacheUsed = true;
                } catch (e) {
                    cacheUsed = false;
                }
            }
        }

        if (!cacheUsed) {
            await this.loadCategories();
            if (!this._isActive) return;
            await this.loadProducts();
            if (!this._isActive) return;
            this.initPurchase();

            // === CACHE WRITE ===
            if (window.ViewCache) {
                var perfEntries = [];
                if (this.performanceMap && typeof this.performanceMap.forEach === 'function') {
                    this.performanceMap.forEach(function (v, k) { perfEntries.push([k, v]); });
                }
                window.ViewCache.set(cacheKey, {
                    products: this.products || [],
                    filteredProducts: this.filteredProducts || this.products || [],
                    categories: this.categories || [],
                    performanceEntries: perfEntries
                }, 60 * 1000); // 60s TTL
            }
        }

        // PERF: data refresh listener'lari TEK SEFER bind. render() her
        // calistirildiginda (cache hit dahil) eskiden _on() ile yeniden
        // bind ediliyordu → _listeners[] sisiyor, ayni event icin N x
        // loadProducts cagriliyordu. Guard ile module-level idempotent.
        // destroy() yine _removeAllListeners ile temizler; _eventsBound
        // flag'ini destroy'da false yapmadigimiz icin yeni render'da
        // tekrar bind olmaz (tek listener'i koruyoruz).
        if (!this._dataEventsBound) {
            this._dataEventsBound = true;
            var self = this;
            this._on(window, 'products:updated', async function () {
                if (!self._isActive) return;
                await self.loadProducts();
                if (!self._isActive) return;
            });
            // Satis sonrasi performanceMap'in stale kalmamasi icin yeniden yukle.
            this._on(window, 'sales:updated', async function () {
                if (!self._isActive) return;
                await self.loadProducts();
                if (!self._isActive) return;
            });
        }
    },

    toggleForm: function (forceOpen) {
        var form = document.getElementById('productForm');
        if (!form) return;

        if (typeof forceOpen === 'boolean') {
            form.style.display = forceOpen ? 'block' : 'none';
            return;
        }

        var willOpen = form.style.display === 'none';
        form.style.display = willOpen ? 'block' : 'none';

        // Form AÇILIRKEN ve düzenleme modu değilsek: temiz başlat + reçete pasif
        if (willOpen && !this.editingId) {
            this.clearForm();
            this.setFormTitle();
            this.setRecipeButtonEnabled(false);
        }
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

            // PERF (Faz 2.2): Data versiyonu artir → applyFiltersAndRender
            // signature mismatch yapsin, stale filter sonucu reuse edilmesin.
            this._productsRev = (this._productsRev || 0) + 1;

            this.pagination.page = 1;
            this.applyFiltersAndRender();
            this._renderProductInsights();
        } catch (error) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata oluştu.</td></tr>';
            this.setStatus(this.getErrorMessage(error, 'Ürünler yüklenirken beklenmeyen hata oluştu.'), 'error');
        }
    },

    applyFiltersAndRender: function () {
        // PERF (Faz 2.2): Filter+sort signature cache. Ayni search +
        // categoryId + sortBy + sortDir + products data versiyonu icin
        // filteredProducts yeniden compute edilmez. Sadece sayfa cevirme
        // veya page-size degisiminde renderTable/Pagination cagriliyorsa
        // bu yol tetiklenir; bunlarin sig'i de _filterSig icinde degil
        // ama renderTable kendi guard'iyla skip eder.
        var sigKey = (this.filters.search || '') + '|' +
                     (this.filters.categoryId || '') + '|' +
                     (this.filters.sortBy || '') + '|' +
                     (this.filters.sortDir || '') + '|' +
                     (this._productsRev || 0);

        if (this._filterSig === sigKey && this.filteredProducts && this.filteredProducts.length === this._filteredLenAtSig) {
            // Same filter+sort, products array degisikligi yok → recompute SKIP
            this.ensurePageInRange();
            this.renderTable();
            this.renderPagination();
            return;
        }

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
        this._filterSig = sigKey;
        this._filteredLenAtSig = rows.length;
        this.ensurePageInRange();
        this.renderTable();
        this.renderPagination();
    },

    renderTable: function () {
        var tbody = document.getElementById('productsTableBody');
        if (!tbody) return;

        // PERF (Faz 2.2): Render signature — pageRows ayni ise tbody.innerHTML
        // rebuild SKIP. Sig'e dahil: page + pageSize + filteredProducts versiyon
        // (_filterSig changes when products data / filters / sort changes) +
        // filteredProducts.length (defensive). Bu sayede ardisik renderTable
        // cagrilari (orn. applyFiltersAndRender same-sig dali) no-op olur.
        var renderSig = (this._filterSig || '') + '@' +
                        (this.pagination.page || 1) + '/' +
                        (this.pagination.pageSize || 10) + '#' +
                        (this.filteredProducts ? this.filteredProducts.length : 0);
        if (this._lastTableRenderSig === renderSig && tbody.children && tbody.children.length > 0) {
            // Same content rendered, no DOM mutation
            return;
        }
        this._lastTableRenderSig = renderSig;

        if (!this.filteredProducts.length) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; padding:24px; color:#64748b;">Filtreye uygun ürün bulunamadı.</td></tr>';
            return;
        }

        var pageRows = this.getCurrentPageRows();

        tbody.innerHTML = pageRows.map(function (product) {
            var metrics = window.ProductsView.getProductMetrics(product);
            var costMissing = window.ProductsView.isCostMissing(product);
            var name = window.ProductsView.escapeHtml(product.name || '-');
            var category = window.ProductsView.escapeHtml(window.ProductsView.getCategoryLabel(product.category_id, product));
            var price = window.ProductsView.formatMoney(product.price);
            // FAZ 1.2: cost=0 → "—" (formatMoney 0₺ yerine). Maliyet
            // kolonu kendi basina yaniltici degil ama tutarli olsun.
            var cost = costMissing ? '—' : window.ProductsView.formatMoney(product.cost);

            var marginAmount = window.ProductsView.calculateMarginAmount(product.price, product.cost);
            var marginRate = window.ProductsView.calculateMarginRate(product.price, product.cost);

            var isActive = product.is_active !== false;

            // FAZ 1.2: cost=missing satirlara hafif amber tint + ayri class
            //   inactive opacity ile birlestiginde gorsel hierarchy: pasif
            //   ürünler her şeyin üstüne fade, costMissing aktif ürünler
            //   amber tinted.
            var rowClass = costMissing ? 'class="product-cost-missing"' : '';
            var rowStyle = isActive ? '' : 'style="opacity:0.55; background:#f8fafc;"';

            // FAZ 1.2: name yanina amber pill badge (cost=0 ise)
            var nameCell = name + (costMissing
                ? ' <span class="badge-missing-cost" title="Bu ürünün hammadde maliyeti tanımlı değil — kâr/marj hesabı yapılamaz">⚠ Maliyetsiz</span>'
                : '');

            var statusBadge = isActive
                ? '<span style="padding:6px 10px; border-radius:999px; background:#ecfdf5; color:#166534; font-size:12px; font-weight:700;">Aktif</span>'
                : '<span style="padding:6px 10px; border-radius:999px; background:#f1f5f9; color:#475569; font-size:12px; font-weight:700;">Pasif</span>';

            // FAZ 1.2: cost yoksa performans badge'i de degerli degil — sustur
            var performanceBadge = costMissing
                ? '<span style="color:#94a3b8; font-size:12px;">—</span>'
                : window.ProductsView.renderPerformanceBadge(metrics);

            // FAZ 1.2: Tahmini Kar — cost=0 → "—", sahte revenue gosterimi yok
            var profitCell = costMissing
                ? '<td style="font-weight:700; color:#94a3b8;" title="Maliyet tanımsız — gerçek kar bilinemez">—</td>'
                : '<td style="font-weight:700; color:' + (metrics.estimatedProfit >= 0 ? '#16a34a' : '#dc2626') + ';">' + window.ProductsView.formatMoney(metrics.estimatedProfit) + '</td>';

            return '' +
                '<tr ' + rowClass + ' ' + rowStyle + '>' +
                    '<td>' + nameCell + '</td>' +
                    '<td>' + category + '</td>' +
                    '<td>' + price + '</td>' +
                    '<td>' + cost + '</td>' +
                    '<td style="font-weight:700; color:' + marginAmount.color + ';"' +
                        (marginAmount.missing ? ' title="Maliyet tanımlanmamış"' : '') +
                        '>' + marginAmount.text + '</td>' +
                    '<td style="font-weight:700; color:' + marginRate.color + ';"' +
                        (marginRate.missing ? ' title="Maliyet tanımlanmamış"' : '') +
                        '>' + marginRate.text + '</td>' +
                    '<td style="font-weight:700; color:#0f172a;">' + window.ProductsView.formatInteger(metrics.quantity) + '</td>' +
                    '<td style="font-weight:700; color:#0f172a;">' + window.ProductsView.formatMoney(metrics.revenue) + '</td>' +
                    profitCell +
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

        // FAZ 1.2: costMissing tabanli sortlar (kar/marj) icin
        // costMissing urunler DAIMA en sona atilir (asc/desc bagimsiz).
        // Boylece "Kar Orani Yuksek -> Dusuk" sirasinda %100 yalanini
        // sirasiz hale getirip listenin dibine koruz; gercek maliyetli
        // urunler once siralanir.
        var COST_BASED_SORTS = ['margin_amount', 'margin_rate', 'profit_est'];
        if (COST_BASED_SORTS.indexOf(sortBy) !== -1) {
            var aMissing = this.isCostMissing(a);
            var bMissing = this.isCostMissing(b);
            if (aMissing && !bMissing) return 1;    // a en sona
            if (!aMissing && bMissing) return -1;   // b en sona
            // Ikisi de missing ise name ile tie-break (deterministic)
            if (aMissing && bMissing) {
                return this.normalizeName(a.name).localeCompare(this.normalizeName(b.name), 'tr');
            }
        }

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
        // PERF: Her keystroke'ta full filter+sort+innerHTML rebuild
        // pahaliydi (100+ urun ile hissedilir kasik). 300ms debounce ile
        // typing tamamlandiktan sonra render. State (filters.search) hemen
        // guncellenir; pagination'i 1'e dondurmek de hemen (kullanici
        // sayfa N'de iken arar). Sadece render zinciri ertelenir.
        this.filters.search = value || '';
        this.pagination.page = 1;

        // window.debounce js/cache.js'te tanimli (300ms default).
        // Lazy-init: ilk kullanima kadar wrapper olusmaz.
        if (!this._searchDebouncer && typeof window.debounce === 'function') {
            var self = this;
            this._searchDebouncer = window.debounce(function () {
                self.applyFiltersAndRender();
            }, 300);
        }
        if (this._searchDebouncer) {
            this._searchDebouncer();
        } else {
            // Fallback (debounce util yoksa) — eski sync davranis
            this.applyFiltersAndRender();
        }
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

                var currentTenantId = await window.SupabaseService.getTenantId();
                if (!currentTenantId) {
                    window.ProductsView.setModalError('Tenant bulunamadı. Lütfen tekrar giriş yapın.');
                    return false;
                }

                var payload = {
                    name: cleanedName,
                    type: 'product',
                    tenant_id: currentTenantId
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

    /* ========================================================
       RECIPE EDITOR — DRAFT-BASED (no auto-save)
       Mevcut reçete DB'den çekilir → originalRecipes (snapshot)
       Kullanıcı duzenlemeleri draftRecipes'a yazar.
       Sadece "Kaydet" butonu DB'ye yazar (batch).
       ======================================================== */

    _newRecipeTempId: function () {
        this._recipeTempCounter = (this._recipeTempCounter || 0) + 1;
        return 'tmp_' + Date.now() + '_' + this._recipeTempCounter;
    },

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
            originalRecipes: [],
            draftRecipes: [],
            rawMaterials: [],
            loading: true,
            saving: false,
            error: ''
        };

        var overlay = document.getElementById('productsRecipeOverlay');
        var subtitle = document.getElementById('productsRecipeSubtitle');
        if (subtitle) subtitle.textContent = this.recipeState.productName;

        this.setRecipeError('');
        // Reset add row state (yeniden acilista chip/qty/search temiz olsun)
        var searchEl = document.getElementById('productsRecipeSearch');
        var qtyEl    = document.getElementById('productsRecipeAddQty');
        var hiddenEl = document.getElementById('productsRecipeAddMaterial');
        var hintEl   = document.getElementById('productsRecipeAddHint');
        if (searchEl) searchEl.value = '';
        if (qtyEl) { qtyEl.value = ''; qtyEl.placeholder = '0'; }
        if (hiddenEl) hiddenEl.value = '';
        if (hintEl) hintEl.innerHTML = '';
        this._renderRecipeSelectedChip(null);

        this.renderRecipeList();
        this.renderRawMaterialSelect();
        this.renderRecipeFooter();

        if (overlay) overlay.style.display = 'flex';

        try {
            await this.loadRecipesAndMaterials();
        } catch (error) {
            this.setRecipeError(this.getErrorMessage(error, 'Reçete yüklenemedi.'));
        }
    },

    closeRecipeModal: function () {
        // Hard close — dirty check yapmaz. Cagiranin sorumlulugu.
        this.recipeState = {
            open: false,
            productId: null,
            productName: '',
            originalRecipes: [],
            draftRecipes: [],
            rawMaterials: [],
            loading: false,
            saving: false,
            error: ''
        };

        var overlay = document.getElementById('productsRecipeOverlay');
        if (overlay) overlay.style.display = 'none';

        var qty = document.getElementById('productsRecipeAddQty');
        if (qty) qty.value = '';
        var search = document.getElementById('productsRecipeSearch');
        if (search) search.value = '';
        var hidden = document.getElementById('productsRecipeAddMaterial');
        if (hidden) hidden.value = '';
        this.recipeShowDropdown(false);
    },

    cancelRecipe: function () {
        if (this.recipeState.saving) return;

        if (this.isRecipeDirty()) {
            var ok = window.confirm('Kaydedilmemiş değişiklikler var. Çıkmak istiyor musun?');
            if (!ok) return;
        }
        this.closeRecipeModal();
    },

    handleRecipeOverlayClick: function (event) {
        var overlay = document.getElementById('productsRecipeOverlay');
        if (event.target === overlay) {
            this.cancelRecipe();
        }
    },

    isRecipeDirty: function () {
        var draft = this.recipeState.draftRecipes || [];
        return draft.some(function (d) {
            return d._state && d._state !== 'unchanged';
        });
    },

    loadRecipesAndMaterials: async function () {
        var productId = this.recipeState.productId;
        if (!productId) return;

        this.recipeState.loading = true;
        this.renderRecipeList();
        this.renderRawMaterialSelect();

        var results = await Promise.all([
            window.SupabaseService.query('product_recipes', {
                filters: [
                    { op: 'eq', column: 'is_deleted', value: false },
                    { op: 'eq', column: 'product_id', value: productId }
                ],
                select: 'id,product_id,raw_material_id,quantity,raw_material:raw_materials(id,name,unit,base_unit,cost,is_deleted)',
                order: { column: 'created_at', asc: true }
            }),
            window.SupabaseService.query('raw_materials', {
                filters: [
                    { op: 'eq', column: 'is_deleted', value: false },
                    { op: 'eq', column: 'is_active', value: true }
                ],
                select: 'id,name,unit,base_unit,cost',
                order: { column: 'name', asc: true }
            })
        ]);

        if (!this._isActive || !this.recipeState.open) return;

        var recipeResult = results[0];
        var materialResult = results[1];

        if (recipeResult.error) throw recipeResult.error;
        if (materialResult.error) throw materialResult.error;

        var recipes = Array.isArray(recipeResult.data) ? recipeResult.data : [];
        recipes = recipes.filter(function (r) {
            return !r.raw_material || r.raw_material.is_deleted !== true;
        });

        var self = this;
        // Snapshot orijinal — degismeyecek
        this.recipeState.originalRecipes = recipes.map(function (r) {
            return {
                id: r.id,
                raw_material_id: r.raw_material_id,
                quantity: Number(r.quantity) || 0,
                raw_material: r.raw_material || {}
            };
        });

        // Draft'i orijinalden seed et
        this.recipeState.draftRecipes = this.recipeState.originalRecipes.map(function (r) {
            return {
                tempId: self._newRecipeTempId(),
                recipeId: r.id,
                raw_material_id: r.raw_material_id,
                quantity: r.quantity,
                raw_material: r.raw_material,
                _state: 'unchanged'
            };
        });

        this.recipeState.rawMaterials = Array.isArray(materialResult.data) ? materialResult.data : [];
        this.recipeState.loading = false;

        this.renderRecipeList();
        this.renderRawMaterialSelect();
        this.renderRecipeFooter();
    },

    renderRecipeList: function () {
        var list = document.getElementById('productsRecipeList');
        var totalEl = document.getElementById('productsRecipeTotalCost');
        if (!list) return;

        if (this.recipeState.loading) {
            list.innerHTML = '<div style="padding:20px; text-align:center; color:#94a3b8; font-size:13px; border:1px dashed #e2e8f0; border-radius:12px;">Yükleniyor...</div>';
            if (totalEl) totalEl.textContent = this.formatMoney(0);
            return;
        }

        var visible = (this.recipeState.draftRecipes || []).filter(function (d) {
            return d._state !== 'removed';
        });

        if (visible.length === 0) {
            list.innerHTML =
                '<div style="padding:28px 20px; text-align:center; color:#64748b; font-size:13px; line-height:1.55; border:1px dashed #e2e8f0; border-radius:14px; background:#ffffff;">' +
                    '<div style="width:36px; height:36px; margin:0 auto 12px; border-radius:10px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; color:#94a3b8;">' +
                        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>' +
                    '</div>' +
                    '<div style="font-weight:700; color:#0f172a; margin-bottom:4px;">Henüz reçete eklenmedi</div>' +
                    '<div style="color:#94a3b8; font-size:12.5px;">Sağ taraftan hammadde arayıp ekleyebilirsin.</div>' +
                '</div>';
            if (totalEl) totalEl.textContent = this.formatMoney(0);
            return;
        }

        var total = 0;
        var self = this;

        var html = visible.map(function (d) {
            var mat = d.raw_material || {};
            var quantity = Number(d.quantity) || 0;
            var unitCost = Number(mat.cost) || 0;
            var lineCost = quantity * unitCost;
            total += lineCost;

            var name = self.escapeHtml(mat.name || '(Silinmiş hammadde)');
            // base_unit kullanilir: contract'a gore quantity base_unit cinsinden saklanir.
            // Eski kayit/UI uyumu icin fallback unit'e dusuyoruz.
            var unit = self.escapeHtml(mat.base_unit || mat.unit || '');
            var qtyText = self.formatQuantity(quantity);
            var unitCostText = self.formatMoney(unitCost) + (unit ? ' / ' + unit : '');
            var lineCostText = self.formatMoney(lineCost);
            var stateBadge = '';
            if (d._state === 'new') {
                stateBadge = '<span style="margin-left:8px; padding:2px 8px; border-radius:999px; background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">YENİ</span>';
            } else if (d._state === 'modified') {
                stateBadge = '<span style="margin-left:8px; padding:2px 8px; border-radius:999px; background:#fef3c7; color:#92400e; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">DEĞİŞTİ</span>';
            }

            return '<div class="recipe-row" data-tempid="' + self.escapeHtml(d.tempId) + '" ' +
                'style="display:grid; grid-template-columns: 1.6fr 1.1fr 1.1fr 1fr auto; gap:12px; align-items:center; padding:14px 16px; border:1px solid #e2e8f0; border-radius:12px; background:#ffffff; transition:box-shadow 0.15s, border-color 0.15s;" ' +
                'onmouseover="this.style.boxShadow=\'0 4px 14px rgba(15,23,42,0.06)\'; this.style.borderColor=\'#cbd5e1\';" ' +
                'onmouseout="this.style.boxShadow=\'none\'; this.style.borderColor=\'#e2e8f0\';">' +

                '<div style="min-width:0;">' +
                    '<div style="font-size:14px; font-weight:700; color:#0f172a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + name + stateBadge + '</div>' +
                    '<div style="font-size:11px; color:#94a3b8; margin-top:2px; letter-spacing:0.04em; text-transform:uppercase;">Hammadde</div>' +
                '</div>' +

                '<div>' +
                    '<div style="display:flex; align-items:center; gap:6px;">' +
                        '<input type="number" step="0.0001" min="0" value="' + quantity + '" ' +
                            'oninput="window.ProductsView.updateRecipeLineQuantity(\'' + self.escapeHtml(d.tempId) + '\', this.value)" ' +
                            'style="width:90px; padding:8px 10px; border:1.5px solid #e2e8f0; border-radius:10px; font-size:14px; font-weight:600; color:#0f172a; background:#f8fafc; text-align:right;">' +
                        '<span style="font-size:12px; color:#64748b; font-weight:600;">' + (unit || '-') + '</span>' +
                    '</div>' +
                    '<div style="font-size:11px; color:#94a3b8; margin-top:4px; letter-spacing:0.04em; text-transform:uppercase;">Miktar</div>' +
                '</div>' +

                '<div>' +
                    '<div style="font-size:14px; font-weight:600; color:#475569;">' + unitCostText + '</div>' +
                    '<div style="font-size:11px; color:#94a3b8; margin-top:2px; letter-spacing:0.04em; text-transform:uppercase;">Birim Maliyet</div>' +
                '</div>' +

                '<div style="text-align:right;">' +
                    '<div style="font-size:16px; font-weight:800; color:#15803d; letter-spacing:-0.01em;">' + lineCostText + '</div>' +
                    '<div style="font-size:11px; color:#94a3b8; margin-top:2px; letter-spacing:0.04em; text-transform:uppercase;">Satır Maliyeti</div>' +
                '</div>' +

                '<button type="button" onclick="window.ProductsView.removeRecipeLine(\'' + self.escapeHtml(d.tempId) + '\')" ' +
                    'title="Kaldır" ' +
                    'style="width:34px; height:34px; border:1px solid #fecaca; background:#fef2f2; color:#b91c1c; border-radius:10px; cursor:pointer; font-size:16px; font-weight:700; transition:all 0.15s;" ' +
                    'onmouseover="this.style.background=\'#fee2e2\'" onmouseout="this.style.background=\'#fef2f2\'">×</button>' +
            '</div>';
        }).join('');

        list.innerHTML = html;
        if (totalEl) totalEl.textContent = this.formatMoney(total);
        this.renderRecipeFooter();
    },

    renderRecipeFooter: function () {
        var saveBtn = document.getElementById('productsRecipeSaveBtn');
        var dirtyBadge = document.getElementById('productsRecipeDirtyBadge');
        var dirty = this.isRecipeDirty();

        if (saveBtn) {
            if (this.recipeState.saving) {
                saveBtn.disabled = true;
                saveBtn.textContent = 'Kaydediliyor...';
            } else {
                saveBtn.disabled = !dirty;
                saveBtn.textContent = 'Kaydet';
                saveBtn.style.opacity = dirty ? '1' : '0.6';
                saveBtn.style.cursor = dirty ? 'pointer' : 'not-allowed';
            }
        }
        if (dirtyBadge) {
            dirtyBadge.style.display = dirty ? 'inline-block' : 'none';
        }
    },

    renderRawMaterialSelect: function () {
        var hint = document.getElementById('productsRecipeAddHint');
        var dropdown = document.getElementById('productsRecipeDropdown');
        var hidden = document.getElementById('productsRecipeAddMaterial');
        var search = document.getElementById('productsRecipeSearch');

        if (!dropdown) return;

        var materials = this.recipeState.rawMaterials || [];

        if (this.recipeState.loading) {
            dropdown.innerHTML = '<div style="padding:24px 16px; text-align:center; color:#94a3b8; font-size:13px;">Yükleniyor...</div>';
            if (hint) hint.textContent = '';
            this._updateRecipeAddCtaState();
            return;
        }

        if (materials.length === 0) {
            dropdown.innerHTML =
                '<div style="padding:28px 20px; text-align:center;">' +
                    '<div style="font-weight:700; color:#0f172a; font-size:13px; margin-bottom:4px;">Hammadde tanımlı değil</div>' +
                    '<div style="color:#94a3b8; font-size:12.5px;">Önce "Hammaddeler" sekmesinden ekle.</div>' +
                '</div>';
            if (hint) hint.textContent = '';
            this._updateRecipeAddCtaState();
            return;
        }

        // Draft icindeki kullanilan id'ler (removed olanlar harici)
        var usedIds = {};
        (this.recipeState.draftRecipes || []).forEach(function (d) {
            if (d._state !== 'removed' && d.raw_material_id) {
                usedIds[String(d.raw_material_id)] = true;
            }
        });

        var self = this;
        var query = this.normalizeName((search && search.value) || '');

        var available = materials.filter(function (m) {
            if (usedIds[String(m.id)]) return false;
            if (!query) return true;
            return self.normalizeName(m.name || '').indexOf(query) !== -1;
        }).slice(0, 200);

        if (hint) {
            var totalAvail = materials.filter(function (m) { return !usedIds[String(m.id)]; }).length;
            hint.textContent = totalAvail === 0
                ? 'Tüm aktif hammaddeler zaten bu reçetede.'
                : '';
        }

        if (!available.length) {
            dropdown.innerHTML =
                '<div style="padding:28px 20px; text-align:center;">' +
                    '<div style="font-weight:700; color:#0f172a; font-size:13px; margin-bottom:4px;">Sonuç bulunamadı</div>' +
                    '<div style="color:#94a3b8; font-size:12.5px;">Farklı bir ad dene.</div>' +
                '</div>';
            this._updateRecipeAddCtaState();
            return;
        }

        var selectedId = hidden ? hidden.value : '';

        dropdown.innerHTML = available.map(function (m) {
            var id = self.escapeHtml(m.id);
            var name = self.escapeHtml((m.name || '').toUpperCase());
            var baseUnit = self.escapeHtml(m.base_unit || m.unit || '-');
            var costNum  = Number(m.cost) || 0;
            var costText = self.formatMoney(costNum) + ' / ' + baseUnit;
            var isSel = String(m.id) === String(selectedId);
            var clsTail = isSel ? ' is-selected' : '';

            return '<div class="recipe-result-item' + clsTail + '" data-rmid="' + id + '" onclick="window.ProductsView.recipeSelectMaterial(\'' + id + '\')">' +
                '<div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">' +
                    '<div style="min-width:0; flex:1;">' +
                        '<div style="font-weight:700; color:#0f172a; font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + name + '</div>' +
                        '<div style="font-size:11.5px; color:#94a3b8; margin-top:2px; font-weight:600;">' + baseUnit + '</div>' +
                    '</div>' +
                    '<div style="flex-shrink:0; font-size:12px; font-weight:700; color:#15803d; white-space:nowrap;">' + costText + '</div>' +
                    (isSel ? '<span style="color:#16a34a;font-size:14px;font-weight:800;flex-shrink:0;">✓</span>' : '') +
                '</div>' +
            '</div>';
        }).join('');

        this._updateRecipeAddCtaState();
    },

    _updateRecipeAddCtaState: function () {
        var btn = document.getElementById('productsRecipeAddBtn');
        var hidden = document.getElementById('productsRecipeAddMaterial');
        var qty = document.getElementById('productsRecipeAddQty');
        if (!btn) return;

        var hasMaterial = !!(hidden && hidden.value);
        var qtyNum = qty ? Number(qty.value) : 0;
        var hasQty = Number.isFinite(qtyNum) && qtyNum > 0;
        btn.disabled = !(hasMaterial && hasQty);
    },

    recipeHandleSearch: function (value) {
        // Kullanici aramaya yazmaya basladi -> aktif chip'i iptal et
        // (yeni hammadde tarama sinyali)
        var hidden = document.getElementById('productsRecipeAddMaterial');
        if (hidden && hidden.value && (value || '').length > 0) {
            hidden.value = '';
            this._renderRecipeSelectedChip(null);
        }
        this.renderRawMaterialSelect();
    },

    // Inline result panel artik her zaman gorunur — bu metod no-op'a yakin.
    // Eski cagri yerlerini kirmamak icin korunuyor.
    recipeShowDropdown: function (show) {
        var dd = document.getElementById('productsRecipeDropdown');
        if (!dd) return;
        // Yeni layout: panel statik gorunur. show=false geldiginde gizleme,
        // sadece scroll'u basa al.
        dd.style.display = 'block';
        if (show === false) { try { dd.scrollTop = 0; } catch (e) {} }
    },

    recipeSelectMaterial: function (id) {
        var m = (this.recipeState.rawMaterials || []).find(function (x) { return String(x.id) === String(id); });
        if (!m) return;

        var hidden = document.getElementById('productsRecipeAddMaterial');
        var qty    = document.getElementById('productsRecipeAddQty');
        var hint   = document.getElementById('productsRecipeAddHint');

        if (hidden) hidden.value = m.id;

        var baseUnit = m.base_unit || m.unit || '';
        if (hint) {
            hint.innerHTML = baseUnit
                ? 'Miktarı <b style="color:#0f172a;">' + this.escapeHtml(baseUnit) + '</b> cinsinden girin.'
                : '';
        }
        if (qty) {
            qty.placeholder = '0';
        }

        // Selected chip + result list highlight
        this._renderRecipeSelectedChip(m);
        this.renderRawMaterialSelect();

        if (qty) {
            try { qty.focus(); qty.select && qty.select(); } catch (e) {}
        }
    },

    _renderRecipeSelectedChip: function (material) {
        var row = document.getElementById('productsRecipeSelectedRow');
        var chip = document.getElementById('productsRecipeSelectedChip');
        var qtyUnit = document.getElementById('productsRecipeQtyUnit');
        if (!row || !chip) return;

        if (!material) {
            row.style.display = 'none';
            if (qtyUnit) qtyUnit.textContent = '';
            return;
        }

        var nameEl = chip.querySelector('.recipe-chip-name');
        var unitEl = chip.querySelector('[data-role="unit"]');
        var unit = material.base_unit || material.unit || '';

        if (nameEl) nameEl.textContent = (material.name || '').toUpperCase();
        if (unitEl) unitEl.textContent = unit ? '· ' + unit : '';
        if (qtyUnit) qtyUnit.textContent = unit || '';

        row.style.display = 'block';
    },

    recipeSearchKey: function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var hidden = document.getElementById('productsRecipeAddMaterial');
            if (!hidden || !hidden.value) {
                var dd = document.getElementById('productsRecipeDropdown');
                if (dd) {
                    var first = dd.querySelector('[data-rmid]');
                    if (first) {
                        this.recipeSelectMaterial(first.getAttribute('data-rmid'));
                        return;
                    }
                }
            }
            var qty = document.getElementById('productsRecipeAddQty');
            if (qty) qty.focus();
        } else if (e.key === 'Escape') {
            this.recipeShowDropdown(false);
        }
    },

    addRecipeLine: function () {
        // DRAFT-ONLY — DB'ye yazmaz.
        if (this.recipeState.saving) return;

        var selectEl = document.getElementById('productsRecipeAddMaterial');
        var qtyEl = document.getElementById('productsRecipeAddQty');

        if (!selectEl || !qtyEl) return;

        var rawMaterialId = selectEl.value;
        var quantity = Number(qtyEl.value);

        if (!rawMaterialId) {
            this.setRecipeError('Hammadde seçmelisin.');
            return;
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            this.setRecipeError('Miktar 0\'dan büyük olmalı.');
            return;
        }

        // Draft icinde aktif (removed olmayan) ayni hammadde var mi?
        var draft = this.recipeState.draftRecipes || [];
        var existingActive = draft.find(function (d) {
            return d._state !== 'removed' && String(d.raw_material_id) === String(rawMaterialId);
        });
        if (existingActive) {
            this.setRecipeError('Bu hammadde zaten reçetede.');
            return;
        }

        // Daha once silinmis ayni hammadde varsa "geri al" — eski ID korunsun
        var previouslyRemoved = draft.find(function (d) {
            return d._state === 'removed' && String(d.raw_material_id) === String(rawMaterialId);
        });

        var material = (this.recipeState.rawMaterials || []).find(function (m) {
            return String(m.id) === String(rawMaterialId);
        });

        if (previouslyRemoved) {
            // Restore + quantity guncelle
            previouslyRemoved.quantity = quantity;
            // Eger DB'de var olan satirsa, quantity orijinalden farkliysa modified
            var orig = (this.recipeState.originalRecipes || []).find(function (o) {
                return String(o.id) === String(previouslyRemoved.recipeId);
            });
            if (orig) {
                previouslyRemoved._state = (Number(orig.quantity) === quantity) ? 'unchanged' : 'modified';
            } else {
                previouslyRemoved._state = 'new';
            }
        } else {
            // Yeni satir
            draft.push({
                tempId: this._newRecipeTempId(),
                recipeId: null,
                raw_material_id: rawMaterialId,
                quantity: quantity,
                raw_material: material || {},
                _state: 'new'
            });
        }

        this.recipeState.draftRecipes = draft;
        this.setRecipeError('');

        // Form temizle
        qtyEl.value = '';
        qtyEl.placeholder = '0';
        selectEl.value = '';
        var searchInput = document.getElementById('productsRecipeSearch');
        if (searchInput) searchInput.value = '';
        var hintEl = document.getElementById('productsRecipeAddHint');
        if (hintEl) hintEl.innerHTML = '';
        this._renderRecipeSelectedChip(null);
        this.recipeShowDropdown(false);

        this.renderRecipeList();
        this.renderRawMaterialSelect();

        // Seri ekleme: search'e tekrar focus
        if (searchInput) { try { searchInput.focus(); } catch (e) {} }
    },

    updateRecipeLineQuantity: function (tempId, value) {
        if (this.recipeState.saving) return;
        var draft = this.recipeState.draftRecipes || [];
        var line = draft.find(function (d) { return d.tempId === tempId; });
        if (!line) return;

        var qty = Number(value);
        if (!Number.isFinite(qty) || qty < 0) return;

        line.quantity = qty;

        // State guncelle
        var orig = (this.recipeState.originalRecipes || []).find(function (o) {
            return String(o.id) === String(line.recipeId);
        });
        if (line._state === 'new') {
            // hala new
        } else if (orig) {
            line._state = (Number(orig.quantity) === qty) ? 'unchanged' : 'modified';
        }

        // Render — sadece total + footer (input focus'u kaybolmasin)
        var totalEl = document.getElementById('productsRecipeTotalCost');
        if (totalEl) {
            var total = 0;
            (this.recipeState.draftRecipes || []).forEach(function (d) {
                if (d._state === 'removed') return;
                var q = Number(d.quantity) || 0;
                var c = Number((d.raw_material || {}).cost) || 0;
                total += q * c;
            });
            totalEl.textContent = this.formatMoney(total);
        }

        // Satirin satir-maliyeti hucresini guncelle
        var row = document.querySelector('.recipe-row[data-tempid="' + tempId + '"]');
        if (row) {
            var unitCost = Number((line.raw_material || {}).cost) || 0;
            var lineCost = qty * unitCost;
            var lineCostEl = row.querySelector('div[style*="text-align:right"] > div:first-child');
            if (lineCostEl) lineCostEl.textContent = this.formatMoney(lineCost);

            // State badge guncelle (basit re-render)
            var nameDiv = row.querySelector('div:first-child > div:first-child');
            if (nameDiv) {
                var matName = (line.raw_material && line.raw_material.name) || '(Silinmiş hammadde)';
                var badge = '';
                if (line._state === 'new') {
                    badge = '<span style="margin-left:8px; padding:2px 8px; border-radius:999px; background:#dcfce7; color:#15803d; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">YENİ</span>';
                } else if (line._state === 'modified') {
                    badge = '<span style="margin-left:8px; padding:2px 8px; border-radius:999px; background:#fef3c7; color:#92400e; font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;">DEĞİŞTİ</span>';
                }
                nameDiv.innerHTML = this.escapeHtml(matName) + badge;
            }
        }

        this.renderRecipeFooter();
    },

    removeRecipeLine: function (tempId) {
        // DRAFT-ONLY — DB'ye yazmaz.
        if (this.recipeState.saving) return;
        var draft = this.recipeState.draftRecipes || [];
        var line = draft.find(function (d) { return d.tempId === tempId; });
        if (!line) return;

        if (line._state === 'new') {
            // Henuz DB'de yok — direkt cikar
            this.recipeState.draftRecipes = draft.filter(function (d) { return d.tempId !== tempId; });
        } else {
            // DB'de var — removed olarak isaretle
            line._state = 'removed';
        }

        this.setRecipeError('');
        this.renderRecipeList();
        this.renderRawMaterialSelect();
    },

    saveRecipe: async function () {
        if (this.recipeState.saving) return;
        if (!this.isRecipeDirty()) {
            this.setRecipeError('');
            return;
        }

        var productId = this.recipeState.productId;
        if (!productId) return;

        this.recipeState.saving = true;
        this.setRecipeError('');
        this.renderRecipeFooter();

        try {
            var draft = this.recipeState.draftRecipes || [];

            // 1) Removed (recipeId !== null) -> soft delete
            var toRemove = draft.filter(function (d) {
                return d._state === 'removed' && d.recipeId;
            });
            for (var i = 0; i < toRemove.length; i++) {
                var rRes = await window.SupabaseService.update('product_recipes', toRemove[i].recipeId, {
                    is_deleted: true
                });
                if (!this._isActive || !this.recipeState.open) return;
                if (rRes && rRes.error) {
                    throw rRes.error;
                }
            }

            // 2) Modified -> update quantity
            var toModify = draft.filter(function (d) { return d._state === 'modified' && d.recipeId; });
            for (var j = 0; j < toModify.length; j++) {
                var mRes = await window.SupabaseService.update('product_recipes', toModify[j].recipeId, {
                    quantity: Number(toModify[j].quantity) || 0
                });
                if (!this._isActive || !this.recipeState.open) return;
                if (mRes && mRes.error) {
                    throw mRes.error;
                }
            }

            // 3) New -> insert
            var toInsert = draft.filter(function (d) { return d._state === 'new'; });
            for (var k = 0; k < toInsert.length; k++) {
                var iRes = await window.SupabaseService.insert('product_recipes', {
                    product_id: productId,
                    raw_material_id: toInsert[k].raw_material_id,
                    quantity: Number(toInsert[k].quantity) || 0
                });
                if (!this._isActive || !this.recipeState.open) return;
                if (iRes && iRes.error) {
                    throw iRes.error;
                }
            }

            // 4) Reload + products refresh
            await this.loadRecipesAndMaterials();
            if (!this._isActive || !this.recipeState.open) return;

            await this.loadProducts();

            if (window.Toast && typeof window.Toast.success === 'function') {
                Toast.success('Reçete kaydedildi.');
            }

            // Modal'i kapat (kaydedildi)
            this.closeRecipeModal();
        } catch (error) {
            this.setRecipeError(this.getErrorMessage(error, 'Reçete kaydedilemedi.'));
        } finally {
            this.recipeState.saving = false;
            this.renderRecipeFooter();
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

    // FAZ 1.2 — Cost=0 misleading profitability hardening.
    // Ürün cost null veya 0 ise "maliyetsiz" sayılır: per-product
    // kar/marj hesabi guvenilir degildir (sahte %100). UX katmaninda
    // "—" gosterilir, badge eklenir, sort'ta en sona atilir.
    // Backend / RPC dokunulmadi.
    isCostMissing: function (product) {
        if (!product) return false;
        if (product.cost === null || typeof product.cost === 'undefined') return true;
        return Number(product.cost) === 0;
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
        // FAZ 1.2: cost=null veya cost=0 → "—" goster, sahte %100
        // marj algisini engelle. Hesap bozulmaz, sadece render.
        if (cost === null || typeof cost === 'undefined' || Number(cost) === 0) {
            return { text: '—', color: '#94a3b8', missing: true };
        }
        var value = (Number(price) || 0) - (Number(cost) || 0);
        if (value > 0) return { text: this.formatMoney(value), color: '#16a34a' };
        if (value === 0) return { text: this.formatMoney(value), color: '#64748b' };
        return { text: this.formatMoney(value), color: '#dc2626' };
    },

    calculateMarginRate: function (price, cost) {
        // FAZ 1.2: cost=null veya cost=0 → "—" goster, %100 yalanini
        // engelle. price=0 ise (eski davranis) "-" goster.
        if (cost === null || typeof cost === 'undefined' || Number(cost) === 0) {
            return { text: '—', color: '#94a3b8', missing: true };
        }

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
        // PERF: _dataEventsBound guard'ini reset et — render listener'larini
        // _removeAllListeners temizledi; bir sonraki render'da yeniden bind
        // edilmesi icin flag'i da sifirla.
        this._dataEventsBound = false;
        this.products = [];
        this.filteredProducts = [];
        this.categories = [];
        this.performanceMap = new Map();
        this.editingId = null;
        this.closeRecipeModal();
        // PERF (Faz 2.2): Render signature cache reset — DOM gidiyor,
        // sig artik anlamsiz. Bir sonraki render fresh.
        this._filterSig = null;
        this._filteredLenAtSig = null;
        this._lastTableRenderSig = null;
        this._productsRev = 0;
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
            // Replay/session protection: her modal acilisi icin yeni UUID.
            // Bu bir CONTENT HASH degildir — UI seviyesinde double-click
            // ve network retry'a karsi koruma. Server fallback
            // (create_purchase_and_update_product_cost icindeki
            // clock_timestamp tabanli key) yalnizca guvenlik agi; gercek
            // replay protection burada uretilen UUID ile saglanir.
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
                // currentPurchaseKey: per-modal UUID; replay/double-click guard.
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
    },

    /* ============================================================
       TAB SWITCHING
       ============================================================ */
    switchTab: function (tab) {
        if (!tab || this._activeTab === tab) return;
        this._activeTab = tab;

        var btns = document.querySelectorAll('.products-tabs button[data-ptab]');
        btns.forEach(function (b) {
            var active = b.dataset.ptab === tab;
            b.style.background = active ? '#0f172a' : 'transparent';
            b.style.color = active ? '#fff' : '#475569';
        });

        var pProducts = document.getElementById('productsPaneProducts');
        var pRaw = document.getElementById('productsPaneRawMaterials');
        var pPur = document.getElementById('productsPanePurchase');

        if (pProducts) pProducts.style.display = tab === 'products' ? '' : 'none';
        if (pRaw) pRaw.style.display = tab === 'raw-materials' ? '' : 'none';
        if (pPur) pPur.style.display = tab === 'purchase' ? '' : 'none';

        if (tab === 'raw-materials') {
            this._renderRawMaterialsPane();
            this.loadRawMaterialsTab();
        } else if (tab === 'purchase') {
            this._renderPurchasePane();
            this.loadPurchaseTab();
        }
    },

    /* ============================================================
       HAMMADDELER TAB
       ============================================================ */
    _renderRawMaterialsPane: function () {
        if (this._tabsRendered['raw-materials']) return;
        this._tabsRendered['raw-materials'] = true;

        var pane = document.getElementById('productsPaneRawMaterials');
        if (!pane) return;

        var unitOpts = this.rmState.UNITS.map(function (u) {
            return '<option value="' + u + '">' + u + '</option>';
        }).join('');

        pane.innerHTML = `
            <div class="page-header">
                <h2 class="page-title">Ham Maddeler</h2>
            </div>

            <div class="form-card" style="margin-top:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
                    <h3 id="rmFormTitle" style="margin:0; font-size:1rem; font-weight:700;">Ham Madde Ekle</h3>
                    <button class="btn btn-secondary" type="button" id="rmCancelBtn" style="display:none;" onclick="window.ProductsView.rmCancelEdit()">İptal</button>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">Ad</label>
                        <input type="text" class="form-input" id="rmName" placeholder="Örn: Sığır Eti">
                    </div>

                    <div class="form-group">
                        <label class="form-label">Birim</label>
                        <select class="form-select" id="rmUnit">${unitOpts}</select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">KDV</label>
                        <select class="form-select" id="rmVat">
                            <option value="0">%0</option>
                            <option value="1">%1</option>
                            <option value="10">%10</option>
                            <option value="20" selected>%20</option>
                        </select>
                    </div>
                </div>
                <div style="margin-top:8px; font-size:12px; color:#64748b;">
                    Birim maliyet alışlardan otomatik hesaplanır (WAC). Manuel girilmez.
                </div>

                <div style="margin-top:14px; display:flex; gap:10px;">
                    <button class="btn btn-primary" type="button" onclick="window.ProductsView.rmSave()">Kaydet</button>
                </div>
            </div>

            <div class="form-card" style="margin-top:16px;">
                <div class="form-group" style="margin-bottom:0;">
                    <label class="form-label">Ham Madde Ara</label>
                    <input type="text" class="form-input" id="rmSearch" placeholder="Ad ile ara..." oninput="window.ProductsView.rmHandleSearch(this.value)">
                </div>
            </div>

            <div id="rmStatus" style="margin:16px 0;"></div>

            <div class="data-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Ad</th>
                            <th>Alış / Hesap</th>
                            <th style="text-align:right;">Birim Maliyet</th>
                            <th style="width:260px;">İşlemler</th>
                        </tr>
                    </thead>
                    <tbody id="rmTableBody">
                        <tr><td colspan="4" style="text-align:center; padding:24px;">Yükleniyor...</td></tr>
                    </tbody>
                </table>
            </div>

            <div id="rmPagination" style="margin-top:16px;"></div>

            <!-- HAM MADDE GEÇMİŞ PANELİ -->
            <div id="rmHistoryOverlay" onclick="window.ProductsView.rmHandleHistoryOverlayClick(event)"
                style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:9998; align-items:center; justify-content:center; padding:20px;">
                <div onclick="event.stopPropagation()"
                    style="width:100%; max-width:1100px; max-height:92vh; background:#fff; border-radius:18px; box-shadow:0 28px 80px rgba(15,23,42,0.28); display:flex; flex-direction:column; overflow:hidden;">
                    <div style="padding:20px 24px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
                        <div>
                            <div style="font-size:18px; font-weight:800; color:#0f172a;">Alış Geçmişi</div>
                            <div id="rmHistorySubtitle" style="margin-top:4px; font-size:13px; color:#475569;"></div>
                        </div>
                        <button type="button" class="btn btn-secondary" onclick="window.ProductsView.rmCloseHistory()" style="padding:8px 14px;">Kapat</button>
                    </div>

                    <div style="padding:16px 24px; border-bottom:1px solid #f1f5f9; background:#fafbfc;">
                        <div style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end;">
                            <div class="form-group" style="margin-bottom:0; flex:1; min-width:160px;">
                                <label class="form-label" style="font-size:11px;">Başlangıç</label>
                                <input type="date" class="form-input" id="rmHistStart" oninput="window.ProductsView.rmApplyHistoryFilter()">
                            </div>
                            <div class="form-group" style="margin-bottom:0; flex:1; min-width:160px;">
                                <label class="form-label" style="font-size:11px;">Bitiş</label>
                                <input type="date" class="form-input" id="rmHistEnd" oninput="window.ProductsView.rmApplyHistoryFilter()">
                            </div>
                            <div class="form-group" style="margin-bottom:0; flex:1; min-width:200px;">
                                <label class="form-label" style="font-size:11px;">Sırala</label>
                                <select class="form-select" id="rmHistSort" onchange="window.ProductsView.rmApplyHistoryFilter()">
                                    <option value="date-desc">Tarih (Yeni → Eski)</option>
                                    <option value="date-asc">Tarih (Eski → Yeni)</option>
                                    <option value="total-desc">Toplam (Yüksek → Düşük)</option>
                                    <option value="total-asc">Toplam (Düşük → Yüksek)</option>
                                    <option value="unit-desc">Birim Maliyet (Yüksek → Düşük)</option>
                                    <option value="unit-asc">Birim Maliyet (Düşük → Yüksek)</option>
                                    <option value="qty-desc">Miktar (Yüksek → Düşük)</option>
                                    <option value="qty-asc">Miktar (Düşük → Yüksek)</option>
                                </select>
                            </div>
                            <div class="form-group" style="margin-bottom:0;">
                                <button type="button" class="btn btn-secondary" onclick="window.ProductsView.rmClearHistoryFilter()">Filtreleri Temizle</button>
                            </div>
                        </div>
                    </div>

                    <div id="rmHistorySummary" style="padding:12px 24px; background:#f8fafc; border-bottom:1px solid #f1f5f9; display:flex; gap:24px; flex-wrap:wrap; font-size:13px; color:#475569;"></div>

                    <div style="flex:1; overflow:auto;">
                        <table class="data-table" style="margin:0;">
                            <thead style="position:sticky; top:0; background:#fff; z-index:1;">
                                <tr>
                                    <th>Tarih</th>
                                    <th style="text-align:right;">Miktar</th>
                                    <th>Birim</th>
                                    <th style="text-align:right;">Birim Maliyet</th>
                                    <th style="text-align:right;">KDV</th>
                                    <th style="text-align:right;">Toplam Fiyat</th>
                                </tr>
                            </thead>
                            <tbody id="rmHistoryBody">
                                <tr><td colspan="6" style="text-align:center; padding:24px;">Yükleniyor...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    },

    loadRawMaterialsTab: async function () {
        var tbody = document.getElementById('rmTableBody');
        if (!tbody) return;

        try {
            var result = await window.SupabaseService.query('raw_materials', {
                filters: [{ op: 'eq', column: 'is_deleted', value: false }],
                order: { column: 'name', asc: true },
                select: 'id,name,unit,base_unit,cost,vat_rate,is_active,created_at'
            });
            if (!this._isActive) return;

            if (result.error) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:24px; color:#dc2626;">Ham maddeler yüklenemedi.</td></tr>';
                this.rmSetStatus(this.getErrorMessage(result.error, 'raw_materials okunamadı.'), 'error');
                return;
            }

            this.rmState.materials = Array.isArray(result.data) ? result.data : [];
            this.rmRenderTable();
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata.</td></tr>';
            this.rmSetStatus(this.getErrorMessage(err, 'Beklenmeyen hata.'), 'error');
        }
    },

    rmRenderTable: function () {
        var tbody = document.getElementById('rmTableBody');
        if (!tbody) return;

        var self = this;
        var q = this.normalizeName(this.rmState.search || '');
        var filtered = this.rmState.materials.filter(function (m) {
            if (!q) return true;
            return self.normalizeName(m.name || '').indexOf(q) !== -1;
        });

        var pageSize = this.rmState.pageSize || 30;
        var totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
        if (this.rmState.page > totalPages) this.rmState.page = totalPages;
        if (this.rmState.page < 1) this.rmState.page = 1;

        var start = (this.rmState.page - 1) * pageSize;
        var pageRows = filtered.slice(start, start + pageSize);

        if (!pageRows.length) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:24px; color:#64748b;">Kayıt yok.</td></tr>';
        } else {
            tbody.innerHTML = pageRows.map(function (m) {
                var id = self.escapeHtml(m.id);
                return '<tr>' +
                    '<td style="font-weight:600;">' + self.escapeHtml(m.name || '-') + '</td>' +
                    '<td>' + self.escapeHtml(m.unit || '-') +
                        ((m.base_unit && m.base_unit !== m.unit) ? ' <span style="color:#94a3b8;">→</span> <span style="font-weight:700;color:#475569;">' + self.escapeHtml(m.base_unit) + '</span>' : '') +
                    '</td>' +
                    '<td style="text-align:right; font-weight:700;">' + self.formatMoney(m.cost) + ' / ' + self.escapeHtml(m.base_unit || m.unit || '-') + '</td>' +
                    '<td><div style="display:flex; gap:6px; flex-wrap:wrap;">' +
                        '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="window.ProductsView.rmViewHistory(\'' + id + '\')">👁 Görüntüle</button>' +
                        '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="window.ProductsView.rmEdit(\'' + id + '\')">Düzenle</button>' +
                        '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px; color:#b91c1c;" onclick="window.ProductsView.rmRemove(\'' + id + '\')">Sil</button>' +
                    '</div></td>' +
                '</tr>';
            }).join('');
        }

        // Pagination
        var pagEl = document.getElementById('rmPagination');
        if (pagEl) {
            var total = filtered.length;
            var from = total === 0 ? 0 : start + 1;
            var to = Math.min(start + pageSize, total);
            var page = this.rmState.page;

            pagEl.innerHTML = '' +
                '<div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border:1px solid #e2e8f0; border-radius:14px; background:#ffffff;">' +
                    '<div style="display:flex; align-items:center; gap:10px;">' +
                        '<span style="font-size:13px; color:#475569; font-weight:600;">Sayfa başı</span>' +
                        '<select class="form-select" style="width:auto; min-width:90px;" onchange="window.ProductsView.rmChangePageSize(this.value)">' +
                            '<option value="30"' + (pageSize === 30 ? ' selected' : '') + '>30</option>' +
                            '<option value="50"' + (pageSize === 50 ? ' selected' : '') + '>50</option>' +
                            '<option value="100"' + (pageSize === 100 ? ' selected' : '') + '>100</option>' +
                        '</select>' +
                    '</div>' +
                    '<div style="font-size:13px; color:#64748b; font-weight:600;">' + from + '-' + to + ' / ' + total + '</div>' +
                    '<div style="display:flex; align-items:center; gap:8px;">' +
                        '<button class="btn btn-secondary" type="button" onclick="window.ProductsView.rmPrevPage()"' + (page <= 1 ? ' disabled style="opacity:0.5; cursor:not-allowed;"' : '') + '>Önceki</button>' +
                        '<span style="min-width:90px; text-align:center; font-size:13px; font-weight:700; color:#334155;">' + page + ' / ' + totalPages + '</span>' +
                        '<button class="btn btn-secondary" type="button" onclick="window.ProductsView.rmNextPage()"' + (page >= totalPages ? ' disabled style="opacity:0.5; cursor:not-allowed;"' : '') + '>Sonraki</button>' +
                    '</div>' +
                '</div>';
        }
    },

    rmPrevPage: function () {
        if (this.rmState.page <= 1) return;
        this.rmState.page--;
        this.rmRenderTable();
    },

    rmNextPage: function () {
        this.rmState.page++;
        this.rmRenderTable();
    },

    rmChangePageSize: function (v) {
        this.rmState.pageSize = Number(v) || 30;
        this.rmState.page = 1;
        this.rmRenderTable();
    },

    rmHandleSearch: function (value) {
        this.rmState.search = String(value || '');
        this.rmState.page = 1;
        this.rmRenderTable();
    },

    /* ============================================================
       HAM MADDE GEÇMİŞ PANELİ
       ============================================================ */
    rmViewHistory: async function (id) {
        var m = this.rmState.materials.find(function (x) { return String(x.id) === String(id); });
        if (!m) return;

        this.rmState.historyOpen = true;
        this.rmState.historyMaterial = m;
        this.rmState.historyRows = [];

        var overlay = document.getElementById('rmHistoryOverlay');
        var sub = document.getElementById('rmHistorySubtitle');
        if (overlay) overlay.style.display = 'flex';
        if (sub) {
            var purUnit = m.unit || '-';
            var basUnit = m.base_unit || m.unit || '-';
            sub.textContent = 'HM - ' + (m.name || '') +
                '  ·  Alış: ' + purUnit +
                '  ·  Hesap: ' + basUnit +
                '  ·  Maliyet: ' + this.formatMoney(m.cost) + ' / ' + basUnit;
        }

        this.rmClearHistoryFilter(true);
        await this.rmLoadHistory(m.id);
    },

    rmCloseHistory: function () {
        this.rmState.historyOpen = false;
        var overlay = document.getElementById('rmHistoryOverlay');
        if (overlay) overlay.style.display = 'none';
        this.rmState.historyMaterial = null;
        this.rmState.historyRows = [];
    },

    rmHandleHistoryOverlayClick: function (e) {
        var overlay = document.getElementById('rmHistoryOverlay');
        if (e.target === overlay) this.rmCloseHistory();
    },

    rmLoadHistory: async function (rawMaterialId) {
        var tbody = document.getElementById('rmHistoryBody');
        if (!tbody) return;

        try {
            var client = window.SupabaseService && typeof window.SupabaseService.getClient === 'function'
                ? window.SupabaseService.getClient() : null;
            if (!client) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:24px; color:#dc2626;">Client yüklenemedi.</td></tr>';
                return;
            }

            var resp = await client
                .from('purchase_items')
                .select('id,quantity,unit,unit_cost,line_total,vat_rate,discount_rate,created_at')
                .eq('raw_material_id', rawMaterialId)
                .eq('is_deleted', false)
                .order('created_at', { ascending: false });

            if (!this._isActive || !this.rmState.historyOpen) return;

            if (resp.error) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:24px; color:#dc2626;">' + this.escapeHtml(resp.error.message || 'Hata') + '</td></tr>';
                return;
            }

            this.rmState.historyRows = Array.isArray(resp.data) ? resp.data : [];
            this.rmRenderHistoryTable();
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata.</td></tr>';
        }
    },

    rmApplyHistoryFilter: function () {
        var f = this.rmState.historyFilter;
        f.startDate = (document.getElementById('rmHistStart') || {}).value || '';
        f.endDate = (document.getElementById('rmHistEnd') || {}).value || '';
        f.sortBy = (document.getElementById('rmHistSort') || {}).value || 'date-desc';
        this.rmRenderHistoryTable();
    },

    rmClearHistoryFilter: function (skipRender) {
        this.rmState.historyFilter = { startDate: '', endDate: '', sortBy: 'date-desc' };
        ['rmHistStart', 'rmHistEnd'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var sortEl = document.getElementById('rmHistSort');
        if (sortEl) sortEl.value = 'date-desc';
        if (!skipRender) this.rmRenderHistoryTable();
    },

    rmRenderHistoryTable: function () {
        var tbody = document.getElementById('rmHistoryBody');
        if (!tbody) return;

        var f = this.rmState.historyFilter;
        var self = this;

        var startTs = f.startDate ? new Date(f.startDate + 'T00:00:00').getTime() : null;
        var endTs = f.endDate ? new Date(f.endDate + 'T23:59:59').getTime() : null;

        var rows = (this.rmState.historyRows || []).filter(function (r) {
            var ts = r.created_at ? new Date(r.created_at).getTime() : 0;
            if (startTs !== null && ts < startTs) return false;
            if (endTs !== null && ts > endTs) return false;
            return true;
        });

        // Sort
        var sortBy = f.sortBy || 'date-desc';
        rows.sort(function (a, b) {
            var av, bv;
            switch (sortBy) {
                case 'date-asc':   av = new Date(a.created_at || 0).getTime(); bv = new Date(b.created_at || 0).getTime(); return av - bv;
                case 'date-desc':  av = new Date(a.created_at || 0).getTime(); bv = new Date(b.created_at || 0).getTime(); return bv - av;
                case 'total-asc':  return (Number(a.line_total) || 0) - (Number(b.line_total) || 0);
                case 'total-desc': return (Number(b.line_total) || 0) - (Number(a.line_total) || 0);
                case 'unit-asc':   return (Number(a.unit_cost) || 0) - (Number(b.unit_cost) || 0);
                case 'unit-desc':  return (Number(b.unit_cost) || 0) - (Number(a.unit_cost) || 0);
                case 'qty-asc':    return (Number(a.quantity) || 0) - (Number(b.quantity) || 0);
                case 'qty-desc':   return (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
                default:           return 0;
            }
        });

        // Summary — WAC: ortalama = sum(unit_cost * qty) / sum(qty)
        var sumQty = 0, sumTotal = 0, sumNetCost = 0;
        rows.forEach(function (r) {
            var qty = Number(r.quantity) || 0;
            var uc = Number(r.unit_cost) || 0;
            sumQty += qty;
            sumTotal += Number(r.line_total) || 0;
            sumNetCost += uc * qty;
        });
        var avgUnit = sumQty > 0 ? (sumNetCost / sumQty) : 0;
        var avgUnitStr = '₺' + (Number(avgUnit) || 0).toLocaleString('tr-TR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });

        var summary = document.getElementById('rmHistorySummary');
        if (summary) {
            summary.innerHTML =
                '<div><strong style="color:#0f172a;">' + rows.length + '</strong> kayıt</div>' +
                '<div>Toplam Tutar: <strong style="color:#059669;">' + self.formatMoney(sumTotal) + '</strong></div>' +
                '<div>Ort. Birim Maliyet: <strong style="color:#6366f1;">' + avgUnitStr + '</strong></div>';
        }

        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:24px; color:#64748b;">Filtreye uygun kayıt yok.</td></tr>';
            return;
        }

        tbody.innerHTML = rows.map(function (r) {
            var d = r.created_at ? new Date(r.created_at) : null;
            var dateStr = d ? d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '-';
            return '<tr>' +
                '<td>' + self.escapeHtml(dateStr) + '</td>' +
                '<td style="text-align:right; font-weight:600;">' + self.formatNumber(r.quantity) + '</td>' +
                '<td>' + self.escapeHtml(r.unit || '-') + '</td>' +
                '<td style="text-align:right;">' + self.formatMoney(r.unit_cost) + '</td>' +
                '<td style="text-align:right; color:#6366f1;">%' + self.formatNumber(r.vat_rate) + '</td>' +
                '<td style="text-align:right; font-weight:700; color:#059669;">' + self.formatMoney(r.line_total) + '</td>' +
            '</tr>';
        }).join('');
    },

    rmEdit: function (id) {
        var m = this.rmState.materials.find(function (x) { return String(x.id) === String(id); });
        if (!m) return;

        this.rmState.editingId = m.id;

        var n = document.getElementById('rmName');
        var u = document.getElementById('rmUnit');
        var v = document.getElementById('rmVat');
        var t = document.getElementById('rmFormTitle');
        var x = document.getElementById('rmCancelBtn');

        if (n) n.value = m.name || '';
        if (u) u.value = m.unit || 'gr';
        if (v) v.value = (m.vat_rate != null ? String(m.vat_rate) : '20');
        if (t) t.textContent = 'Ham Madde Düzenle';
        if (x) x.style.display = '';

        var pane = document.getElementById('productsPaneRawMaterials');
        if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    rmCancelEdit: function () {
        this.rmState.editingId = null;
        this.rmClearForm();
    },

    rmClearForm: function () {
        var n = document.getElementById('rmName');
        var u = document.getElementById('rmUnit');
        var v = document.getElementById('rmVat');
        var t = document.getElementById('rmFormTitle');
        var x = document.getElementById('rmCancelBtn');

        if (n) n.value = '';
        if (u) u.value = 'gr';
        if (v) v.value = '20';
        if (t) t.textContent = 'Ham Madde Ekle';
        if (x) x.style.display = 'none';
    },

    rmSave: async function () {
        var nEl = document.getElementById('rmName');
        var uEl = document.getElementById('rmUnit');
        var vEl = document.getElementById('rmVat');

        var name = nEl ? String(nEl.value || '').trim() : '';
        var unit = uEl ? String(uEl.value || '').trim() : '';
        var vat = vEl ? parseFloat(vEl.value) : 20;

        var errs = [];
        if (!name) errs.push('Ad zorunlu.');
        if (this.rmState.UNITS.indexOf(unit) === -1) errs.push('Birim geçersiz.');
        if (!Number.isFinite(vat) || vat < 0 || vat > 100) errs.push('KDV oranı 0-100 arası olmalı.');

        if (errs.length) { this.rmSetStatus(errs.join(' '), 'error'); return; }

        if (!window.SupabaseService || !window.SupabaseService.isConnected()) {
            this.rmSetStatus('Supabase bağlı değil.', 'error');
            return;
        }

        var self = this;
        var dup = this.rmState.materials.some(function (m) {
            if (self.rmState.editingId && String(m.id) === String(self.rmState.editingId)) return false;
            return self.normalizeName(m.name) === self.normalizeName(name);
        });
        if (dup) { this.rmSetStatus('Aynı isimde ham madde var.', 'error'); return; }

        // Cost manuel girilmiyor — yeni kayıtlarda 0 (WAC ilk alışta dolduracak);
        // düzenlemede cost'a dokunmuyoruz. vat_rate her iki durumda da yazılır.
        var resp;
        if (this.rmState.editingId) {
            resp = await window.SupabaseService.update('raw_materials', this.rmState.editingId, {
                name: name,
                unit: unit,
                vat_rate: vat
            });
        } else {
            resp = await window.SupabaseService.insert('raw_materials', {
                name: name,
                unit: unit,
                cost: 0,
                vat_rate: vat
            });
        }
        if (!this._isActive) return;

        if (resp && resp.error) {
            this.rmSetStatus(this.getErrorMessage(resp.error, 'Kaydedilemedi.'), 'error');
            return;
        }

        this.rmSetStatus(this.rmState.editingId ? 'Güncellendi.' : 'Eklendi.', 'success');
        this.rmState.editingId = null;
        this.rmClearForm();
        await this.loadRawMaterialsTab();
    },

    rmRemove: async function (id) {
        var m = this.rmState.materials.find(function (x) { return String(x.id) === String(id); });
        if (!m) return;
        var ok = window.confirm('"' + (m.name || '') + '" ham maddesi silinsin mi?');
        if (!ok) return;

        var resp = await window.SupabaseService.update('raw_materials', id, { is_deleted: true, is_active: false });
        if (!this._isActive) return;

        if (resp && resp.error) {
            this.rmSetStatus(this.getErrorMessage(resp.error, 'Silinemedi.'), 'error');
            return;
        }

        if (this.rmState.editingId && String(this.rmState.editingId) === String(id)) {
            this.rmState.editingId = null;
            this.rmClearForm();
        }

        this.rmSetStatus('Silindi.', 'success');
        await this.loadRawMaterialsTab();
    },

    rmSetStatus: function (msg, type) {
        var el = document.getElementById('rmStatus');
        if (!el) return;
        if (type === 'success') {
            el.innerHTML = '<div style="padding:12px 14px; border-radius:12px; background:#ecfdf5; border:1px solid #86efac; color:#166534; font-size:13px; font-weight:600;">' + this.escapeHtml(msg) + '</div>';
        } else {
            el.innerHTML = '<div style="padding:12px 14px; border-radius:12px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:13px; font-weight:600;">' + this.escapeHtml(msg) + '</div>';
        }
    },

    /* ============================================================
       PRODUCT INTELLIGENCE PANEL
       Real-data insights: margin, cost trends, recommendations.
       Veri yoksa: açıkça belirtilir, fake yok.
       ============================================================ */
    _renderProductInsights: async function () {
        var host = document.getElementById('productsInsightsPanel');
        if (!host) return;

        var products = (this.products || []).filter(function (p) {
            return p && !p.is_deleted;
        });

        if (!products.length) {
            host.innerHTML = '';
            return;
        }

        // Skeleton — loading state
        host.innerHTML = this._insightsSkeletonHtml();

        var self = this;

        // === ENRICH: products + performanceMap (gercek satis/kar verisi) ===
        var enriched = products
            .filter(function (p) { return Number(p.price || 0) > 0; })
            .map(function (p) {
                var perf = self.performanceMap ? (self.performanceMap.get(String(p.id)) || {}) : {};
                var price = Number(p.price || 0);
                var cost  = Number(p.cost || 0);
                var margin = price > 0 ? ((price - cost) / price) * 100 : 0;
                return {
                    id:       p.id,
                    name:     p.name,
                    price:    price,
                    cost:     cost,
                    margin:   margin,
                    quantity: Number(perf.quantity || 0),
                    revenue:  Number(perf.revenue  || 0),
                    profit:   Number(perf.estimated_profit || 0)
                };
            });

        // === EN GUCLU URUNLER: gercek kar (estimated_profit) DESC ===
        // Yalnizca bu ay satis olmus + cost > 0 olanlar; tie-breaker revenue.
        var highMargin = enriched
            .filter(function (p) { return p.quantity > 0 && p.cost > 0; })
            .sort(function (a, b) {
                if (b.profit !== a.profit) return b.profit - a.profit;
                return b.revenue - a.revenue;
            })
            .slice(0, 5);

        // === EN DUSUK KARLI: dusuk margin + en az 1 satis (anlamli kayip) ===
        var lowMargin = enriched
            .filter(function (p) { return p.quantity > 0 && p.cost > 0; })
            .sort(function (a, b) {
                if (a.margin !== b.margin) return a.margin - b.margin;
                return b.quantity - a.quantity; // ayni margin → cok satan once
            })
            .slice(0, 5);

        // === HAMMADDE FIYAT TRENDI ===
        var rmTrend = await this._computeRawMaterialPriceTrend();
        var trendingRmIds = {};
        rmTrend.forEach(function (t) { if (t.rmId) trendingRmIds[String(t.rmId)] = true; });

        // === PRODUCT_RECIPES MAPPING (urun -> rm seti) ===
        // Sadece hangi urunlerin hangi rm'leri kullandigini bilmek icin minimal fetch.
        // recipeState varsa kullan, yoksa tek seferlik fetch.
        var productToRm = {};  // { product_id: Set<rm_id> }
        try {
            var recRes = await window.SupabaseService.query('product_recipes', {
                filters: [{ op: 'eq', column: 'is_deleted', value: false }],
                select: 'product_id,raw_material_id'
            });
            if (recRes && Array.isArray(recRes.data)) {
                recRes.data.forEach(function (r) {
                    if (!r.product_id || !r.raw_material_id) return;
                    var key = String(r.product_id);
                    if (!productToRm[key]) productToRm[key] = {};
                    productToRm[key][String(r.raw_material_id)] = true;
                });
            }
        } catch (e) { /* noop */ }

        // === FIYAT ARTIRMA ONERILERI ===
        // Tetikleyici (OR):
        //   a) margin < %25 (acik kayip)
        //   b) margin < %35 + recipe'sinde son 60 gun maliyet artisi yasamis rm var (risk altinda)
        // Sıralama: revenue DESC (yuksek satis hacmi → onerinin etkisi buyuk)
        // Hedef: %35 margin → gerekli zam %.
        var suggestions = enriched
            .filter(function (p) {
                if (!(p.cost > 0)) return false;
                if (p.margin < 25) return true;
                if (p.margin < 35) {
                    var rms = productToRm[String(p.id)];
                    if (!rms) return false;
                    var hit = false;
                    Object.keys(rms).some(function (rmId) {
                        if (trendingRmIds[rmId]) { hit = true; return true; }
                        return false;
                    });
                    return hit;
                }
                return false;
            })
            .sort(function (a, b) {
                if (b.revenue !== a.revenue) return b.revenue - a.revenue; // satis hacmi onceligi
                return a.margin - b.margin;                                 // sonra dusuk margin
            })
            .slice(0, 5)
            .map(function (p) {
                var targetPrice = p.cost / (1 - 0.35); // hedef margin %35
                var raise = p.price > 0 ? ((targetPrice - p.price) / p.price) * 100 : 0;
                if (raise < 3) raise = 3;
                if (raise > 30) raise = 30;
                return { name: p.name, raisePct: Math.round(raise), currentMargin: p.margin };
            });

        host.innerHTML = this._insightsHtml({
            rmTrend: rmTrend,
            suggestions: suggestions,
            lowMargin: lowMargin,
            highMargin: highMargin
        });
    },

    _computeRawMaterialPriceTrend: async function () {
        try {
            if (!window.SupabaseService || typeof window.SupabaseService.query !== 'function') return [];

            // ============================================================
            // YENI MANTIK — son alis vs onceki alis (kullanici beklentisi)
            //   1) created_at DESC ile son alis kayitlarini cek
            //   2) Her hammadde icin ilk 2 (latest, previous) sakla
            //   3) base_unit_cost uzerinden % fark hesapla (mixed unit-safe)
            //   4) >=%5 artislari sirala, top 5
            // ============================================================
            var res = await window.SupabaseService.query('purchase_items', {
                filters: [
                    { op: 'eq', column: 'is_deleted', value: false }
                ],
                order: { column: 'created_at', asc: false },
                select: 'raw_material_id,created_at,base_unit_cost'
            });

            if (!res || res.error || !Array.isArray(res.data) || !res.data.length) return [];

            // Per-rm en son 2 satir (DESC siralama sayesinde ilk 2 = latest, previous)
            var pair = {}; // { rmId: [latest, previous] }
            res.data.forEach(function (it) {
                var rmId = it.raw_material_id;
                if (!rmId) return;
                var cost = Number(it.base_unit_cost) || 0;
                if (cost <= 0) return;
                if (!pair[rmId]) pair[rmId] = [];
                if (pair[rmId].length < 2) {
                    pair[rmId].push({ cost: cost, created_at: it.created_at });
                }
            });

            // RM isim + birim cozumu (rmState varsa kullan, yoksa fetch)
            var rmInfoMap = {}; // { id: {name, unit, base_unit} }
            var rmList = (this.rmState && this.rmState.materials) || [];
            rmList.forEach(function (m) {
                rmInfoMap[m.id] = { name: m.name, unit: m.unit, base_unit: m.base_unit };
            });

            var rmIds = Object.keys(pair);
            var missingIds = rmIds.filter(function (id) {
                var info = rmInfoMap[id];
                return !info || !info.name || !info.base_unit;
            });
            if (missingIds.length) {
                try {
                    var nameRes = await window.SupabaseService.query('raw_materials', {
                        filters: [{ op: 'in', column: 'id', value: missingIds }],
                        select: 'id,name,unit,base_unit'
                    });
                    (nameRes && nameRes.data || []).forEach(function (m) {
                        rmInfoMap[m.id] = { name: m.name, unit: m.unit, base_unit: m.base_unit };
                    });
                } catch (e) { /* noop */ }
            }

            var self = this;
            var trends = rmIds.map(function (rmId) {
                var arr = pair[rmId];
                if (!arr || arr.length < 2) return null; // karsilastirma icin 2 alis sart
                var latest   = arr[0];
                var previous = arr[1];
                if (!latest || !previous) return null;
                if (!(previous.cost > 0)) return null;

                var pct = ((latest.cost - previous.cost) / previous.cost) * 100;
                if (pct < 5) return null; // sadece anlamli artislar (>=%5)

                var info = rmInfoMap[rmId] || {};
                var purchaseUnit = info.unit || info.base_unit || '';
                var baseUnit     = info.base_unit || info.unit || '';

                // Purchase unit cost (display) — base_unit_cost'tan kullanicinin gordugu birime cevir
                var fromPurchase = self._puPurchaseUnitCost(previous.cost, purchaseUnit, baseUnit);
                var toPurchase   = self._puPurchaseUnitCost(latest.cost,   purchaseUnit, baseUnit);

                return {
                    rmId: rmId,
                    name: info.name || 'Hammadde',
                    pct: Math.round(pct),
                    // base_unit cost'lar (ham veri)
                    fromCost: previous.cost,
                    toCost:   latest.cost,
                    // purchase unit cost'lar (display icin)
                    fromCostPurchase: fromPurchase,
                    toCostPurchase:   toPurchase,
                    purchaseUnit:     purchaseUnit
                };
            }).filter(Boolean);

            trends.sort(function (a, b) { return b.pct - a.pct; });
            return trends.slice(0, 5);
        } catch (e) {
            return [];
        }
    },

    _insightsSkeletonHtml: function () {
        var skel = function () {
            return '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;min-height:120px;">' +
                '<div style="height:10px;width:130px;background:#f1f5f9;border-radius:6px;margin-bottom:10px;"></div>' +
                '<div style="height:8px;width:90%;background:#f1f5f9;border-radius:6px;margin-bottom:6px;"></div>' +
                '<div style="height:8px;width:70%;background:#f1f5f9;border-radius:6px;"></div>' +
            '</div>';
        };
        return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">' +
            skel() + skel() + skel() + skel() +
        '</div>';
    },

    _insightsHtml: function (data) {
        var fmt = window.Formatters;
        var c   = function (v) { return (fmt && fmt.currency) ? fmt.currency(v) : ('₺' + Number(v||0).toLocaleString('tr-TR')); };

        var card = function (opts) {
            var icon = opts.icon || '';
            var title = opts.title;
            var color = opts.color || '#0f172a';
            var rows = opts.rows || [];
            var empty = opts.empty || 'Veri yok';

            var rowsHtml = rows.length
                ? rows.map(function (r) {
                    var topLine =
                        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                            '<span style="font-size:12.5px;color:#0f172a;font-weight:600;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + r.label + '</span>' +
                            '<span style="font-size:12.5px;font-weight:700;color:' + (r.valueColor || color) + ';">' + r.value + '</span>' +
                        '</div>';
                    var subLine = r.subtitle
                        ? '<div style="margin-top:2px;font-size:11px;color:#94a3b8;font-weight:500;">' + r.subtitle + '</div>'
                        : '';
                    return '<div style="padding:6px 0;border-bottom:1px solid #f1f5f9;">' + topLine + subLine + '</div>';
                }).join('')
                : '<div style="padding:14px 0;text-align:center;color:#94a3b8;font-size:12.5px;font-weight:600;">' + empty + '</div>';

            return '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;">' +
                '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:' + (opts.iconBg || '#f1f5f9') + ';color:' + color + ';">' + icon + '</span>' +
                    '<span style="font-size:12.5px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">' + title + '</span>' +
                '</div>' +
                '<div style="margin-top:2px;">' + rowsHtml + '</div>' +
            '</div>';
        };

        var iconUp   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
        var iconBolt = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
        var iconDown = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
        var iconStar = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

        var moneyShort = function (v) {
            var n = Number(v) || 0;
            return '₺' + n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        };

        var rmTrendCard = card({
            title: 'En Çok Artan Hammaddeler',
            icon:  iconUp,
            color: '#b45309',
            iconBg:'#fef3c7',
            empty: 'Son alışlarda anlamlı fiyat artışı yok',
            rows: data.rmTrend.map(function (t) {
                var unit = t.purchaseUnit ? ' / ' + t.purchaseUnit : '';
                var hasPrices = (t.fromCostPurchase > 0 && t.toCostPurchase > 0);
                var sub = hasPrices
                    ? (moneyShort(t.fromCostPurchase) + unit + ' → ' + moneyShort(t.toCostPurchase) + unit)
                    : '';
                return {
                    label:      t.name,
                    value:      '+' + t.pct + '%',
                    valueColor: '#b45309',
                    subtitle:   sub
                };
            })
        });

        var sugCard = card({
            title: 'Fiyat Artırma Önerileri',
            icon:  iconBolt,
            color: '#0ea5e9',
            iconBg:'#e0f2fe',
            empty: 'Şu an öneri gerektiren ürün yok',
            rows: data.suggestions.map(function (s) {
                return { label: s.name, value: '+' + s.raisePct + '%', valueColor: '#0369a1' };
            })
        });

        var lowCard = card({
            title: 'En Düşük Karlı Ürünler',
            icon:  iconDown,
            color: '#dc2626',
            iconBg:'#fee2e2',
            empty: 'Maliyet verisi olan ürün yok',
            rows: data.lowMargin.map(function (p) {
                return { label: p.name, value: '%' + p.margin.toFixed(0), valueColor: '#dc2626' };
            })
        });

        var highCard = card({
            title: 'En Çok Kazandıranlar',
            icon:  iconStar,
            color: '#16a34a',
            iconBg:'#dcfce7',
            empty: 'Maliyet verisi olan ürün yok',
            rows: data.highMargin.map(function (p) {
                return { label: p.name, value: '%' + p.margin.toFixed(0), valueColor: '#16a34a' };
            })
        });

        return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z"/></svg>' +
                '<span style="font-size:12.5px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">Akıllı İçgörüler</span>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">' +
                rmTrendCard + sugCard + lowCard + highCard +
            '</div>';
    },

    /* ============================================================
       ALIŞ TAB
       ============================================================ */
    _renderPurchasePane: function () {
        if (this._tabsRendered['purchase']) return;
        this._tabsRendered['purchase'] = true;

        var pane = document.getElementById('productsPanePurchase');
        if (!pane) return;

        var today = new Date();
        var dateStr = today.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });

        pane.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:4px 0 14px 0;">
                <div>
                    <h2 style="margin:0 0 6px 0;font-size:26px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;">Alış Faturası</h2>
                    <p style="margin:0;color:#64748b;font-size:13.5px;">Yeni alış faturası oluşturun.</p>
                </div>
                <button id="puToggleFormBtn" type="button" style="
                    border:none;background:#0f172a;color:#fff;padding:11px 18px;
                    border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;
                    display:inline-flex;align-items:center;gap:8px;
                ">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span id="puToggleFormBtnLabel">Yeni Alış Faturası</span>
                </button>
            </div>

            <!-- INVOICE CARD (accordion) -->
            <div id="puInvoiceCard" style="display:none; margin-top:8px; background:#fff; border:1px solid #e2e8f0; border-radius:18px; overflow:hidden; box-shadow:0 1px 3px rgba(15,23,42,0.04);">
                <div style="padding:20px 24px; background:linear-gradient(135deg,#0f172a,#1e293b); color:#fff; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px;">
                    <div>
                        <div style="font-size:11px; font-weight:600; color:#94a3b8; letter-spacing:0.1em;">ALIŞ FATURASI</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap;">
                        <!-- KDV TOGGLE -->
                        <div style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14); padding:4px; border-radius:10px;">
                            <button type="button" id="puVatModeExcl" onclick="window.ProductsView.puSetVatMode(false)"
                                style="padding:7px 14px; border:none; border-radius:7px; font-size:12px; font-weight:700; cursor:pointer; background:#fff; color:#0f172a;">
                                KDV HARİÇ
                            </button>
                            <button type="button" id="puVatModeIncl" onclick="window.ProductsView.puSetVatMode(true)"
                                style="padding:7px 14px; border:none; border-radius:7px; font-size:12px; font-weight:700; cursor:pointer; background:transparent; color:#cbd5e1;">
                                KDV DAHİL
                            </button>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:11px; font-weight:600; color:#94a3b8; letter-spacing:0.1em;">TARİH</div>
                            <div style="font-size:15px; font-weight:700; margin-top:4px;">${dateStr}</div>
                        </div>
                    </div>
                </div>

                <!-- TARIH + SUPPLIER + DESCRIPTION (UI only, optional) -->
                <div style="padding:16px 24px; background:#fff; border-bottom:1px solid #f1f5f9; display:grid; grid-template-columns: 0.6fr 1fr 1.6fr; gap:14px;">
                    <div>
                        <label style="display:block; font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.05em; margin-bottom:6px;">TARİH</label>
                        <input type="date" id="puDate" class="form-input"
                            style="font-size:14px;" />
                    </div>
                    <div>
                        <label style="display:block; font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.05em; margin-bottom:6px;">FİRMA</label>
                        <input type="text" id="puSupplier" class="form-input" placeholder="Tedarikçi / firma adı (opsiyonel)"
                            oninput="window.ProductsView.puSetSupplier(this.value)"
                            style="font-size:14px;" />
                    </div>
                    <div>
                        <label style="display:block; font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.05em; margin-bottom:6px;">AÇIKLAMA</label>
                        <input type="text" id="puDescription" class="form-input" placeholder="Fatura açıklaması (opsiyonel)"
                            oninput="window.ProductsView.puSetDescription(this.value)"
                            style="font-size:14px;" />
                    </div>
                </div>

                <!-- COLUMN HEADERS (7 col: HM | MIKTAR | BIRIM | ISK% | KDV | TOPLAM | x) -->
                <div style="padding:12px 24px; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:grid; grid-template-columns: 1.9fr 0.85fr 0.95fr 0.65fr 0.7fr 1.05fr 36px; gap:8px; font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.05em;">
                    <div>HAM MADDE</div>
                    <div style="text-align:right;">MİKTAR</div>
                    <div style="text-align:right;" id="puHdrUnit">BİRİM FİYAT (KDV HARİÇ)</div>
                    <div style="text-align:right;">% İSK</div>
                    <div style="text-align:right;">KDV</div>
                    <div style="text-align:right;">TOPLAM</div>
                    <div></div>
                </div>

                <!-- LINES -->
                <div id="puLinesWrap" style="padding:8px 12px;"></div>

                <!-- ADD LINE -->
                <div style="padding:12px 24px; border-top:1px solid #f1f5f9;">
                    <button class="btn btn-secondary" type="button" onclick="window.ProductsView.puAddLine()" style="width:100%; padding:12px; border:1.5px dashed #cbd5e1; background:#fafbfc;">
                        + Satır Ekle
                    </button>
                </div>

                <!-- GENEL ISKONTO PANELI + TOTALS -->
                <div style="padding:20px 24px; background:#fafbfc; border-top:1px solid #e2e8f0; display:grid; grid-template-columns:1fr 1fr; gap:24px;">
                    <!-- LEFT: Genel iskonto -->
                    <div style="background:#ffffff; border:1.5px solid #fde68a; border-radius:12px; padding:14px 16px;">
                        <div style="font-size:11px; font-weight:700; color:#92400e; letter-spacing:0.06em; text-transform:uppercase; margin-bottom:10px;">Genel İskonto</div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <select id="puGenDiscType" class="form-select"
                                onchange="window.ProductsView.puSetGeneralDiscountType(this.value)"
                                style="flex:0 0 auto; min-width:90px; font-size:14px;">
                                <option value="amount" selected>₺ TL</option>
                                <option value="percent">% Yüzde</option>
                            </select>
                            <input type="number" id="puGenDiscValue" class="form-input"
                                placeholder="0"
                                step="0.01" min="0"
                                value=""
                                oninput="window.ProductsView.puSetGeneralDiscountValue(this.value)"
                                style="flex:1; text-align:right; font-size:14px;">
                        </div>
                        <div style="margin-top:8px; font-size:12px; color:#92400e; font-weight:600;">
                            KDV'den önce uygulanır. Tüm satırlara orantılı dağıtılır.
                        </div>
                    </div>

                    <!-- RIGHT: Totals -->
                    <div style="display:flex; justify-content:flex-end;">
                        <div style="min-width:320px;">
                            <div style="display:flex; justify-content:space-between; padding:6px 0; font-size:14px; color:#475569;">
                                <span>Brüt Toplam</span>
                                <span id="puGrandBrut" style="font-weight:700; color:#0f172a;">₺0,00</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; padding:6px 0; font-size:14px; color:#b45309;">
                                <span>Satır İskontoları</span>
                                <span id="puGrandLineDisc" style="font-weight:700;">−₺0,00</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; padding:6px 0; font-size:14px; color:#b45309;">
                                <span>Genel İskonto</span>
                                <span id="puGrandGenDisc" style="font-weight:700;">−₺0,00</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; padding:6px 0; font-size:14px; color:#0f172a; border-top:1px solid #e2e8f0; margin-top:6px; padding-top:10px;">
                                <span>Ara Toplam (KDV hariç)</span>
                                <span id="puGrandNet" style="font-weight:700;">₺0,00</span>
                            </div>
                            <div id="puVatBreakdown" style="padding:4px 0;"></div>
                            <div style="display:flex; justify-content:space-between; padding:6px 0; font-size:14px; color:#475569; border-top:1px solid #e2e8f0; margin-top:6px; padding-top:10px;">
                                <span>Toplam KDV</span>
                                <span id="puGrandVat" style="font-weight:700; color:#6366f1;">₺0,00</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; padding:12px 0 0 0; font-size:18px; font-weight:800; color:#059669; border-top:2px solid #0f172a; margin-top:10px;">
                                <span>GENEL TOPLAM</span>
                                <span id="puGrandTotal">₺0,00</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- ACTIONS -->
                <div style="padding:16px 24px; border-top:1px solid #e2e8f0; display:flex; justify-content:flex-end; gap:10px;">
                    <button class="btn btn-secondary" type="button" onclick="window.ProductsView.puToggleForm()" style="border:1px solid #e5e7eb;background:#fff;color:#475569;">Formu Kapat</button>
                    <button class="btn btn-secondary" type="button" onclick="window.ProductsView.puClearAll()">Temizle</button>
                    <button class="btn btn-primary" type="button" id="puSaveAllBtn" onclick="window.ProductsView.puSaveAll()" style="min-width:160px;">Faturayı Kaydet</button>
                </div>
            </div>

            <div id="puStatus" style="margin:16px 0;"></div>

            <div class="page-header" style="margin-top:24px; display:flex; justify-content:space-between; align-items:center;">
                <h2 class="page-title" style="font-size:1rem; margin:0;">Son Alışlar</h2>
            </div>

            <!-- FİLTRE BAR -->
            <div style="margin:10px 0 12px 0; padding:14px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; display:flex; gap:12px; align-items:end; flex-wrap:wrap;">
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <label style="font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.04em;">BAŞLANGIÇ</label>
                    <input type="date" id="puFilterStart" class="form-input" style="font-size:13px; min-width:150px;">
                </div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <label style="font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.04em;">BİTİŞ</label>
                    <input type="date" id="puFilterEnd" class="form-input" style="font-size:13px; min-width:150px;">
                </div>
                <button type="button" class="btn btn-primary" onclick="window.ProductsView.puApplyRecentFilter()" style="padding:8px 16px; font-size:13px;">Filtrele</button>
                <button type="button" class="btn btn-secondary" onclick="window.ProductsView.puClearRecentFilter()" style="padding:8px 16px; font-size:13px;">Temizle</button>
                <div style="margin-left:auto; font-size:12px; color:#64748b;" id="puRecentCount">—</div>
            </div>

            <div class="data-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="white-space:nowrap;">Tarih</th>
                            <th>Firma</th>
                            <th>Ham Madde</th>
                            <th style="text-align:right;">Miktar</th>
                            <th style="text-align:right;">Birim Fiyat</th>
                            <th style="text-align:right; width:60px;">KDV</th>
                            <th style="text-align:right;">Toplam</th>
                            <th style="width:190px; text-align:right;">İşlem</th>
                        </tr>
                    </thead>
                    <tbody id="puTableBody">
                        <tr><td colspan="8" style="text-align:center; padding:24px;">Yükleniyor...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- PAGINATION -->
            <div id="puPagination" style="margin-top:12px; display:flex; justify-content:center; gap:6px; flex-wrap:wrap;"></div>

            <!-- VIEW MODAL -->
            <div id="puViewModal" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,0.5); backdrop-filter:blur(4px); z-index:9998; align-items:center; justify-content:center; padding:20px;">
                <div style="background:#fff; width:100%; max-width:640px; border-radius:18px; box-shadow:0 25px 60px rgba(15,23,42,0.25); overflow:hidden; max-height:90vh; display:flex; flex-direction:column;">
                    <div style="padding:20px 24px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center;">
                        <h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">Alış Detay</h3>
                        <button type="button" onclick="window.ProductsView.puCloseView()" style="border:none; background:transparent; color:#64748b; font-size:22px; cursor:pointer; padding:4px 8px; border-radius:6px;">×</button>
                    </div>
                    <div id="puViewBody" style="padding:20px 24px; overflow-y:auto;"></div>
                    <div style="padding:14px 24px; border-top:1px solid #f1f5f9; display:flex; justify-content:flex-end; gap:10px;">
                        <button type="button" class="btn btn-secondary" onclick="window.ProductsView.puCloseView()">Kapat</button>
                    </div>
                </div>
            </div>
        `;

        // Close dropdowns on outside click
        var self = this;
        document.addEventListener('click', function (e) {
            if (self._activeTab !== 'purchase') return;
            var dds = document.querySelectorAll('.pu-line-dropdown');
            dds.forEach(function (dd) {
                var parent = dd.closest('.pu-line-row');
                if (!parent) return;
                if (!parent.contains(e.target)) dd.style.display = 'none';
            });
        });

        // Start with 1 empty line
        if (!this.purchaseState.lines.length) {
            this.puAddLine();
        } else {
            this.puRenderLines();
        }

        // Default tarih = bugün (kullanıcı değiştirebilir)
        var puDateEl = document.getElementById('puDate');
        if (puDateEl && !puDateEl.value) {
            puDateEl.value = new Date().toISOString().slice(0, 10);
        }

        // Accordion toggle button
        var toggleBtn = document.getElementById('puToggleFormBtn');
        if (toggleBtn) {
            toggleBtn.onclick = function () { window.ProductsView.puToggleForm(); };
        }
    },

    puToggleForm: function () {
        var card  = document.getElementById('puInvoiceCard');
        var label = document.getElementById('puToggleFormBtnLabel');
        var topBtn = document.getElementById('puToggleFormBtn');
        if (!card) return;
        var willOpen = (card.style.display === 'none' || !card.style.display);
        card.style.display = willOpen ? 'block' : 'none';
        if (label) label.textContent = 'Yeni Alış Faturası';
        // Form acikken ust butonu gizle, kapaliyken goster
        if (topBtn) topBtn.style.display = willOpen ? 'none' : 'inline-flex';
        if (willOpen) {
            try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* noop */ }
        }
    },

    loadPurchaseTab: async function () {
        await Promise.all([
            this.puLoadRawMaterials(),
            this.puLoadRecent()
        ]);
    },

    puLoadRawMaterials: async function () {
        try {
            var result = await window.SupabaseService.query('raw_materials', {
                filters: [{ op: 'eq', column: 'is_deleted', value: false }],
                order: { column: 'name', asc: true },
                select: 'id,name,unit,base_unit,cost,vat_rate'
            });
            if (!this._isActive) return;
            if (result.error) {
                this.puSetStatus(this.getErrorMessage(result.error, 'Ham maddeler yüklenemedi.'), 'error');
                return;
            }
            this.purchaseState.rawMaterials = Array.isArray(result.data) ? result.data : [];
        } catch (err) {
            this.puSetStatus(this.getErrorMessage(err, 'Beklenmeyen hata.'), 'error');
        }
    },

    // ============================================================
    // INVOICE-LEVEL HELPERS (note sütununda JSON metadata ile)
    // ============================================================
    _puMakeInvoiceId: function () {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
        } catch (e) {}
        // RFC4122 v4 fallback
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    },

    _puParseNote: function (note) {
        // HER DURUMDA güvenli sonuç döner — asla throw etmez
        var empty = { invoice_id: null, supplier: null, description: null, general_discount: null };
        try {
            if (note === null || typeof note === 'undefined' || note === '') return empty;

            if (typeof note === 'object') {
                try {
                    return {
                        invoice_id: note.invoice_id || null,
                        supplier: note.supplier || null,
                        description: note.description || null,
                        general_discount: note.general_discount || null
                    };
                } catch (e1) { return empty; }
            }

            var str = String(note).trim();
            if (!str) return empty;

            if (str.charAt(0) === '{') {
                try {
                    var obj = JSON.parse(str);
                    if (obj && typeof obj === 'object') {
                        return {
                            invoice_id: obj.invoice_id || null,
                            supplier: obj.supplier || null,
                            description: obj.description || null,
                            general_discount: obj.general_discount || null
                        };
                    }
                } catch (e2) {
                    return { invoice_id: null, supplier: null, description: str, general_discount: null };
                }
                return empty;
            }

            return { invoice_id: null, supplier: null, description: str, general_discount: null };
        } catch (eAll) {
            return empty;
        }
    },

    _puMakeNote: function (invoiceId, supplier, description, generalDiscount) {
        var payload = {
            invoice_id: invoiceId || null,
            supplier: supplier || null,
            description: description || null
        };
        if (generalDiscount && typeof generalDiscount === 'object'
            && Number(generalDiscount.value) > 0) {
            payload.general_discount = {
                type: generalDiscount.type === 'percent' ? 'percent' : 'amount',
                value: Number(generalDiscount.value) || 0
            };
        }
        return JSON.stringify(payload);
    },

    _puGroupByInvoice: function (items) {
        var self = this;
        var map = {};
        var order = [];

        (items || []).forEach(function (it) {
            var meta = self._puParseNote(it.note);
            // legacy item (invoice_id yok): her item kendi faturası
            var invId = meta.invoice_id || ('legacy:' + it.id);
            if (!map[invId]) {
                map[invId] = {
                    invoice_id: invId,
                    invoice_no: (it.invoice_no != null) ? Number(it.invoice_no) : null,
                    is_legacy: !meta.invoice_id,
                    supplier: meta.supplier,
                    description: meta.description,
                    created_at: it.created_at,
                    items: [],
                    total: 0,
                    count: 0,
                    general_discount: null
                };
                order.push(invId);
            }
            var g = map[invId];
            g.items.push(it);
            g.total += Number(it.line_total) || 0;
            g.count++;
            // invoice_no — null degilse ilk goren yazsin (tum satirlar ayni numara)
            if (g.invoice_no == null && it.invoice_no != null) {
                g.invoice_no = Number(it.invoice_no);
            }
            // en eski (ilk) created_at'ı header tarihi olarak tut
            if (it.created_at && (!g.created_at || new Date(it.created_at) < new Date(g.created_at))) {
                g.created_at = it.created_at;
            }
            // metadata öncelik: doluysa güncelle
            if (!g.supplier && meta.supplier) g.supplier = meta.supplier;
            if (!g.description && meta.description) g.description = meta.description;
            // Genel iskonto — önce kolonlardan oku, yoksa legacy note fallback
            if (!g.general_discount) {
                var colAmt = Number(it.general_discount_amount);
                if (Number.isFinite(colAmt) && colAmt > 0) {
                    g.general_discount = {
                        type: it.general_discount_type === 'percent' ? 'percent' : 'amount',
                        value: colAmt
                    };
                } else if (meta.general_discount && Number(meta.general_discount.value) > 0) {
                    g.general_discount = {
                        type: meta.general_discount.type === 'percent' ? 'percent' : 'amount',
                        value: Number(meta.general_discount.value) || 0
                    };
                }
            }
        });

        // Genel iskontoyu net_total'a yansıt — liste için (puRecalcAll mantığıyla aynı)
        order.forEach(function (k) {
            var g = map[k];
            // Her satırın netPost'unu yeniden çıkar (line_total = q*u*(1-d/100)*(1+v/100))
            var sumNetPost = 0;
            var rows = [];
            (g.items || []).forEach(function (it) {
                var q = Number(it.quantity) || 0;
                var u = Number(it.unit_cost) || 0;
                var v = Number(it.vat_rate) || 0;
                var d = Number(it.discount_rate) || 0;
                if (d < 0) d = 0; if (d > 100) d = 100;
                var rowNetPost = q * u * (1 - d / 100);
                sumNetPost += rowNetPost;
                rows.push({ rowNetPost: rowNetPost, v: v });
            });

            var gdVal = (g.general_discount && Number(g.general_discount.value)) || 0;
            var gdType = g.general_discount && g.general_discount.type === 'percent' ? 'percent' : 'amount';
            var gdAmt = 0;
            if (gdVal > 0 && sumNetPost > 0) {
                gdAmt = (gdType === 'percent')
                    ? sumNetPost * (Math.max(0, Math.min(100, gdVal)) / 100)
                    : gdVal;
                if (gdAmt > sumNetPost) gdAmt = sumNetPost;
                if (gdAmt < 0) gdAmt = 0;
            }

            var finalNet = sumNetPost - gdAmt;
            var factor = sumNetPost > 0 ? (finalNet / sumNetPost) : 0;
            var vatTotal = 0;
            rows.forEach(function (r) {
                var lineFinalNet = r.rowNetPost * factor;
                var lineVat = lineFinalNet * (r.v / 100);
                if (lineVat < 0) lineVat = 0;
                vatTotal += lineVat;
            });

            g.net_total = Math.max(0, finalNet + vatTotal);
        });

        // Yeni fatura en üstte
        return order.map(function (k) { return map[k]; }).sort(function (a, b) {
            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });
    },

    puLoadRecent: async function () {
        var tbody = document.getElementById('puTableBody');
        if (!tbody) return;

        try {
            var client = window.SupabaseService && typeof window.SupabaseService.getClient === 'function'
                ? window.SupabaseService.getClient() : null;
            if (!client) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:#dc2626;">Client yüklenemedi.</td></tr>';
                return;
            }

            // Tarih + pagination — RPC ile sunucu tarafi
            var f = (this.purchaseState && this.purchaseState.recentFilter) || {};
            var startDate = f.startDate || null;
            var endDate   = f.endDate   || null;
            var page      = Number(f.page) > 0 ? Number(f.page) : 1;
            var pageSize  = Number(f.pageSize) > 0 ? Number(f.pageSize) : 20;
            var offset    = (page - 1) * pageSize;

            var resp = await client.rpc('get_purchase_invoices_paginated', {
                p_start:  startDate,
                p_end:    endDate,
                p_limit:  pageSize,
                p_offset: offset
            });

            if (!this._isActive) return;

            if (resp.error) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:#dc2626;">' + this.escapeHtml(resp.error.message || 'Hata') + '</td></tr>';
                return;
            }

            this.purchaseState.purchasesAll = Array.isArray(resp.data) ? resp.data : [];
            this.purchaseState.recentFilter.page = page;
            this.puRenderTable();
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata.</td></tr>';
        }
    },

    puApplyRecentFilter: function () {
        var s = document.getElementById('puFilterStart');
        var e = document.getElementById('puFilterEnd');
        this.purchaseState.recentFilter.startDate = s ? s.value : '';
        this.purchaseState.recentFilter.endDate   = e ? e.value : '';
        this.purchaseState.recentFilter.page = 1;
        this.puRenderTable();
    },

    puClearRecentFilter: function () {
        var s = document.getElementById('puFilterStart');
        var e = document.getElementById('puFilterEnd');
        if (s) s.value = '';
        if (e) e.value = '';
        this.purchaseState.recentFilter.startDate = '';
        this.purchaseState.recentFilter.endDate = '';
        this.purchaseState.recentFilter.page = 1;
        this.puRenderTable();
    },

    puSetRecentPage: function (n) {
        this.purchaseState.recentFilter.page = Math.max(1, Number(n) || 1);
        this.puRenderTable();
    },

    _puFilterRecent: function () {
        // Önce itemları fatura bazında grupla, sonra faturaya göre tarih filtrele
        var all = this.purchaseState.purchasesAll || [];
        var invoices = this._puGroupByInvoice(all);

        var f = this.purchaseState.recentFilter || {};
        var startTs = f.startDate ? new Date(f.startDate + 'T00:00:00').getTime() : null;
        var endTs   = f.endDate   ? new Date(f.endDate   + 'T23:59:59').getTime() : null;

        return invoices.filter(function (inv) {
            if (!inv.created_at) return true;
            var t = new Date(inv.created_at).getTime();
            if (startTs !== null && t < startTs) return false;
            if (endTs   !== null && t > endTs)   return false;
            return true;
        });
    },

    formatInvoiceNo: function (no) {
        if (no == null || no === '') return '—';
        var n = Number(no);
        if (!Number.isFinite(n)) return String(no);
        return String(Math.floor(n)).padStart(12, '0');
    },

    puRenderTable: function () {
        var tbody = document.getElementById('puTableBody');
        if (!tbody) return;

        // Invoice-bazli kolonlar (RPC: get_purchase_invoices_paginated)
        var thead = tbody.parentNode ? tbody.parentNode.querySelector('thead') : null;
        if (thead) {
            thead.innerHTML = '<tr>' +
                '<th style="white-space:nowrap; width:160px;">No</th>' +
                '<th style="white-space:nowrap; width:140px;">Tarih</th>' +
                '<th style="text-align:right; width:100px;">Kalem</th>' +
                '<th style="text-align:right;">Toplam</th>' +
                '<th style="width:120px; text-align:right;">İşlem</th>' +
            '</tr>';
        }

        // RPC sonucunu dogrudan kullan (server-side pagination)
        var invoices = Array.isArray(this.purchaseState.purchasesAll)
            ? this.purchaseState.purchasesAll : [];

        var f = this.purchaseState.recentFilter || {};
        var pageSize = f.pageSize || 20;
        var page = f.page || 1;
        var totalCount = (invoices[0] && invoices[0].total_count != null)
            ? Number(invoices[0].total_count)
            : invoices.length;
        var totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

        this.purchaseState.purchases = invoices;

        var countEl = document.getElementById('puRecentCount');
        if (countEl) {
            countEl.textContent = totalCount
                ? (totalCount + ' fatura • Sayfa ' + page + ' / ' + totalPages)
                : '0 fatura';
        }

        if (!invoices.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#64748b;">Kayıt bulunamadı.</td></tr>';
            this._puRenderPagination(totalPages);
            return;
        }

        var self = this;
        tbody.innerHTML = invoices.map(function (inv) {
            // Tarih: invoice_date ONCELIKLI; yoksa created_at fallback
            var rawDate = inv.invoice_date || inv.created_at;
            var d = rawDate ? new Date(rawDate) : null;
            var dateStr = d ? d.toLocaleDateString('tr-TR') : '-';

            var invNoText = (inv.invoice_no != null)
                ? self.formatInvoiceNo(inv.invoice_no)
                : '—';

            var itemCount = (inv.item_count != null) ? Number(inv.item_count) : (inv.count || 0);
            var totalAmount = (inv.total_amount != null) ? Number(inv.total_amount)
                            : (inv.net_total != null ? Number(inv.net_total)
                            : (inv.total != null ? Number(inv.total) : 0));

            // Tum aksiyonlar invoice_no uzerinden — RPC inv.invoice_id donmuyor.
            // Düzenle: invoice_no -> items fetch -> note JSON parse -> invoice_id resolve
            var invNoSafe = self.escapeHtml(String(inv.invoice_no != null ? inv.invoice_no : ''));

            return '<tr>' +
                '<td style="white-space:nowrap; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; font-weight:700; color:#0f172a; letter-spacing:0.02em;">' +
                    '<span style="color:#94a3b8; font-weight:600; margin-right:4px;">No:</span>' +
                    self.escapeHtml(invNoText) +
                '</td>' +
                '<td style="white-space:nowrap;">' + self.escapeHtml(dateStr) + '</td>' +
                '<td style="text-align:right; font-weight:700;">' + itemCount + '</td>' +
                '<td style="text-align:right; font-weight:700; color:#059669;">' + self.formatMoney(totalAmount) + '</td>' +
                '<td style="text-align:right; white-space:nowrap;">' +
                    '<div style="display:inline-flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">' +
                        '<button type="button" style="padding:5px 11px;font-size:12px;border:1px solid #e5e7eb;background:#fff;color:#0f172a;border-radius:8px;font-weight:600;cursor:pointer;" onclick="window.ProductsView.puShowInvoiceDetail(\'' + invNoSafe + '\')">Detay</button>' +
                        '<button type="button" style="padding:5px 11px;font-size:12px;border:1px solid #e5e7eb;background:#fff;color:#0f172a;border-radius:8px;font-weight:600;cursor:pointer;" onclick="window.ProductsView.puEditInvoiceByNo(\'' + invNoSafe + '\')">Düzenle</button>' +
                        '<button type="button" style="padding:5px 11px;font-size:12px;border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:8px;font-weight:600;cursor:pointer;" onclick="window.ProductsView.puConfirmDeleteInvoice(\'' + invNoSafe + '\')">Sil</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');

        this._puRenderPagination(totalPages);
    },

    /* ============================================================
       INVOICE EDIT — son alıştan düzenle butonu
       RPC `get_purchase_invoices_paginated` invoice_id donmuyor;
       invoice_no ile fetch + group → invoice_id resolve → puEditItem.
       ============================================================ */
    puEditInvoiceByNo: async function (invoiceNo) {
        console.log('[EDIT_CLICK] invoice_no =', invoiceNo, '| typeof:', typeof invoiceNo);

        if (!invoiceNo) {
            console.log('[ERROR] invoice_no boş — fonksiyon erken çıkış');
            return;
        }

        var client = window.SupabaseService && typeof window.SupabaseService.getClient === 'function'
            ? window.SupabaseService.getClient() : null;
        if (!client) {
            console.log('[ERROR] Supabase client yok');
            this.puSetStatus('Client yüklenemedi.', 'error');
            return;
        }

        try {
            var queryNum = Number(invoiceNo);
            console.log('[FETCH_QUERY] invoice_no =', queryNum, '(Number cast)');

            var resp = await client
                .from('purchase_items')
                .select('id,quantity,unit,unit_cost,line_total,vat_rate,discount_rate,invoice_no,invoice_date,note,created_at,general_discount_amount,general_discount_type,raw_material_id,raw_material:raw_materials(id,name,unit,base_unit)')
                .eq('invoice_no', queryNum)
                .eq('is_deleted', false)
                .order('created_at', { ascending: true });

            console.log('[FETCH_RESPONSE] error:', resp.error || 'none', '| data type:', Array.isArray(resp.data) ? 'array' : typeof resp.data);

            if (resp.error) {
                console.log('[ERROR] fetch hatası:', resp.error);
                this.puSetStatus(this.getErrorMessage(resp.error, 'Düzenleme için veri alınamadı.'), 'error');
                return;
            }

            var rows = Array.isArray(resp.data) ? resp.data : [];
            console.log('[FETCH_ITEMS] count =', rows.length);
            if (rows.length) {
                console.log('[FETCH_ITEMS_SAMPLE]', {
                    id: rows[0].id,
                    invoice_no: rows[0].invoice_no,
                    raw_material_id: rows[0].raw_material_id,
                    quantity: rows[0].quantity,
                    unit: rows[0].unit,
                    unit_cost: rows[0].unit_cost,
                    line_total: rows[0].line_total,
                    note: rows[0].note,
                    note_type: typeof rows[0].note,
                    raw_material: rows[0].raw_material
                });
            }

            if (!rows.length) {
                console.log('[ERROR] 0 row geldi — RLS/tenant/invoice_no mismatch ihtimali');
                this.puSetStatus('Bu faturaya ait satır bulunamadı.', 'error');
                return;
            }

            // ============================================================
            // SINGLE SYNTHETIC INVOICE — invoice_no zaten benzersiz, tum
            // rows tek faturanin satirlari. _puGroupByInvoice legacy
            // (note.invoice_id yok) durumda her itemi ayri grup yapiyor;
            // edit icin TUM satirlari tek inv.items altinda topla.
            // ============================================================
            var self = this;
            var resolvedInvoiceId = null;
            var supplier  = null;
            var description = null;
            var earliestCreatedAt = null;
            var generalDiscount   = null;

            rows.forEach(function (it) {
                var meta = self._puParseNote(it.note) || {};
                if (!resolvedInvoiceId && meta.invoice_id) resolvedInvoiceId = meta.invoice_id;
                if (!supplier && meta.supplier) supplier = meta.supplier;
                if (!description && meta.description) description = meta.description;
                if (it.created_at) {
                    if (!earliestCreatedAt || new Date(it.created_at) < new Date(earliestCreatedAt)) {
                        earliestCreatedAt = it.created_at;
                    }
                }
                if (!generalDiscount) {
                    var colAmt = Number(it.general_discount_amount);
                    if (Number.isFinite(colAmt) && colAmt > 0) {
                        generalDiscount = {
                            type: it.general_discount_type === 'percent' ? 'percent' : 'amount',
                            value: colAmt
                        };
                    } else if (meta.general_discount && Number(meta.general_discount.value) > 0) {
                        generalDiscount = {
                            type: meta.general_discount.type === 'percent' ? 'percent' : 'amount',
                            value: Number(meta.general_discount.value) || 0
                        };
                    }
                }
            });

            var isLegacy = !resolvedInvoiceId;
            var syntheticId = resolvedInvoiceId || ('inv_no:' + String(invoiceNo));

            var inv = {
                invoice_id: syntheticId,
                invoice_no: Number(invoiceNo),
                is_legacy: isLegacy,
                supplier: supplier,
                description: description,
                created_at: earliestCreatedAt,
                items: rows,
                total: rows.reduce(function (s, r) { return s + (Number(r.line_total) || 0); }, 0),
                count: rows.length,
                general_discount: generalDiscount
            };

            console.log('[SYNTH_INVOICE] invoice_id =', JSON.stringify(syntheticId), '| typeof:', typeof syntheticId, '| is_legacy:', isLegacy, '| items =', inv.items.length, '| resolvedFromNote:', !!resolvedInvoiceId);
            console.log('[SYNTH_INVOICE.invoice_id_in_inv]', JSON.stringify(inv.invoice_id), '| typeof:', typeof inv.invoice_id);

            // STATE INSERTION
            var existing = (this.purchaseState.purchases || []);
            console.log('[BEFORE_PUSH] existing.length =', existing.length);
            console.log('[BEFORE_PUSH] existing ids =', existing.map(function (x) { return x && x.invoice_id; }));
            console.log('[BEFORE_PUSH] purchaseState ref check:', this.purchaseState === window.ProductsView.purchaseState);

            var hasIt = existing.some(function (x) { return String(x.invoice_id) === String(syntheticId); });
            this.purchaseState.purchases = hasIt ? existing : existing.concat([inv]);

            console.log('[STATE_PUSH] purchases length =', this.purchaseState.purchases.length, '| hasIt:', hasIt);
            console.log('[STATE_PUSH] all invoice_ids =', this.purchaseState.purchases.map(function (x) { return x && x.invoice_id; }));
            console.log('[STATE_PUSH] last item =', this.purchaseState.purchases[this.purchaseState.purchases.length - 1]);

            // Sanity: _puFindInvoice ile sentetik invoice'ı bulabiliyor muyuz?
            var foundCheck = this._puFindInvoice(syntheticId);
            console.log('[FIND_INVOICE] looking for:', JSON.stringify(syntheticId));
            console.log('[FIND_INVOICE] found =', !!foundCheck, '| matched_id:', foundCheck && foundCheck.invoice_id, '| matched_items:', foundCheck && foundCheck.items && foundCheck.items.length);

            // FALLBACK: _puFindInvoice basarisiz ise direkt inv referansini stash et
            // ve puEditItem'i bypass'la calistir.
            if (!foundCheck) {
                console.log('[FALLBACK] _puFindInvoice basarisiz; direkt inv referansi ile devam edilecek');
                this.purchaseState._editStash = inv;
            } else {
                this.purchaseState._editStash = null;
            }

            // Form kapaliysa ac
            var card = document.getElementById('puInvoiceCard');
            if (card && (card.style.display === 'none' || !card.style.display)) {
                console.log('[FORM_TOGGLE] Form kapali idi, aciliyor');
                this.puToggleForm();
            } else {
                console.log('[FORM_STATE] Form zaten acik');
            }

            // EditItem öncesi state ölç
            console.log('[BEFORE_EDIT_ITEM] purchaseState.lines (önceki) =', (this.purchaseState.lines || []).length);

            this.puEditItem(syntheticId);

            // EditItem sonrası state + DOM kontrol
            console.log('[AFTER_EDIT_ITEM] purchaseState.lines =', (this.purchaseState.lines || []).length);
            setTimeout(function () {
                var rowsDom = document.querySelectorAll('.pu-line-row').length;
                console.log('[DOM_AFTER_RENDER] rows =', rowsDom);
            }, 50);

            if (card) {
                try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* noop */ }
            }
        } catch (err) {
            console.log('[ERROR] catch:', err && err.message ? err.message : err);
            this.puSetStatus(this.getErrorMessage(err, 'Düzenleme açılamadı.'), 'error');
        }
    },

    // Geriye doniik uyum — eski cagrilar varsa
    puEditInvoiceById: function (invoiceId) {
        if (!invoiceId) return;
        var card = document.getElementById('puInvoiceCard');
        if (card && (card.style.display === 'none' || !card.style.display)) {
            this.puToggleForm();
        }
        try { this.puEditItem(invoiceId); } catch (e) { /* noop */ }
        if (card) {
            try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* noop */ }
        }
    },

    /* ============================================================
       INVOICE DELETE — soft delete tum purchase_items satirlari
       Trigger 021 + 035 zinciri raw_materials.cost ve products.cost
       guncellemelerini otomatik yapar.
       ============================================================ */
    puConfirmDeleteInvoice: async function (invoiceNo) {
        if (!invoiceNo) return;

        var ok = window.confirm(
            'Bu alış faturası SİLİNECEK.\n\n' +
            'Faturadaki tüm satırlar pasif (soft-delete) olur. ' +
            'İlgili hammaddelerin maliyeti ve bu hammaddeleri kullanan ürünlerin ' +
            'cost değerleri otomatik yeniden hesaplanır.\n\n' +
            'Devam etmek istiyor musunuz?'
        );
        if (!ok) return;

        try {
            // invoice_no -> tum purchase_items satirlarini soft-delete
            var client = (window.SupabaseService && window.SupabaseService.getClient)
                ? window.SupabaseService.getClient() : null;
            if (!client) {
                this.puSetStatus('Supabase bağlı değil.', 'error');
                return;
            }

            var res = await client
                .from('purchase_items')
                .update({ is_deleted: true })
                .eq('invoice_no', invoiceNo)
                .eq('is_deleted', false)
                .select('id');

            if (res.error) {
                this.puSetStatus(this.getErrorMessage(res.error, 'Silme başarısız.'), 'error');
                return;
            }

            // Cache invalidate (products + raw-materials + dashboard)
            if (window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
                try {
                    window.ViewCache.invalidate('products:');
                    window.ViewCache.invalidate('raw-materials:');
                    window.ViewCache.invalidate('dashboard:');
                } catch (e) { /* noop */ }
            }

            // Notify
            try {
                window.dispatchEvent(new Event('products:updated'));
                window.dispatchEvent(new Event('raw-materials:updated'));
            } catch (e) { /* noop */ }

            if (window.Toast && Toast.success) Toast.success('Fatura silindi. Maliyetler güncellendi.');

            // Reload recent + raw materials cost cache
            try { await this.puLoadRecent(); } catch (e) { /* noop */ }
            try { if (typeof this.loadProducts === 'function') await this.loadProducts(); } catch (e) { /* noop */ }
        } catch (err) {
            this.puSetStatus(this.getErrorMessage(err, 'Silme başarısız.'), 'error');
        }
    },

    /* ============================================================
       INVOICE DETAIL — Detay butonu
       Tek invoice_no icin purchase_items satirlarini cek + modal goster
       ============================================================ */
    puShowInvoiceDetail: async function (invoiceNo) {
        if (!invoiceNo) return;

        var client = window.SupabaseService && typeof window.SupabaseService.getClient === 'function'
            ? window.SupabaseService.getClient() : null;
        if (!client) {
            this.puSetStatus('Client yüklenemedi.', 'error');
            return;
        }

        var resp = await client
            .from('purchase_items')
            .select('id,quantity,unit,unit_cost,line_total,vat_rate,discount_rate,invoice_no,invoice_date,note,raw_material:raw_materials(id,name,unit)')
            .eq('invoice_no', Number(invoiceNo))
            .eq('is_deleted', false)
            .order('created_at', { ascending: true });

        if (resp.error) {
            this.puSetStatus(this.getErrorMessage(resp.error, 'Detay yüklenemedi.'), 'error');
            return;
        }

        var rows = Array.isArray(resp.data) ? resp.data : [];

        // Mevcut modal varsa kullan, yoksa basit overlay yarat
        var modal = document.getElementById('puViewModal');
        var body  = document.getElementById('puViewBody');

        if (modal && body) {
            // Mevcut puViewModal'i invoice_no detayi ile doldur
            var self = this;
            var headerInfo = (rows[0] && rows[0].invoice_date)
                ? new Date(rows[0].invoice_date).toLocaleDateString('tr-TR')
                : '-';

            // Genel Toplam — tum satirlarin line_total toplami
            var grandTotal = rows.reduce(function (sum, r) {
                return sum + (Number(r.line_total) || 0);
            }, 0);

            body.innerHTML =
                '<div style="margin-bottom:14px; padding:12px 14px; background:#f8fafc; border-radius:10px; font-size:13px; color:#475569;">' +
                    '<div style="font-weight:700; color:#0f172a; font-family:ui-monospace,Consolas,monospace;">No: ' + this.escapeHtml(this.formatInvoiceNo(invoiceNo)) + '</div>' +
                    '<div style="margin-top:4px;">Tarih: ' + this.escapeHtml(headerInfo) + ' • ' + rows.length + ' kalem</div>' +
                '</div>' +
                '<table class="data-table" style="margin:0;"><thead><tr>' +
                    '<th>Ham Madde</th>' +
                    '<th style="text-align:right;">Miktar</th>' +
                    '<th style="text-align:right;">Birim Fiyat</th>' +
                    '<th style="text-align:right;">% İsk</th>' +
                    '<th style="text-align:right;">KDV</th>' +
                    '<th style="text-align:right;">Toplam</th>' +
                '</tr></thead><tbody>' +
                rows.map(function (r) {
                    var rm = r.raw_material || {};
                    var name = self.escapeHtml(rm.name || '(Silinmiş)');
                    var unit = self.escapeHtml(r.unit || rm.unit || '');
                    return '<tr>' +
                        '<td style="font-weight:600;">' + name + '</td>' +
                        '<td style="text-align:right;">' + Number(r.quantity || 0) + (unit ? ' ' + unit : '') + '</td>' +
                        '<td style="text-align:right;">' + self.formatMoney(r.unit_cost) + '</td>' +
                        '<td style="text-align:right; color:#b45309;">' + (Number(r.discount_rate) || 0) + '%</td>' +
                        '<td style="text-align:right; color:#6366f1;">%' + (Number(r.vat_rate) || 0) + '</td>' +
                        '<td style="text-align:right; font-weight:700; color:#059669;">' + self.formatMoney(r.line_total) + '</td>' +
                    '</tr>';
                }).join('') +
                '</tbody>' +
                '<tfoot>' +
                    '<tr style="background:#f8fafc; border-top:2px solid #0f172a;">' +
                        '<td colspan="5" style="text-align:right; font-weight:800; color:#0f172a; padding:14px 12px; font-size:14px; letter-spacing:0.02em;">GENEL TOPLAM</td>' +
                        '<td style="text-align:right; font-weight:800; color:#059669; padding:14px 12px; font-size:16px;">' + self.formatMoney(grandTotal) + '</td>' +
                    '</tr>' +
                '</tfoot>' +
                '</table>';

            modal.style.display = 'flex';
            return;
        }

        // Modal element yoksa basit fallback
        var msg = rows.length
            ? rows.length + ' kalem bulundu (puViewModal element\'i yok — UI render edilemedi)'
            : 'Bu fatura için kalem bulunamadı';
        this.puSetStatus(msg, rows.length ? 'success' : 'error');
    },

    _puFindInvoice: function (invoiceId) {
        var invoices = this._puGroupByInvoice(this.purchaseState.purchasesAll || []);
        return invoices.find(function (inv) { return String(inv.invoice_id) === String(invoiceId); });
    },

    _puRenderPagination: function (totalPages) {
        var wrap = document.getElementById('puPagination');
        if (!wrap) return;
        if (totalPages <= 1) { wrap.innerHTML = ''; return; }

        var current = this.purchaseState.recentFilter.page || 1;
        var html = '';

        var btn = function (n, label, active, disabled) {
            var bg = active ? '#0f172a' : '#fff';
            var color = active ? '#fff' : (disabled ? '#cbd5e1' : '#0f172a');
            var cursor = disabled ? 'default' : 'pointer';
            return '<button type="button" ' + (disabled ? 'disabled ' : '') +
                'onclick="window.ProductsView.puSetRecentPage(' + n + ')" ' +
                'style="min-width:36px; padding:7px 12px; border:1px solid #e2e8f0; background:' + bg + '; color:' + color + '; border-radius:8px; font-size:13px; font-weight:600; cursor:' + cursor + ';">' +
                label + '</button>';
        };

        html += btn(Math.max(1, current - 1), '‹', false, current === 1);

        // Window of pages
        var from = Math.max(1, current - 2);
        var to   = Math.min(totalPages, from + 4);
        from = Math.max(1, to - 4);
        if (from > 1) {
            html += btn(1, '1', current === 1, false);
            if (from > 2) html += '<span style="padding:7px 4px; color:#94a3b8;">…</span>';
        }
        for (var p = from; p <= to; p++) {
            html += btn(p, String(p), current === p, false);
        }
        if (to < totalPages) {
            if (to < totalPages - 1) html += '<span style="padding:7px 4px; color:#94a3b8;">…</span>';
            html += btn(totalPages, String(totalPages), current === totalPages, false);
        }

        html += btn(Math.min(totalPages, current + 1), '›', false, current === totalPages);

        wrap.innerHTML = html;
    },

    puViewItem: function (invoiceId) {
        var inv = this._puFindInvoice(invoiceId);
        if (!inv) return;

        var body = document.getElementById('puViewBody');
        var modal = document.getElementById('puViewModal');
        if (!body || !modal) return;

        var d = inv.created_at ? new Date(inv.created_at) : null;
        var dateStr = d ? d.toLocaleString('tr-TR') : '-';
        var supplier = inv.supplier || '-';
        var desc = inv.description || '-';

        var self = this;
        // İki geçişli hesap (puRecalcAll mantığının aynası):
        //  1) per-row netPre, netPost(=q*u*(1-d/100)), satır iskonto, sumNetPost
        //  2) genel iskontoyu tüm satırlara orantılı dağıt → finalNet, vat = finalNet * v/100
        var rowsCalc = [];
        var netSum = 0;          // Σ rowNetPre (iskonto öncesi)
        var discountSum = 0;     // Σ satır iskonto
        var sumNetPost = 0;      // Σ rowNetPost (satır iskonto sonrası, KDV öncesi)

        (inv.items || []).forEach(function (it) {
            var rmName = (it.raw_material && it.raw_material.name) ? it.raw_material.name : '(silinmiş)';
            var q = Number(it.quantity) || 0;
            var u = Number(it.unit_cost) || 0;
            var v = Number(it.vat_rate) || 0;
            var d = Number(it.discount_rate) || 0;
            if (d < 0) d = 0; if (d > 100) d = 100;

            var rowNetPre  = q * u;
            var rowNetPost = rowNetPre * (1 - d / 100);
            var rowDisc    = rowNetPre - rowNetPost;

            netSum      += rowNetPre;
            discountSum += rowDisc;
            sumNetPost  += rowNetPost;

            rowsCalc.push({ it: it, rmName: rmName, q: q, u: u, v: v, rowNetPost: rowNetPost });
        });

        // Genel iskonto — kolon (inv.general_discount) önceliğiyle, sumNetPost üzerinden hesaplanır
        var gd = inv.general_discount || null;
        var gdAmtCalc = 0;
        if (gd && Number(gd.value) > 0 && sumNetPost > 0) {
            if (gd.type === 'percent') {
                var gp = Math.max(0, Math.min(100, Number(gd.value) || 0));
                gdAmtCalc = sumNetPost * (gp / 100);
            } else {
                gdAmtCalc = Number(gd.value) || 0;
            }
            if (gdAmtCalc > sumNetPost) gdAmtCalc = sumNetPost;
            if (gdAmtCalc < 0) gdAmtCalc = 0;
        }

        // Orantılı dağıtım faktörü
        var finalNet = sumNetPost - gdAmtCalc;
        var factor = sumNetPost > 0 ? (finalNet / sumNetPost) : 0;

        // Satır KDV'leri — finalNet üzerinden, daima >= 0
        var vatSum = 0;
        var grossSum = 0;
        var itemsHtml = rowsCalc.map(function (rc) {
            var lineFinalNet = rc.rowNetPost * factor;
            var lineVat = lineFinalNet * (rc.v / 100);
            if (lineVat < 0) lineVat = 0;
            var lineGross = lineFinalNet + lineVat;
            vatSum   += lineVat;
            grossSum += lineGross;

            return '<tr>' +
                '<td style="padding:8px 10px; border-bottom:1px solid #f1f5f9;">' + self.escapeHtml('HM - ' + rc.rmName) + '</td>' +
                '<td style="padding:8px 10px; text-align:right; border-bottom:1px solid #f1f5f9; white-space:nowrap;">' + self.formatNumber(rc.q) + ' ' + self.escapeHtml(rc.it.unit || '') + '</td>' +
                '<td style="padding:8px 10px; text-align:right; border-bottom:1px solid #f1f5f9;">' + self.formatMoney(rc.u) + '</td>' +
                '<td style="padding:8px 10px; text-align:right; border-bottom:1px solid #f1f5f9;">%' + self.formatNumber(rc.v) + '</td>' +
                '<td style="padding:8px 10px; text-align:right; border-bottom:1px solid #f1f5f9; font-weight:700; color:#059669;">' + self.formatMoney(lineGross) + '</td>' +
            '</tr>';
        }).join('');

        if (vatSum < 0) vatSum = 0;
        var vatTotal = vatSum;
        var grandFinal = grossSum;  // = finalNet + vatSum

        var row = function (label, val) {
            return '<div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f1f5f9;">' +
                '<span style="color:#64748b; font-size:13px;">' + label + '</span>' +
                '<span style="font-weight:600; color:#0f172a; font-size:14px;">' + val + '</span>' +
                '</div>';
        };

        body.innerHTML =
            '<div style="margin-bottom:14px;">' +
                row('Tarih', this.escapeHtml(dateStr)) +
                row('Firma', this.escapeHtml(supplier)) +
                row('Açıklama', this.escapeHtml(desc)) +
                row('Kalem Sayısı', String(inv.count)) +
            '</div>' +
            '<div style="margin-top:16px;">' +
                '<div style="font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.05em; margin-bottom:8px;">SATIRLAR</div>' +
                '<div style="border:1px solid #e2e8f0; border-radius:10px; overflow:hidden;">' +
                '<table style="width:100%; border-collapse:collapse; font-size:13px;">' +
                    '<thead><tr style="background:#f8fafc;">' +
                        '<th style="padding:8px 10px; text-align:left; font-size:11px; color:#64748b; letter-spacing:0.04em;">HAM MADDE</th>' +
                        '<th style="padding:8px 10px; text-align:right; font-size:11px; color:#64748b; letter-spacing:0.04em;">MİKTAR</th>' +
                        '<th style="padding:8px 10px; text-align:right; font-size:11px; color:#64748b; letter-spacing:0.04em;">BİRİM (NET)</th>' +
                        '<th style="padding:8px 10px; text-align:right; font-size:11px; color:#64748b; letter-spacing:0.04em;">KDV</th>' +
                        '<th style="padding:8px 10px; text-align:right; font-size:11px; color:#64748b; letter-spacing:0.04em;">TOPLAM</th>' +
                    '</tr></thead>' +
                    '<tbody>' + itemsHtml + '</tbody>' +
                '</table>' +
                '</div>' +
            '</div>' +
            '<div style="margin-top:16px; padding:14px 16px; background:linear-gradient(135deg,#f8fafc,#f1f5f9); border-radius:12px; border:1px solid #e2e8f0;">' +
                '<div style="font-size:11px; font-weight:700; color:#64748b; letter-spacing:0.05em; margin-bottom:8px;">TOPLAMLAR</div>' +
                row('Ara Toplam (net)', this.formatMoney(netSum)) +
                (discountSum > 0
                    ? '<div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f1f5f9;">' +
                          '<span style="color:#64748b; font-size:13px;">Satır İskontoları</span>' +
                          '<span style="font-weight:700; color:#dc2626; font-size:14px;">-' + this.formatMoney(discountSum) + '</span>' +
                      '</div>'
                    : '') +
                (gd && gdAmtCalc > 0
                    ? '<div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid #f1f5f9;">' +
                          '<span style="color:#64748b; font-size:13px;">Genel İskonto' +
                              (gd.type === 'percent' ? ' (%' + this.formatNumber(Number(gd.value) || 0) + ')' : '') +
                          '</span>' +
                          '<span style="font-weight:700; color:#dc2626; font-size:14px;">-' + this.formatMoney(gdAmtCalc) + '</span>' +
                      '</div>'
                    : '') +
                row('KDV Tutarı', '+' + this.formatMoney(vatTotal)) +
                '<div style="display:flex; justify-content:space-between; padding:10px 0 0 0; margin-top:4px; border-top:2px solid #0f172a;">' +
                    '<span style="font-size:15px; font-weight:800; color:#0f172a;">Genel Toplam</span>' +
                    '<span style="font-size:17px; font-weight:800; color:#059669;">' + this.formatMoney(grandFinal) + '</span>' +
                '</div>' +
            '</div>';

        modal.style.display = 'flex';
    },

    puCloseView: function () {
        var modal = document.getElementById('puViewModal');
        if (modal) modal.style.display = 'none';
    },

    puEditItem: function (invoiceId) {
        console.log('[EDIT_ITEM] called with id =', invoiceId);
        var inv = this._puFindInvoice(invoiceId);
        console.log('[EDIT_ITEM] _puFindInvoice =>', inv ? { invoice_id: inv.invoice_id, items_len: (inv.items || []).length, is_legacy: inv.is_legacy } : 'NULL');

        // FALLBACK: state lookup basarisiz ise stash'tan al
        if ((!inv || !inv.items || !inv.items.length) && this.purchaseState._editStash) {
            console.log('[EDIT_ITEM] Stash fallback aktif — direkt inv kullanılıyor');
            inv = this.purchaseState._editStash;
            console.log('[EDIT_ITEM] stash inv:', { invoice_id: inv.invoice_id, items_len: (inv.items || []).length, is_legacy: inv.is_legacy });
        }

        if (!inv || !inv.items || !inv.items.length) {
            console.log('[ERROR][EDIT_ITEM] Erken çıkış — inv yok ya da items boş');
            return;
        }

        // State reset
        this.purchaseState.editingInvoiceId = inv.is_legacy ? null : inv.invoice_id;
        this.purchaseState.editingOriginalIds = inv.items.map(function (it) { return it.id; });
        this.purchaseState.lines = [];
        this._puLineKey = (this._puLineKey || 1);

        // KDV hariç moda zorla (unit_cost = net)
        this.purchaseState.vatIncluded = false;

        // Supplier & description restore
        this.purchaseState.supplierName = inv.supplier || '';
        this.purchaseState.description = inv.description || '';
        var sEl = document.getElementById('puSupplier');
        var dEl = document.getElementById('puDescription');
        if (sEl) sEl.value = this.purchaseState.supplierName;
        if (dEl) dEl.value = this.purchaseState.description;

        // Tarih restore — created_at'tan YYYY-MM-DD
        var dateEl = document.getElementById('puDate');
        if (dateEl) {
            if (inv.created_at) {
                dateEl.value = String(inv.created_at).slice(0, 10);
            } else {
                dateEl.value = new Date().toISOString().slice(0, 10);
            }
        }

        // Genel iskonto restore — öncelik: kolonlar (group), fallback: note (legacy)
        var firstItem = (inv.items && inv.items.length) ? inv.items[0] : null;
        var gdRestored = null;
        if (inv.general_discount && Number(inv.general_discount.value) > 0) {
            gdRestored = {
                type: inv.general_discount.type === 'percent' ? 'percent' : 'amount',
                value: Number(inv.general_discount.value) || 0
            };
        } else if (firstItem) {
            var colAmt = Number(firstItem.general_discount_amount);
            if (Number.isFinite(colAmt) && colAmt > 0) {
                gdRestored = {
                    type: firstItem.general_discount_type === 'percent' ? 'percent' : 'amount',
                    value: colAmt
                };
            } else {
                var meta = this._puParseNote(firstItem.note);
                if (meta && meta.general_discount && Number(meta.general_discount.value) > 0) {
                    gdRestored = {
                        type: meta.general_discount.type === 'percent' ? 'percent' : 'amount',
                        value: Number(meta.general_discount.value) || 0
                    };
                }
            }
        }
        this.purchaseState.generalDiscount = gdRestored || { type: 'amount', value: 0 };
        var gdtEl = document.getElementById('puGenDiscType');
        var gdvEl = document.getElementById('puGenDiscValue');
        if (gdtEl) gdtEl.value = this.purchaseState.generalDiscount.type;
        if (gdvEl) gdvEl.value = this.purchaseState.generalDiscount.value > 0
            ? String(this.purchaseState.generalDiscount.value) : '';

        // Tüm itemları satır olarak yükle
        var self = this;
        inv.items.forEach(function (it) {
            var k = self._puLineKey++;
            var q = Number(it.quantity) || 0;
            var u = Number(it.unit_cost) || 0;
            var v = Number(it.vat_rate) || 0;
            var d = Number(it.discount_rate) || 0;
            var rm = it.raw_material || {};

            // unit_cost DB'de NET (KDV haric, iskonto sonrasi netUnit degil; eski mantikla netUnit'tir)
            // Yeni mantik: u DB'de q*u*(1-d/100)*(1+v/100) = line_total iliskisini tutar
            // Edit modunda mode=excluded, lastEdited=unit, total = q*u*(1-d/100)*(1+v/100)
            var dMul = 1 - (d / 100);
            var vMul = 1 + (v / 100);
            var displayTotal = +(q * u * dMul * vMul).toFixed(2);

            self.purchaseState.lines.push({
                _k: k,
                _originalId: it.id,
                rmId: rm.id || null,
                rmName: rm.name || '',
                rmUnit: it.unit || rm.unit || '',
                qty: q,
                unitCost: u,
                discount: d,
                total: displayTotal,
                vat: v,
                _vatTouched: true,  // edit modunda VAT zaten kayitli, override etme
                lastEdited: 'unit',
                search: '',
                dropdownOpen: false
            });
        });

        console.log('[LINES_AFTER_MAP] purchaseState.lines length =', this.purchaseState.lines.length);
        if (this.purchaseState.lines.length) {
            console.log('[LINES_SAMPLE]', {
                _k: this.purchaseState.lines[0]._k,
                _originalId: this.purchaseState.lines[0]._originalId,
                rmId: this.purchaseState.lines[0].rmId,
                rmName: this.purchaseState.lines[0].rmName,
                rmUnit: this.purchaseState.lines[0].rmUnit,
                qty: this.purchaseState.lines[0].qty,
                unitCost: this.purchaseState.lines[0].unitCost,
                total: this.purchaseState.lines[0].total
            });
        }

        var btn = document.getElementById('puSaveAllBtn');
        if (btn) btn.textContent = 'Faturayı Güncelle';

        this.puSetVatMode(false);
        this.puRenderLines();
        console.log('[POST_RENDER_LINES] purchaseState.lines =', this.purchaseState.lines.length, '| DOM .pu-line-row =', document.querySelectorAll('.pu-line-row').length);

        try {
            var form = document.getElementById('puLinesWrap');
            if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {}

        var msg = inv.is_legacy
            ? 'Eski kayıt düzenleme — kaydedildiğinde yeni faturaya dönüşür.'
            : 'Fatura düzenleme modu. Kaydederek güncelleyebilirsiniz.';
        this.puSetStatus(msg, 'success');
    },

    /* ============================================================
       MULTI-LINE INVOICE (ALIŞ)
       ============================================================ */
    puAddLine: function () {
        var k = this._puLineKey++;
        this.purchaseState.lines.push({
            _k: k,
            rmId: null,
            rmName: '',
            rmUnit: '',
            qty: '',
            unitCost: '',
            discount: 0,        // satir bazli iskonto orani (%) — 0-100
            total: '',          // editable display total (KDV dahil modda gross-after-disc, KDV hariç modda net-after-disc)
            vat: 20,
            _vatTouched: false, // kullanıcı manuel değiştirdiyse true
            lastEdited: 'unit', // 'unit' | 'total' — hangi alan son değiştirildi
            search: '',
            dropdownOpen: false
        });
        this.puRenderLines();
    },

    puSetVatMode: function (included) {
        this.purchaseState.vatIncluded = !!included;

        var inc = document.getElementById('puVatModeIncl');
        var exc = document.getElementById('puVatModeExcl');
        var hdr = document.getElementById('puHdrUnit');

        if (inc && exc) {
            inc.style.background = included ? '#fff' : 'transparent';
            inc.style.color = included ? '#0f172a' : '#cbd5e1';
            exc.style.background = included ? 'transparent' : '#fff';
            exc.style.color = included ? '#cbd5e1' : '#0f172a';
        }
        if (hdr) hdr.textContent = included ? 'BİRİM FİYAT (KDV DAHİL)' : 'BİRİM FİYAT (KDV HARİÇ)';

        // Her satırda lastEdited'a göre yeniden hesapla
        this.recalcPurchase();
    },

    puRemoveLine: function (k) {
        this.purchaseState.lines = this.purchaseState.lines.filter(function (l) { return l._k !== k; });
        if (!this.purchaseState.lines.length) {
            this.puAddLine();
        } else {
            this.puRenderLines();
        }
    },

    puRenderLines: function () {
        var wrap = document.getElementById('puLinesWrap');
        if (!wrap) return;

        var self = this;
        wrap.innerHTML = this.purchaseState.lines.map(function (l) {
            var k = l._k;
            var unit = l.rmUnit ? self.escapeHtml(l.rmUnit) : '';

            var discVal = (l.discount === '' || l.discount == null) ? '' : Number(l.discount);
            return '' +
                '<div class="pu-line-row" data-k="' + k + '" style="position:relative; display:grid; grid-template-columns: 1.9fr 0.85fr 0.95fr 0.65fr 0.7fr 1.05fr 36px; gap:8px; padding:10px 12px; align-items:center; border-bottom:1px solid #f1f5f9;">' +
                    '<div style="position:relative;">' +
                        '<input type="text" class="form-input" placeholder="HM - ...  (ara)" autocomplete="off" ' +
                            'oninput="window.ProductsView.puLineSearch(' + k + ', this.value)" ' +
                            'onfocus="window.ProductsView.puLineOpenDropdown(' + k + ')" ' +
                            'id="puLineSearch_' + k + '" ' +
                            'style="font-size:14px;">' +
                        '<div class="pu-line-dropdown" id="puLineDropdown_' + k + '" style="display:none; position:absolute; top:100%; left:0; right:0; background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 10px 30px rgba(15,23,42,0.14); max-height:240px; overflow-y:auto; z-index:30; margin-top:4px;"></div>' +
                    '</div>' +
                    '<div style="display:flex; gap:4px; align-items:center;">' +
                        '<input type="number" class="form-input" placeholder="0" step="0.0001" min="0" value="' + (l.qty || '') + '" oninput="window.ProductsView.handlePurchaseInput(' + k + ', \'qty\', this.value)" onblur="window.ProductsView.handlePurchaseBlur(' + k + ', \'qty\')" style="text-align:right; font-size:14px;">' +
                        (unit ? '<span style="font-size:12px; color:#64748b; font-weight:600; min-width:30px;">' + unit + '</span>' : '') +
                    '</div>' +
                    '<input type="number" class="form-input" id="puLineUnit_' + k + '" placeholder="0.00" step="0.0001" min="0" value="' + (l.unitCost || '') + '" oninput="window.ProductsView.handlePurchaseInput(' + k + ', \'unit\', this.value)" onblur="window.ProductsView.handlePurchaseBlur(' + k + ', \'unit\')" style="text-align:right; font-size:14px;">' +
                    '<input type="number" class="form-input" id="puLineDisc_' + k + '" placeholder="0" step="0.01" min="0" max="100" value="' + (discVal === 0 ? '' : discVal) + '" oninput="window.ProductsView.handlePurchaseInput(' + k + ', \'discount\', this.value)" onblur="window.ProductsView.handlePurchaseBlur(' + k + ', \'discount\')" title="Satır iskontosu (%)" style="text-align:right; font-size:14px; color:#b45309; background:#fffbeb;">' +
                    '<select class="form-select" onchange="window.ProductsView.handlePurchaseInput(' + k + ', \'vat\', this.value)" style="font-size:14px;">' +
                        '<option value="0"' + (Number(l.vat) === 0 ? ' selected' : '') + '>%0</option>' +
                        '<option value="1"' + (Number(l.vat) === 1 ? ' selected' : '') + '>%1</option>' +
                        '<option value="10"' + (Number(l.vat) === 10 ? ' selected' : '') + '>%10</option>' +
                        '<option value="20"' + (Number(l.vat) === 20 ? ' selected' : '') + '>%20</option>' +
                    '</select>' +
                    '<input type="number" class="form-input" id="puLineTotal_' + k + '" placeholder="0.00" step="0.01" min="0" value="' + (l.total || '') + '" oninput="window.ProductsView.handlePurchaseInput(' + k + ', \'total\', this.value)" onblur="window.ProductsView.handlePurchaseBlur(' + k + ', \'total\')" style="text-align:right; font-size:14px; font-weight:700; color:#059669; background:#f0fdf4;">' +
                    '<button type="button" onclick="window.ProductsView.puRemoveLine(' + k + ')" title="Satırı sil" style="border:none; background:transparent; color:#dc2626; cursor:pointer; font-size:18px; padding:4px 8px; border-radius:6px;" onmouseover="this.style.background=\'#fef2f2\'" onmouseout="this.style.background=\'transparent\'">×</button>' +
                '</div>';
        }).join('');

        // Set search input values via DOM (avoid HTML injection)
        this.purchaseState.lines.forEach(function (l) {
            var el = document.getElementById('puLineSearch_' + l._k);
            if (el) {
                var dn = l.rmId ? ('HM - ' + (l.rmName || '')) : (l.search || '');
                el.value = dn;
            }
        });

        this.puRecalcAll();
    },

    puLineEdit: function (k, field, value) {
        // Field alias: UI "unit" gönderiyor, state "unitCost" kullaniyor
        var stateField = (field === 'unit') ? 'unitCost' : field;

        var line = this.purchaseState.lines.find(function (l) { return l._k === k; });
        if (!line) return;
        line[stateField] = value;

        var q = parseFloat(line.qty) || 0;
        var u = parseFloat(line.unitCost) || 0;
        var t = parseFloat(line.total) || 0;

        // ---------- BIDIRECTIONAL HESAP ----------
        if (stateField === 'qty' || stateField === 'unitCost') {
            line.lastEdited = 'unit';
            if (q > 0 && u > 0) {
                line.total = +(q * u).toFixed(2);
            } else {
                line.total = '';
            }
        } else if (stateField === 'total') {
            line.lastEdited = 'total';
            if (q > 0 && t > 0) {
                line.unitCost = +(t / q).toFixed(4);
            } else {
                line.unitCost = '';
            }
        } else if (stateField === 'vat') {
            if (line.lastEdited === 'total' && q > 0 && t > 0) {
                line.unitCost = +(t / q).toFixed(4);
            } else if (q > 0 && u > 0) {
                line.total = +(q * u).toFixed(2);
            }
        }

        // ---------- DOM UPDATE (focus kaybı olmasın) ----------
        var uEl = document.getElementById('puLineUnit_' + k);
        var tEl = document.getElementById('puLineTotal_' + k);
        if (uEl && document.activeElement !== uEl) uEl.value = (line.unitCost === '' || line.unitCost == null) ? '' : line.unitCost;
        if (tEl && document.activeElement !== tEl) tEl.value = (line.total === '' || line.total == null) ? '' : line.total;

        if(window.__DEBUG__)console.log('LINE AFTER:', line);
    },

    // Satırların lastEdited'a göre yeniden hesaplanması + grand totals
    recalcPurchase: function (lastEdited) {
        if(window.__DEBUG__)console.log('RECALC:', lastEdited);

        // Field normalization:
        //   qty   → unit-side master (q × u = total)
        //   unit  → unit-side master
        //   total → total-side master (t / q = unit)
        // Discount / VAT change'inde line-level override yapma — _puComputeLine
        // zaten precise hesaplamis ve KDV/iskonto orantili dagilim icin
        // puRecalcAll yeniden cagrilacak.
        var normalized;
        if (lastEdited === 'qty' || lastEdited === 'unit') normalized = 'unit';
        else if (lastEdited === 'total') normalized = 'total';
        else normalized = null; // discount/vat → line-level override yok

        var self = this;
        (this.purchaseState.lines || []).forEach(function (line) {
            var k = line._k;
            var mode = normalized || line.lastEdited || 'unit';
            var q = parseFloat(line.qty) || 0;
            var u = parseFloat(line.unitCost) || 0;
            var t = parseFloat(line.total) || 0;

            if (mode === 'unit' && q > 0 && u > 0) {
                line.total = +(q * u).toFixed(2);
            } else if (mode === 'total' && q > 0 && t > 0) {
                line.unitCost = +(t / q).toFixed(4);
            }

            var uEl = document.getElementById('puLineUnit_' + k);
            var tEl = document.getElementById('puLineTotal_' + k);
            if (uEl && document.activeElement !== uEl) uEl.value = (line.unitCost === '' || line.unitCost == null) ? '' : line.unitCost;
            if (tEl && document.activeElement !== tEl) tEl.value = (line.total === '' || line.total == null) ? '' : line.total;
        });

        this.puRecalcAll();
    },

    // Summary refresher (grand total card)
    updatePurchaseSummary: function () {
        this.puRecalcAll();
    },

    // ============================================================
    // INPUT ZİNCİRİ (DEBOUNCED — input sırasında state override YOK)
    // input → state write (anlık) → debounce(400ms) → compute + summary
    // ============================================================
    handlePurchaseInput: function (k, field, value) {
        // 1) ANLIK STATE WRITE — kullanıcı yazdıkça state güncel, ama DOM'a dokunmuyoruz
        var stateField = (field === 'unit') ? 'unitCost' : field;
        var line = this.purchaseState.lines.find(function (l) { return l._k === k; });
        if (!line) return;

        // discount: clamp 0..100, bos string -> 0
        if (stateField === 'discount') {
            var d = (value === '' || value == null) ? 0 : Number(value);
            if (!Number.isFinite(d) || d < 0) d = 0;
            if (d > 100) d = 100;
            line.discount = d;
        } else {
            line[stateField] = value;
        }

        if (stateField === 'qty' || stateField === 'unitCost') {
            line.lastEdited = 'unit';
        } else if (stateField === 'total') {
            line.lastEdited = 'total';
        } else if (stateField === 'vat') {
            // Kullanıcı KDV'yi manuel değiştirdi — bir sonraki HM seçiminde
            // otomatik override etmesin.
            line._vatTouched = true;
        }
        this.lastEdited = field;

        // 2) DEBOUNCE — kullanıcı yazmayı kesince hesapla
        var self = this;
        if (this._puDebounceTimer) clearTimeout(this._puDebounceTimer);

        // VAT select / discount input değişiminde anında hesapla
        var delay = (field === 'vat' || field === 'discount') ? 0 : 250;

        this._puDebounceTimer = setTimeout(function () {
            self._puDebounceTimer = null;
            self._puComputeLine(k, field);
            self.recalcPurchase(field);
            self.updatePurchaseSummary();
        }, delay);
    },

    // Blur'da: debounce'u flush et
    handlePurchaseBlur: function (k, field) {
        if (this._puDebounceTimer) {
            clearTimeout(this._puDebounceTimer);
            this._puDebounceTimer = null;
        }
        this._puComputeLine(k, field);
        this.recalcPurchase(field);
        this.updatePurchaseSummary();
    },

    // ============================================================
    // SATIR HESAP MOTORU (iskonto + KDV)
    // ------------------------------------------------------------
    //   brut    = quantity * unit_cost
    //   iskonto = brut * (discount/100)
    //   net     = brut - iskonto
    //   kdv     = net * (vat/100)
    //   total   = net + kdv  (display total — KDV dahil, iskonto sonrasi)
    //
    // VAT EXCLUDED MODU: u = NET pre-disc unit
    //   total_display = q * u * (1-d) * (1+v)
    //
    // VAT INCLUDED MODU: u = GROSS pre-disc unit (KDV dahil)
    //   total_display = q * u * (1-d)
    //
    // Bidirectional: kullanici total yazarsa unit geri hesaplanir.
    //   excluded: u = total / (q * (1-d) * (1+v))
    //   included: u = total / (q * (1-d))
    // ============================================================
    _puComputeLine: function (k, field) {
        var stateField = (field === 'unit') ? 'unitCost' : field;
        var line = this.purchaseState.lines.find(function (l) { return l._k === k; });
        if (!line) return;

        var q = parseFloat(line.qty) || 0;
        var u = parseFloat(line.unitCost) || 0;
        var t = parseFloat(line.total) || 0;
        var d = parseFloat(line.discount) || 0;
        var v = parseFloat(line.vat) || 0;

        var dMul = 1 - (d / 100);   // iskonto carpani
        var vMul = 1 + (v / 100);   // kdv carpani
        var vatIncluded = !!this.purchaseState.vatIncluded;

        if (stateField === 'qty' || stateField === 'unitCost' || stateField === 'discount' || stateField === 'vat') {
            // Total'i unit'ten hesapla (eger lastEdited 'total' ise ve sadece vat/disc degisti -> unit'i yeniden hesapla)
            if (line.lastEdited === 'total' && stateField !== 'qty' && stateField !== 'unitCost' && q > 0 && t > 0) {
                var denom = vatIncluded ? (q * dMul) : (q * dMul * vMul);
                if (denom > 0) line.unitCost = +(t / denom).toFixed(4);
            } else if (q > 0 && u > 0) {
                var disp = vatIncluded ? (q * u * dMul) : (q * u * dMul * vMul);
                line.total = +disp.toFixed(2);
            } else {
                line.total = '';
            }
        } else if (stateField === 'total') {
            if (q > 0 && t > 0) {
                var denom2 = vatIncluded ? (q * dMul) : (q * dMul * vMul);
                if (denom2 > 0) line.unitCost = +(t / denom2).toFixed(4);
            } else {
                line.unitCost = '';
            }
        }

        // DOM — sadece aktif olmayan paired input'a yaz (user typing'i override etme)
        var uEl = document.getElementById('puLineUnit_' + k);
        var tEl = document.getElementById('puLineTotal_' + k);
        if (uEl && document.activeElement !== uEl) {
            uEl.value = (line.unitCost === '' || line.unitCost == null) ? '' : line.unitCost;
        }
        if (tEl && document.activeElement !== tEl) {
            tEl.value = (line.total === '' || line.total == null) ? '' : line.total;
        }
    },

    // Firma & Açıklama setter'ları — state-only, recompute tetiklemez
    puSetSupplier: function (v) {
        this.purchaseState.supplierName = String(v || '');
    },
    puSetDescription: function (v) {
        this.purchaseState.description = String(v || '');
    },

    puLineSearch: function (k, value) {
        var line = this.purchaseState.lines.find(function (l) { return l._k === k; });
        if (!line) return;
        line.search = String(value || '');

        // if typed something different than selected, clear selection
        if (line.rmId) {
            var expected = 'HM - ' + (line.rmName || '');
            if (value !== expected) {
                line.rmId = null;
                line.rmName = '';
                line.rmUnit = '';
            }
        }

        this.puLineRenderDropdown(k);
        this.puLineOpenDropdown(k);
    },

    puLineOpenDropdown: function (k) {
        this.puLineRenderDropdown(k);
        var dd = document.getElementById('puLineDropdown_' + k);
        if (dd) dd.style.display = 'block';
    },

    /* ============================================================
       PURCHASE UNIT COST HELPER (display-only)
       DB cost = ₺ / base_unit (gr/ml/adet).
       Purchase ekranı kullanicinin GÖRDÜĞÜ birim üzerinden çalışır
       (kg/lt/adet) → display + prefill icin geri çeviririz.
       Bu helper SADECE UI gösterim/prefill içindir; save flow’u
       yine purchase unit (kg/lt) yazar, DB trigger 021 base'e çevirir.
       ============================================================ */
    _puPurchaseUnitCost: function (baseCost, purchaseUnit, baseUnit) {
        var c = Number(baseCost) || 0;
        if (!purchaseUnit || !baseUnit) return c;
        if (purchaseUnit === baseUnit) return c;
        // mass: gr ↔ kg
        if (purchaseUnit === 'kg' && baseUnit === 'gr') return c * 1000;
        // volume: ml ↔ cl ↔ lt
        if (purchaseUnit === 'lt' && baseUnit === 'ml') return c * 1000;
        if (purchaseUnit === 'cl' && baseUnit === 'ml') return c * 10;
        // count: adet (paket desteklenmiyor — base_unit_cost as-is)
        return c;
    },

    puLineRenderDropdown: function (k) {
        var dd = document.getElementById('puLineDropdown_' + k);
        if (!dd) return;

        var line = this.purchaseState.lines.find(function (l) { return l._k === k; });
        if (!line) return;

        var self = this;
        var q = this.normalizeName(line.search || '');
        var list = this.purchaseState.rawMaterials.filter(function (m) {
            if (!q) return true;
            return self.normalizeName(m.name || '').indexOf(q) !== -1;
        }).slice(0, 30);

        if (!list.length) {
            dd.innerHTML = '<div style="padding:12px; text-align:center; color:#94a3b8; font-size:13px;">Ham madde bulunamadı.</div>';
            return;
        }

        dd.innerHTML = list.map(function (m) {
            var id = self.escapeHtml(m.id);
            var name = self.escapeHtml(m.name || '');
            var purchaseUnit = m.unit || '';
            var unit = self.escapeHtml(purchaseUnit || '');
            // Cost: DB ₺/base_unit → display purchase_unit'e cevrilir
            var purchaseCost = self._puPurchaseUnitCost(m.cost, purchaseUnit, m.base_unit || purchaseUnit);
            var costText = purchaseCost > 0
                ? (self.formatMoney(purchaseCost) + (unit ? ' / ' + unit : ''))
                : '—';
            return '<div onclick="window.ProductsView.puLineSelect(' + k + ', \'' + id + '\')" ' +
                'style="padding:10px 12px; cursor:pointer; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; gap:10px;" ' +
                'onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'transparent\'">' +
                '<div><div style="font-weight:700; color:#0f172a; font-size:13px;">HM - ' + name + '</div>' +
                '<div style="font-size:11px; color:#64748b;">Birim: ' + unit + ' • ' + costText + '</div></div>' +
            '</div>';
        }).join('');
    },

    puLineSelect: function (k, rmId) {
        var line = this.purchaseState.lines.find(function (l) { return l._k === k; });
        if (!line) return;
        var m = this.purchaseState.rawMaterials.find(function (x) { return String(x.id) === String(rmId); });
        if (!m) return;

        line.rmId = m.id;
        line.rmName = m.name || '';
        line.rmUnit = m.unit || '';
        // PREFILL: ₺/base_unit (DB) → ₺/purchase_unit (kullanicinin gordugu)
        if (!line.unitCost) {
            var prefill = this._puPurchaseUnitCost(m.cost, m.unit, m.base_unit || m.unit);
            line.unitCost = prefill > 0 ? prefill : '';
        }

        // ============================================================
        // KDV OTOMATIK DOLDURMA
        // ------------------------------------------------------------
        // Kullanici manuel KDV degistirmediyse hammadde KDV'sini uygula.
        // vat_rate string ('20.00') veya number olabilir; Number() ile coerce.
        // null/NaN durumunda fallback 20.
        // ============================================================
        var rawVat = m.vat_rate;
        var coerced = (rawVat == null || rawVat === '') ? NaN : Number(rawVat);
        var hmVat = Number.isFinite(coerced) ? coerced : 20;

        if (!line._vatTouched) {
            line.vat = hmVat;
            if(window.__DEBUG__)console.log('[puLineSelect] HM:', m.name, '| raw vat_rate:', rawVat, '| applied:', hmVat);
        } else {
            if(window.__DEBUG__)console.log('[puLineSelect] HM:', m.name, '| vat manuel degistirilmis, dokunulmadi. line.vat:', line.vat);
        }

        var dd = document.getElementById('puLineDropdown_' + k);
        if (dd) dd.style.display = 'none';

        // Tum satiri yeniden render et — select'in selected attribute'u line.vat ile
        // birlikte yeniden olusturulur.
        this.puRenderLines();

        // GUVENCE: render sonrasi DOM'a direkt bind et (race condition'a karsi).
        // Satirin SELECT elementini bul ve degerini line.vat'a esitle.
        var row = document.querySelector('.pu-line-row[data-k="' + k + '"]');
        if (row) {
            var sel = row.querySelector('select.form-select');
            if (sel && !line._vatTouched) {
                sel.value = String(line.vat);
            }
        }
    },

    puRecalcAll: function () {
        // ============================================================
        // GENEL HESAP MOTORU (satir iskontosu + genel iskonto + KDV)
        // ------------------------------------------------------------
        // SATIR ICIN (her satirda):
        //   netUnit    = u (excluded mode) | u/(1+v) (included mode)
        //   brut_net   = q * netUnit
        //   line_disc  = brut_net * (discount/100)
        //   net_after  = brut_net - line_disc
        //
        // SUM:
        //   sum_brut_net   = sum of q*netUnit
        //   sum_line_disc  = sum of line_disc
        //   sum_net_after  = sum_brut_net - sum_line_disc
        //
        // GENEL ISKONTO (KDV oncesi, satirlara orantili dagit):
        //   percent: gen_disc_net = sum_net_after * (gd.value/100)
        //   amount : gen_disc_net = min(gd.value, sum_net_after)
        //   final_net_factor = (sum_net_after - gen_disc_net) / sum_net_after
        //   per line: line_final_net = net_after * final_net_factor
        //              line_vat = line_final_net * v
        //              line_gross = line_final_net + line_vat
        //
        // SUM final:
        //   final_net = sum_net_after - gen_disc_net
        //   total_vat = sum of line_vat (after general discount applied)
        //   grand     = final_net + total_vat
        // ============================================================
        var vatIncluded = !!this.purchaseState.vatIncluded;
        var gd = this.purchaseState.generalDiscount || { type: 'amount', value: 0 };
        var gdType = gd.type === 'percent' ? 'percent' : 'amount';
        var gdValue = Number(gd.value) || 0;
        if (gdValue < 0) gdValue = 0;

        // 1. Satir bazli on-hesap
        var lineCalcs = [];
        var sumBrutNet = 0;
        var sumLineDisc = 0;

        (this.purchaseState.lines || []).forEach(function (l) {
            var q = parseFloat(l.qty) || 0;
            var u = parseFloat(l.unitCost) || 0;
            var v = parseFloat(l.vat) || 0;
            var d = parseFloat(l.discount) || 0;
            if (q <= 0 || u <= 0) return;

            var netUnit = vatIncluded ? (u / (1 + v / 100)) : u;
            var brutNet = q * netUnit;
            var lineDisc = brutNet * (d / 100);
            var netAfter = brutNet - lineDisc;

            sumBrutNet  += brutNet;
            sumLineDisc += lineDisc;

            lineCalcs.push({
                vatRate: v,
                netAfter: netAfter
            });
        });

        var sumNetAfter = sumBrutNet - sumLineDisc;

        // 2. Genel iskonto hesabi
        var genDiscNet = 0;
        if (sumNetAfter > 0) {
            if (gdType === 'percent') {
                var gp = Math.max(0, Math.min(100, gdValue));
                genDiscNet = sumNetAfter * (gp / 100);
            } else {
                genDiscNet = Math.min(Math.max(0, gdValue), sumNetAfter);
            }
        }

        // 3. Final net + KDV (genel iskonto orantili dagilim)
        var finalNet = sumNetAfter - genDiscNet;
        var factor = sumNetAfter > 0 ? (finalNet / sumNetAfter) : 0;

        var totalVat = 0;
        var vatByRate = {};

        lineCalcs.forEach(function (lc) {
            var lineFinalNet = lc.netAfter * factor;
            var lineVat = lineFinalNet * (lc.vatRate / 100);
            totalVat += lineVat;
            if (!vatByRate[lc.vatRate]) vatByRate[lc.vatRate] = 0;
            vatByRate[lc.vatRate] += lineVat;
        });

        var grand = finalNet + totalVat;

        // 4. DOM update
        var brutEl  = document.getElementById('puGrandBrut');
        var lDscEl  = document.getElementById('puGrandLineDisc');
        var gDscEl  = document.getElementById('puGrandGenDisc');
        var netEl   = document.getElementById('puGrandNet');
        var vatEl   = document.getElementById('puGrandVat');
        var totalEl = document.getElementById('puGrandTotal');
        var brEl    = document.getElementById('puVatBreakdown');

        if (brutEl) brutEl.textContent = this.formatMoney(sumBrutNet);
        if (lDscEl) lDscEl.textContent = '−' + this.formatMoney(sumLineDisc);
        if (gDscEl) gDscEl.textContent = '−' + this.formatMoney(genDiscNet);
        if (netEl)  netEl.textContent  = this.formatMoney(finalNet);
        if (vatEl)  vatEl.textContent  = this.formatMoney(totalVat);
        if (totalEl) totalEl.textContent = this.formatMoney(grand);

        if (brEl) {
            var self = this;
            var rates = Object.keys(vatByRate).map(Number).sort(function (a, b) { return a - b; });
            if (!rates.length) {
                brEl.innerHTML = '';
            } else {
                brEl.innerHTML = rates.map(function (r) {
                    return '<div style="display:flex; justify-content:space-between; padding:3px 0; font-size:13px; color:#64748b;">' +
                        '<span>KDV %' + r + '</span>' +
                        '<span>' + self.formatMoney(vatByRate[r]) + '</span>' +
                    '</div>';
                }).join('');
            }
        }
    },

    puClearAll: function () {
        this.purchaseState.lines = [];
        this.purchaseState.supplierName = '';
        this.purchaseState.description = '';
        this.purchaseState.generalDiscount = { type: 'amount', value: 0 };
        this.purchaseState.editingItemId = null;
        this.purchaseState.editingInvoiceId = null;
        this.purchaseState.editingOriginalIds = [];
        var sEl = document.getElementById('puSupplier');
        var dEl = document.getElementById('puDescription');
        var dateEl0 = document.getElementById('puDate');
        if (sEl) sEl.value = '';
        if (dEl) dEl.value = '';
        if (dateEl0) dateEl0.value = new Date().toISOString().slice(0, 10);
        var gdtEl = document.getElementById('puGenDiscType');
        var gdvEl = document.getElementById('puGenDiscValue');
        if (gdtEl) gdtEl.value = 'amount';
        if (gdvEl) gdvEl.value = '';
        var btn = document.getElementById('puSaveAllBtn');
        if (btn) btn.textContent = 'Faturayı Kaydet';
        this.puAddLine();
        this.puSetStatus('', '');
        var status = document.getElementById('puStatus');
        if (status) status.innerHTML = '';
    },

    puSetGeneralDiscountType: function (type) {
        if (type !== 'amount' && type !== 'percent') type = 'amount';
        this.purchaseState.generalDiscount.type = type;
        this.puRecalcAll();
    },

    puSetGeneralDiscountValue: function (value) {
        var v = (value === '' || value == null) ? 0 : Number(value);
        if (!Number.isFinite(v) || v < 0) v = 0;
        var type = this.purchaseState.generalDiscount.type;
        if (type === 'percent' && v > 100) v = 100;
        this.purchaseState.generalDiscount.value = v;
        this.puRecalcAll();
    },

    // ============================================================
    // WAC HELPER — net maliyet faktörü (genel iskonto sonrası)
    // ------------------------------------------------------------
    // Her satırın rowNetPost = q * netUnit * (1 - d/100) değerini topla,
    // genel iskontoyu sumNetPost üzerinden uygula, faktör döndür.
    // base_unit_cost = (rowNetPost * factor) / q ile yazılır.
    // ============================================================
    _puComputeWacFactor: function (lines, vatIncluded) {
        var sumNetPost = 0;
        var rowsMeta = [];
        (lines || []).forEach(function (l) {
            var q = parseFloat(l.qty) || 0;
            var u = parseFloat(l.unitCost) || 0;
            var v = parseFloat(l.vat) || 0;
            var d = parseFloat(l.discount) || 0;
            if (!Number.isFinite(d) || d < 0) d = 0;
            if (d > 100) d = 100;
            if (q <= 0 || u <= 0) {
                rowsMeta.push({ key: l._k, q: q, netUnit: 0, rowNetPost: 0 });
                return;
            }
            var netUnit = vatIncluded ? (u / (1 + v / 100)) : u;
            var rowNetPost = q * netUnit * (1 - d / 100);
            sumNetPost += rowNetPost;
            rowsMeta.push({ key: l._k, q: q, netUnit: netUnit, rowNetPost: rowNetPost });
        });

        var gd = this.purchaseState.generalDiscount || { type: 'amount', value: 0 };
        var gdType = gd.type === 'percent' ? 'percent' : 'amount';
        var gdValue = Number(gd.value) || 0;
        if (gdValue < 0) gdValue = 0;

        var gdAmt = 0;
        if (sumNetPost > 0 && gdValue > 0) {
            if (gdType === 'percent') {
                var gp = Math.max(0, Math.min(100, gdValue));
                gdAmt = sumNetPost * (gp / 100);
            } else {
                gdAmt = gdValue;
            }
            if (gdAmt > sumNetPost) gdAmt = sumNetPost;
            if (gdAmt < 0) gdAmt = 0;
        }

        var finalNet = sumNetPost - gdAmt;
        var factor = sumNetPost > 0 ? (finalNet / sumNetPost) : 0;
        return { factor: factor, rowsMeta: rowsMeta };
    },

    puSaveAll: async function () {
        // Re-entry guard: hızlı çift tık aynı faturayı 2 kez kaydetmesin
        if (this._savingPurchase) return;
        this._savingPurchase = true;
        try {
        if (this.purchaseState.saving) return;

        // ====== UNIFIED INVOICE DATE ======
        // Kullanicinin sectigi tarih invoice_date kolonuna yazilir (DATE).
        // created_at DB tarafindan now() ile otomatik dolar — manuel
        // gondermiyoruz (timezone kaymalarini onlemek icin).
        var dateInput = document.getElementById('puDate');
        var selectedDate = dateInput ? dateInput.value : '';
        // date-only string (YYYY-MM-DD). Bos ise bugunun tarihi.
        var invoiceDate = selectedDate
            ? String(selectedDate).slice(0, 10)
            : new Date().toISOString().slice(0, 10);

        // Debounce'u flush et — pending compute varsa şimdi çalışsın
        if (this._puDebounceTimer) {
            clearTimeout(this._puDebounceTimer);
            this._puDebounceTimer = null;
            var self = this;
            (this.purchaseState.lines || []).forEach(function (line) {
                self._puComputeLine(line._k, line.lastEdited === 'total' ? 'total' : 'unit');
            });
            this.puRecalcAll();
        }

        // Geçerli satırları filtrele (hem insert hem edit için ortak)
        var validLines = this.purchaseState.lines.filter(function (l) {
            var q = parseFloat(l.qty);
            var u = parseFloat(l.unitCost);
            return l.rmId && Number.isFinite(q) && q > 0 && Number.isFinite(u) && u > 0;
        });
        var anyInvalid = this.purchaseState.lines.some(function (l) {
            var hasAny = l.rmId || l.qty || l.unitCost;
            if (!hasAny) return false;
            var q = parseFloat(l.qty);
            var u = parseFloat(l.unitCost);
            return !l.rmId || !Number.isFinite(q) || q <= 0 || !Number.isFinite(u) || u <= 0;
        });

        // ====== HARD GUARD — VERİ KALİTESİ ======
        // Boş satır / 0 miktar / 0 fiyat / hammadde seçilmemiş → hiç kayıt yapma
        if (validLines.length === 0) {
            try { alert('Geçerli satır yok. Her satırda ham madde, miktar (>0) ve birim fiyat (>0) gerekli.'); } catch (e) {}
            this.puSetStatus('Geçerli satır yok.', 'error');
            this._savingPurchase = false;
            return;
        }
        if (anyInvalid) {
            try { alert('Eksik/hatalı satır var. Boş satırları kaldırın veya ham madde + miktar + birim fiyat girin.'); } catch (e) {}
            this.puSetStatus('Eksik/hatalı satır var. Her satırda ham madde, miktar ve birim fiyat gerekli.', 'error');
            this._savingPurchase = false;
            return;
        }

        // ====== EDIT MODE — INVOICE UPDATE (multi-line) ======
        if (this.purchaseState.editingInvoiceId || (this.purchaseState.editingOriginalIds && this.purchaseState.editingOriginalIds.length)) {
            if (anyInvalid) {
                this.puSetStatus('Eksik/hatalı satır var. Her satırda ham madde, miktar ve birim fiyat gerekli.', 'error');
                return;
            }
            if (!validLines.length) {
                this.puSetStatus('En az bir geçerli satır gerekli.', 'error');
                return;
            }

            var eBtn = document.getElementById('puSaveAllBtn');
            this.purchaseState.saving = true;
            if (eBtn) { eBtn.disabled = true; eBtn.textContent = 'Güncelleniyor...'; }

            var editInvoiceId = this.purchaseState.editingInvoiceId || this._puMakeInvoiceId();
            var editSupplier = this.purchaseState.supplierName || null;
            var editDesc = this.purchaseState.description || null;
            // Genel iskonto note'ta YAZILMAZ — kolon olarak gönderilir
            var editNote = this._puMakeNote(editInvoiceId, editSupplier, editDesc, null);
            var editGenDisc  = this.purchaseState.generalDiscount || { type: 'amount', value: 0 };
            var editGdAmount = Number(editGenDisc.value) || 0;
            var editGdType   = editGenDisc.type === 'percent' ? 'percent' : 'amount';
            var originalIds = (this.purchaseState.editingOriginalIds || []).slice();

            // Tenant resolve
            var eTenantId = null;
            try {
                if (window.SupabaseService && typeof window.SupabaseService.getTenantId === 'function') {
                    eTenantId = await window.SupabaseService.getTenantId();
                }
            } catch (e) { eTenantId = null; }
            if (!eTenantId) {
                this.purchaseState.saving = false;
                if (eBtn) { eBtn.disabled = false; eBtn.textContent = 'Faturayı Güncelle'; }
                this.puSetStatus('Tenant doğrulanamadı. Lütfen tekrar giriş yapın.', 'error');
                return;
            }

            var eVatIncluded = !!this.purchaseState.vatIncluded;
            var keepIds = [];
            var eOk = 0, eFail = 0, eLastErr = null;

            // YENI SATIRLAR ICIN BATCH KUYRUGU — tek atomic RPC ile gonderilir
            var editNewItems = [];

            // Tarih: fonksiyon başında tek seferlik hesaplanan invoiceDate kullanılır
            var eCreatedAt = invoiceDate;

            // WAC: genel iskonto sonrası net birim maliyet için faktör
            var eWac = this._puComputeWacFactor(validLines, eVatIncluded);
            var eFactor = eWac.factor;

            // 1) Her satır: orijinal varsa UPDATE, yoksa BATCH KUYRUGU'na ekle
            for (var ei = 0; ei < validLines.length; ei++) {
                var el = validLines[ei];
                var eq2 = parseFloat(el.qty);
                var eu2 = parseFloat(el.unitCost);
                var ev2 = parseFloat(el.vat) || 0;
                var ed2 = parseFloat(el.discount) || 0;
                if (!Number.isFinite(ed2) || ed2 < 0) ed2 = 0;
                if (ed2 > 100) ed2 = 100;
                var eVatMul2 = 1 + (ev2 / 100);
                var eDMul2 = 1 - (ed2 / 100);
                var eNetUnit2, eLineTotal2;
                if (eVatIncluded) {
                    eNetUnit2 = eu2 / eVatMul2;
                    eLineTotal2 = eq2 * eu2 * eDMul2; // = eq2 * eNetUnit2 * eDMul2 * eVatMul2
                } else {
                    eNetUnit2 = eu2;
                    eLineTotal2 = eq2 * eu2 * eDMul2 * eVatMul2;
                }

                // WAC: rowNetPost = eq2 * eNetUnit2 * eDMul2 ; rowFinalNet = rowNetPost * eFactor
                // base_unit_cost = rowFinalNet / eq2 = eNetUnit2 * eDMul2 * eFactor
                var eRowNetPost = eq2 * eNetUnit2 * eDMul2;
                var eRowFinalNet = eRowNetPost * eFactor;
                var eBaseUnitCost = eq2 > 0 ? (eRowFinalNet / eq2) : 0;
                if (!Number.isFinite(eBaseUnitCost) || eBaseUnitCost < 0) eBaseUnitCost = 0;

                try {
                    if (el._originalId && originalIds.indexOf(el._originalId) !== -1) {
                        const payload = {
                            raw_material_id: el.rmId,

                            quantity: Number(eq2),
                            unit: el.rmUnit,

                            unit_cost: Number(eNetUnit2),
                            line_total: Number(eLineTotal2),
                            vat_rate: Number(ev2),
                            discount_rate: Number(ed2),

                            base_quantity: Number(eq2),
                            base_unit_cost: Number(eBaseUnitCost),

                            general_discount_amount: Number(editGdAmount) || 0,
                            general_discount_type: editGdType,

                            note: editNote,
                            invoice_date: eCreatedAt
                        };

                        // === FORCE NUMERIC ===
                        payload.quantity        = Number(payload.quantity);
                        payload.unit_cost       = Number(payload.unit_cost);
                        payload.line_total      = Number(payload.line_total);
                        payload.vat_rate        = Number(payload.vat_rate);
                        payload.discount_rate   = Number(payload.discount_rate);
                        payload.base_quantity   = Number(payload.base_quantity);
                        payload.base_unit_cost  = Number(payload.base_unit_cost);
                        payload.general_discount_amount = Number(payload.general_discount_amount) || 0;

                        if (!Number.isFinite(payload.base_quantity) || payload.base_quantity <= 0 ||
                            !Number.isFinite(payload.base_unit_cost) || payload.base_unit_cost < 0) {
                            console.error('SAVE ABORT-ROW: base_* invalid (edit-update)', payload);
                            eFail++;
                            eLastErr = { message: 'WAC verisi geçersiz (base_quantity/base_unit_cost)' };
                            continue;
                        }


                        // RPC-ONLY ile guncelle — REST fallback YOK
                        // (REST UPDATE PostgREST schema cache stale ise invoice_date'i sessiz drop edebilir)
                        var ures;
                        try {
                            var rpcCli = window.SupabaseService.getClient && window.SupabaseService.getClient();
                            if (!rpcCli || typeof rpcCli.rpc !== 'function') {
                                console.error('[UPDATE EDIT] RPC client bulunamadi — satir GUNCELLENMEDI', payload);
                                ures = { data: null, error: { message: 'Supabase RPC client yok' } };
                            } else {
                                var rpcU = await rpcCli.rpc('update_purchase_item', {
                                    p_id: el._originalId,
                                    p_raw_material_id: payload.raw_material_id,
                                    p_quantity: payload.quantity,
                                    p_unit: payload.unit,
                                    p_unit_cost: payload.unit_cost,
                                    p_line_total: payload.line_total,
                                    p_vat_rate: payload.vat_rate,
                                    p_discount_rate: payload.discount_rate,
                                    p_base_quantity: payload.base_quantity,
                                    p_base_unit_cost: payload.base_unit_cost,
                                    p_general_discount_amount: payload.general_discount_amount,
                                    p_general_discount_type: payload.general_discount_type,
                                    p_note: payload.note,
                                    p_invoice_date: payload.invoice_date
                                });
                                if (rpcU && rpcU.error) {
                                    console.error('[UPDATE EDIT] RPC FAIL — satir GUNCELLENMEDI', rpcU.error, payload);
                                    ures = { data: null, error: rpcU.error };
                                } else {
                                    ures = { data: rpcU && rpcU.data, error: null };
                                }
                            }
                        } catch (rpcErr) {
                            console.error('[UPDATE EDIT] RPC THREW — satir GUNCELLENMEDI', rpcErr, payload);
                            ures = { data: null, error: rpcErr };
                        }
                        if (ures && ures.error) { eFail++; eLastErr = ures.error; }
                        else { eOk++; keepIds.push(el._originalId); }
                    } else {
                        // ============================================================
                        // YENI SATIR — tek tek INSERT YOK. Batch kuyruguna eklenir.
                        // (note JSON'da invoice_id mevcut; batch RPC ayni invoice_no'yu reuse eder)
                        // ============================================================
                        var newItem = {
                            raw_material_id: el.rmId,
                            quantity: Number(eq2),
                            unit: el.rmUnit,
                            unit_cost: Number(eNetUnit2),
                            line_total: Number(eLineTotal2),
                            vat_rate: Number(ev2),
                            discount_rate: Number(ed2),
                            base_quantity: Number(eq2),
                            base_unit_cost: Number(eBaseUnitCost),
                            general_discount_amount: Number(editGdAmount) || 0,
                            general_discount_type: editGdType,
                            note: editNote,
                            invoice_date: eCreatedAt
                        };

                        // === FORCE NUMERIC ===
                        newItem.quantity        = Number(newItem.quantity);
                        newItem.unit_cost       = Number(newItem.unit_cost);
                        newItem.line_total      = Number(newItem.line_total);
                        newItem.vat_rate        = Number(newItem.vat_rate);
                        newItem.discount_rate   = Number(newItem.discount_rate);
                        newItem.base_quantity   = Number(newItem.base_quantity);
                        newItem.base_unit_cost  = Number(newItem.base_unit_cost);
                        newItem.general_discount_amount = Number(newItem.general_discount_amount) || 0;

                        if (!Number.isFinite(newItem.base_quantity) || newItem.base_quantity <= 0 ||
                            !Number.isFinite(newItem.base_unit_cost) || newItem.base_unit_cost < 0) {
                            console.error('SAVE ABORT-ROW: base_* invalid (edit-new-line)', newItem);
                            eFail++;
                            eLastErr = { message: 'WAC verisi geçersiz (base_quantity/base_unit_cost)' };
                            continue;
                        }

                        // Sadece kuyruga ekle — RPC asagida tek seferde calisacak
                        editNewItems.push(newItem);
                    }
                } catch (err) {
                    eFail++; eLastErr = err;
                }
            }

            // ============================================================
            // 1.5) BATCH INSERT — tum yeni satirlar TEK atomic RPC ile
            // ============================================================
            if (editNewItems.length > 0) {
                try {
                    var rpcCli2 = window.SupabaseService.getClient && window.SupabaseService.getClient();
                    if (!rpcCli2 || typeof rpcCli2.rpc !== 'function') {
                        console.error('[BATCH EDIT-NEW] RPC client bulunamadi — ' + editNewItems.length + ' YENI SATIR EKLENMEDI');
                        eFail += editNewItems.length;
                        eLastErr = { message: 'Supabase RPC client yok' };
                    } else {
                        if(window.__DEBUG__)console.log('[BATCH EDIT-NEW] RPC → insert_purchase_items_batch, satir:', editNewItems.length);
                        var bRes = await rpcCli2.rpc('insert_purchase_items_batch', {
                            p_items: editNewItems
                        });
                        if(window.__DEBUG__)console.log('[BATCH EDIT-NEW] RPC RESULT:', bRes);
                        if (bRes && bRes.error) {
                            console.error('[BATCH EDIT-NEW] RPC FAIL — TUM YENI SATIRLAR ROLLBACK', bRes.error);
                            eFail += editNewItems.length;
                            eLastErr = bRes.error;
                        } else {
                            var inserted = (bRes && bRes.data && Number(bRes.data.count)) || editNewItems.length;
                            eOk += inserted;
                            // Batch'in donen inserted_ids'lerini keepIds'e ekle (delete adimi
                            // bunlari soft-delete ETMEMELI cunku yeni eklendiler)
                            var insertedIds = (bRes && bRes.data && Array.isArray(bRes.data.inserted_ids))
                                ? bRes.data.inserted_ids : [];
                            for (var ii = 0; ii < insertedIds.length; ii++) {
                                if (insertedIds[ii]) keepIds.push(insertedIds[ii]);
                            }
                        }
                    }
                } catch (rpcErr2) {
                    console.error('[BATCH EDIT-NEW] RPC THREW — TUM YENI SATIRLAR ROLLBACK', rpcErr2);
                    eFail += editNewItems.length;
                    eLastErr = rpcErr2;
                }
            }

            // 2) Silinmiş satırlar: orijinallerden keepIds dışında kalanları soft-delete
            for (var di = 0; di < originalIds.length; di++) {
                var origId = originalIds[di];
                if (keepIds.indexOf(origId) === -1) {
                    try {
                        var dres = await window.SupabaseService.update('purchase_items', origId, { is_deleted: true });
                        if (dres && dres.error) { eFail++; eLastErr = dres.error; }
                    } catch (err2) { eFail++; eLastErr = err2; }
                }
            }

            this.purchaseState.saving = false;
            if (eBtn) { eBtn.disabled = false; eBtn.textContent = 'Faturayı Kaydet'; }

            if (!this._isActive) return;

            if (eFail > 0) {
                this.puSetStatus(eOk + ' satır güncellendi, ' + eFail + ' hata. ' + this.getErrorMessage(eLastErr, ''), 'error');
                if (eBtn) eBtn.textContent = 'Faturayı Güncelle';
                return;
            }

            this.purchaseState.editingInvoiceId = null;
            this.purchaseState.editingOriginalIds = [];
            this.purchaseState.supplierName = '';
            this.purchaseState.description = '';
            this.purchaseState.generalDiscount = { type: 'amount', value: 0 };
            var esEl = document.getElementById('puSupplier');
            var edEl = document.getElementById('puDescription');
            var egdtEl = document.getElementById('puGenDiscType');
            var egdvEl = document.getElementById('puGenDiscValue');
            var eDate2 = document.getElementById('puDate');
            if (esEl) esEl.value = '';
            if (edEl) edEl.value = '';
            if (egdtEl) egdtEl.value = 'amount';
            if (egdvEl) egdvEl.value = '';
            if (eDate2) eDate2.value = new Date().toISOString().slice(0, 10);
            this.purchaseState.lines = [];
            this.puAddLine();
            this.puSetStatus('Fatura güncellendi.', 'success');
            await this.puLoadRecent();
            window.dispatchEvent(new CustomEvent('products:updated'));
            return;
        }
        // ====== /EDIT MODE ======

        // INSERT path artık ortak validLines'ı kullanır (yukarıda hard-guard ile doğrulandı)
        var lines = validLines;

        this.purchaseState.saving = true;
        var btn = document.getElementById('puSaveAllBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor...'; }

        var ok = 0, fail = 0, lastErr = null;

        var vatIncluded = !!this.purchaseState.vatIncluded;

        // RLS fix — tenant_id'yi backend'den resolve et ve her payload'a ekle
        var tenantId = null;
        try {
            if (window.SupabaseService && typeof window.SupabaseService.getTenantId === 'function') {
                tenantId = await window.SupabaseService.getTenantId();
            }
        } catch (e) {
            tenantId = null;
        }
        if (!tenantId) {
            this.purchaseState.saving = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Faturayı Kaydet'; }
            this.puSetStatus('Tenant doğrulanamadı. Lütfen tekrar giriş yapın.', 'error');
            return;
        }

        // INVOICE — tüm satırlar aynı invoice_id + supplier + description ile
        // Genel iskonto artık note'ta DEĞİL, kolon olarak (general_discount_amount/type) tutulur
        var invoiceId = this._puMakeInvoiceId();
        var invoiceNote = this._puMakeNote(
            invoiceId,
            this.purchaseState.supplierName || null,
            this.purchaseState.description || null,
            null
        );
        var saveGenDisc = this.purchaseState.generalDiscount || { type: 'amount', value: 0 };
        var saveGdAmount = Number(saveGenDisc.value) || 0;
        var saveGdType   = saveGenDisc.type === 'percent' ? 'percent' : 'amount';

        // Tarih: fonksiyon başında tek seferlik hesaplanan invoiceDate kullanılır
        var sCreatedAt = invoiceDate;

        // WAC: genel iskonto sonrası net birim maliyet faktörü
        var sWac = this._puComputeWacFactor(lines, vatIncluded);
        var sFactor = sWac.factor;

        // ============================================================
        // ATOMIC BATCH INSERT
        // ------------------------------------------------------------
        // Tum satirlar TEK RPC ile gonderilir. Herhangi biri patlarsa
        // hepsi rollback olur (sunucu tarafi). Yarim fatura YOK.
        // ============================================================

        // 1) Tum payload'lari hazirla (validasyon + numeric coerce)
        var batchItems = [];
        var skipped = 0;

        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            var q = parseFloat(l.qty);
            var u = parseFloat(l.unitCost);
            var v = parseFloat(l.vat) || 0;
            var d = parseFloat(l.discount) || 0;
            if (!Number.isFinite(d) || d < 0) d = 0;
            if (d > 100) d = 100;
            var vatMul = 1 + (v / 100);
            var dMul = 1 - (d / 100);

            var netUnit, lineTotal;
            if (vatIncluded) {
                netUnit   = u / vatMul;
                lineTotal = q * u * dMul;
            } else {
                netUnit   = u;
                lineTotal = q * u * dMul * vatMul;
            }

            var sRowNetPost = q * netUnit * dMul;
            var sRowFinalNet = sRowNetPost * sFactor;
            var sBaseUnitCost = q > 0 ? (sRowFinalNet / q) : 0;
            if (!Number.isFinite(sBaseUnitCost) || sBaseUnitCost < 0) sBaseUnitCost = 0;

            var item = {
                raw_material_id: l.rmId,
                quantity: Number(q),
                unit: l.rmUnit,
                unit_cost: Number(netUnit),
                line_total: Number(lineTotal),
                vat_rate: Number(v),
                discount_rate: Number(d),
                base_quantity: Number(q),
                base_unit_cost: Number(sBaseUnitCost),
                general_discount_amount: Number(saveGdAmount) || 0,
                general_discount_type: saveGdType,
                note: invoiceNote,
                invoice_date: sCreatedAt
            };

            // base_* invalid → bu satiri batch'e DAHIL ETME, kullaniciyi uyar.
            // (atomik gerek: atılan satır hata olarak görünmeli, sessiz drop yok.)
            if (!Number.isFinite(item.base_quantity) || item.base_quantity <= 0 ||
                !Number.isFinite(item.base_unit_cost) || item.base_unit_cost < 0) {
                console.error('[BATCH NEW] WAC verisi gecersiz — satir batche eklenmedi', item);
                skipped++;
                continue;
            }

            batchItems.push(item);
        }

        // Hicbir gecerli satir kalmadiysa hata
        if (!batchItems.length) {
            this.purchaseState.saving = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Faturayı Kaydet'; }
            this.puSetStatus('Geçerli satır yok (WAC verisi eksik). Fatura kaydedilmedi.', 'error');
            return;
        }

        // Skip varsa kullaniciyi engelle — atomik garantisi icin
        if (skipped > 0) {
            this.purchaseState.saving = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Faturayı Kaydet'; }
            this.puSetStatus(skipped + ' satırda WAC verisi eksik. Fatura kaydedilmedi.', 'error');
            return;
        }

        // 2) TEK RPC cagrisi — atomic
        var resp;
        try {
            var rpcClient = window.SupabaseService.getClient && window.SupabaseService.getClient();
            if (!rpcClient || typeof rpcClient.rpc !== 'function') {
                console.error('[BATCH NEW] RPC client bulunamadi');
                resp = { data: null, error: { message: 'Supabase RPC client yok' } };
            } else {
                if(window.__DEBUG__)console.log('[BATCH NEW] RPC → insert_purchase_items_batch, satir:', batchItems.length);
                var rpcRes = await rpcClient.rpc('insert_purchase_items_batch', {
                    p_items: batchItems
                });
                if(window.__DEBUG__)console.log('[BATCH NEW] RPC RESULT:', rpcRes);
                if (rpcRes && rpcRes.error) {
                    console.error('[BATCH NEW] RPC FAIL — TUM SATIRLAR ROLLBACK', rpcRes.error);
                    resp = { data: null, error: rpcRes.error };
                } else {
                    resp = { data: rpcRes && rpcRes.data, error: null };
                }
            }
        } catch (rpcErr) {
            console.error('[BATCH NEW] RPC THREW — TUM SATIRLAR ROLLBACK', rpcErr);
            resp = { data: null, error: rpcErr };
        }

        // 3) Sonuc isle
        if (resp && resp.error) {
            fail = batchItems.length;
            ok = 0;
            lastErr = resp.error;
        } else {
            ok = (resp.data && Number(resp.data.count)) || batchItems.length;
            fail = 0;
        }

        this.purchaseState.saving = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Faturayı Kaydet'; }

        if (!this._isActive) return;

        if (fail > 0) {
            this.puSetStatus(ok + ' kayıt eklendi, ' + fail + ' satır hata verdi. ' + this.getErrorMessage(lastErr, ''), 'error');
        } else {
            this.puSetStatus('Fatura kaydedildi (' + ok + ' satır). Ham madde maliyetleri otomatik güncellenecek.', 'success');
            this.purchaseState.lines = [];
            this.purchaseState.supplierName = '';
            this.purchaseState.description = '';
            this.purchaseState.generalDiscount = { type: 'amount', value: 0 };
            var sEl2 = document.getElementById('puSupplier');
            var dEl2 = document.getElementById('puDescription');
            var gdt2 = document.getElementById('puGenDiscType');
            var gdv2 = document.getElementById('puGenDiscValue');
            var dt2 = document.getElementById('puDate');
            if (sEl2) sEl2.value = '';
            if (dEl2) dEl2.value = '';
            if (gdt2) gdt2.value = 'amount';
            if (gdv2) gdv2.value = '';
            if (dt2) dt2.value = new Date().toISOString().slice(0, 10);
            this.puAddLine();
        }

        // Hammadde cost'lari trigger ile DB'de guncellendi —
        // frontend cache'ini de yenile ki "alis faturasi" listesinde
        // anlik son cost gorunsun.
        try {
            await this.puLoadRawMaterials();
        } catch (eRm) { /* noop */ }

        await this.puLoadRecent();

        // Tum dinleyicilere haber ver: products + raw_materials + dashboard
        try {
            window.dispatchEvent(new CustomEvent('products:updated'));
            window.dispatchEvent(new CustomEvent('raw-materials:updated'));
            window.dispatchEvent(new CustomEvent('purchases:updated'));
            window.dispatchEvent(new Event('dashboard:refresh'));
        } catch (eEv) { /* noop */ }

        // ViewCache'i de invalidate et (defensif — diger view'lar stale olmasin)
        if (window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
            try {
                window.ViewCache.invalidate('raw-materials-view:');
                window.ViewCache.invalidate('products-view:');
                window.ViewCache.invalidate('dashboard:');
            } catch (eC) { /* noop */ }
        }
        } finally {
            // Hata olsa da, başarı olsa da, erken return olsa da flag mutlaka resetlenir
            this._savingPurchase = false;
        }
    },

    puRemove: async function (invoiceId) {
        // invoice id gelir → o faturanın tüm itemlarını soft-delete
        var inv = this._puFindInvoice(invoiceId);
        if (!inv) {
            // Fallback: belki direkt item id gelmiş (eski davranış)
            var okSingle = window.confirm('Bu kayıt silinsin mi? (Ham madde maliyeti yeniden hesaplanacak)');
            if (!okSingle) return;
            try {
                var rsingle = await window.SupabaseService.update('purchase_items', invoiceId, { is_deleted: true });
                if (!this._isActive) return;
                if (rsingle && rsingle.error) {
                    this.puSetStatus(this.getErrorMessage(rsingle.error, 'Silinemedi.'), 'error');
                    return;
                }
                this.puSetStatus('Silindi.', 'success');
                await this.puLoadRecent();
                window.dispatchEvent(new CustomEvent('products:updated'));
            } catch (err) {
                this.puSetStatus(this.getErrorMessage(err, 'Beklenmeyen hata.'), 'error');
            }
            return;
        }

        var msg = 'Bu fatura (' + inv.count + ' satır) silinsin mi? Ham madde maliyetleri yeniden hesaplanacak.';
        var okInv = window.confirm(msg);
        if (!okInv) return;

        var failC = 0, okC = 0, lastErrI = null;
        for (var ri = 0; ri < inv.items.length; ri++) {
            try {
                var rres = await window.SupabaseService.update('purchase_items', inv.items[ri].id, { is_deleted: true });
                if (rres && rres.error) { failC++; lastErrI = rres.error; }
                else { okC++; }
            } catch (err) { failC++; lastErrI = err; }
        }

        if (!this._isActive) return;
        if (failC > 0) {
            this.puSetStatus(okC + ' silindi, ' + failC + ' hata. ' + this.getErrorMessage(lastErrI, ''), 'error');
        } else {
            this.puSetStatus('Fatura silindi (' + okC + ' satır).', 'success');
        }
        await this.puLoadRecent();
        window.dispatchEvent(new CustomEvent('products:updated'));
    },

    puSetStatus: function (msg, type) {
        var el = document.getElementById('puStatus');
        if (!el) return;
        if (type === 'success') {
            el.innerHTML = '<div style="padding:12px 14px; border-radius:12px; background:#ecfdf5; border:1px solid #86efac; color:#166534; font-size:13px; font-weight:600;">' + this.escapeHtml(msg) + '</div>';
        } else {
            el.innerHTML = '<div style="padding:12px 14px; border-radius:12px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:13px; font-weight:600;">' + this.escapeHtml(msg) + '</div>';
        }
    },

    formatNumber: function (value) {
        var n = Number(value);
        if (!Number.isFinite(n)) return '0';
        return n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
    }
};
