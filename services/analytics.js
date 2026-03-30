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
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 10);
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
     * Hem getProductPerformanceSummary hem getDashboardAnalytics kullanır.
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
        if (previous === 0) {
            if (current === 0) return 0;
            return 100;
        }
        return ((current - previous) / Math.abs(previous)) * 100;
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
    ============================================================ */

    async getDashboardAnalytics() {
        var now = new Date();

        var start = this.monthStart(now);
        var end = this.monthEnd(now);

        var prev = new Date();
        prev.setMonth(prev.getMonth() - 1);

        var prevStart = this.monthStart(prev);
        var prevEnd = this.monthEnd(prev);

        var results = await Promise.all([
            this.getMonthlySalesRange(start, end),          // 0
            this.getMonthlySalesRange(prevStart, prevEnd),   // 1
            this.getMonthlyExpensesRange(start, end),        // 2
            this.getMonthlyExpensesRange(prevStart, prevEnd),// 3
            this.getProductSalesRange(start, end),           // 4 (products join aşağıda)
            this.getProductSalesRange(prevStart, prevEnd),   // 5
            this.getWeeklySales(),                           // 6
            this.getTasksTodayCount(),                       // 7
            this.getAllTasks(),                               // 8
            this.getProductPerformanceSummary(start, end)     // 9
        ]);

        var sales = results[0].data || [];
        var salesP = results[1].data || [];
        var expenses = results[2].data || [];
        var expensesP = results[3].data || [];
        var rawProductSalesRows = results[4].data || [];
        var rawProductSalesRowsPrev = results[5].data || [];
        var weeklySales = results[6] || [];
        var tasksToday = results[7] || 0;
        var allTasks = results[8] || [];
        var productSalesData = results[9] || [];

        // Aktif satış ID'leri — sales sorgusu zaten is_deleted=false filtreli
        var validSaleIds = {};
        sales.forEach(function (s) { if (s.id) validSaleIds[s.id] = true; });
        var validSaleIdsPrev = {};
        salesP.forEach(function (s) { if (s.id) validSaleIdsPrev[s.id] = true; });

        // product_sales → sadece aktif satışlara ait olanlar
        var productSalesRows = this.filterByActiveSales(rawProductSalesRows, validSaleIds);
        var productSalesRowsPrev = this.filterByActiveSales(rawProductSalesRowsPrev, validSaleIdsPrev);

        var today = this.today();
        var yesterday = this.yesterday();

        // AYLIK
        var monthlyRevenue = this.sum(sales, 'total');
        var monthlyExpenseOnly = this.sum(expenses, 'amount');
        var monthlyProductCost = this.sumProductCost(productSalesRows);
        var monthlyTotalExpense = monthlyExpenseOnly + monthlyProductCost;
        var monthlyProfit = monthlyRevenue - monthlyTotalExpense;

        // ÖNCEKİ AY
        var prevRevenue = this.sum(salesP, 'total');
        var prevExpenseOnly = this.sum(expensesP, 'amount');
        var prevProductCost = this.sumProductCost(productSalesRowsPrev);
        var prevTotalExpense = prevExpenseOnly + prevProductCost;
        var prevProfit = prevRevenue - prevTotalExpense;

        // GÜNLÜK
        var todaySales = this.sumDate(sales, today, 'total');
        var todayExpenseOnly = this.sumDate(expenses, today, 'amount');
        var todayProductCost = this.sumProductCostDate(productSalesRows, today);
        var todayTotalExpense = todayExpenseOnly + todayProductCost;
        var todayProfit = todaySales - todayTotalExpense;

        // DÜN
        var yesterdaySales = this.sumDate(sales, yesterday, 'total') + this.sumDate(salesP, yesterday, 'total');
        var yesterdayExpenseOnly = this.sumDate(expenses, yesterday, 'amount') + this.sumDate(expensesP, yesterday, 'amount');
        var yesterdayProductCost = this.sumProductCostDate(productSalesRows, yesterday) + this.sumProductCostDate(productSalesRowsPrev, yesterday);
        var yesterdayTotalExpense = yesterdayExpenseOnly + yesterdayProductCost;
        var yesterdayProfit = yesterdaySales - yesterdayTotalExpense;

        var monthlyRevenueChange = this.change(monthlyRevenue, prevRevenue);
        var monthlyExpenseChange = this.change(monthlyTotalExpense, prevTotalExpense);
        var monthlyProfitChange = this.change(monthlyProfit, prevProfit);

        var dailyRevenueChange = this.change(todaySales, yesterdaySales);
        var dailyExpenseChange = this.change(todayTotalExpense, yesterdayTotalExpense);
        var dailyProfitChange = this.change(todayProfit, yesterdayProfit);

        var expenseCategories = this.buildExpenseCategories(expenses);
        var topProducts = this.buildTopProducts(productSalesData);
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
            tasks: allTasks
        };
    }
};