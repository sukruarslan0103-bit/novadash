/* ============================================================
   services/analytics.js
   Dashboard Analytics Engine
   Tüm dashboard hesapları tek merkezden üretilir.
   alerts, analysis, healthScore dahil.
   ============================================================ */

window.AnalyticsService = {

    client() {
        return window.SupabaseService.getClient();
    },

    tenantId() {
        if (!window.STATE || !window.STATE.tenant || !window.STATE.tenant.id) {
            throw new Error('Tenant bulunamadı');
        }
        return window.STATE.tenant.id;
    },

    assertResponse(res, fallbackMessage) {
        if (!res) {
            throw new Error(fallbackMessage || 'Boş sunucu yanıtı alındı');
        }

        if (res.error) {
            throw new Error(res.error.message || fallbackMessage || 'Veri alınırken hata oluştu');
        }

        return res;
    },

    iso(date) {
        var y = date.getFullYear();
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    },

    today() {
        return this.iso(new Date());
    },

    yesterday() {
        var d = new Date();
        d.setDate(d.getDate() - 1);
        return this.iso(d);
    },

    monthStart(date) {
        return this.iso(new Date(date.getFullYear(), date.getMonth(), 1));
    },

    monthEnd(date) {
        return this.iso(new Date(date.getFullYear(), date.getMonth() + 1, 0));
    },

    /* ============================================================
       DATA FETCH
    ============================================================ */

    async getMonthlySalesRange(start, end) {
        var res = await this.client()
            .from('sales')
            .select('id,date,total,cash,card')
            .eq('tenant_id', this.tenantId())
            .eq('is_deleted', false)
            .gte('date', start)
            .lte('date', end)
            .order('date', { ascending: true });

        return this.assertResponse(res, 'Aylık satış verisi alınamadı');
    },

    async getMonthlyExpensesRange(start, end) {
        var res = await this.client()
            .from('expenses')
            .select('date,amount,category_id,categories(name,color,type)')
            .eq('tenant_id', this.tenantId())
            .gte('date', start)
            .lte('date', end)
            .order('date', { ascending: true });

        return this.assertResponse(res, 'Aylık gider verisi alınamadı');
    },

    async getProductSalesRange(start, end) {
        var res = await this.client()
            .from('product_sales')
            .select('date,product_id,quantity,total,cost,sale_id')
            .eq('tenant_id', this.tenantId())
            .not('sale_id', 'is', null)
            .gte('date', start)
            .lte('date', end);

        return this.assertResponse(res, 'Ürün satış verisi alınamadı');
    },

    /**
     * Aktif (is_deleted=false) satışların ID setini döndürür.
     * product_sales filtrelemesinde kullanılır.
     */
    async getActiveSaleIds(start, end) {
        var res = await this.client()
            .from('sales')
            .select('id')
            .eq('tenant_id', this.tenantId())
            .eq('is_deleted', false)
            .gte('date', start)
            .lte('date', end);

        this.assertResponse(res, 'Aktif satış ID listesi alınamadı');

        var ids = {};
        (res.data || []).forEach(function (s) { ids[s.id] = true; });
        return ids;
    },

    /**
     * product_sales satırlarını aktif satışlara göre filtreler.
     */
    filterByActiveSales(rows, activeSaleIds) {
        return (rows || []).filter(function (r) {
            return r.sale_id && activeSaleIds[r.sale_id];
        });
    },

    async getProductPerformanceSummary(start, end) {
        var query = this.client()
            .from('product_sales')
            .select('date,product_id,quantity,total,cost,sale_id,products(name,price,category_id,is_active)')
            .eq('tenant_id', this.tenantId())
            .not('sale_id', 'is', null)
            .order('date', { ascending: false });

        if (start) {
            query = query.gte('date', start);
        }

        if (end) {
            query = query.lte('date', end);
        }

        var res = await query;
        this.assertResponse(res, 'Ürün performans verisi alınamadı');

        // Aktif satış ID'lerini çek ve filtrele
        var activeSaleIds = await this.getActiveSaleIds(
            start || '2000-01-01',
            end || '2099-12-31'
        );
        var filtered = this.filterByActiveSales(res.data || [], activeSaleIds);

        return this.groupProductPerformance(filtered);
    },

    /**
     * product_sales satırlarını ürün bazında gruplar.
     * getProductPerformanceSummary tarafından kullanılır.
     */
    groupProductPerformance(rows) {
        var grouped = {};
        var self = this;

        (rows || []).forEach(function (row) {
            var productId = row && row.product_id ? String(row.product_id) : '_deleted';

            var product = row.products || {};
            var qty = Number(row.quantity || 0);
            var revenue = Number(row.total || 0);
            var lineCost = self.rowCost(row);
            var price = Number(product.price || 0);
            var name = product.name || (row.product_id ? 'Ürün' : 'Silinmiş Ürün');

            if (!grouped[productId]) {
                grouped[productId] = {
                    product_id: productId,
                    name: name,
                    price: price,
                    cost: lineCost,
                    category_id: product.category_id || null,
                    is_active: typeof product.is_active === 'undefined' ? true : product.is_active,
                    quantity: 0,
                    total: 0,
                    revenue: 0,
                    estimated_profit: 0,
                    row_count: 0,
                    last_sale_date: row.date || ''
                };
            }

            grouped[productId].quantity += qty;
            grouped[productId].total += revenue;
            grouped[productId].revenue += revenue;
            grouped[productId].estimated_profit += revenue - lineCost;
            grouped[productId].row_count += 1;

            if (row.date && (!grouped[productId].last_sale_date || row.date > grouped[productId].last_sale_date)) {
                grouped[productId].last_sale_date = row.date;
            }
        });

        return Object.values(grouped).sort(function (a, b) {
            if (b.quantity !== a.quantity) {
                return b.quantity - a.quantity;
            }
            return b.revenue - a.revenue;
        });
    },

    async getWeeklySales() {
        var today = new Date();
        var start = new Date();
        start.setDate(start.getDate() - 6);

        var rows = await this.client()
            .from('sales')
            .select('date,total')
            .eq('tenant_id', this.tenantId())
            .eq('is_deleted', false)
            .gte('date', this.iso(start))
            .lte('date', this.iso(today))
            .order('date', { ascending: true });

        this.assertResponse(rows, 'Haftalık satış verisi alınamadı');

        var map = {};
        (rows.data || []).forEach(function (r) {
            var dateKey = r.date;
            var amount = Number(r.total || 0);

            if (!map[dateKey]) {
                map[dateKey] = 0;
            }

            map[dateKey] += amount;
        });

        var labels = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
        var result = [];
        var self = this;

        for (var i = 6; i >= 0; i--) {
            var d = new Date();
            d.setDate(d.getDate() - i);
            var iso = self.iso(d);

            result.push({
                day: labels[d.getDay()],
                amount: Number(map[iso] || 0),
                date: iso
            });
        }

        return result;
    },

    async getTasksTodayCount() {
        var res = await this.client()
            .from('tasks')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', this.tenantId())
            .eq('due_date', this.today());

        this.assertResponse(res, 'Bugünkü görev sayısı alınamadı');
        return res.count || 0;
    },

    async getAllTasks() {
        var res = await this.client()
            .from('tasks')
            .select('id,due_date,status,priority,title')
            .eq('tenant_id', this.tenantId());

        this.assertResponse(res, 'Görevler alınamadı');
        return res.data || [];
    },

    /* ============================================================
       MATH HELPERS
    ============================================================ */

    sum(list, field) {
        return (list || []).reduce(function (s, i) {
            return s + Number(i[field] || 0);
        }, 0);
    },

    sumDate(list, date, field) {
        return (list || []).reduce(function (s, i) {
            return i.date === date ? s + Number(i[field] || 0) : s;
        }, 0);
    },

    // product_sales.cost = birim maliyet (unit cost)
    // Satır toplam maliyeti = cost × quantity
    rowCost(row) {
        return Number((row && row.cost) || 0) * Number((row && row.quantity) || 0);
    },

    sumProductCost(list) {
        var self = this;
        return (list || []).reduce(function (s, row) {
            return s + self.rowCost(row);
        }, 0);
    },

    sumProductCostDate(list, date) {
        var self = this;
        return (list || []).reduce(function (s, row) {
            if (!row || row.date !== date) return s;
            return s + self.rowCost(row);
        }, 0);
    },

    change(current, previous) {
        // prev === 0 → sonsuzluğa bölme (Infinity) yerine 0 dön.
        // Bu, KPI kartlarında "%Infinity" / "NaN" gösterimini engeller.
        var prev = Number(previous || 0);
        var curr = Number(current || 0);
        if (prev === 0) return 0;
        return ((curr - prev) / Math.abs(prev)) * 100;
    },

    margin(profit, revenue) {
        if (revenue <= 0) return 0;
        return (profit / revenue) * 100;
    },

    average(arr) {
        if (!arr || !arr.length) return 0;
        var total = arr.reduce(function (s, v) { return s + v; }, 0);
        return total / arr.length;
    },

    /* ============================================================
       BUILDERS — expenseCategories, topProducts
    ============================================================ */

    buildExpenseCategories(expenses) {
        var totals = {};

        (expenses || []).forEach(function (row) {
            var name = 'Diğer';
            var color = '#9CA3AF';

            if (row.categories) {
                name = row.categories.name || 'Diğer';
                color = row.categories.color || '#9CA3AF';
            }

            if (!totals[name]) {
                totals[name] = { name: name, amount: 0, color: color };
            }

            totals[name].amount += Number(row.amount || 0);
        });

        return Object.values(totals).sort(function (a, b) {
            return b.amount - a.amount;
        });
    },

    buildTopProducts(rows) {
        return (rows || []).slice(0, 5).map(function (item, index) {
            return {
                rank: index + 1,
                name: item.name,
                sales: Number(item.quantity || 0),
                revenue: Number(item.revenue || 0),
                profit: Number(item.estimated_profit || 0)
            };
        });
    },

    /* ============================================================
       ALERTS — Akıllı Uyarılar
    ============================================================ */

    buildAlerts(ctx) {
        var alerts = [];

        if (ctx.averageWeeklySales > 0 && ctx.todaySales < ctx.averageWeeklySales * 0.7) {
            alerts.push({
                type: 'warning',
                text: 'Bugünkü satış, haftalık ortalamanın %30 altında.'
            });
        }

        if (ctx.monthlyRevenueChange < -10) {
            alerts.push({
                type: 'danger',
                text: 'Aylık ciro geçen aya göre %' + Math.abs(ctx.monthlyRevenueChange).toFixed(0) + ' düştü.'
            });
        }

        if (ctx.monthlyExpenseChange > 15) {
            alerts.push({
                type: 'danger',
                text: 'Aylık giderler geçen aya göre %' + ctx.monthlyExpenseChange.toFixed(0) + ' arttı.'
            });
        }

        if (ctx.monthlyRevenue > 0 && ctx.monthlyProfitChange < -15) {
            alerts.push({
                type: 'danger',
                text: 'Kâr oranı geçen aya göre ciddi düşüş gösteriyor.'
            });
        }

        if (ctx.monthlyRevenueChange > 10) {
            alerts.push({
                type: 'success',
                text: 'Aylık ciro geçen aya göre %' + ctx.monthlyRevenueChange.toFixed(0) + ' arttı.'
            });
        }

        if (ctx.monthlyExpenseChange < -5) {
            alerts.push({
                type: 'success',
                text: 'Giderler geçen aya göre %' + Math.abs(ctx.monthlyExpenseChange).toFixed(0) + ' azaldı.'
            });
        }

        var overdueTasks = (ctx.tasks || []).filter(function (t) {
            return t.status !== 'done' && t.due_date && t.due_date < ctx.today;
        });

        if (overdueTasks.length > 0) {
            alerts.push({
                type: 'warning',
                text: overdueTasks.length + ' adet gecikmiş görev var.'
            });
        }

        if (alerts.length === 0) {
            alerts.push({
                type: 'success',
                text: 'Tüm göstergeler normal seviyede.'
            });
        }

        return alerts;
    },

    /* ============================================================
       ANALYSIS — Akıllı Yorumlar
    ============================================================ */

    buildAnalysis(ctx) {
        var items = [];
        var self = this;

        var weekAmounts = (ctx.weeklySales || []).map(function (s) { return s.amount; });
        var weekAvg = self.average(weekAmounts);

        if (weekAvg > 0) {
            var lastDay = weekAmounts[weekAmounts.length - 1] || 0;
            var trendText = lastDay >= weekAvg
                ? 'Son gün satışı haftalık ortalamanın üzerinde.'
                : 'Son gün satışı haftalık ortalamanın altında.';

            items.push({
                icon: '📈',
                iconClass: 'blue',
                title: 'Haftalık Trend',
                text: trendText + ' Ort: ₺' + Math.round(weekAvg).toLocaleString('tr-TR')
            });
        }

        if ((ctx.expenseCategories || []).length > 0) {
            var topExpense = ctx.expenseCategories[0];
            items.push({
                icon: '💰',
                iconClass: 'red',
                title: 'En Büyük Gider',
                text: topExpense.name + ' kategorisi ₺' + Math.round(topExpense.amount).toLocaleString('tr-TR') + ' ile en yüksek gider kalemi.'
            });
        }

        if (ctx.monthlyRevenue > 0) {
            var profitMargin = self.margin(ctx.monthlyProfit, ctx.monthlyRevenue);
            var marginText = profitMargin >= 40
                ? 'Kâr marjı sağlıklı seviyede (%' + profitMargin.toFixed(1) + ').'
                : profitMargin >= 20
                    ? 'Kâr marjı orta seviyede (%' + profitMargin.toFixed(1) + '). İyileştirme alanı mevcut.'
                    : 'Kâr marjı düşük (%' + profitMargin.toFixed(1) + '). Maliyet optimizasyonu önerilir.';

            items.push({
                icon: '🎯',
                iconClass: 'green',
                title: 'Kâr Marjı',
                text: marginText
            });
        }

        if ((ctx.topProducts || []).length > 0) {
            var bestProduct = ctx.topProducts[0];
            items.push({
                icon: '⭐',
                iconClass: 'orange',
                title: 'En Çok Satan',
                text: bestProduct.name + ' bu ay ' + bestProduct.sales + ' adet satışla lider.'
            });
        }

        if (items.length === 0) {
            items.push({
                icon: 'ℹ️',
                iconClass: 'blue',
                title: 'Veri Durumu',
                text: 'Analiz üretmek için yeterli veri bulunamadı.'
            });
        }

        return items;
    },

    /* ============================================================
       HEALTH SCORE — İşletme Sağlık Skoru (0-100)
    ============================================================ */

    buildHealthScore(ctx) {
        var score = 50;

        if (ctx.monthlyRevenueChange > 10) score += 15;
        else if (ctx.monthlyRevenueChange > 0) score += 8;
        else if (ctx.monthlyRevenueChange > -10) score -= 5;
        else score -= 15;

        if (ctx.monthlyExpenseChange < 0) score += 10;
        else if (ctx.monthlyExpenseChange < 10) score += 3;
        else if (ctx.monthlyExpenseChange < 20) score -= 5;
        else score -= 10;

        var profitMargin = ctx.monthlyRevenue > 0
            ? (ctx.monthlyProfit / ctx.monthlyRevenue) * 100
            : 0;

        if (profitMargin >= 40) score += 15;
        else if (profitMargin >= 25) score += 8;
        else if (profitMargin >= 10) score += 0;
        else score -= 10;

        var dangerAlerts = (ctx.alerts || []).filter(function (a) {
            return a.type === 'danger';
        }).length;

        if (dangerAlerts === 0) score += 10;
        else if (dangerAlerts === 1) score -= 3;
        else score -= 10;

        if (score > 100) score = 100;
        if (score < 0) score = 0;

        return Math.round(score);
    },

    /* ============================================================
       MAIN — getDashboardAnalytics()
       Tek RPC call ile tüm aggregation DB seviyesinde yapılır.
       10+ ayrı sorgu yerine 1 RPC.
    ============================================================ */

    async getDashboardAnalytics() {
        var self = this;
        var now = new Date();

        var start = this.monthStart(now);
        var end = this.monthEnd(now);

        // Yerel hesaplamalar için tarih (DB artık almıyor — client'ta kullanılıyor)
        var today = this.today();

        // === SINGLE UNIFIED RPC — analytics + alerts_master tek çağrıda ===
        var res;
        try {
            res = await this.client().rpc('get_dashboard_with_alerts', {
                p_start: start,
                p_end: end
            });
        } catch (err) {
            console.warn('[analytics] get_dashboard_with_alerts rpc threw:', err && err.message ? err.message : err);
            res = { data: null, error: err };
        }

        this.assertResponse(res, 'Dashboard verisi alınamadı');

        // DB yeni imzada daraltılmış response dönebilir — tüm alanlar null-safe parse edilir
        var d = (res && res.data) || {};

        // === PARSE AGGREGATED VALUES ===
        var monthlyRevenue = Number(d.monthly_revenue || 0);
        var monthlyExpenseOnly = Number(d.monthly_expense || 0);
        var monthlyProductCost = Number(d.monthly_product_cost || 0);
        var monthlyTotalExpense = monthlyExpenseOnly + monthlyProductCost;
        var monthlyProfit = monthlyRevenue - monthlyTotalExpense;

        var prevRevenue = Number(d.prev_revenue || 0);
        var prevExpenseOnly = Number(d.prev_expense || 0);
        var prevProductCost = Number(d.prev_product_cost || 0);
        var prevTotalExpense = prevExpenseOnly + prevProductCost;
        var prevProfit = prevRevenue - prevTotalExpense;

        var todaySales = Number(d.today_revenue || 0);
        var todayExpenseOnly = Number(d.today_expense || 0);
        var todayProductCost = Number(d.today_product_cost || 0);
        var todayTotalExpense = todayExpenseOnly + todayProductCost;
        var todayProfit = todaySales - todayTotalExpense;

        var yesterdaySales = Number(d.yesterday_revenue || 0);
        var yesterdayExpenseOnly = Number(d.yesterday_expense || 0);
        var yesterdayProductCost = Number(d.yesterday_product_cost || 0);
        var yesterdayTotalExpense = yesterdayExpenseOnly + yesterdayProductCost;
        var yesterdayProfit = yesterdaySales - yesterdayTotalExpense;

        // === CHANGE CALCULATIONS ===
        var monthlyRevenueChange = this.change(monthlyRevenue, prevRevenue);
        var monthlyExpenseChange = this.change(monthlyTotalExpense, prevTotalExpense);
        var monthlyProfitChange = this.change(monthlyProfit, prevProfit);

        var dailyRevenueChange = this.change(todaySales, yesterdaySales);
        var dailyExpenseChange = this.change(todayTotalExpense, yesterdayTotalExpense);
        var dailyProfitChange = this.change(todayProfit, yesterdayProfit);

        // === WEEKLY SALES (fill missing days) ===
        var weekMap = {};
        (d.weekly_sales || []).forEach(function (w) {
            weekMap[w.date] = Number(w.amount || 0);
        });

        var dayLabels = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
        var weeklySales = [];
        for (var i = 6; i >= 0; i--) {
            var wd = new Date();
            wd.setDate(wd.getDate() - i);
            var wiso = self.iso(wd);
            weeklySales.push({
                day: dayLabels[wd.getDay()],
                amount: Number(weekMap[wiso] || 0),
                date: wiso
            });
        }

        // === EXPENSE CATEGORIES (already grouped by DB) ===
        var expenseCategories = (d.expense_categories || []).map(function (c) {
            return {
                name: c.name || 'Diğer',
                color: c.color || '#9CA3AF',
                amount: Number(c.amount || 0)
            };
        });

        // === TOP PRODUCTS (already grouped & limited by DB) ===
        var topProducts = (d.top_products || []).map(function (item, index) {
            return {
                rank: index + 1,
                name: item.name || 'Bilinmeyen Ürün',
                sales: Number(item.quantity || 0),
                revenue: Number(item.revenue || 0),
                profit: Number(item.estimated_profit || 0)
            };
        });

        // === TASKS ===
        var tasksToday = Number(d.tasks_today_count || 0);
        var allTasks = d.all_tasks || [];

        // === ALERTS, ANALYSIS, HEALTH SCORE ===
        var averageWeeklySales = this.average(
            weeklySales.map(function (s) { return s.amount; })
        );

        var alerts = this.buildAlerts({
            todaySales: todaySales,
            averageWeeklySales: averageWeeklySales,
            monthlyRevenueChange: monthlyRevenueChange,
            monthlyExpenseChange: monthlyExpenseChange,
            monthlyProfitChange: monthlyProfitChange,
            monthlyRevenue: monthlyRevenue,
            tasks: allTasks,
            today: today
        });

        var analysis = this.buildAnalysis({
            weeklySales: weeklySales,
            monthlyRevenue: monthlyRevenue,
            monthlyExpenses: monthlyTotalExpense,
            monthlyProfit: monthlyProfit,
            topProducts: topProducts,
            expenseCategories: expenseCategories
        });

        var healthScore = this.buildHealthScore({
            monthlyRevenueChange: monthlyRevenueChange,
            monthlyExpenseChange: monthlyExpenseChange,
            monthlyProfitChange: monthlyProfitChange,
            monthlyRevenue: monthlyRevenue,
            monthlyProfit: monthlyProfit,
            alerts: alerts
        });

        // === ALERTS MASTER (decision cards) — RPC içinden ===
        // Defansif parser: ne format gelirse gelsin ARRAY garantisi
        function _coerceArray(v) {
            if (!v) return [];
            if (Array.isArray(v)) return v;
            if (typeof v === 'string') {
                try {
                    var parsed = JSON.parse(v);
                    return Array.isArray(parsed) ? parsed : [];
                } catch (e) { return []; }
            }
            if (typeof v === 'object') {
                if (Array.isArray(v.rows))           return v.rows;
                if (Array.isArray(v.data))           return v.data;
                if (Array.isArray(v.items))          return v.items;
                if (Array.isArray(v.alerts_master)) return v.alerts_master;
            }
            return [];
        }

        var rawAm = d.alerts_master;
        var alertsMaster = _coerceArray(rawAm);

        // FAILSAFE — object icinde gizli array varsa yakala
        if (!alertsMaster.length && rawAm && typeof rawAm === 'object') {
            alertsMaster = Object.values(rawAm).find(Array.isArray) || [];
        }
        // Fallback kaynaklar
        if (!alertsMaster.length) {
            alertsMaster = _coerceArray(d.product_priority);
        }

        d.alerts_master = alertsMaster;

        console.log('[analytics] alerts_master count:', alertsMaster.length,
                    '| raw type:', typeof rawAm,
                    '| sample:', alertsMaster[0] || null,
                    '| raw:', rawAm);

        return {
            monthly: {
                ciro: monthlyRevenue,
                gider: monthlyTotalExpense,
                kar: monthlyProfit,
                ciroChange: monthlyRevenueChange,
                giderChange: monthlyExpenseChange,
                karChange: monthlyProfitChange,
                trend: monthlyRevenueChange,
                trendChange: this.margin(monthlyProfit, monthlyRevenue)
            },

            daily: {
                ciro: todaySales,
                gider: todayTotalExpense,
                kar: todayProfit,
                ciroChange: dailyRevenueChange,
                giderChange: dailyExpenseChange,
                karChange: dailyProfitChange,
                trend: dailyRevenueChange,
                trendChange: this.margin(todayProfit, todaySales)
            },

            weeklySales: weeklySales,
            expenseCategories: expenseCategories,
            topProducts: topProducts,
            alerts: alerts,
            analysis: analysis,
            healthScore: healthScore,
            taskCount: tasksToday,
            tasks: allTasks,
            alerts_master: alertsMaster,
            product_priority: alertsMaster
        };
    }
};
