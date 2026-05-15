/* ============================================================
   EXPENSES VIEW — Phase 3.7
   + daily / monthly summary toggle
   + custom date range stays visible after filtering
   + professional excel export
   ============================================================ */

window.ExpensesView = {
    container: null,
    categories: [],
    expenses: [],
    groupedMonthlyExpenses: [],
    filters: {
        mode: 'daily', // daily | monthly | custom
        startDate: '',
        endDate: ''
    },
    pendingDeleteId: null,
    toastTimer: null,
    _listeners: [],
    _isActive: false,
    _skeletonMounted: false,
    _lastFilterMode: null,
    _lastFilterDateBlockHash: null,

    // Aylik ciro/gider orani — null while loading, number (percent) when ready
    monthlyRatio: null,
    monthlyRatioLabel: '',
    _monthlyRatioKey: '',

    pagination: {
        page: 1,
        pageSize: 10,
        totalPages: 1,
        totalCount: 0,
        from: 0,
        to: 0
    },

    async render(container) {
        this._isActive = true;
        this.container = container;

        // === CACHE INVALIDATION HANDLER (sadece bir kez bağlanır) ===
        if (!this._cacheEventsBound) {
            this._cacheEventsBound = true;
            var self = this;
            window.addEventListener('expenses:updated', function () {
                if (window.ViewCache) {
                    window.ViewCache.invalidate('expenses-view:');
                }
            });
        }

        // === CACHE READ ===
        var tid = (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || '';
        var cacheKey = 'expenses-view:' + tid +
                       ':' + (this.filters.mode || 'daily') +
                       ':' + (this.filters.startDate || '') +
                       ':' + (this.filters.endDate || '') +
                       ':' + (this.pagination.page || 1);
        if (window.ViewCache) {
            var cached = window.ViewCache.get(cacheKey);
            if (cached) {
                this.categories = cached.categories || [];
                this.expenses = cached.expenses || [];
                this.groupedMonthlyExpenses = cached.groupedMonthlyExpenses || [];
                this.pagination = Object.assign({}, this.pagination, cached.pagination || {});
                try {
                    this.renderPage();
                    this.bindEvents();
                } catch (e) { /* render hatası varsa cache'i bypass eder */ }
                if (this.expenses.length || this.groupedMonthlyExpenses.length || this.categories.length) {
                    return;
                }
            }
        }

        container.innerHTML =
            '<div class="card">' +
                '<div class="card-header">' +
                    '<div class="card-title">Giderler yükleniyor</div>' +
                    '<div class="card-subtitle">Veriler hazırlanıyor...</div>' +
                '</div>' +
            '</div>';

        try {
            this.ensureDefaultFilterMode();
            await this.ensureDefaultCategories();
            if (!this._isActive) return;
            await this.loadCategories();
            if (!this._isActive) return;
            await this.loadExpenses();
            if (!this._isActive) return;
            this.renderPage();
            this.bindEvents();

            // Aylik ciro/gider orani — fire-and-forget, hazir olunca re-render
            this.loadMonthlyRatio();

            // === CACHE WRITE ===
            if (window.ViewCache) {
                window.ViewCache.set(cacheKey, {
                    categories: this.categories,
                    expenses: this.expenses,
                    groupedMonthlyExpenses: this.groupedMonthlyExpenses,
                    pagination: Object.assign({}, this.pagination)
                }, 60 * 1000); // 60s TTL
            }
        } catch (error) {
            console.error('ExpensesView render error:', error);

            container.innerHTML =
                '<div class="card">' +
                    '<div class="card-header">' +
                        '<div class="card-title">Gider ekranı yüklenemedi</div>' +
                        '<div class="card-subtitle">Lütfen console ekranını kontrol et.</div>' +
                    '</div>' +
                    '<div style="padding:16px;color:#DC2626;font-weight:600;">' +
                        this.escapeHtml(error && error.message ? error.message : 'Bilinmeyen hata') +
                    '</div>' +
                '</div>';
        }
    },

    async tenantId() {
        var supabase = this.client();

        var authRes = await supabase.auth.getUser();
        var user = authRes && authRes.data ? authRes.data.user : null;
        if (!user) {
            throw new Error('User yok');
        }

        var res = await supabase
            .from('users')
            .select('tenant_id')
            .eq('id', user.id)
            .single();

        if (res.error) {
            throw new Error(res.error.message || 'Tenant bulunamadı');
        }

        if (!res.data || !res.data.tenant_id) {
            throw new Error('Tenant bulunamadı');
        }

        return res.data.tenant_id;
    },

    tenantName() {
        return (
            window.STATE?.tenant?.name ||
            window.STATE?.user?.business_name ||
            window.STATE?.profile?.business_name ||
            'Firma Adı'
        );
    },

    client() {
        return window.SupabaseService.getClient();
    },

    todayISO() {
        return new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 10);
    },

    toISODate(date) {
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 10);
    },

    formatCurrency(amount) {
        if (window.Formatters && typeof window.Formatters.currency === 'function') {
            return window.Formatters.currency(amount);
        }
        return '₺' + Number(amount || 0).toLocaleString('tr-TR');
    },

    formatCurrencyExcel(amount) {
        return Number(amount || 0);
    },

    formatPercent(value) {
        return Number(value || 0).toFixed(1) + '%';
    },

    formatRatioForExcel(value) {
        return Number(value || 0) / 100;
    },

    /* ============================================================
       AYLIK CIRO / GIDER ORANI
       - Hangi ay? Mevcut filtreye göre:
           daily/custom → startDate'in ait olduğu ay
           monthly      → bugünün ait olduğu ay
       - Sales (is_deleted=false) toplam cirosu / Expenses toplamı
       - Display: "%35" + "Mayıs 2026" (örnek)
       ============================================================ */

    _getRatioMonthBounds() {
        var iso = this.filters.startDate || this.todayISO();
        var d   = new Date(iso + 'T00:00:00');
        if (isNaN(d.getTime())) d = new Date();
        var y = d.getFullYear();
        var m = d.getMonth(); // 0-based
        var first = new Date(y, m, 1);
        var last  = new Date(y, m + 1, 0);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        var fmt = function (dd) { return dd.getFullYear() + '-' + pad(dd.getMonth() + 1) + '-' + pad(dd.getDate()); };
        var monthNames = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                          'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
        return {
            start: fmt(first),
            end:   fmt(last),
            label: monthNames[m] + ' ' + y,
            key:   y + '-' + pad(m + 1)
        };
    },

    _getMonthlyRatioDisplay() {
        var b = this._getRatioMonthBounds();
        if (this.monthlyRatio === null) {
            return { value: '—', label: b.label };
        }
        return { value: '%' + Number(this.monthlyRatio).toFixed(1), label: b.label };
    },

    async loadMonthlyRatio() {
        var b = this._getRatioMonthBounds();

        // Aynı ay zaten yüklenmişse tekrar fetch yapma
        if (this._monthlyRatioKey === b.key && this.monthlyRatio !== null) return;

        this._monthlyRatioKey = b.key;
        // Önce reset (loading state)
        this.monthlyRatio = null;
        this.monthlyRatioLabel = b.label;

        try {
            var client = this.client();
            if (!client) return;

            var tenantId = await this.tenantId();
            if (!this._isActive) return;

            // Paralel fetch — sales total + expenses total (aylik)
            var salesP = client
                .from('sales')
                .select('total')
                .eq('tenant_id', tenantId)
                .eq('is_deleted', false)
                .gte('date', b.start)
                .lte('date', b.end);

            var expensesP = client
                .from('expenses')
                .select('amount')
                .eq('tenant_id', tenantId)
                .gte('date', b.start)
                .lte('date', b.end);

            var results = await Promise.all([salesP, expensesP]);
            if (!this._isActive) return;

            var salesRes = results[0];
            var expRes   = results[1];

            if (salesRes.error || expRes.error) return;

            var salesSum = (salesRes.data || []).reduce(function (s, r) { return s + Number(r.total || 0); }, 0);
            var expSum   = (expRes.data   || []).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);

            this.monthlyRatio = salesSum > 0 ? (expSum / salesSum) * 100 : 0;

            // Sadece ratio kart değeri tazelensin — full render gereksiz
            if (this._isActive && this._skeletonMounted) {
                var info = this._getMonthlyRatioDisplay();
                this._setText('exKpiValRatio', info.value);
                this._setText('exKpiSubRatio', info.label);
            }
        } catch (err) {
            // Sessiz fail — KPI "—" olarak kalir
            this.monthlyRatio = null;
        }
    },

    formatDate(value) {
        if (!value) return '-';
        try {
            return new Date(value).toLocaleDateString('tr-TR');
        } catch (e) {
            return value;
        }
    },

    formatMonthLabel(monthKey) {
        if (!monthKey) return '-';

        var parts = String(monthKey).split('-');
        var year = Number(parts[0]);
        var month = Number(parts[1]);

        var monthNames = [
            'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
            'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
        ];

        return (monthNames[month - 1] || monthKey) + ' ' + year;
    },

    escapeHtml(str) {
        return String(str || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    },

    showToast(message, type) {
        var toast = document.getElementById('expenseToast');
        var text = document.getElementById('expenseToastText');

        if (!toast || !text) return;

        text.textContent = message || '';

        var bg = '#0F172A';
        if (type === 'success') bg = '#16A34A';
        if (type === 'error') bg = '#DC2626';
        if (type === 'warning') bg = '#D97706';

        toast.style.background = bg;
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
        toast.style.pointerEvents = 'auto';

        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(function () {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            toast.style.pointerEvents = 'none';
        }, 2600);
    },

    openConfirmModal(id) {
        this.pendingDeleteId = id;
        var modal = document.getElementById('expenseConfirmModalOverlay');
        if (modal) modal.style.display = 'block';
    },

    closeConfirmModal() {
        this.pendingDeleteId = null;
        var modal = document.getElementById('expenseConfirmModalOverlay');
        if (modal) modal.style.display = 'none';
    },

    ensureDefaultFilterMode() {
        if (!this.filters) {
            this.filters = {
                mode: 'daily',
                startDate: '',
                endDate: ''
            };
        }

        if (!this.filters.mode) {
            this.filters.mode = 'daily';
        }

        if (this.filters.mode === 'daily') {
            var dailyRange = this.getTodayRange();
            this.filters.startDate = dailyRange.startDate;
            this.filters.endDate = dailyRange.endDate;
        }

        if (this.filters.mode === 'monthly') {
            this.filters.startDate = '';
            this.filters.endDate = '';
        }
    },

    getTodayRange() {
        var today = this.todayISO();
        return {
            startDate: today,
            endDate: today
        };
    },

    isDateFilterVisible() {
        return this.filters.mode === 'daily' || this.filters.mode === 'custom';
    },

    getActiveFilterLabel() {
        if (this.filters.mode === 'monthly') {
            return 'Aylık Özet';
        }

        if (this.filters.startDate && this.filters.endDate) {
            if (this.filters.startDate === this.filters.endDate) {
                return this.formatDate(this.filters.startDate);
            }
            return this.formatDate(this.filters.startDate) + ' - ' + this.formatDate(this.filters.endDate);
        }

        if (this.filters.startDate) {
            return this.formatDate(this.filters.startDate) + ' sonrası';
        }

        if (this.filters.endDate) {
            return this.formatDate(this.filters.endDate) + ' öncesi';
        }

        return 'Tüm Kayıtlar';
    },

    async applyPresetFilter(mode) {
        if (mode !== 'daily' && mode !== 'monthly') {
            return;
        }

        this.pagination.page = 1;

        if (mode === 'daily') {
            var dailyRange = this.getTodayRange();
            this.filters.mode = 'daily';
            this.filters.startDate = dailyRange.startDate;
            this.filters.endDate = dailyRange.endDate;
        }

        if (mode === 'monthly') {
            this.filters.mode = 'monthly';
            this.filters.startDate = '';
            this.filters.endDate = '';
        }

        await this.loadExpenses();
        if (!this._isActive) return;
        this._softUpdate();
        this.loadMonthlyRatio();
    },

    async ensureDefaultCategories() {
        var tenantId = await this.tenantId();

        var existing = await this.client()
            .from('categories')
            .select('id,name,type')
            .eq('tenant_id', tenantId)
            .eq('type', 'expense')
            .limit(1);

        if (existing.error) {
            throw new Error(existing.error.message || 'Kategoriler kontrol edilemedi');
        }

        if ((existing.data || []).length > 0) {
            return;
        }

        var defaults = [
            { name: 'Personel', color: '#EF4444', type: 'expense', sort_order: 1 },
            { name: 'Kira', color: '#8B5CF6', type: 'expense', sort_order: 2 },
            { name: 'Elektrik', color: '#F59E0B', type: 'expense', sort_order: 3 },
            { name: 'Malzeme', color: '#10B981', type: 'expense', sort_order: 4 },
            { name: 'Temizlik', color: '#06B6D4', type: 'expense', sort_order: 5 },
            { name: 'Diğer', color: '#64748B', type: 'expense', sort_order: 6 }
        ].map(function (item) {
            return {
                tenant_id: tenantId,
                name: item.name,
                color: item.color,
                type: item.type,
                sort_order: item.sort_order
            };
        });

        var inserted = await this.client()
            .from('categories')
            .insert(defaults);

        if (inserted.error) {
            throw new Error(inserted.error.message || 'Varsayılan kategoriler oluşturulamadı');
        }
    },

    async loadCategories() {
        var tenantId = await this.tenantId();
        var res = await this.client()
            .from('categories')
            .select('id,name,color,type,sort_order')
            .eq('tenant_id', tenantId)
            .eq('type', 'expense')
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });

        if (res.error) {
            throw new Error(res.error.message || 'Kategoriler alınamadı');
        }

        this.categories = res.data || [];
    },

    async loadExpenses() {
        if (this.filters.mode === 'monthly') {
            await this.loadMonthlyExpenses();
            return;
        }

        await this.loadDailyExpenses();
    },

    async loadDailyExpenses() {
        var startDate = this.filters.startDate || null;
        var endDate = this.filters.endDate || null;

        var res = await window.ExpensesService.getByDateRange(startDate, endDate, {
            ascending: false,
            page: this.pagination.page,
            pageSize: this.pagination.pageSize
        });

        this.expenses = res.data || [];
        this.groupedMonthlyExpenses = [];
        this.pagination.totalPages = Number(res.totalPages || 1);
        this.pagination.totalCount = Number(res.count || 0);
        this.pagination.from = Number(res.from || 0);
        this.pagination.to = Number(res.to || 0);

        if (this.pagination.totalPages < 1) {
            this.pagination.totalPages = 1;
        }
    },

    async loadMonthlyExpenses() {
        var result = await window.ExpensesService.getMonthlySummary(
            this.pagination.page,
            this.pagination.pageSize
        );

        var rows = result.data || [];
        this.expenses = [];
        this.groupedMonthlyExpenses = rows;

        var totalMonths = Number(result.count || 0);
        var totalPages = Math.max(1, Math.ceil(totalMonths / this.pagination.pageSize));

        if (this.pagination.page > totalPages) {
            this.pagination.page = totalPages;
        }

        this.pagination.totalPages = totalPages;
        this.pagination.totalCount = totalMonths;
        this.pagination.from = totalMonths === 0 ? 0 : ((this.pagination.page - 1) * this.pagination.pageSize) + 1;
        this.pagination.to = Math.min(this.pagination.page * this.pagination.pageSize, totalMonths);
    },

    groupExpensesByMonth(rows) {
        var groupedMap = {};

        (rows || []).forEach(function (row) {
            if (!row || !row.date) return;

            var monthKey = String(row.date).slice(0, 7);

            if (!groupedMap[monthKey]) {
                groupedMap[monthKey] = {
                    monthKey: monthKey,
                    totalAmount: 0,
                    recordCount: 0,
                    dailyTotalsMap: {}
                };
            }

            groupedMap[monthKey].totalAmount += Number(row.amount || 0);
            groupedMap[monthKey].recordCount += 1;

            var dayKey = row.date;
            if (!groupedMap[monthKey].dailyTotalsMap[dayKey]) {
                groupedMap[monthKey].dailyTotalsMap[dayKey] = {
                    date: dayKey,
                    totalAmount: 0,
                    recordCount: 0
                };
            }

            groupedMap[monthKey].dailyTotalsMap[dayKey].totalAmount += Number(row.amount || 0);
            groupedMap[monthKey].dailyTotalsMap[dayKey].recordCount += 1;
        });

        return Object.keys(groupedMap)
            .sort(function (a, b) {
                return a < b ? 1 : -1;
            })
            .map(function (monthKey) {
                var item = groupedMap[monthKey];
                item.dailyTotals = Object.keys(item.dailyTotalsMap)
                    .sort(function (a, b) {
                        return a > b ? 1 : -1;
                    })
                    .map(function (dayKey) {
                        return item.dailyTotalsMap[dayKey];
                    });

                delete item.dailyTotalsMap;
                return item;
            });
    },

    getVisibleTotalExpense() {
        if (this.filters.mode === 'monthly') {
            return (this.groupedMonthlyExpenses || []).reduce(function (sum, row) {
                return sum + Number(row.total || 0);
            }, 0);
        }

        return (this.expenses || []).reduce(function (sum, row) {
            return sum + Number(row.amount || 0);
        }, 0);
    },

    getVisibleExpenseCount() {
        if (this.filters.mode === 'monthly') {
            return (this.groupedMonthlyExpenses || []).length;
        }

        return (this.expenses || []).length;
    },

    getVisibleMonthlyRows() {
        return this.groupedMonthlyExpenses || [];
    },

    async fetchExportData(startDate, endDate) {
        var tenantId = await this.tenantId();
        var expenseRes = await this.client()
            .from('expenses')
            .select('date,amount')
            .eq('tenant_id', tenantId)
            .gte('date', startDate)
            .lte('date', endDate)
            .order('date', { ascending: true });

        if (expenseRes.error) {
            throw new Error(expenseRes.error.message || 'Excel için gider verileri alınamadı');
        }

        var salesRes = await this.client()
            .from('sales')
            .select('date,total')
            .eq('tenant_id', tenantId)
            .eq('is_deleted', false)
            .gte('date', startDate)
            .lte('date', endDate)
            .order('date', { ascending: true });

        if (salesRes.error) {
            throw new Error(salesRes.error.message || 'Excel için satış verileri alınamadı');
        }

        return {
            expenses: expenseRes.data || [],
            sales: salesRes.data || []
        };
    },

    buildExportSummaryRows(expenseRows, salesRows) {
        var expenseMap = {};
        var salesMap = {};
        var dateMap = {};

        (expenseRows || []).forEach(function (row) {
            if (!row || !row.date) return;
            dateMap[row.date] = true;
            expenseMap[row.date] = Number(expenseMap[row.date] || 0) + Number(row.amount || 0);
        });

        (salesRows || []).forEach(function (row) {
            if (!row || !row.date) return;
            dateMap[row.date] = true;
            salesMap[row.date] = Number(salesMap[row.date] || 0) + Number(row.total || 0);
        });

        return Object.keys(dateMap)
            .sort(function (a, b) { return a > b ? 1 : -1; })
            .map(function (date) {
                var expenseTotal = Number(expenseMap[date] || 0);
                var salesTotal = Number(salesMap[date] || 0);
                var ratio = salesTotal > 0 ? (expenseTotal / salesTotal) * 100 : 0;

                return {
                    date: date,
                    expenseTotal: expenseTotal,
                    salesTotal: salesTotal,
                    ratio: ratio
                };
            });
    },

    styleExcelCell(ws, cellRef, style) {
        if (!ws[cellRef]) return;
        ws[cellRef].s = style;
    },

    exportRowsToExcel(rows, totals, startDate, endDate) {
        if (typeof XLSX === 'undefined') {
            throw new Error('Excel kütüphanesi yüklenemedi');
        }

        var firmaAdi = this.tenantName();
        var tarihAraligi = this.formatDate(startDate) + ' - ' + this.formatDate(endDate);

        var aoa = [
            ['', '', 'GİDER RAPORU'],
            [],
            ['FİRMA ADI', firmaAdi],
            ['TARİH ARALIĞI', tarihAraligi],
            [],
            ['TARİH', 'GİDER TUTARI', 'CİRO ORANI']
        ];

        rows.forEach(function (row) {
            aoa.push([
                window.ExpensesView.formatDate(row.date),
                window.ExpensesView.formatCurrencyExcel(row.expenseTotal),
                window.ExpensesView.formatRatioForExcel(row.ratio)
            ]);
        });

        aoa.push([]);
        aoa.push([
            'ALT TOPLAM',
            window.ExpensesView.formatCurrencyExcel(totals.totalExpense),
            window.ExpensesView.formatRatioForExcel(totals.totalRatio)
        ]);

        var ws = XLSX.utils.aoa_to_sheet(aoa);

        ws['!cols'] = [
            { wch: 18 },
            { wch: 18 },
            { wch: 14 }
        ];

        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }
        ];

        var lastDataRowIndex = 5 + rows.length;
        var totalRowIndex = lastDataRowIndex + 2;

        if (!ws['A1']) ws['A1'] = { t: 's', v: 'GİDER RAPORU' };

        this.styleExcelCell(ws, 'A1', {
            font: { bold: true, sz: 16 },
            alignment: { horizontal: 'center', vertical: 'center' }
        });

        ['A3', 'A4'].forEach(function (ref) {
            if (ws[ref]) {
                ws[ref].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: 'D9E2F3' } },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                };
            }
        });

        ['B3', 'B4'].forEach(function (ref) {
            if (ws[ref]) {
                ws[ref].s = {
                    font: { bold: false },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                };
            }
        });

        ['A6', 'B6', 'C6'].forEach(function (ref) {
            if (ws[ref]) {
                ws[ref].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: 'FCE4D6' } },
                    alignment: { horizontal: 'center' },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                };
            }
        });

        for (var i = 7; i <= lastDataRowIndex + 1; i++) {
            ['A', 'B', 'C'].forEach(function (col) {
                var ref = col + i;
                if (ws[ref]) {
                    ws[ref].s = {
                        border: {
                            top: { style: 'thin', color: { rgb: 'BFBFBF' } },
                            bottom: { style: 'thin', color: { rgb: 'BFBFBF' } },
                            left: { style: 'thin', color: { rgb: 'BFBFBF' } },
                            right: { style: 'thin', color: { rgb: 'BFBFBF' } }
                        }
                    };
                }
            });
        }

        var totalRowRefA = 'A' + (totalRowIndex + 1);
        var totalRowRefB = 'B' + (totalRowIndex + 1);
        var totalRowRefC = 'C' + (totalRowIndex + 1);

        [totalRowRefA, totalRowRefB, totalRowRefC].forEach(function (ref) {
            if (ws[ref]) {
                ws[ref].s = {
                    font: { bold: true },
                    fill: { fgColor: { rgb: 'D9E2F3' } },
                    border: {
                        top: { style: 'thin', color: { rgb: '000000' } },
                        bottom: { style: 'thin', color: { rgb: '000000' } },
                        left: { style: 'thin', color: { rgb: '000000' } },
                        right: { style: 'thin', color: { rgb: '000000' } }
                    }
                };
            }
        });

        rows.forEach(function (_, idx) {
            var rowNumber = 7 + idx;
            var amountRef = 'B' + rowNumber;
            var ratioRef = 'C' + rowNumber;

            if (ws[amountRef]) {
                ws[amountRef].z = '#,##0.00';
            }
            if (ws[ratioRef]) {
                ws[ratioRef].z = '0.0%';
            }
        });

        if (ws[totalRowRefB]) {
            ws[totalRowRefB].z = '#,##0.00';
        }
        if (ws[totalRowRefC]) {
            ws[totalRowRefC].z = '0.0%';
        }

        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Gider Raporu');

        var fileName =
            'gider-raporu-' +
            String(startDate || '').replaceAll('-', '') +
            '-' +
            String(endDate || '').replaceAll('-', '') +
            '.xlsx';

        XLSX.writeFile(wb, fileName);
    },

    async handleExcelExport() {
        try {
            if (this.filters.mode === 'monthly') {
                this.showToast('Excel indirme aylık özet modunda değil, tarih aralığında çalışır', 'warning');
                return;
            }

            var startDate = this.filters.startDate || '';
            var endDate = this.filters.endDate || '';

            if (!startDate || !endDate) {
                this.showToast('Excel için başlangıç ve bitiş tarihi gerekli', 'warning');
                return;
            }

            if (startDate > endDate) {
                this.showToast('Başlangıç tarihi bitiş tarihinden büyük olamaz', 'warning');
                return;
            }

            var data = await this.fetchExportData(startDate, endDate);
            var rows = this.buildExportSummaryRows(data.expenses, data.sales);

            if (!rows.length) {
                this.showToast('Bu tarih aralığında indirilecek veri bulunamadı', 'warning');
                return;
            }

            var totalExpense = rows.reduce(function (sum, row) {
                return sum + Number(row.expenseTotal || 0);
            }, 0);

            var totalSales = rows.reduce(function (sum, row) {
                return sum + Number(row.salesTotal || 0);
            }, 0);

            var totalRatio = totalSales > 0 ? (totalExpense / totalSales) * 100 : 0;

            this.exportRowsToExcel(
                rows,
                {
                    totalExpense: totalExpense,
                    totalSales: totalSales,
                    totalRatio: totalRatio
                },
                startDate,
                endDate
            );

            this.showToast('Excel dosyası indirildi', 'success');
        } catch (error) {
            console.error(error);
            this.showToast(error.message || 'Excel oluşturulamadı', 'error');
        }
    },

    renderPage() {
        if (!this._isActive || !this.container) return;

        var totalExpense = this.getVisibleTotalExpense();
        var expenseCount = this.getVisibleExpenseCount();
        var activeFilterLabel = this.getActiveFilterLabel();

        var ratioInfo = this._getMonthlyRatioDisplay();
        this._lastFilterMode = this.filters.mode;

        this.container.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">' +
                '<div>' +
                    '<h1 style="margin:0;font-size:30px;font-weight:800;line-height:1.1;">Giderler</h1>' +
                    '<p style="margin:8px 0 0;color:#64748B;">Gider girişleri, kategori yönetimi ve dönemsel takip</p>' +
                '</div>' +
                '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
                    '<button id="openExpenseModalBtn" type="button" class="card-action-btn active" style="padding:12px 18px;font-weight:700;">+ Gider Ekle</button>' +
                '</div>' +
            '</div>' +

            // === KPI GRID (3 esit kart, premium finans hissi) ===
            '<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px;">' +

                // 1) TOPLAM GİDER — yeşil accent
                '<div class="card" style="border-top:3px solid #22C55E;display:flex;flex-direction:column;min-height:128px;box-shadow:0 1px 3px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.10);">' +
                    '<div style="padding:18px 20px;display:flex;flex-direction:column;flex:1;">' +
                        '<div style="font-size:11px;font-weight:800;color:#94A3B8;letter-spacing:.06em;text-transform:uppercase;">Toplam Gider</div>' +
                        '<div id="exKpiValTotal" style="margin-top:10px;font-size:30px;font-weight:800;color:#0F172A;letter-spacing:-0.02em;line-height:1.1;">' + this.formatCurrency(totalExpense) + '</div>' +
                        '<div id="exKpiSubTotal" style="margin-top:auto;padding-top:10px;font-size:12.5px;color:#64748B;font-weight:600;">' + this.escapeHtml(activeFilterLabel) + '</div>' +
                    '</div>' +
                '</div>' +

                // 2) GÖRÜNEN KAYIT — kırmızı accent
                '<div class="card" style="border-top:3px solid #EF4444;display:flex;flex-direction:column;min-height:128px;box-shadow:0 1px 3px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.10);">' +
                    '<div style="padding:18px 20px;display:flex;flex-direction:column;flex:1;">' +
                        '<div style="font-size:11px;font-weight:800;color:#94A3B8;letter-spacing:.06em;text-transform:uppercase;">Görünen Kayıt</div>' +
                        '<div id="exKpiValCount" style="margin-top:10px;font-size:30px;font-weight:800;color:#0F172A;letter-spacing:-0.02em;line-height:1.1;">' + Number(expenseCount).toLocaleString('tr-TR') + '</div>' +
                        '<div id="exKpiSubCount" style="margin-top:auto;padding-top:10px;font-size:12.5px;color:#64748B;font-weight:600;">' + (this.filters.mode === 'monthly' ? 'Ay özeti' : 'Sayfadaki gider') + '</div>' +
                    '</div>' +
                '</div>' +

                // 3) CİRO / GİDER ORANI — mavi accent (aylık)
                '<div class="card" style="border-top:3px solid #2563EB;display:flex;flex-direction:column;min-height:128px;box-shadow:0 1px 3px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.10);">' +
                    '<div style="padding:18px 20px;display:flex;flex-direction:column;flex:1;">' +
                        '<div style="font-size:11px;font-weight:800;color:#94A3B8;letter-spacing:.06em;text-transform:uppercase;">Ciro / Gider Oranı</div>' +
                        '<div id="exKpiValRatio" style="margin-top:10px;font-size:30px;font-weight:800;color:#0F172A;letter-spacing:-0.02em;line-height:1.1;">' + ratioInfo.value + '</div>' +
                        '<div id="exKpiSubRatio" style="margin-top:auto;padding-top:10px;font-size:12.5px;color:#64748B;font-weight:600;">' + this.escapeHtml(ratioInfo.label) + '</div>' +
                    '</div>' +
                '</div>' +

            '</div>' +

            '<style>' +
                '@media (max-width: 720px) {' +
                    '.expenses-page-kpi-grid, [style*="grid-template-columns:repeat(3,minmax(0,1fr))"]{grid-template-columns:1fr !important;}' +
                '}' +
            '</style>' +

            '<div class="card" style="margin-top:18px;">' +
                '<div class="card-header">' +
                    '<div>' +
                        '<div class="card-title">Gider Listesi</div>' +
                        '<div class="card-subtitle">Günlük kayıt veya aylık özet görünümü</div>' +
                    '</div>' +
                '</div>' +
                '<div style="padding:16px 18px 18px;">' +

                    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">' +
                        '<button id="expenseDailyToggleBtn" type="button" class="card-action-btn' + ((this.filters.mode === 'daily' || this.filters.mode === 'custom') ? ' active' : '') + '" style="padding:10px 16px;font-weight:700;">Günlük</button>' +
                        '<button id="expenseMonthlyToggleBtn" type="button" class="card-action-btn' + (this.filters.mode === 'monthly' ? ' active' : '') + '" style="padding:10px 16px;font-weight:700;">Aylık</button>' +
                        '<div id="exFilterChip" style="padding:10px 14px;border:1px solid #E2E8F0;border-radius:10px;background:#F8FAFC;color:#475569;font-size:13px;font-weight:600;">Aktif filtre: ' + this.escapeHtml(activeFilterLabel) + '</div>' +
                    '</div>' +

                    '<div id="exFilterRowHost">' + this._buildFilterRowHtml() + '</div>' +

                    '<div id="exTableHost" style="margin-top:16px;overflow:auto;">' +
                        (this.filters.mode === 'monthly' ? this.buildMonthlySummaryTable() : this.buildExpensesTable()) +
                    '</div>' +

                    '<div id="exPagFooter" style="margin-top:16px;">' + this._buildPaginationFooterHtml() + '</div>' +
                '</div>' +
            '</div>' +

            this.buildExpenseModal() +
            this.buildViewModal() +
            this.buildConfirmModal() +
            this.buildToast();

        this._skeletonMounted = true;
    },

    /* ============================================================
       PARTIAL DOM UPDATE HELPERS
       Filter / pagination / data degistiginde full innerHTML rebuild
       yerine sadece degisen alanlari guncelle. Modal/header/skeleton
       yeniden olusturulmaz → blink/flicker yok, focus kaybolmaz.
       ============================================================ */

    _buildFilterRowHtml() {
        if (this.isDateFilterVisible()) {
            return '<div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;align-items:end;">' +
                '<div>' +
                    '<label style="display:block;margin-bottom:6px;font-weight:600;">Başlangıç Tarihi</label>' +
                    '<input id="filterStartDate" type="date" value="' + this.escapeHtml(this.filters.startDate || '') + '" style="width:100%;padding:10px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                '</div>' +
                '<div>' +
                    '<label style="display:block;margin-bottom:6px;font-weight:600;">Bitiş Tarihi</label>' +
                    '<input id="filterEndDate" type="date" value="' + this.escapeHtml(this.filters.endDate || '') + '" style="width:100%;padding:10px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                '</div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                    '<button id="applyExpenseFilterBtn" type="button" class="card-action-btn active" style="height:42px;padding:0 16px;">Filtrele</button>' +
                    '<button id="resetExpenseFilterBtn" type="button" class="card-action-btn" style="height:42px;padding:0 16px;">Bugüne Dön</button>' +
                '</div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                    '<button id="expenseExcelExportBtn" type="button" class="card-action-btn" style="height:42px;padding:0 16px;font-weight:700;">Excel İndir</button>' +
                '</div>' +
            '</div>';
        }
        return '<div style="padding:12px 14px;border:1px solid #E2E8F0;border-radius:12px;background:#F8FAFC;color:#475569;font-size:14px;font-weight:600;">Aylık görünümde her satır bir ayı temsil eder. Görüntüle ile o aya ait günlük toplamlar açılır.</div>';
    },

    _buildPaginationFooterHtml() {
        return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                '<span style="font-size:14px;font-weight:600;color:#475569;">Sayfa başı</span>' +
                '<select id="expensePageSizeSelect" style="padding:10px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                    this.buildPageSizeOptions() +
                '</select>' +
                '<span style="font-size:14px;color:#64748B;">' + this.pagination.from + '-' + this.pagination.to + ' / ' + this.pagination.totalCount + ' kayıt</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                '<button id="expensePrevPageBtn" type="button" class="card-action-btn" ' + (this.pagination.page <= 1 ? 'disabled' : '') + ' style="padding:10px 14px;' + (this.pagination.page <= 1 ? 'opacity:.5;cursor:not-allowed;' : '') + '">Önceki</button>' +
                '<div style="padding:10px 14px;border:1px solid #E2E8F0;border-radius:10px;background:#F8FAFC;font-weight:700;color:#0F172A;">Sayfa ' + this.pagination.page + ' / ' + this.pagination.totalPages + '</div>' +
                '<button id="expenseNextPageBtn" type="button" class="card-action-btn" ' + (this.pagination.page >= this.pagination.totalPages ? 'disabled' : '') + ' style="padding:10px 14px;' + (this.pagination.page >= this.pagination.totalPages ? 'opacity:.5;cursor:not-allowed;' : '') + '">Sonraki</button>' +
            '</div>' +
        '</div>';
    },

    _setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    },

    _setHtml(id, html) {
        var el = document.getElementById(id);
        if (el) el.innerHTML = html;
    },

    _softUpdate() {
        if (!this._skeletonMounted || !this._isActive || !this.container) {
            // Skeleton yoksa first mount yap
            this.renderPage();
            this.bindEvents();
            return;
        }

        var totalExpense = this.getVisibleTotalExpense();
        var expenseCount = this.getVisibleExpenseCount();
        var activeFilterLabel = this.getActiveFilterLabel();
        var ratioInfo = this._getMonthlyRatioDisplay();

        // 1) KPI metinleri (text-only — repaint cüzi)
        this._setText('exKpiValTotal',  this.formatCurrency(totalExpense));
        this._setText('exKpiSubTotal',  activeFilterLabel);
        this._setText('exKpiValCount',  Number(expenseCount).toLocaleString('tr-TR'));
        this._setText('exKpiSubCount',  this.filters.mode === 'monthly' ? 'Ay özeti' : 'Sayfadaki gider');
        this._setText('exKpiValRatio',  ratioInfo.value);
        this._setText('exKpiSubRatio',  ratioInfo.label);

        // 2) Active filter chip
        this._setText('exFilterChip', 'Aktif filtre: ' + activeFilterLabel);

        // 3) Toggle button active class
        var dEl = document.getElementById('expenseDailyToggleBtn');
        var mEl = document.getElementById('expenseMonthlyToggleBtn');
        if (dEl) dEl.classList.toggle('active', (this.filters.mode === 'daily' || this.filters.mode === 'custom'));
        if (mEl) mEl.classList.toggle('active', this.filters.mode === 'monthly');

        // 4) Filter row (date inputs vs monthly hint) — sadece mode değiştiyse rebuild
        if (this._lastFilterMode !== this.filters.mode) {
            this._setHtml('exFilterRowHost', this._buildFilterRowHtml());
            this._bindFilterRowEvents();
            this._lastFilterMode = this.filters.mode;
        } else {
            // Aynı moddaysa sadece input value'ları senkronize et
            var sEl = document.getElementById('filterStartDate');
            var eEl = document.getElementById('filterEndDate');
            if (sEl && document.activeElement !== sEl) sEl.value = this.filters.startDate || '';
            if (eEl && document.activeElement !== eEl) eEl.value = this.filters.endDate || '';
        }

        // 5) Tablo (tbody + table komple)
        this._setHtml('exTableHost', this.filters.mode === 'monthly' ? this.buildMonthlySummaryTable() : this.buildExpensesTable());
        this._bindRowActions();

        // 6) Pagination footer
        this._setHtml('exPagFooter', this._buildPaginationFooterHtml());
        this._bindPaginationEvents();
    },

    _bindRowActions() {
        var self = this;
        document.querySelectorAll('.expense-view-btn').forEach(function (btn) {
            btn.onclick = function () { self.handleViewExpense(this.dataset.id); };
        });
        document.querySelectorAll('.expense-delete-btn').forEach(function (btn) {
            btn.onclick = function () { self.openConfirmModal(this.dataset.id); };
        });
        document.querySelectorAll('.expense-month-view-btn').forEach(function (btn) {
            btn.onclick = function () { self.handleViewMonth(this.dataset.month); };
        });
    },

    _bindFilterRowEvents() {
        var self = this;
        var apply  = document.getElementById('applyExpenseFilterBtn');
        var reset  = document.getElementById('resetExpenseFilterBtn');
        var excel  = document.getElementById('expenseExcelExportBtn');

        if (apply) apply.onclick = function () { self.pagination.page = 1; self.applyFilters(); };
        if (reset) reset.onclick = function () { self.pagination.page = 1; self.resetFilters(); };
        if (excel) excel.onclick = function () { self.handleExcelExport(); };
    },

    _bindPaginationEvents() {
        var self = this;
        var ps   = document.getElementById('expensePageSizeSelect');
        var prev = document.getElementById('expensePrevPageBtn');
        var next = document.getElementById('expenseNextPageBtn');

        if (ps) ps.onchange = async function () {
            self.pagination.pageSize = Number(this.value || 10);
            self.pagination.page = 1;
            await self.loadExpenses();
            if (!self._isActive) return;
            self._softUpdate();
        };
        if (prev) prev.onclick = async function () {
            if (self.pagination.page <= 1) return;
            self.pagination.page -= 1;
            await self.loadExpenses();
            if (!self._isActive) return;
            self._softUpdate();
        };
        if (next) next.onclick = async function () {
            if (self.pagination.page >= self.pagination.totalPages) return;
            self.pagination.page += 1;
            await self.loadExpenses();
            if (!self._isActive) return;
            self._softUpdate();
        };
    },

    buildPageSizeOptions() {
        var sizes = [10, 20, 30, 50];
        var current = Number(this.pagination.pageSize || 10);

        return sizes.map(function (size) {
            return '<option value="' + size + '"' + (size === current ? ' selected' : '') + '>' + size + '</option>';
        }).join('');
    },

    buildCategoryOptions() {
        var options = ['<option value="">Kategori seç</option>'];

        (this.categories || []).forEach(function (cat) {
            options.push(
                '<option value="' + String(cat.id) + '">' +
                    String(cat.name) +
                '</option>'
            );
        });

        return options.join('');
    },

    buildExpensesTable() {
        var rows = this.expenses || [];
        var total = this.getVisibleTotalExpense();
        var self = this;

        if (!rows.length) {
            return '<div style="padding:28px;text-align:center;color:#64748B;border:1px solid #E2E8F0;border-radius:14px;background:#fff;">Kayıt bulunamadı</div>';
        }

        return '' +
            '<table class="product-table">' +
                '<thead>' +
                    '<tr>' +
                        '<th>Tarih</th>' +
                        '<th>Kategori</th>' +
                        '<th>Açıklama</th>' +
                        '<th>Tutar</th>' +
                        '<th>Gider Oranı</th>' +
                        '<th>İşlem</th>' +
                    '</tr>' +
                '</thead>' +
                '<tbody>' +
                    rows.map(function (row) {
                        var ratio = total > 0 ? (Number(row.amount || 0) / total) * 100 : 0;
                        var categoryName = (row.categories && row.categories.name) ? row.categories.name : (row.category_name || 'Kategori yok');

                        return '' +
                            '<tr>' +
                                '<td>' + self.escapeHtml(self.formatDate(row.date)) + '</td>' +
                                '<td>' + self.escapeHtml(categoryName) + '</td>' +
                                '<td>' + self.escapeHtml(row.description || '-') + '</td>' +
                                '<td>' + self.escapeHtml(self.formatCurrency(row.amount)) + '</td>' +
                                '<td>' + self.escapeHtml(self.formatPercent(ratio)) + '</td>' +
                                '<td>' +
                                    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                                        '<button type="button" class="card-action-btn expense-view-btn" data-id="' + String(row.id) + '">Görüntüle</button>' +
                                        '<button type="button" class="card-action-btn expense-delete-btn" data-id="' + String(row.id) + '">Sil</button>' +
                                    '</div>' +
                                '</td>' +
                            '</tr>';
                    }).join('') +
                '</tbody>' +
            '</table>';
    },

    buildMonthlySummaryTable() {
        var rows = this.getVisibleMonthlyRows();
        var self = this;

        if (!rows.length) {
            return '<div style="padding:28px;text-align:center;color:#64748B;border:1px solid #E2E8F0;border-radius:14px;background:#fff;">Aylık özet bulunamadı</div>';
        }

        return '' +
            '<table class="product-table">' +
                '<thead>' +
                    '<tr>' +
                        '<th>Ay</th>' +
                        '<th>Toplam Gider</th>' +
                        '<th>Kayıt Sayısı</th>' +
                        '<th>İşlem</th>' +
                    '</tr>' +
                '</thead>' +
                '<tbody>' +
                    rows.map(function (row) {
                        return '' +
                            '<tr>' +
                                '<td>' + self.escapeHtml(self.formatMonthLabel(row.month)) + '</td>' +
                                '<td>' + self.escapeHtml(self.formatCurrency(row.total)) + '</td>' +
                                '<td>' + Number(row.count || 0).toLocaleString('tr-TR') + '</td>' +
                                '<td>' +
                                    '<button type="button" class="card-action-btn expense-month-view-btn" data-month="' + self.escapeHtml(row.month) + '">Görüntüle</button>' +
                                '</td>' +
                            '</tr>';
                    }).join('') +
                '</tbody>' +
            '</table>';
    },

    buildExpenseModal() {
        return '' +
            '<div id="expenseModalOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:1000;padding:24px;overflow:auto;">' +
                '<div style="max-width:920px;margin:40px auto;background:#fff;border-radius:20px;box-shadow:0 25px 80px rgba(15,23,42,.18);overflow:hidden;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid #E2E8F0;">' +
                        '<div>' +
                            '<div style="font-size:20px;font-weight:800;color:#0F172A;">Yeni Gider Ekle</div>' +
                            '<div style="margin-top:4px;font-size:14px;color:#64748B;">Kategori yoksa aynı ekranda ekleyebilirsin</div>' +
                        '</div>' +
                        '<button id="closeExpenseModalBtn" type="button" style="border:none;background:#F1F5F9;color:#334155;border-radius:10px;padding:10px 12px;cursor:pointer;font-weight:700;">Kapat</button>' +
                    '</div>' +

                    '<div style="padding:20px 22px 22px;">' +
                        '<form id="expenseForm">' +
                            '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;">' +
                                '<div>' +
                                    '<label style="display:block;margin-bottom:6px;font-weight:600;">Tarih</label>' +
                                    '<input id="expenseDate" type="date" value="' + this.todayISO() + '" style="width:100%;padding:11px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                                '</div>' +
                                '<div>' +
                                    '<label style="display:block;margin-bottom:6px;font-weight:600;">Kategori</label>' +
                                    '<select id="expenseCategory" style="width:100%;padding:11px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                                        this.buildCategoryOptions() +
                                    '</select>' +
                                '</div>' +
                            '</div>' +

                            '<div style="display:grid;grid-template-columns:1fr auto;gap:12px;margin-top:14px;align-items:end;">' +
                                '<div>' +
                                    '<label style="display:block;margin-bottom:6px;font-weight:600;">Açıklama</label>' +
                                    '<input id="expenseDescription" type="text" placeholder="Gider açıklaması" style="width:100%;padding:11px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                                '</div>' +
                                '<div>' +
                                    '<label style="display:block;margin-bottom:6px;font-weight:600;">Ödenen Tutar (KDV Dahil, ₺)</label>' +
                                    '<input id="expenseAmount" type="number" min="0" step="0.01" placeholder="0.00" style="width:220px;max-width:100%;padding:11px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                                '</div>' +
                            '</div>' +

                            '<div style="margin-top:16px;padding:14px;border:1px dashed #CBD5E1;border-radius:14px;background:#F8FAFC;">' +
                                '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
                                    '<div>' +
                                        '<div style="font-size:15px;font-weight:700;color:#0F172A;">Yeni Kategori</div>' +
                                        '<div style="margin-top:4px;font-size:13px;color:#64748B;">Listeye yeni gider kategorisi ekle</div>' +
                                    '</div>' +
                                    '<button id="toggleCategoryFormBtn" type="button" class="card-action-btn" style="padding:10px 14px;">+ Kategori Ekle</button>' +
                                '</div>' +

                                '<div id="newCategoryPanel" style="display:none;margin-top:14px;">' +
                                    '<div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;">' +
                                        '<div>' +
                                            '<label style="display:block;margin-bottom:6px;font-weight:600;">Yeni Kategori Adı</label>' +
                                            '<input id="newCategoryName" type="text" placeholder="Örn: Doğalgaz" style="width:100%;padding:11px 12px;border:1px solid #D9E1EC;border-radius:10px;background:#fff;">' +
                                        '</div>' +
                                        '<button id="createCategoryBtn" type="button" class="card-action-btn active" style="height:44px;padding:0 16px;">Kaydet</button>' +
                                    '</div>' +
                                    /* Bug-fix: manuel color picker kaldirildi. Renk auto-assign:
                                       kategori adi hash → 12-renk semantic palette (deterministic). */
                                    '<div style="margin-top:8px;font-size:12px;color:#64748B;font-weight:500;">Renk otomatik atanır.</div>' +
                                '</div>' +
                            '</div>' +

                            '<div style="margin-top:18px;display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">' +
                                '<button id="resetExpenseFormBtn" type="button" class="card-action-btn" style="padding:10px 14px;">Temizle</button>' +
                                '<button id="saveExpenseBtn" type="submit" class="card-action-btn active" style="padding:10px 16px;font-weight:700;">Gider Ekle</button>' +
                            '</div>' +
                        '</form>' +
                    '</div>' +
                '</div>' +
            '</div>';
    },

    buildViewModal() {
        return '' +
            '<div id="expenseViewModalOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:1001;padding:24px;overflow:auto;">' +
                '<div style="max-width:680px;margin:70px auto;background:#fff;border-radius:20px;box-shadow:0 25px 80px rgba(15,23,42,.18);overflow:hidden;">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid #E2E8F0;">' +
                        '<div>' +
                            '<div style="font-size:20px;font-weight:800;color:#0F172A;">Gider Detayı</div>' +
                            '<div style="margin-top:4px;font-size:14px;color:#64748B;">Seçilen kayıt bilgileri</div>' +
                        '</div>' +
                        '<button id="closeExpenseViewModalBtn" type="button" style="border:none;background:#F1F5F9;color:#334155;border-radius:10px;padding:10px 12px;cursor:pointer;font-weight:700;">Kapat</button>' +
                    '</div>' +
                    '<div id="expenseViewModalContent" style="padding:22px;"></div>' +
                '</div>' +
            '</div>';
    },

    buildConfirmModal() {
        return '' +
            '<div id="expenseConfirmModalOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:1002;padding:24px;overflow:auto;">' +
                '<div style="max-width:460px;margin:120px auto;background:#fff;border-radius:20px;box-shadow:0 25px 80px rgba(15,23,42,.18);overflow:hidden;">' +
                    '<div style="padding:22px;border-bottom:1px solid #E2E8F0;">' +
                        '<div style="font-size:20px;font-weight:800;color:#0F172A;">Gider Kaydını Sil</div>' +
                        '<div style="margin-top:8px;font-size:14px;color:#64748B;line-height:1.5;">Bu kayıt silinecek. İşlem geri alınamaz.</div>' +
                    '</div>' +
                    '<div style="padding:18px 22px;display:flex;justify-content:flex-end;gap:10px;">' +
                        '<button id="cancelDeleteExpenseBtn" type="button" class="card-action-btn" style="padding:10px 16px;">Vazgeç</button>' +
                        '<button id="confirmDeleteExpenseBtn" type="button" class="card-action-btn active" style="padding:10px 16px;background:#DC2626;border-color:#DC2626;">Sil</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
    },

    buildToast() {
        return '' +
            '<div id="expenseToast" style="position:fixed;right:24px;bottom:24px;z-index:1100;min-width:260px;max-width:420px;padding:14px 16px;border-radius:14px;color:#fff;font-weight:700;box-shadow:0 18px 50px rgba(15,23,42,.18);opacity:0;transform:translateY(10px);pointer-events:none;transition:all .22s ease;">' +
                '<div id="expenseToastText"></div>' +
            '</div>';
    },

    _on(el, event, fn) {
        if (!el) return;
        el.addEventListener(event, fn);
        this._listeners.push({ el: el, event: event, fn: fn });
    },

    _removeAllListeners() {
        (this._listeners || []).forEach(function (h) {
            h.el.removeEventListener(h.event, h.fn);
        });
        this._listeners = [];
    },

    bindEvents() {
        if (!this._isActive || !this.container) return;

        var self = this;

        this._removeAllListeners();

        this._on(document.getElementById('openExpenseModalBtn'), 'click', function () {
            self.openExpenseModal();
        });

        this._on(document.getElementById('closeExpenseModalBtn'), 'click', function () {
            self.closeExpenseModal();
        });

        var expenseModalOverlay = document.getElementById('expenseModalOverlay');
        this._on(expenseModalOverlay, 'click', function (e) {
            if (e.target === expenseModalOverlay) self.closeExpenseModal();
        });

        this._on(document.getElementById('expenseForm'), 'submit', async function (e) {
            e.preventDefault();
            await self.handleCreateExpense();
        });

        this._on(document.getElementById('toggleCategoryFormBtn'), 'click', function () {
            self.toggleCategoryPanel();
        });

        this._on(document.getElementById('createCategoryBtn'), 'click', async function () {
            await self.handleCreateCategory();
        });

        this._on(document.getElementById('resetExpenseFormBtn'), 'click', function () {
            self.resetExpenseForm();
        });

        this._on(document.getElementById('expenseDailyToggleBtn'), 'click', async function () {
            await self.applyPresetFilter('daily');
        });

        this._on(document.getElementById('expenseMonthlyToggleBtn'), 'click', async function () {
            await self.applyPresetFilter('monthly');
        });

        this._on(document.getElementById('applyExpenseFilterBtn'), 'click', async function () {
            self.pagination.page = 1;
            await self.applyFilters();
        });

        this._on(document.getElementById('resetExpenseFilterBtn'), 'click', async function () {
            self.pagination.page = 1;
            await self.resetFilters();
        });

        this._on(document.getElementById('expenseExcelExportBtn'), 'click', async function () {
            await self.handleExcelExport();
        });

        this._on(document.getElementById('expensePageSizeSelect'), 'change', async function () {
            self.pagination.pageSize = Number(this.value || 10);
            self.pagination.page = 1;
            await self.loadExpenses();
            if (!self._isActive) return;
            self._softUpdate();
        });

        this._on(document.getElementById('expensePrevPageBtn'), 'click', async function () {
            if (self.pagination.page <= 1) return;
            self.pagination.page -= 1;
            await self.loadExpenses();
            if (!self._isActive) return;
            self._softUpdate();
        });

        this._on(document.getElementById('expenseNextPageBtn'), 'click', async function () {
            if (self.pagination.page >= self.pagination.totalPages) return;
            self.pagination.page += 1;
            await self.loadExpenses();
            if (!self._isActive) return;
            self._softUpdate();
        });

        this._on(document.getElementById('closeExpenseViewModalBtn'), 'click', function () {
            self.closeViewModal();
        });

        var expenseViewModalOverlay = document.getElementById('expenseViewModalOverlay');
        this._on(expenseViewModalOverlay, 'click', function (e) {
            if (e.target === expenseViewModalOverlay) self.closeViewModal();
        });

        this._on(document.getElementById('cancelDeleteExpenseBtn'), 'click', function () {
            self.closeConfirmModal();
        });

        this._on(document.getElementById('confirmDeleteExpenseBtn'), 'click', async function () {
            await self.confirmDeleteExpense();
        });

        var expenseConfirmModalOverlay = document.getElementById('expenseConfirmModalOverlay');
        this._on(expenseConfirmModalOverlay, 'click', function (e) {
            if (e.target === expenseConfirmModalOverlay) self.closeConfirmModal();
        });

        document.querySelectorAll('.expense-view-btn').forEach(function (btn) {
            self._on(btn, 'click', function () {
                self.handleViewExpense(this.dataset.id);
            });
        });

        document.querySelectorAll('.expense-delete-btn').forEach(function (btn) {
            self._on(btn, 'click', function () {
                self.openConfirmModal(this.dataset.id);
            });
        });

        document.querySelectorAll('.expense-month-view-btn').forEach(function (btn) {
            self._on(btn, 'click', function () {
                self.handleViewMonth(this.dataset.month);
            });
        });
    },

    openExpenseModal() {
        var modal = document.getElementById('expenseModalOverlay');
        if (modal) modal.style.display = 'block';
    },

    closeExpenseModal() {
        var modal = document.getElementById('expenseModalOverlay');
        if (modal) modal.style.display = 'none';
    },

    openViewModal(html) {
        var modal = document.getElementById('expenseViewModalOverlay');
        var content = document.getElementById('expenseViewModalContent');

        if (content) content.innerHTML = html;
        if (modal) modal.style.display = 'block';
    },

    closeViewModal() {
        var modal = document.getElementById('expenseViewModalOverlay');
        if (modal) modal.style.display = 'none';
    },

    toggleCategoryPanel() {
        var panel = document.getElementById('newCategoryPanel');
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'block' : 'none';
    },

    async handleCreateCategory() {
        try {
            var nameEl = document.getElementById('newCategoryName');
            var selectEl = document.getElementById('expenseCategory');

            var name = nameEl ? String(nameEl.value || '').trim() : '';
            // Bug-fix: manuel picker yerine deterministic auto-assign (kategori adi hash).
            var color = this.autoCategoryColor(name);

            if (!name) {
                this.showToast('Kategori adı gerekli', 'warning');
                return;
            }

            var duplicate = (this.categories || []).find(function (cat) {
                return String(cat.name || '').trim().toLowerCase() === name.toLowerCase();
            });

            if (duplicate) {
                if (selectEl) selectEl.value = duplicate.id;
                this.showToast('Bu kategori zaten mevcut', 'warning');
                return;
            }

            var maxSort = (this.categories || []).reduce(function (max, item) {
                return Math.max(max, Number(item.sort_order || 0));
            }, 0);

            var tenantId = await this.tenantId();
            var inserted = await this.client()
                .from('categories')
                .insert({
                    tenant_id: tenantId,
                    name: name,
                    color: color,
                    type: 'expense',
                    sort_order: maxSort + 1
                })
                .select('id,name,color,type,sort_order')
                .single();

            if (inserted.error) {
                throw new Error(inserted.error.message || 'Kategori oluşturulamadı');
            }

            this.categories.push(inserted.data);
            this.categories.sort(function (a, b) {
                return Number(a.sort_order || 0) - Number(b.sort_order || 0);
            });

            if (selectEl) {
                selectEl.innerHTML = this.buildCategoryOptions();
                selectEl.value = inserted.data.id;
            }

            if (nameEl) nameEl.value = '';
            if (colorEl) colorEl.value = '#64748B';

            var panel = document.getElementById('newCategoryPanel');
            if (panel) panel.style.display = 'none';

            this.showToast('Kategori oluşturuldu', 'success');
        } catch (error) {
            console.error(error);
            this.showToast(error.message || 'Kategori oluşturulamadı', 'error');
        }
    },

    async handleCreateExpense() {
        try {
            var dateEl = document.getElementById('expenseDate');
            var amountEl = document.getElementById('expenseAmount');
            var categoryEl = document.getElementById('expenseCategory');
            var descriptionEl = document.getElementById('expenseDescription');

            var date = dateEl ? dateEl.value : '';
            var amount = amountEl ? Number(amountEl.value || 0) : 0;
            var categoryId = categoryEl ? categoryEl.value : '';
            var description = descriptionEl ? String(descriptionEl.value || '').trim() : '';

            if (!date) {
                this.showToast('Tarih gerekli', 'warning');
                return;
            }

            if (!amount || amount <= 0) {
                this.showToast('Tutar 0’dan büyük olmalı', 'warning');
                return;
            }

            if (!categoryId) {
                this.showToast('Kategori seçmelisin', 'warning');
                return;
            }

            var selectedCategory = (this.categories || []).find(function (c) { return c.id === categoryId; });
            var categoryName = selectedCategory ? selectedCategory.name : null;

            var saveResult = await window.ExpensesService.create({
                date: date,
                amount: amount,
                category_id: categoryId,
                category_name: categoryName,
                description: description
            });

            if (!this._isActive) return;

            // RPC duplicate dondurduyse kullaniciyi uyar, formu KAPATMA
            if (saveResult && saveResult.duplicate) {
                this.showToast(saveResult.message || 'Aynı gider zaten kayıtlı. Yeni kayıt eklenmedi.', 'error');
                return;
            }

            this.resetExpenseForm();
            this.closeExpenseModal();
            this.pagination.page = 1;

            await this.loadExpenses();
            if (!this._isActive) return;
            this._softUpdate();

            // Yeni gider eklendi → aylik ratio yeniden hesaplansin
            this._monthlyRatioKey = '';
            this.loadMonthlyRatio();

            if (window.AnalyticsService && typeof window.AnalyticsService.getDashboardAnalytics === 'function') {
                window.STATE.dashboardData = null;
            }

            this.showToast('Gider kaydedildi', 'success');
        } catch (error) {
            console.error(error);
            this.showToast(error.message || 'Gider kaydedilemedi', 'error');
        }
    },

    async applyFilters() {
        var startEl = document.getElementById('filterStartDate');
        var endEl = document.getElementById('filterEndDate');

        this.filters.startDate = startEl ? String(startEl.value || '').trim() : '';
        this.filters.endDate = endEl ? String(endEl.value || '').trim() : '';
        this.filters.mode = 'custom';

        if (!this.filters.startDate || !this.filters.endDate) {
            this.showToast('Başlangıç ve bitiş tarihi gerekli', 'warning');
            return;
        }

        if (this.filters.startDate > this.filters.endDate) {
            this.showToast('Başlangıç tarihi bitiş tarihinden büyük olamaz', 'warning');
            return;
        }

        await this.loadExpenses();
        if (!this._isActive) return;
        this._softUpdate();
        this.loadMonthlyRatio();
    },

    async resetFilters() {
        var dailyRange = this.getTodayRange();

        this.filters.mode = 'daily';
        this.filters.startDate = dailyRange.startDate;
        this.filters.endDate = dailyRange.endDate;

        await this.loadExpenses();
        if (!this._isActive) return;
        this._softUpdate();
        this.loadMonthlyRatio();
    },

    resetExpenseForm() {
        var dateEl = document.getElementById('expenseDate');
        var amountEl = document.getElementById('expenseAmount');
        var categoryEl = document.getElementById('expenseCategory');
        var descriptionEl = document.getElementById('expenseDescription');
        var nameEl = document.getElementById('newCategoryName');
        var panel = document.getElementById('newCategoryPanel');

        if (dateEl) dateEl.value = this.todayISO();
        if (amountEl) amountEl.value = '';
        if (categoryEl) categoryEl.value = '';
        if (descriptionEl) descriptionEl.value = '';
        if (nameEl) nameEl.value = '';
        // Bug-fix: colorEl artik DOM'da yok (auto-color); reset gerekmez.
        if (panel) panel.style.display = 'none';
    },

    /* ============================================================
       autoCategoryColor — semantic 12-renk palette + hash mapping.
       Ayni kategori adi her zaman ayni rengi alir (cross-tenant tutarli).
       Manuel picker UX friction'i ve random renk seciminin "themed dashboard"
       riskini elimine eder.
       ============================================================ */
    _expensePalette: [
        '#10B981', '#06B6D4', '#F43F5E', '#84CC16',
        '#F59E0B', '#3B82F6', '#8B5CF6', '#EC4899',
        '#0EA5E9', '#22C55E', '#A855F7', '#14B8A6'
    ],

    autoCategoryColor(name) {
        var s = String(name || '').trim();
        if (!s) return '#64748B';
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = (h * 31 + s.charCodeAt(i)) | 0;
        }
        var idx = Math.abs(h) % this._expensePalette.length;
        return this._expensePalette[idx];
    },

    handleViewExpense(id) {
        var row = (this.expenses || []).find(function (item) {
            return String(item.id) === String(id);
        });

        if (!row) {
            this.showToast('Kayıt bulunamadı', 'error');
            return;
        }

        var categoryName = (row.categories && row.categories.name) ? row.categories.name : (row.category_name || 'Kategori yok');

        var html =
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">' +
                '<div style="padding:14px;border:1px solid #E2E8F0;border-radius:14px;background:#F8FAFC;">' +
                    '<div style="font-size:12px;font-weight:700;color:#64748B;">TARİH</div>' +
                    '<div style="margin-top:6px;font-size:17px;font-weight:700;color:#0F172A;">' + this.escapeHtml(this.formatDate(row.date)) + '</div>' +
                '</div>' +
                '<div style="padding:14px;border:1px solid #E2E8F0;border-radius:14px;background:#F8FAFC;">' +
                    '<div style="font-size:12px;font-weight:700;color:#64748B;">KATEGORİ</div>' +
                    '<div style="margin-top:6px;font-size:17px;font-weight:700;color:#0F172A;">' + this.escapeHtml(categoryName) + '</div>' +
                '</div>' +
                '<div style="padding:14px;border:1px solid #E2E8F0;border-radius:14px;background:#F8FAFC;grid-column:1 / -1;">' +
                    '<div style="font-size:12px;font-weight:700;color:#64748B;">AÇIKLAMA</div>' +
                    '<div style="margin-top:6px;font-size:16px;font-weight:600;color:#0F172A;">' + this.escapeHtml(row.description || '-') + '</div>' +
                '</div>' +
                '<div style="padding:14px;border:1px solid #E2E8F0;border-radius:14px;background:#F8FAFC;grid-column:1 / -1;">' +
                    '<div style="font-size:12px;font-weight:700;color:#64748B;">ÖDENEN TUTAR (KDV DAHİL)</div>' +
                    '<div style="margin-top:6px;font-size:24px;font-weight:800;color:#16A34A;">' + this.escapeHtml(this.formatCurrency(row.amount)) + '</div>' +
                '</div>' +
            '</div>';

        this.openViewModal(html);
    },

    handleViewMonth(monthKey) {
        var row = (this.groupedMonthlyExpenses || []).find(function (item) {
            return String(item.month) === String(monthKey);
        });

        if (!row) {
            this.showToast('Ay özeti bulunamadı', 'error');
            return;
        }

        var html =
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">' +
                '<div style="padding:14px;border:1px solid #E2E8F0;border-radius:14px;background:#F8FAFC;">' +
                    '<div style="font-size:12px;font-weight:700;color:#64748B;">AY</div>' +
                    '<div style="margin-top:6px;font-size:18px;font-weight:800;color:#0F172A;">' + this.escapeHtml(this.formatMonthLabel(row.month)) + '</div>' +
                '</div>' +
                '<div style="padding:14px;border:1px solid #E2E8F0;border-radius:14px;background:#F8FAFC;">' +
                    '<div style="font-size:12px;font-weight:700;color:#64748B;">TOPLAM GİDER</div>' +
                    '<div style="margin-top:6px;font-size:24px;font-weight:800;color:#16A34A;">' + this.escapeHtml(this.formatCurrency(row.total)) + '</div>' +
                '</div>' +
            '</div>';

        this.openViewModal(html);
    },

    destroy() {
        this._isActive = false;
        this._removeAllListeners();
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
            this.toastTimer = null;
        }
        this.container = null;
        this.expenses = [];
        this.groupedMonthlyExpenses = [];
        this.pendingDeleteId = null;
    },

    async confirmDeleteExpense() {
        if (!this.pendingDeleteId) return;

        try {
            var result = await window.ExpensesService.remove(this.pendingDeleteId);

            if (result && result.error) {
                this.showToast('Gider kaydı silinemedi', 'error');
                return;
            }

            this.closeConfirmModal();

            if (this.filters.mode !== 'monthly' && this.expenses.length === 1 && this.pagination.page > 1) {
                this.pagination.page -= 1;
            }

            await this.loadExpenses();
            if (!this._isActive) return;
            this._softUpdate();

            // Silme sonrası ratio yenile
            this._monthlyRatioKey = '';
            this.loadMonthlyRatio();

            if (window.AnalyticsService && typeof window.AnalyticsService.getDashboardAnalytics === 'function') {
                window.STATE.dashboardData = null;
            }

            this.showToast('Gider kaydı silindi', 'success');
        } catch (error) {
            console.error(error);
            this.showToast(error.message || 'Gider kaydı silinemedi', 'error');
        }
    }
};
