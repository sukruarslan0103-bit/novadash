/* ============================================================
   HEALTH VIEW — Saglik Raporu
   Premium isletme performans analiz paneli
   Gercek veri ile calisan akilli oneri sistemi
   ============================================================ */

window.HealthView = {
    _listeners: [],
    _isActive: false,

    /* ============================================================
       DATA FETCHING — Gercek veriden skor + oneri uret
       ============================================================ */
    fetchData: async function () {
        var products = [];
        var sales = [];
        var expenses = [];
        var hasData = false;

        var d30 = new Date();
        d30.setDate(d30.getDate() - 30);
        var d30str = d30.toISOString().slice(0, 10);

        var d60 = new Date();
        d60.setDate(d60.getDate() - 60);
        var d60str = d60.toISOString().slice(0, 10);

        var productSales = [];

        try {
            var results = await Promise.all([
                window.SupabaseService.query('products', {
                    select: 'id,name,price,cost,is_active,is_deleted',
                    filters: [{ op: 'eq', column: 'is_deleted', value: false }]
                }),
                window.SupabaseService.query('sales', {
                    select: 'id,date,total',
                    filters: [
                        { op: 'gte', column: 'date', value: d60str },
                        { op: 'eq', column: 'is_deleted', value: false }
                    ],
                    order: { column: 'date', asc: false }
                }),
                window.SupabaseService.query('expenses', {
                    select: 'id,date,amount',
                    filters: [{ op: 'gte', column: 'date', value: d60str }],
                    order: { column: 'date', asc: false }
                }),
                window.SupabaseService.query('product_sales', {
                    select: 'product_id,quantity,unit_price,total,cost',
                    filters: [{ op: 'gte', column: 'date', value: d30str }]
                })
            ]);

            products = (results[0] && results[0].data) || [];
            sales = (results[1] && results[1].data) || [];
            expenses = (results[2] && results[2].data) || [];
            productSales = (results[3] && results[3].data) || [];
        } catch (e) { /* ignore */ }

        hasData = products.length > 0 || sales.length > 0 || expenses.length > 0;

        /* ============================================================
           PRODUCT ANALYTICS — urun bazli kar/zarar hesapla
           ============================================================ */
        var IDEAL_MARGIN = 0.40;

        // Urun bazli satis miktari haritasi
        var salesByProduct = {};
        for (var psi = 0; psi < productSales.length; psi++) {
            var ps = productSales[psi];
            var pid = ps.product_id;
            if (!salesByProduct[pid]) salesByProduct[pid] = { qty: 0, revenue: 0 };
            salesByProduct[pid].qty += Number(ps.quantity || 0);
            salesByProduct[pid].revenue += Number(ps.total || 0);
        }

        // Her urun icin loss/margin hesapla
        var productAnalysis = [];
        var lossProducts = [];
        var noCostCount = 0;
        var activeProducts = 0;
        var totalDailyLoss = 0;
        var totalPotentialProfit = 0;

        for (var i = 0; i < products.length; i++) {
            var p = products[i];
            if (!p.is_active) continue;
            activeProducts++;

            var price = Number(p.price || 0);
            var cost = Number(p.cost || 0);

            if (cost <= 0) {
                noCostCount++;
                continue;
            }

            var lossPerSale = price - cost;
            var marginPct = price > 0 ? ((price - cost) / price) : 0;
            var pSales = salesByProduct[p.id];
            var dailyQty = pSales ? (pSales.qty / 30) : 0;

            var entry = {
                id: p.id,
                name: p.name,
                price: price,
                cost: cost,
                lossPerSale: lossPerSale,
                marginPct: marginPct,
                dailyQty: dailyQty,
                monthlyQty: pSales ? pSales.qty : 0,
                dailyLoss: 0,
                potentialProfit: 0
            };

            // Zarar eden urun
            if (lossPerSale < 0) {
                entry.dailyLoss = Math.abs(lossPerSale) * dailyQty;
                totalDailyLoss += entry.dailyLoss;
                lossProducts.push(entry);
            }

            // Dusuk marjli urun (margin < ideal)
            if (lossPerSale >= 0 && marginPct < 0.35 && dailyQty > 0 && entry.monthlyQty > 10) {
                var idealPrice = cost / (1 - IDEAL_MARGIN);
                var priceDiff = idealPrice - price;
                entry.potentialProfit = priceDiff * dailyQty * 30;
                totalPotentialProfit += entry.potentialProfit;
            }

            productAnalysis.push(entry);
        }

        // Top 3 en cok zarar yazan
        lossProducts.sort(function (a, b) { return b.dailyLoss - a.dailyLoss; });
        var top3Loss = lossProducts.slice(0, 3);

        // Top 3 en dusuk marjli (satis yapilan, pozitif marjli ama dusuk)
        var lowMarginProducts = productAnalysis
            .filter(function (x) { return x.lossPerSale >= 0 && x.marginPct < 0.35 && x.monthlyQty > 10; })
            .sort(function (a, b) { return a.marginPct - b.marginPct; })
            .slice(0, 3);

        var insights = [];

        /* ============================================================
           KARAR MOTORU 2.0 — bilgi > karar > aksiyon > sonuc
           Her insight: TL bazli etki, spesifik aksiyon, oncelik sirasi
           ============================================================ */

        // --- ZAMAN HESAPLARI ---
        var now = new Date();
        var thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        var lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);

        var thisMonthExp = 0;
        var lastMonthExp = 0;
        for (var ei = 0; ei < expenses.length; ei++) {
            var exp = expenses[ei];
            if (exp.date >= thisMonthStart) {
                thisMonthExp += Number(exp.amount || 0);
            } else if (exp.date >= lastMonthStart && exp.date < thisMonthStart) {
                lastMonthExp += Number(exp.amount || 0);
            }
        }

        var last7 = 0;
        var prev7 = 0;
        var d7 = new Date(); d7.setDate(d7.getDate() - 7);
        var d7str = d7.toISOString().slice(0, 10);
        var d14 = new Date(); d14.setDate(d14.getDate() - 14);
        var d14str = d14.toISOString().slice(0, 10);

        for (var si = 0; si < sales.length; si++) {
            var sale = sales[si];
            if (sale.date >= d7str) {
                last7 += Number(sale.total || 0);
            } else if (sale.date >= d14str && sale.date < d7str) {
                prev7 += Number(sale.total || 0);
            }
        }

        // --- 1. ZARAR EDEN URUNLER (AGRESİF) ---
        if (top3Loss.length > 0) {
            for (var li = 0; li < top3Loss.length; li++) {
                var lp = top3Loss[li];
                var lpDailyLoss = Math.round(lp.dailyLoss);
                var lpMonthlyLoss = Math.round(lp.dailyLoss * 30);
                var suggestedPrice = Math.round(lp.cost * 1.5);
                var recoveryDays = lpDailyLoss > 0 ? Math.ceil(lpMonthlyLoss / lpDailyLoss) : 0;
                insights.push({
                    type: 'danger',
                    title: lp.name + ' her satista ' + Math.round(Math.abs(lp.lossPerSale)) + ' TL kaybettiriyor',
                    description: 'Fiyat ' + Math.round(lp.price) + ' TL, maliyet ' + Math.round(lp.cost) + ' TL. Gunluk ' + Math.round(lp.dailyQty) + ' adet satiliyor.',
                    action: 'Fiyati ' + suggestedPrice + ' TL yap → ' + recoveryDays + ' gunde toparlar',
                    route: '#products',
                    impact: 'Aylik ' + lpMonthlyLoss + ' TL zarar duracak',
                    priority: lpMonthlyLoss
                });
            }
        }

        // --- 2. FIRSAT MOTORU (dusuk marj → ideal fiyat → kazanc) ---
        if (lowMarginProducts.length > 0) {
            for (var lmi = 0; lmi < lowMarginProducts.length; lmi++) {
                var lm = lowMarginProducts[lmi];
                var idealP = Math.round(lm.cost / (1 - IDEAL_MARGIN));
                var priceBump = idealP - Math.round(lm.price);
                var monthlyGain = Math.round(lm.potentialProfit);
                if (monthlyGain < 50) continue;
                insights.push({
                    type: 'warning',
                    title: lm.name + ': fiyat ' + priceBump + ' TL artirirsan aylik +' + monthlyGain + ' TL',
                    description: 'Simdi %' + Math.round(lm.marginPct * 100) + ' marj, hedef %' + Math.round(IDEAL_MARGIN * 100) + '. Aylik ' + lm.monthlyQty + ' adet satiliyor.',
                    action: 'Fiyati ' + Math.round(lm.price) + ' → ' + idealP + ' TL yap',
                    route: '#products',
                    impact: 'Aylik +' + monthlyGain + ' TL ek kar',
                    priority: monthlyGain
                });
            }
        }

        // --- 3. TOP SELLER BOOST (%5 fiyat artisi etkisi) ---
        var topSeller = null;
        for (var tsi = 0; tsi < productAnalysis.length; tsi++) {
            var tse = productAnalysis[tsi];
            if (tse.monthlyQty > 0 && tse.marginPct >= 0.35 && (!topSeller || tse.monthlyQty > topSeller.monthlyQty)) {
                topSeller = tse;
            }
        }
        if (topSeller && topSeller.monthlyQty >= 10) {
            var boostPrice = Math.round(topSeller.price * 1.05);
            var boostGain = Math.round((boostPrice - topSeller.price) * topSeller.monthlyQty);
            var tsRevenue = Math.round(topSeller.monthlyQty * topSeller.price);
            insights.push({
                type: 'success',
                title: topSeller.name + ': %5 zam = aylik +' + boostGain + ' TL',
                description: 'En cok satan urun (aylik ' + topSeller.monthlyQty + ' adet, ' + tsRevenue + ' TL ciro). Fiyat ' + Math.round(topSeller.price) + ' → ' + boostPrice + ' TL.',
                action: 'Fiyati ' + boostPrice + ' TL yap',
                route: '#products',
                impact: 'Aylik +' + boostGain + ' TL ekstra gelir',
                priority: boostGain
            });
        }

        // --- 4. LOW SALES (menu temizligi) ---
        var lowSalesProducts = productAnalysis
            .filter(function (x) { return x.monthlyQty > 0 && x.monthlyQty < 5; })
            .sort(function (a, b) { return a.monthlyQty - b.monthlyQty; });
        if (lowSalesProducts.length > 0) {
            var lsP = lowSalesProducts[0];
            var lsWaste = Math.round(lsP.cost * lsP.monthlyQty);
            insights.push({
                type: 'warning',
                title: lsP.name + ': ayda ' + lsP.monthlyQty + ' adet — menuyu yoruyor',
                description: 'Stok maliyeti aylik ~' + lsWaste + ' TL. Dusuk satis = stok riski + operasyon yuku.',
                action: 'Menuden kaldir veya haftalik ozel yap',
                route: '#products',
                impact: lsWaste + ' TL stok maliyeti kurtarilabilir',
                priority: lsWaste + 200
            });
        }

        // --- 5. GIDER ANALİZİ (akilli) ---
        if (lastMonthExp > 0 && thisMonthExp > lastMonthExp) {
            var expIncPct = Math.round(((thisMonthExp - lastMonthExp) / lastMonthExp) * 100);
            if (expIncPct > 10) {
                var expDiff = Math.round(thisMonthExp - lastMonthExp);
                var expRatio = last7 > 0 ? Math.round((thisMonthExp / (last7 * 4)) * 100) : 0;
                insights.push({
                    type: 'warning',
                    title: 'Giderler %' + expIncPct + ' artti → ' + expDiff + ' TL fazla',
                    description: 'Bu ay ' + Math.round(thisMonthExp) + ' TL, gecen ay ' + Math.round(lastMonthExp) + ' TL.' +
                        (expRatio > 0 ? ' Gider/ciro orani: %' + expRatio + '.' : ''),
                    action: '%10 dusurursen aylik ' + Math.round(thisMonthExp * 0.1) + ' TL tasarruf',
                    route: '#expenses',
                    impact: expDiff + ' TL ekstra gider bu ay',
                    priority: expDiff
                });
            }
        }

        // --- 6. GIDER BASARISI ---
        if (lastMonthExp > 0 && thisMonthExp < lastMonthExp * 0.9) {
            var expDecPct = Math.round(((lastMonthExp - thisMonthExp) / lastMonthExp) * 100);
            var savedAmount = Math.round(lastMonthExp - thisMonthExp);
            insights.push({
                type: 'success',
                title: 'Giderlerde ' + savedAmount + ' TL tasarruf (%' + expDecPct + ' azalma)',
                description: 'Gecen ay ' + Math.round(lastMonthExp) + ' TL → bu ay ' + Math.round(thisMonthExp) + ' TL.',
                action: 'Bu kontrolu surdurun',
                route: '#expenses',
                impact: savedAmount + ' TL tasarruf bu ay',
                priority: savedAmount
            });
        }

        // --- 7. SATIS TREND ---
        if (prev7 > 0 && last7 > prev7 * 1.1) {
            var salesUpPct = Math.round(((last7 - prev7) / prev7) * 100);
            var salesUpDiff = Math.round(last7 - prev7);
            var projectedMonth = Math.round(last7 * 4);
            insights.push({
                type: 'success',
                title: 'Ciro %' + salesUpPct + ' yukseldi → bu ay ~' + projectedMonth + ' TL',
                description: 'Bu hafta ' + Math.round(last7) + ' TL, gecen hafta ' + Math.round(prev7) + ' TL.',
                action: 'Bu tempoyu koruyun',
                route: '#sales',
                impact: '+' + salesUpDiff + ' TL bu hafta',
                priority: salesUpDiff
            });
        } else if (prev7 > 0 && last7 < prev7 * 0.85) {
            var salesDownPct = Math.round(((prev7 - last7) / prev7) * 100);
            var salesDownDiff = Math.round(prev7 - last7);
            var monthlyLossProjection = Math.round(salesDownDiff * 4);
            insights.push({
                type: 'warning',
                title: 'Ciro %' + salesDownPct + ' dustu → aylik ~' + monthlyLossProjection + ' TL risk',
                description: 'Bu hafta ' + Math.round(last7) + ' TL, gecen hafta ' + Math.round(prev7) + ' TL.',
                action: 'Kampanya baslat veya menu ozellerini one cikar',
                route: '#sales',
                impact: 'Aylik ' + monthlyLossProjection + ' TL kayip riski',
                priority: monthlyLossProjection
            });
        }

        // --- 8. HIGH COST RISK ---
        var highCostProducts = productAnalysis
            .filter(function (x) { return x.price > 0 && x.cost > 0 && (x.cost / x.price) > 0.70 && x.lossPerSale >= 0 && x.monthlyQty > 5; })
            .sort(function (a, b) { return (b.cost / b.price) - (a.cost / a.price); });
        if (highCostProducts.length > 0) {
            var hcP = highCostProducts[0];
            var hcRatio = Math.round((hcP.cost / hcP.price) * 100);
            var hcSafePrice = Math.round(hcP.cost / 0.60);
            var hcGain = Math.round((hcSafePrice - hcP.price) * hcP.monthlyQty);
            insights.push({
                type: 'warning',
                title: hcP.name + ': maliyet %' + hcRatio + ' — risk yuksek',
                description: 'Fiyat ' + Math.round(hcP.price) + ' TL, maliyet ' + Math.round(hcP.cost) + ' TL. Ayda ' + hcP.monthlyQty + ' adet satiliyor.',
                action: 'Fiyati ' + hcSafePrice + ' TL yap veya tedarikci degistir',
                route: '#products',
                impact: hcGain > 0 ? ('Aylik +' + hcGain + ' TL ek kar') : ('Maliyet %' + hcRatio + ' — zarar riski'),
                priority: hcGain > 0 ? hcGain : hcRatio * 10
            });
        }

        // --- 9. MALIYET EKSIK ---
        if (noCostCount > 0 && activeProducts > 0) {
            insights.push({
                type: 'warning',
                title: noCostCount + ' urunde maliyet yok → kar hesabi yapilamiyor',
                description: activeProducts + ' aktif urunden ' + noCostCount + ' tanesinde alis kaydi yok.',
                action: 'Alis kaydi gir → kar analizi acilsin',
                route: '#products',
                impact: noCostCount + ' urun kor noktada',
                priority: noCostCount * 50
            });
        }

        // --- 10. HIC SATIS YOK ---
        if (sales.length === 0 && products.length > 0) {
            insights.push({
                type: 'warning',
                title: 'Son 60 gunde satis yok — analiz yapilamiyor',
                description: products.length + ' urun tanimli ama satis verisi girilmemis.',
                action: 'Ilk satisi gir → sistem canlansin',
                route: '#sales',
                impact: 'Veri olmadan karar verilemez',
                priority: 999
            });
        }

        // --- 11. DATA GAP ---
        if (sales.length > 0) {
            var gapMap = {};
            for (var gmi = 0; gmi < sales.length; gmi++) {
                var gd = sales[gmi].date;
                if (gd && typeof gd === 'string') gapMap[gd] = true;
            }
            var gapDays = 0;
            var today = new Date();
            for (var gi = 0; gi < 7; gi++) {
                var checkDate = new Date(today);
                checkDate.setDate(checkDate.getDate() - gi);
                var checkStr = checkDate.toISOString().slice(0, 10);
                if (!gapMap[checkStr]) gapDays++;
            }
            if (gapDays >= 3) {
                insights.push({
                    type: 'warning',
                    title: 'Son 7 gunde ' + gapDays + ' gun veri yok',
                    description: 'Eksik veri yanlis analiz uretir. Tutarli giris yapilmali.',
                    action: 'Her gun satis girisi yap',
                    route: '#sales',
                    impact: 'Eksik gun = yanlis skor',
                    priority: gapDays * 100
                });
            }
        }

        // --- PRIORITY ENGINE: finansal etki + risk → en buyuk para ustte ---
        var typeWeight = { danger: 100000, warning: 10000, success: 1000 };
        insights.sort(function (a, b) {
            var wa = (typeWeight[a.type] || 0) + (a.priority || 0);
            var wb = (typeWeight[b.type] || 0) + (b.priority || 0);
            return wb - wa;
        });
        if (insights.length > 5) insights.length = 5;

        /* SKORLAR */
        var totalRevenue = 0;
        var totalCost = 0;
        for (var fi = 0; fi < sales.length; fi++) {
            if (sales[fi].date >= thisMonthStart) {
                totalRevenue += Number(sales[fi].total || 0);
            }
        }
        totalCost = thisMonthExp;

        var financialScore = 50;
        if (totalRevenue > 0) {
            var margin = ((totalRevenue - totalCost) / totalRevenue) * 100;
            if (margin >= 30) financialScore = 95;
            else if (margin >= 20) financialScore = 82;
            else if (margin >= 10) financialScore = 65;
            else if (margin >= 0) financialScore = 45;
            else financialScore = 20;
        } else if (!hasData) { financialScore = 0; }

        var salesScore = 50;
        if (prev7 > 0) {
            var salesRatio = last7 / prev7;
            if (salesRatio >= 1.15) salesScore = 90;
            else if (salesRatio >= 1.0) salesScore = 75;
            else if (salesRatio >= 0.85) salesScore = 55;
            else salesScore = 30;
        } else if (sales.length > 0) { salesScore = 60; }
        else if (!hasData) { salesScore = 0; }

        var productScore = 50;
        if (activeProducts > 0) {
            var healthyPct = ((activeProducts - lossProducts.length - noCostCount) / activeProducts) * 100;
            if (healthyPct >= 90) productScore = 92;
            else if (healthyPct >= 70) productScore = 75;
            else if (healthyPct >= 50) productScore = 55;
            else productScore = 30;
        } else if (!hasData) { productScore = 0; }

        var opsScore = 50;
        var daysWithSales = {};
        for (var oi = 0; oi < sales.length; oi++) {
            if (sales[oi].date >= d30str) {
                var d = sales[oi].date;
                if (d && typeof d === 'string') {
                    daysWithSales[d] = true;
                }
            }
        }
        var activeDays = Object.keys(daysWithSales).length;
        if (activeDays >= 25) opsScore = 95;
        else if (activeDays >= 20) opsScore = 80;
        else if (activeDays >= 10) opsScore = 60;
        else if (activeDays > 0) opsScore = 35;
        else if (!hasData) opsScore = 0;

        var totalScore = Math.round(financialScore * 0.35 + salesScore * 0.25 + productScore * 0.25 + opsScore * 0.15);

        var summary = '';
        if (!hasData) summary = 'Henuz analiz icin yeterli veri yok. Satis ve urun girisi yapin.';
        else if (totalScore >= 80) summary = 'Isletmeniz cok iyi durumda. Boyle devam edin!';
        else if (totalScore >= 60) summary = 'Isletmeniz genel olarak saglikh. Bazi alanlar iyilestirilebilir.';
        else if (totalScore >= 40) summary = 'Dikkat edilmesi gereken alanlar var. Onerileri inceleyin.';
        else summary = 'Isletme sagligi kritik seviyede. Acil aksiyon gerekiyor.';

        var finSummary = 'Veri bekleniyor';
        if (totalRevenue > 0) { var m = Math.round(((totalRevenue - totalCost) / totalRevenue) * 100); finSummary = 'Kar marji %' + m; }

        var salesSummary = 'Veri bekleniyor';
        if (prev7 > 0 && last7 > 0) { var diff = Math.round(((last7 - prev7) / prev7) * 100); salesSummary = diff >= 0 ? ('Haftalik ciro %' + diff + ' yukseldi') : ('Haftalik ciro %' + Math.abs(diff) + ' dustu'); }
        else if (sales.length > 0) { salesSummary = Math.round(last7) + ' TL son 7 gun'; }

        var prodSummary = 'Veri bekleniyor';
        if (activeProducts > 0) {
            if (lossProducts.length > 0) prodSummary = lossProducts.length + ' urunde maliyet satisi gecti';
            else if (noCostCount > 0) prodSummary = noCostCount + ' urunde maliyet eksik';
            else prodSummary = 'Tum urunler karli durumda';
        }

        var opsSummary = 'Veri bekleniyor';
        if (activeDays > 0) opsSummary = 'Son 30 gunde ' + activeDays + ' gun veri girisi';

        /* ============================================================
           SCORE REASON — neden dusuk/yuksek?
           ============================================================ */
        var reasons = [];
        if (!hasData) {
            reasons.push('Henuz yeterli veri yok');
        } else {
            if (lossProducts.length > 0) {
                reasons.push(lossProducts.length + ' urun zarar yaziyor (gunluk ~' + Math.round(totalDailyLoss) + ' TL kayip)');
            }
            if (totalRevenue > 0) {
                var marginPctAll = Math.round(((totalRevenue - totalCost) / totalRevenue) * 100);
                if (marginPctAll < 20) {
                    reasons.push('Kar marji dusuk (%' + marginPctAll + ')');
                } else if (marginPctAll >= 30) {
                    reasons.push('Kar marji saglam (%' + marginPctAll + ')');
                }
            }
            if (totalRevenue > 0 && totalCost > 0) {
                var expRatio = Math.round((totalCost / totalRevenue) * 100);
                if (expRatio > 40) {
                    reasons.push('Gider orani yuksek (%' + expRatio + ')');
                }
            }
            if (noCostCount > 2) {
                reasons.push(noCostCount + ' urunde maliyet eksik');
            }
            if (totalPotentialProfit > 500) {
                reasons.push('Fiyat optimizasyonu ile aylik +' + Math.round(totalPotentialProfit) + ' TL mumkun');
            }
            if (activeDays < 15 && activeDays > 0) {
                reasons.push('Son 30 gunde sadece ' + activeDays + ' gun veri girisi');
            }
            if (prev7 > 0 && last7 < prev7 * 0.85) {
                reasons.push('Haftalik ciro dususte');
            }
        }
        if (reasons.length === 0) {
            if (totalScore >= 70) reasons.push('Genel performans iyi gorunuyor');
            else reasons.push('Daha fazla veri ile daha net analiz yapilabilir');
        }
        if (reasons.length > 3) reasons.length = 3;
        var scoreReason = reasons.join('. ') + '.';

        return {
            score: totalScore,
            summary: summary,
            scoreReason: scoreReason,
            hasData: hasData,
            subScores: [
                { key: 'financial', label: 'Finansal Saglik',   icon: '💰', score: financialScore, summary: finSummary },
                { key: 'sales',     label: 'Satis Performansi', icon: '📈', score: salesScore,     summary: salesSummary },
                { key: 'product',   label: 'Urun Verimliligi',  icon: '📦', score: productScore,   summary: prodSummary },
                { key: 'ops',       label: 'Operasyonel Duzen', icon: '⚙️',  score: opsScore,       summary: opsSummary }
            ],
            insights: insights
        };
    },

    /* ============================================================
       HELPERS
       ============================================================ */
    getScoreColor: function (score) {
        if (score >= 70) return '#059669';
        if (score >= 40) return '#d97706';
        return '#dc2626';
    },

    getScoreGlow: function (score) {
        if (score >= 70) return 'rgba(5,150,105,0.4)';
        if (score >= 40) return 'rgba(217,119,6,0.4)';
        return 'rgba(220,38,38,0.4)';
    },

    getScoreLabel: function (score) {
        if (score >= 80) return 'Mukemmel';
        if (score >= 70) return 'Iyi';
        if (score >= 50) return 'Orta';
        if (score >= 30) return 'Zayif';
        return 'Kritik';
    },

    getInsightStyle: function (type) {
        if (type === 'danger')  return { bg: 'linear-gradient(135deg, #fef2f2 0%, #fff5f5 100%)', border: '#fca5a5', dot: '#dc2626', text: '#991b1b', btnBg: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)', btnText: '#fff', glow: 'rgba(220,38,38,0.08)' };
        if (type === 'warning') return { bg: 'linear-gradient(135deg, #fffbeb 0%, #fefce8 100%)', border: '#fcd34d', dot: '#d97706', text: '#92400e', btnBg: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', btnText: '#fff', glow: 'rgba(217,119,6,0.08)' };
        return                         { bg: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)', border: '#86efac', dot: '#059669', text: '#166534', btnBg: 'linear-gradient(135deg, #059669 0%, #047857 100%)', btnText: '#fff', glow: 'rgba(5,150,105,0.08)' };
    },

    animateCounter: function (el, target, duration) {
        if (!el) return;
        var start = 0;
        var startTime = null;
        function step(ts) {
            if (!startTime) startTime = ts;
            var progress = Math.min((ts - startTime) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = Math.round(eased * target);
            el.textContent = current;
            if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
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
    },

    /* ============================================================
       RENDER
       ============================================================ */
    render: async function (container) {
        this._isActive = true;
        var self = this;
        var CACHE_KEY = 'health_cache_v1';

        // Cache hit — anında göster
        var cached = window.ViewCache ? window.ViewCache.get(CACHE_KEY) : null;
        if (cached) {
            container.innerHTML = cached.html;
            self.animateCounter(document.getElementById('healthMainScore'), cached.score, 800);
            var subNums = container.querySelectorAll('.health-sub-score-num');
            for (var ci = 0; ci < subNums.length; ci++) {
                var ct = parseInt(subNums[ci].getAttribute('data-target'), 10) || 0;
                self.animateCounter(subNums[ci], ct, 600 + ci * 100);
            }
            return;
        }

        container.innerHTML =
            '<div style="max-width:960px;margin:0 auto;padding:60px 0;text-align:center;">' +
                '<div class="health-loader-ring"></div>' +
                '<div style="font-size:15px;font-weight:600;color:#94a3b8;margin-top:16px;">Saglik raporu hazirlaniyor...</div>' +
            '</div>' +
            '<style>' +
                '.health-loader-ring{width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;margin:0 auto;animation:hlSpin 0.8s linear infinite;}' +
                '@keyframes hlSpin{to{transform:rotate(360deg)}}' +
            '</style>';

        var data = await this.fetchData();
        if (!this._isActive) return;

        var mainColor = self.getScoreColor(data.score);
        var mainGlow = self.getScoreGlow(data.score);
        var scoreLabel = self.getScoreLabel(data.score);

        var html = '';

        /* ============================================================
           STYLE — Premium animations
           ============================================================ */
        html += '<style>' +

            /* --- KEYFRAMES --- */
            '@keyframes hFadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }' +
            '@keyframes hSlideIn { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:translateX(0); } }' +
            '@keyframes hRingDraw { from { stroke-dasharray:0, 100; } }' +
            '@keyframes hGlow { 0%,100% { box-shadow:0 0 24px ' + mainGlow + ', 0 0 4px ' + mainGlow + ' inset; } 50% { box-shadow:0 0 48px ' + mainGlow + ', 0 0 8px ' + mainGlow + ' inset; } }' +
            '@keyframes hBarGrow { from { width:0%; } }' +
            '@keyframes hFloat { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-4px); } }' +
            '@keyframes hPulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }' +

            /* --- WRAP --- */
            '.health-wrap { max-width:960px; margin:0 auto; }' +

            /* --- HERO --- */
            '.health-hero {' +
                'background:linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);' +
                'border-radius:24px;' +
                'padding:40px 44px;' +
                'display:flex;' +
                'align-items:center;' +
                'justify-content:space-between;' +
                'flex-wrap:wrap;' +
                'gap:28px;' +
                'box-shadow:0 24px 80px rgba(15,23,42,0.35), 0 0 0 1px rgba(255,255,255,0.05) inset;' +
                'position:relative;' +
                'overflow:hidden;' +
                'animation:hFadeUp 0.6s ease-out;' +
            '}' +
            '.health-hero::before {' +
                'content:"";position:absolute;top:-60%;right:-15%;width:400px;height:400px;' +
                'background:radial-gradient(circle, ' + mainGlow + ' 0%, transparent 65%);' +
                'border-radius:50%;pointer-events:none;' +
            '}' +
            '.health-hero::after {' +
                'content:"";position:absolute;bottom:-40%;left:-10%;width:300px;height:300px;' +
                'background:radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 65%);' +
                'border-radius:50%;pointer-events:none;' +
            '}' +
            '.health-hero-info { flex:1; min-width:220px; position:relative; z-index:1; }' +
            '.health-hero-title { font-size:30px; font-weight:900; color:#fff; margin:0 0 8px 0; letter-spacing:-0.03em; }' +
            '.health-hero-sub { font-size:15px; color:rgba(255,255,255,0.55); margin:0; line-height:1.6; }' +
            '.health-hero-badge {' +
                'display:inline-flex; align-items:center; gap:7px; padding:7px 16px; border-radius:20px;' +
                'font-size:12px; font-weight:700; margin-top:14px; backdrop-filter:blur(8px);' +
                '-webkit-backdrop-filter:blur(8px);' +
            '}' +

            /* --- SCORE REASON --- */
            '.health-score-reason {' +
                'margin-top:14px; padding:12px 18px;' +
                'background:rgba(255,255,255,0.06);' +
                'border:1px solid rgba(255,255,255,0.08);' +
                'border-radius:12px;' +
                'font-size:13px; color:rgba(255,255,255,0.5); line-height:1.5;' +
                'font-weight:500; letter-spacing:0.01em;' +
                'animation:hFadeUp 0.8s ease-out 0.4s backwards;' +
            '}' +

            /* --- RING --- */
            '.health-ring-wrap {' +
                'position:relative; width:130px; height:130px; flex-shrink:0; z-index:1;' +
                'animation:hGlow 3s ease-in-out infinite;' +
                'border-radius:50%;' +
            '}' +
            '.health-ring-svg { width:130px; height:130px; transform:rotate(-90deg); filter:drop-shadow(0 0 8px ' + mainGlow + '); }' +
            '.health-ring-bg { fill:none; stroke:rgba(255,255,255,0.08); stroke-width:5; }' +
            '.health-ring-fill { fill:none; stroke-width:5; stroke-linecap:round; animation:hRingDraw 1.5s cubic-bezier(0.4,0,0.2,1) forwards; }' +
            '.health-ring-text { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }' +
            '.health-ring-score { font-size:36px; font-weight:900; color:#fff; line-height:1; }' +
            '.health-ring-label { font-size:11px; font-weight:700; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.1em; margin-top:4px; }' +

            /* --- SUB CARDS --- */
            '.health-subs { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-top:22px; }' +
            '.health-sub-card {' +
                'background:rgba(255,255,255,0.85);' +
                'backdrop-filter:blur(12px);' +
                '-webkit-backdrop-filter:blur(12px);' +
                'border-radius:18px;' +
                'padding:24px;' +
                'border:1px solid rgba(226,232,240,0.7);' +
                'box-shadow:0 4px 16px rgba(15,23,42,0.05);' +
                'transition:transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s;' +
                'animation:hFadeUp 0.5s ease-out backwards;' +
                'position:relative;' +
                'overflow:hidden;' +
            '}' +
            '.health-sub-card::after {' +
                'content:"";position:absolute;top:0;left:0;right:0;height:3px;border-radius:3px 3px 0 0;opacity:0;transition:opacity 0.2s;' +
            '}' +
            '.health-sub-card:hover { transform:translateY(-6px) scale(1.03); box-shadow:0 20px 48px rgba(15,23,42,0.14); }' +
            '.health-sub-card:hover::after { opacity:1; }' +
            '.health-sub-card:nth-child(1) { animation-delay:0.15s; }' +
            '.health-sub-card:nth-child(2) { animation-delay:0.25s; }' +
            '.health-sub-card:nth-child(3) { animation-delay:0.35s; }' +
            '.health-sub-card:nth-child(4) { animation-delay:0.45s; }' +
            '.health-sub-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }' +
            '.health-sub-icon { font-size:28px; animation:hFloat 3s ease-in-out infinite; }' +
            '.health-sub-icon:nth-child(1) { animation-delay:0s; }' +
            '.health-sub-score-num { font-size:28px; font-weight:900; transition:color 0.3s; }' +
            '.health-sub-label { font-size:13px; font-weight:700; color:#334155; margin-bottom:10px; letter-spacing:0.01em; }' +
            '.health-sub-bar { height:7px; background:#f1f5f9; border-radius:4px; overflow:hidden; margin-bottom:12px; }' +
            '.health-sub-bar-fill { height:100%; border-radius:4px; animation:hBarGrow 1s cubic-bezier(0.4,0,0.2,1) backwards; }' +
            '.health-sub-summary { font-size:12px; color:#64748b; line-height:1.5; }' +

            /* --- INSIGHTS --- */
            '.health-insights { margin-top:22px; }' +
            '.health-insights-title { font-size:20px; font-weight:800; color:#0f172a; margin:0 0 16px 0; letter-spacing:-0.01em; }' +
            '.health-insight {' +
                'display:flex;' +
                'align-items:flex-start;' +
                'gap:16px;' +
                'padding:20px 22px;' +
                'border-radius:16px;' +
                'border:1.5px solid;' +
                'margin-bottom:14px;' +
                'transition:transform 0.2s cubic-bezier(0.4,0,0.2,1), box-shadow 0.2s;' +
                'animation:hSlideIn 0.5s ease-out backwards;' +
                'position:relative;' +
            '}' +
            '.health-insight:nth-child(2) { animation-delay:0.12s; }' +
            '.health-insight:nth-child(3) { animation-delay:0.2s; }' +
            '.health-insight:nth-child(4) { animation-delay:0.28s; }' +
            '.health-insight:nth-child(5) { animation-delay:0.36s; }' +
            '.health-insight:nth-child(6) { animation-delay:0.44s; }' +
            '.health-insight:hover { transform:translateX(6px) translateY(-2px); box-shadow:0 8px 28px rgba(0,0,0,0.08); }' +
            '.health-insight-dot {' +
                'width:12px; height:12px; border-radius:50%; margin-top:4px; flex-shrink:0;' +
                'animation:hPulse 2s ease-in-out infinite;' +
            '}' +
            '.health-insight-body { flex:1; }' +
            '.health-insight-head { font-size:15px; font-weight:700; margin-bottom:5px; }' +
            '.health-insight-desc { font-size:13px; line-height:1.55; }' +
            '.health-insight-btn {' +
                'flex-shrink:0; align-self:center; padding:10px 20px; border:none; border-radius:12px;' +
                'font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap;' +
                'transition:transform 0.15s, box-shadow 0.15s;' +
                'box-shadow:0 2px 8px rgba(0,0,0,0.1);' +
            '}' +
            '.health-insight-btn:hover { transform:scale(1.04); box-shadow:0 4px 16px rgba(0,0,0,0.15); }' +

            /* --- IMPACT BADGE --- */
            '.health-insight-impact {' +
                'display:inline-flex; align-items:center; gap:6px;' +
                'margin-top:10px; padding:8px 14px;' +
                'background:linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);' +
                'border:1px solid #f59e0b33;' +
                'border-radius:10px;' +
                'font-size:12px; font-weight:700; color:#92400e;' +
                'line-height:1.4; letter-spacing:0.01em;' +
                'animation:hFadeUp 0.4s ease-out 0.3s backwards;' +
            '}' +
            '.health-insight-impact.critical {' +
                'background:linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);' +
                'border-color:#ef444433;' +
                'color:#991b1b;' +
            '}' +
            '.health-insight-impact.positive {' +
                'background:linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%);' +
                'border-color:#22c55e33;' +
                'color:#166534;' +
            '}' +

            /* --- EMPTY --- */
            '.health-empty {' +
                'background:linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);' +
                'border:1.5px dashed #cbd5e1; border-radius:18px; padding:48px 32px;' +
                'text-align:center; margin-top:22px; animation:hFadeUp 0.6s ease-out 0.3s backwards;' +
            '}' +

            /* --- FOOTER --- */
            '.health-footer {' +
                'margin-top:22px; background:#fff; border-radius:16px; border:1px solid #e2e8f0;' +
                'padding:18px 24px; display:flex; align-items:center; gap:10px;' +
                'box-shadow:0 2px 12px rgba(15,23,42,0.04); animation:hFadeUp 0.5s ease-out 0.5s backwards;' +
            '}' +

            /* --- RESPONSIVE --- */
            '@media (max-width:640px) {' +
                '.health-hero { padding:28px 22px; border-radius:20px; }' +
                '.health-hero-title { font-size:24px; }' +
                '.health-ring-wrap { width:100px; height:100px; }' +
                '.health-ring-svg { width:100px; height:100px; }' +
                '.health-ring-score { font-size:28px; }' +
                '.health-subs { grid-template-columns:1fr 1fr; gap:10px; }' +
                '.health-sub-card { padding:18px; }' +
            '}' +
        '</style>';

        /* ============================================================
           HERO
           ============================================================ */
        html += '<div class="health-wrap">';

        html += '<div class="health-hero">' +
            '<div class="health-hero-info">' +
                '<h2 class="health-hero-title">Saglik Raporu</h2>' +
                '<p class="health-hero-sub">' + data.summary + '</p>' +
                '<div class="health-hero-badge" style="background:' + mainColor + '20; color:' + mainColor + '; border:1px solid ' + mainColor + '33;">' +
                    '<span style="width:8px;height:8px;border-radius:50%;background:' + mainColor + ';box-shadow:0 0 6px ' + mainColor + ';"></span>' +
                    scoreLabel +
                '</div>' +
                '<div class="health-score-reason">' + data.scoreReason + '</div>' +
            '</div>' +
            '<div class="health-ring-wrap">' +
                '<svg class="health-ring-svg" viewBox="0 0 36 36">' +
                    '<circle class="health-ring-bg" cx="18" cy="18" r="15.5"></circle>' +
                    '<circle class="health-ring-fill" cx="18" cy="18" r="15.5" stroke="' + mainColor + '" stroke-dasharray="' + data.score + ', 100"></circle>' +
                '</svg>' +
                '<div class="health-ring-text">' +
                    '<div class="health-ring-score" id="healthMainScore">0</div>' +
                    '<div class="health-ring-label">/ 100</div>' +
                '</div>' +
            '</div>' +
        '</div>';

        /* ============================================================
           SUB CARDS
           ============================================================ */
        html += '<div class="health-subs">';
        for (var i = 0; i < data.subScores.length; i++) {
            var s = data.subScores[i];
            var sColor = self.getScoreColor(s.score);
            html += '<div class="health-sub-card" style="">' +
                '<div style="position:absolute;top:0;left:0;right:0;height:3px;background:' + sColor + ';border-radius:3px 3px 0 0;opacity:0;transition:opacity 0.2s;" class="health-sub-accent"></div>' +
                '<div class="health-sub-top">' +
                    '<span class="health-sub-icon">' + s.icon + '</span>' +
                    '<span class="health-sub-score-num" style="color:' + sColor + ';" data-target="' + s.score + '">0</span>' +
                '</div>' +
                '<div class="health-sub-label">' + s.label + '</div>' +
                '<div class="health-sub-bar">' +
                    '<div class="health-sub-bar-fill" style="width:' + s.score + '%;background:linear-gradient(90deg, ' + sColor + ' 0%, ' + sColor + 'cc 100%);animation-delay:' + (0.3 + i * 0.15) + 's;"></div>' +
                '</div>' +
                '<div class="health-sub-summary">' + s.summary + '</div>' +
            '</div>';
        }
        html += '</div>';

        /* ============================================================
           INSIGHTS
           ============================================================ */
        if (data.insights.length > 0) {
            html += '<div class="health-insights">' +
                '<h3 class="health-insights-title">Akilli Oneriler</h3>';

            for (var j = 0; j < data.insights.length; j++) {
                var ins = data.insights[j];
                var st = self.getInsightStyle(ins.type);

                var impactClass = (ins.type === 'danger' || ins.type === 'critical') ? ' critical' : (ins.type === 'success' ? ' positive' : '');
                var impactHtml = ins.impact ? '<div class="health-insight-impact' + impactClass + '">💰 ' + ins.impact + '</div>' : '';

                var priorityLabel = '';
                var priorityColor = '';
                if ((ins.priority || 0) > 5000) {
                    priorityLabel = 'KRITIK';
                    priorityColor = '#dc2626';
                } else if ((ins.priority || 0) > 1000) {
                    priorityLabel = 'ONEMLI';
                    priorityColor = '#d97706';
                } else {
                    priorityLabel = 'FIRSAT';
                    priorityColor = '#059669';
                }

                html += '<div class="health-insight" style="background:' + st.bg + '; border-color:' + st.border + '; box-shadow:0 4px 20px ' + st.glow + ';">' +
                    '<div class="health-insight-dot" style="background:' + st.dot + '; box-shadow:0 0 8px ' + st.dot + '44;"></div>' +
                    '<div class="health-insight-body">' +
                        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px;">' +
                            '<div class="health-insight-head" style="color:' + st.text + ';">' + ins.title + '</div>' +
                            '<span style="font-size:10px;font-weight:800;padding:4px 8px;border-radius:8px;background:' + priorityColor + '22;color:' + priorityColor + ';border:1px solid ' + priorityColor + '55;">' +
                                priorityLabel +
                            '</span>' +
                        '</div>' +
                        '<div class="health-insight-desc" style="color:' + st.text + 'cc;">' + ins.description + '</div>' +
                        impactHtml +
                    '</div>' +
                    '<button class="health-insight-btn" style="background:' + st.btnBg + '; color:' + st.btnText + ';" onclick="window.location.hash=\'' + ins.route + '\'">' +
                        ins.action + ' →' +
                    '</button>' +
                '</div>';
            }

            html += '</div>';
        } else if (data.hasData) {
            html += '<div class="health-empty">' +
                '<div style="font-size:36px;margin-bottom:14px;">✅</div>' +
                '<h3 style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:#334155;">Simdilik Oneri Yok</h3>' +
                '<p style="margin:0;font-size:14px;color:#64748b;">Her sey yolunda gorunuyor. Veri girdikce oneriler otomatik olusacak.</p>' +
            '</div>';
        } else {
            html += '<div class="health-empty">' +
                '<div style="font-size:36px;margin-bottom:14px;">📊</div>' +
                '<h3 style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:#334155;">Henuz Analiz Icin Yeterli Veri Yok</h3>' +
                '<p style="margin:0;font-size:14px;color:#64748b;">Satis, urun ve gider verileri girdikce akilli oneriler burada gorunecek.</p>' +
            '</div>';
        }

        /* ============================================================
           FOOTER
           ============================================================ */
        html += '<div class="health-footer">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:#6366f1;box-shadow:0 0 6px rgba(99,102,241,0.5);"></div>' +
            '<span style="font-size:13px;color:#94a3b8;font-weight:500;">Skorlar gercek verilerinize gore hesaplandi</span>' +
        '</div>';

        html += '</div>';

        container.innerHTML = html;

        // Cache kaydet (60 saniye TTL)
        if (window.ViewCache) {
            window.ViewCache.set(CACHE_KEY, { html: html, score: data.score }, 60000);
        }

        /* ============================================================
           POST-RENDER ANIMATIONS — counter animate
           ============================================================ */
        if (!self._isActive) return;

        // Main score counter
        self.animateCounter(document.getElementById('healthMainScore'), data.score, 1200);

        // Sub score counters
        var subNums = container.querySelectorAll('.health-sub-score-num');
        for (var k = 0; k < subNums.length; k++) {
            var target = parseInt(subNums[k].getAttribute('data-target'), 10) || 0;
            self.animateCounter(subNums[k], target, 1000 + k * 150);
        }

        // Sub card hover accent
        var subCards = container.querySelectorAll('.health-sub-card');
        for (var sc = 0; sc < subCards.length; sc++) {
            (function (card) {
                var accent = card.querySelector('.health-sub-accent');
                if (!accent) return;
                card.addEventListener('mouseenter', function () { accent.style.opacity = '1'; });
                card.addEventListener('mouseleave', function () { accent.style.opacity = '0'; });
            })(subCards[sc]);
        }
    }
};
