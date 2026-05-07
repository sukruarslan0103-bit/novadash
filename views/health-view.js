/* ============================================================
   HEALTH VIEW — Sağlık Raporu
   Tek veri kaynagi: AnalyticsService.getDashboardAnalytics()
   Direkt tablo sorgusu YOK. Hesap DB'de (RPC) yapilir,
   view sadece render eder.
   ============================================================ */

window.HealthView = {
    _listeners: [],
    _isActive: false,

    /* ============================================================
       DATA — tek RPC cagrisindan turetilmis skorlar
       ============================================================ */
    fetchData: async function () {
        var analytics;
        try {
            analytics = await window.AnalyticsService.getDashboardAnalytics();
        } catch (err) {
            console.warn('[health] analytics fetch failed:', err && err.message ? err.message : err);
            return {
                score: 0,
                summary: 'Analiz verisi alınamadı. Lütfen tekrar deneyin.',
                scoreReason: 'Sunucu verisi yok.',
                hasData: false,
                subScores: [
                    { key: 'financial', label: 'Finansal Sağlık',   icon: '💰', score: 0, summary: 'Veri yok' },
                    { key: 'sales',     label: 'Satış Performansı', icon: '📈', score: 0, summary: 'Veri yok' },
                    { key: 'product',   label: 'Ürün Verimliliği',  icon: '📦', score: 0, summary: 'Veri yok' },
                    { key: 'ops',       label: 'Operasyonel Düzen', icon: '⚙️', score: 0, summary: 'Veri yok' }
                ],
                insights: []
            };
        }

        var monthly = analytics.monthly || {};
        var daily   = analytics.daily   || {};
        var weekly  = analytics.weeklySales || [];
        var topProd = analytics.topProducts || [];
        var expCats = analytics.expenseCategories || [];
        var alerts  = analytics.alerts || [];
        var analysis = analytics.analysis || [];

        var monthlyRevenue = Number(monthly.ciro || 0);
        var monthlyExpense = Number(monthly.gider || 0);
        var monthlyProfit  = Number(monthly.kar || 0);
        var monthlyProfitMargin = monthlyRevenue > 0 ? (monthlyProfit / monthlyRevenue) * 100 : 0;
        var monthlyRevChange = Number(monthly.ciroChange || 0);
        var monthlyExpChange = Number(monthly.giderChange || 0);

        var hasData = monthlyRevenue > 0 || monthlyExpense > 0 || weekly.some(function (w) { return w.amount > 0; });

        // === SUB SCORES (analytics verisinden turetilir — ek query yok) ===

        // Finansal: kar marji
        var financialScore = 50;
        var finSummary = 'Veri bekleniyor';
        if (monthlyRevenue > 0) {
            if (monthlyProfitMargin >= 30) financialScore = 92;
            else if (monthlyProfitMargin >= 20) financialScore = 80;
            else if (monthlyProfitMargin >= 10) financialScore = 65;
            else if (monthlyProfitMargin >= 0) financialScore = 45;
            else financialScore = 20;
            finSummary = 'Kâr marjı %' + Math.round(monthlyProfitMargin);
        } else if (!hasData) {
            financialScore = 0;
        }

        // Satis: haftalik trend (son 3 gun vs onceki 3 gun)
        var salesScore = 50;
        var salesSummary = 'Veri bekleniyor';
        var weeklyTotal = 0;
        for (var wi = 0; wi < weekly.length; wi++) weeklyTotal += Number(weekly[wi].amount || 0);
        if (weekly.length >= 6) {
            var recent3 = 0, prev3 = 0;
            for (var ri = weekly.length - 3; ri < weekly.length; ri++) recent3 += Number(weekly[ri].amount || 0);
            for (var pi = weekly.length - 6; pi < weekly.length - 3; pi++) prev3 += Number(weekly[pi].amount || 0);
            if (prev3 > 0) {
                var ratio = recent3 / prev3;
                if (ratio >= 1.15) { salesScore = 90; salesSummary = 'Haftalık ciro yükselişte'; }
                else if (ratio >= 1.0) { salesScore = 75; salesSummary = 'Haftalık ciro stabil / artıyor'; }
                else if (ratio >= 0.85) { salesScore = 55; salesSummary = 'Haftalık ciro hafif düşüşte'; }
                else { salesScore = 30; salesSummary = 'Haftalık ciro belirgin düşüşte'; }
            } else if (recent3 > 0) {
                salesScore = 60;
                salesSummary = 'Son günlerde satış var';
            }
        } else if (weeklyTotal > 0) {
            salesScore = 60;
            salesSummary = Math.round(weeklyTotal) + ' TL son 7 gün';
        } else if (!hasData) {
            salesScore = 0;
        }

        // Urun: top urunlerin karlilik orani
        var productScore = 50;
        var prodSummary = 'Veri bekleniyor';
        if (topProd.length > 0) {
            var profitableCount = 0;
            var lossCount = 0;
            for (var tpi = 0; tpi < topProd.length; tpi++) {
                var tp = topProd[tpi];
                if (Number(tp.profit || 0) > 0) profitableCount++;
                else if (Number(tp.profit || 0) < 0) lossCount++;
            }
            var healthyPct = (profitableCount / topProd.length) * 100;
            if (healthyPct >= 90) productScore = 90;
            else if (healthyPct >= 70) productScore = 75;
            else if (healthyPct >= 50) productScore = 55;
            else productScore = 30;

            if (lossCount > 0) prodSummary = lossCount + ' popüler üründe kâr yok';
            else prodSummary = 'Popüler ürünler kârlı';
        } else if (!hasData) {
            productScore = 0;
        }

        // Ops: haftada kac gun satis var
        var opsScore = 50;
        var opsSummary = 'Veri bekleniyor';
        var activeDays = 0;
        for (var di = 0; di < weekly.length; di++) {
            if (Number(weekly[di].amount || 0) > 0) activeDays++;
        }
        if (weekly.length > 0) {
            if (activeDays >= 6) opsScore = 90;
            else if (activeDays >= 5) opsScore = 75;
            else if (activeDays >= 3) opsScore = 55;
            else if (activeDays > 0) opsScore = 35;
            else opsScore = !hasData ? 0 : 20;

            opsSummary = 'Son 7 günde ' + activeDays + ' gün satış';
        } else if (!hasData) {
            opsScore = 0;
        }

        // Ana skor = analytics.healthScore (RPC + buildHealthScore)
        var totalScore = Number(analytics.healthScore || 0);

        var summary = '';
        if (!hasData) summary = 'Henüz analiz için yeterli veri yok. Satış ve ürün girişi yapın.';
        else if (totalScore >= 80) summary = 'İşletmeniz çok iyi durumda. Böyle devam edin!';
        else if (totalScore >= 60) summary = 'İşletmeniz genel olarak sağlıklı. Bazı alanlar iyileştirilebilir.';
        else if (totalScore >= 40) summary = 'Dikkat edilmesi gereken alanlar var. Önerileri inceleyin.';
        else summary = 'İşletme sağlığı kritik seviyede. Acil aksiyon gerekiyor.';

        // Skor nedenleri
        var reasons = [];
        if (!hasData) {
            reasons.push('Henüz yeterli veri yok');
        } else {
            if (monthlyProfitMargin < 20 && monthlyRevenue > 0) {
                reasons.push('Kâr marjı düşük (%' + Math.round(monthlyProfitMargin) + ')');
            } else if (monthlyProfitMargin >= 30) {
                reasons.push('Kâr marjı sağlam (%' + Math.round(monthlyProfitMargin) + ')');
            }
            if (monthlyRevChange < -10) {
                reasons.push('Aylık ciro %' + Math.round(Math.abs(monthlyRevChange)) + ' düştü');
            } else if (monthlyRevChange > 10) {
                reasons.push('Aylık ciro %' + Math.round(monthlyRevChange) + ' arttı');
            }
            if (monthlyExpChange > 15) {
                reasons.push('Giderler %' + Math.round(monthlyExpChange) + ' arttı');
            }
            if (activeDays > 0 && weekly.length > 0 && activeDays < 4) {
                reasons.push('Son 7 günde sadece ' + activeDays + ' gün veri girişi');
            }
        }
        if (reasons.length === 0) {
            if (totalScore >= 70) reasons.push('Genel performans iyi görünüyor');
            else reasons.push('Daha fazla veri ile daha net analiz yapılabilir');
        }
        if (reasons.length > 3) reasons.length = 3;
        var scoreReason = reasons.join('. ') + '.';

        // Insight listesi: alerts + analysis'i ortak formata topla
        var insights = [];

        // Alerts
        for (var ai = 0; ai < alerts.length; ai++) {
            var a = alerts[ai];
            insights.push({
                type: a.type || 'warning',
                title: a.text || '',
                description: '',
                action: 'Detaylı İncele',
                route: '#dashboard',
                impact: '',
                priority: a.type === 'danger' ? 100000 : (a.type === 'warning' ? 10000 : 1000)
            });
        }

        // Top urunler / top gider uzerinden spesifik oneriler
        if (expCats.length > 0) {
            var topExp = expCats[0];
            insights.push({
                type: 'warning',
                title: topExp.name + ' kategorisi aylık ' + Math.round(Number(topExp.amount || 0)) + ' TL',
                description: 'En yüksek gider kalemi. Optimizasyon potansiyeli var.',
                action: 'Giderleri İncele',
                route: '#expenses',
                impact: 'Aylık ' + Math.round(Number(topExp.amount || 0)) + ' TL',
                priority: 5000 + Number(topExp.amount || 0)
            });
        }

        if (topProd.length > 0) {
            var bestProd = topProd[0];
            insights.push({
                type: 'success',
                title: bestProd.name + ': Ayın Lideri (' + Math.round(bestProd.sales) + ' adet)',
                description: 'Aylık ciro: ' + Math.round(Number(bestProd.revenue || 0)) + ' TL. Stok ve tedariği güvende tut.',
                action: 'Ürünü İncele',
                route: '#products',
                impact: '+' + Math.round(Number(bestProd.profit || 0)) + ' TL aylık kâr',
                priority: 1500 + Number(bestProd.profit || 0)
            });

            // Zarar eden populer urun
            for (var tpj = 0; tpj < topProd.length; tpj++) {
                var tpl = topProd[tpj];
                if (Number(tpl.profit || 0) < 0) {
                    insights.push({
                        type: 'danger',
                        title: tpl.name + ': zarar yazıyor',
                        description: Math.round(tpl.sales) + ' adet satılmış, net ' + Math.round(Number(tpl.profit || 0)) + ' TL.',
                        action: 'Fiyatı Güncelle',
                        route: '#products',
                        impact: Math.round(Math.abs(Number(tpl.profit || 0))) + ' TL zarar',
                        priority: 50000 + Math.abs(Number(tpl.profit || 0))
                    });
                }
            }
        }

        // Analysis'ten turetilmis bilgi kartlari
        for (var ani = 0; ani < analysis.length; ani++) {
            var an = analysis[ani];
            insights.push({
                type: 'success',
                title: an.title,
                description: an.text,
                action: 'Detay Gör',
                route: '#dashboard',
                impact: '',
                priority: 500
            });
        }

        // Priority sort
        var typeWeight = { danger: 100000, warning: 10000, success: 1000 };
        insights.sort(function (x, y) {
            var wa = (typeWeight[x.type] || 0) + (x.priority || 0);
            var wb = (typeWeight[y.type] || 0) + (y.priority || 0);
            return wb - wa;
        });

        // ============================================================
        // RULE: Genel "En Büyük Gider" varsa, aynı bilgiyi tekrar eden
        // kategori-bazlı insight ("X kategorisi aylık Y TL") düşürülür.
        // Yönetici dili tercih edilir → "bildirim çöplüğü" hissi yok.
        // ============================================================
        var hasGenericTopCost = insights.some(function (ins) {
            var t = String(ins.title || '').toLowerCase()
                .replace(/İ/g, 'i').replace(/I/g, 'ı');
            return /büyük\s+gider|en\s+büyük/.test(t);
        });
        if (hasGenericTopCost) {
            insights = insights.filter(function (ins) {
                var t = String(ins.title || '').toLowerCase()
                    .replace(/İ/g, 'i').replace(/I/g, 'ı');
                // expCats[0] tarzı "X kategorisi aylık Y TL" pattern düşürülür
                return !/kategorisi\s+aylık/.test(t);
            });
        }

        // ============================================================
        // ROUTE INFERENCE (alerts + analysis için)
        // alerts/analysis genel başlıklı geliyor; metinden ilgili tab'a yönlendir.
        // Eşleşme yoksa null → CTA hide + cursor default (fake nav yasak).
        // ============================================================
        var inferRoute = function (text) {
            var t = (text || '').toLowerCase();
            // Türkçe lowercase için manuel: I→ı, İ→i, Ş, Ç...
            t = t.replace(/İ/g, 'i').replace(/I/g, 'ı');
            if (/(kira|elektrik|gider|kategori|fatura|yakıt|enerji)/.test(t)) return '#expenses';
            if (/(satış|sat[ıi]ş|ciro|gelir|hasilat)/.test(t))                 return '#sales';
            if (/(ürün|reçete|stok|maliyet|hammadde|hammade)/.test(t))         return '#products';
            return null;
        };

        for (var ri = 0; ri < insights.length; ri++) {
            var ins = insights[ri];
            // Sadece generic '#dashboard' + alerts/analysis kaynaklılar üzerinden infer et
            if (ins.route === '#dashboard') {
                var inferred = inferRoute(ins.title + ' ' + (ins.description || ''));
                ins.route = inferred; // null ise CTA gizlenir
            }
        }

        // ============================================================
        // INSIGHT DEDUP — duplicate / overlap normalize
        //   Kural 1: Aynı topic'i farklı kaynaklardan tekrarlama
        //   Kural 2: ≥2 ortak content word'lü insight'ları merge et
        //            (yüksek priority kalır, düşük düşer)
        // ============================================================
        var STOP = {};
        ['ürün','ürünü','urun','aylık','aylik','tl','adet','satış','sat[ıi]ş','satışı','gider','giderler',
         'kategori','kategorisi','toplam','yüksek','düşük','üzeri','altı','arttı','düştü','sonra','önce',
         'için','olarak','daha','en','bir','bu','şu','o','ile','ve','veya','ayın','güçlü','aktif','net']
            .forEach(function (w) { STOP[w] = true; });

        var normalizeWords = function (s) {
            return String(s || '')
                .toLowerCase()
                .replace(/İ/g, 'i').replace(/I/g, 'ı')
                .replace(/[^a-zçğıöşü0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(function (w) { return w.length >= 4 && !STOP[w]; });
        };

        var dedupInsights = [];
        var usedTagSets = [];

        for (var di = 0; di < insights.length; di++) {
            var item = insights[di];
            var tags = normalizeWords(item.title);
            var tagSet = {};
            tags.forEach(function (w) { tagSet[w] = true; });

            // Mevcut kabul edilenlerle ortak word kontrolü
            var dup = false;
            for (var ui = 0; ui < usedTagSets.length; ui++) {
                var prev = usedTagSets[ui];
                var intersect = 0;
                for (var k in tagSet) {
                    if (prev[k]) intersect++;
                }
                // ≥2 ortak content word → duplicate
                // Veya çok kısa başlıklarda (≤2 word) tek ortak da duplicate kabul edilir
                var sizeA = Object.keys(tagSet).length;
                var sizeB = Object.keys(prev).length;
                if (intersect >= 2) { dup = true; break; }
                if (intersect >= 1 && (sizeA <= 2 || sizeB <= 2)) { dup = true; break; }
            }

            if (!dup) {
                dedupInsights.push(item);
                usedTagSets.push(tagSet);
            }
        }

        insights = dedupInsights;
        if (insights.length > 5) insights.length = 5;

        return {
            score: totalScore,
            summary: summary,
            scoreReason: scoreReason,
            hasData: hasData,
            subScores: [
                { key: 'financial', label: 'Finansal Sağlık',   icon: '💰', score: financialScore, summary: finSummary },
                { key: 'sales',     label: 'Satış Performansı', icon: '📈', score: salesScore,     summary: salesSummary },
                { key: 'product',   label: 'Ürün Verimliliği',  icon: '📦', score: productScore,   summary: prodSummary },
                { key: 'ops',       label: 'Operasyonel Düzen', icon: '⚙️', score: opsScore,       summary: opsSummary }
            ],
            insights: insights
        };
    },

    /* ============================================================
       HELPERS
       ============================================================ */
    // 4-katmanlı sağlık paleti (yeni mapping)
    //   0–49   → kırmızı  (kritik)
    //   50–74  → amber    (izlenmeli)
    //   75–89  → mavi     (stabil)
    //   90–100 → yeşil    (mükemmel)
    getScoreColor: function (score) {
        if (score >= 90) return '#16a34a'; // yeşil
        if (score >= 75) return '#2563eb'; // mavi
        if (score >= 50) return '#d97706'; // amber
        return '#dc2626';                  // kırmızı
    },

    getScoreGlow: function (score) {
        if (score >= 90) return 'rgba(22,163,74,0.24)';
        if (score >= 75) return 'rgba(37,99,235,0.24)';
        if (score >= 50) return 'rgba(217,119,6,0.24)';
        return 'rgba(220,38,38,0.24)';
    },

    // 4-katmanlı palet ile hizalı status etiketi
    getScoreLabel: function (score) {
        if (score >= 90) return 'Mükemmel';
        if (score >= 75) return 'Stabil';
        if (score >= 50) return 'İzlenmeli';
        return 'Kritik';
    },

    getInsightStyle: function (type) {
        if (type === 'danger')  return { bg: 'linear-gradient(135deg, #fef2f2 0%, #fff5f5 100%)', border: '#fca5a5', dot: '#dc2626', text: '#991b1b', btnBg: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)', btnText: '#fff', glow: 'rgba(220,38,38,0.048)' };
        if (type === 'warning') return { bg: 'linear-gradient(135deg, #fffbeb 0%, #fefce8 100%)', border: '#fcd34d', dot: '#d97706', text: '#92400e', btnBg: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', btnText: '#fff', glow: 'rgba(217,119,6,0.048)' };
        return                         { bg: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)', border: '#86efac', dot: '#059669', text: '#166534', btnBg: 'linear-gradient(135deg, #059669 0%, #047857 100%)', btnText: '#fff', glow: 'rgba(5,150,105,0.048)' };
    },

    animateCounter: function (el, target, duration) {
        if (!el) return;
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
        // Panel açıksa kapat ve listener'ı temizle
        try { this.closeKpiPanel(); } catch (e) { /* noop */ }
        // Body scroll kilidi açık kaldıysa serbest bırak
        document.body.style.overflow = '';
    },

    _injectLoaderStyle: function () {
        if (document.getElementById('health-loader-style')) return;
        var st = document.createElement('style');
        st.id = 'health-loader-style';
        st.textContent =
            '.health-loader-ring{width:48px;height:48px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;margin:0 auto;animation:hlSpin 0.8s linear infinite;}' +
            '@keyframes hlSpin{to{transform:rotate(360deg)}}';
        document.head.appendChild(st);
    },

    /* ============================================================
       NABIZ — KPI KEY → CTA ROUTE MAP & ETKI TURETME
       (Backend dokunulmadi; sadece UI metni & yonlendirme)
       ============================================================ */
    // KPI → Route mapping. ops için anlamlı detay ekranı yok → null (CTA gizli).
    _kpiRoute: { financial: '#expenses', sales: '#sales', product: '#products', ops: null },

    _kpiEffect: function (key, score) {
        if (key === 'financial') {
            if (score < 50) return 'Maliyet baskısı yüksek';
            if (score < 70) return 'Kâr marjı izlenmeli';
            return 'Finansal denge sağlam';
        }
        if (key === 'sales') {
            if (score < 50) return 'Satış momentumu zayıf';
            if (score < 70) return 'Satış stabil seyirde';
            return 'Satış trendi olumlu';
        }
        if (key === 'product') {
            if (score < 50) return 'Ürün karması zayıf';
            if (score < 70) return 'Karlı ürün çeşitliliği orta';
            return 'Karlı ürün karması güçlü';
        }
        if (key === 'ops') {
            if (score < 50) return 'Operasyonel risk var';
            if (score < 70) return 'İşlem ritmi düzensiz';
            return 'İşlem disiplini sağlam';
        }
        return '';
    },

    /* ============================================================
       KPI DETAY PANELİ — AI check-up katmanı
       Backend dokunulmadı; mevcut data.subScores + data.insights'tan
       yönetici dili + 4 katmanlı paletle açıklama türetilir.
       ============================================================ */

    _lastKpiData: null,

    _kpiNarrative: function (s, data) {
        var key = s.key;
        var score = Number(s.score) || 0;
        var hasData = !!(data && data.hasData);
        var insights = (data && data.insights) || [];

        // === Headline: tek güçlü AI özet cümlesi ===
        var headline = '';
        if (!hasData) {
            headline = 'Bu kategori için yeterli veri henüz oluşmadı; analiz kısıtlı kalıyor.';
        } else if (key === 'financial') {
            if (score < 50)      headline = 'Kâr marjı baskı altında olduğu için finansal sağlık zayıf görünüyor.';
            else if (score < 75) headline = 'Finansal yapı stabil, ancak izlenmesi gereken alanlar var.';
            else if (score < 90) headline = 'Finansal denge sağlam, kâr marjı sürdürülebilir görünüyor.';
            else                 headline = 'Finansal sağlık güçlü, kârlılık örnek seviyede.';
        } else if (key === 'sales') {
            if (score < 50)      headline = 'Satış momentumu zayıf seyrediyor, haftalık ciro düşük.';
            else if (score < 75) headline = 'Satış trendi stabil; momentum kazanmak için fırsat var.';
            else if (score < 90) headline = 'Satış trendi olumlu, momentum güçlü ilerliyor.';
            else                 headline = 'Satış performansı çok güçlü, trend istikrarlı yukarı.';
        } else if (key === 'product') {
            if (score < 50)      headline = 'Ürün karması zayıf, popüler ürünlerde kârlılık sorunu olabilir.';
            else if (score < 75) headline = 'Ürün karması orta seviyede, kârlılık dengesi iyileştirilebilir.';
            else if (score < 90) headline = 'Karlı ürün karması güçlü, lider ürünler verimli çalışıyor.';
            else                 headline = 'Ürün portföyü mükemmel kârlılık üretiyor.';
        } else if (key === 'ops') {
            // Ops için sakin dil — gerçek operasyon datası sınırlı
            if (score < 50)      headline = 'İşlem ritmi düzensiz; veri akışı stabil değil.';
            else if (score < 75) headline = 'İşlem akışı genel olarak düzenli, ufak boşluklar var.';
            else                 headline = 'İşlem disiplini sağlam, veri akışı tutarlı.';
        }

        // === Genel Durum: 1-2 cümle ===
        var generalState = '';
        if (!hasData) {
            generalState = 'Daha fazla veri girişiyle bu alanın analizi netleşecek.';
        } else if (key === 'financial') {
            if (score < 50)      generalState = 'Maliyet/ciro dengesi bozuk; kâr üretimi şu an sınırlı.';
            else if (score < 75) generalState = 'Kâr marjı kabul edilebilir seviyede, ancak gider kontrolü kritik.';
            else                 generalState = 'Maliyet/kâr dengesi sağlıklı şekilde işliyor.';
        } else if (key === 'sales') {
            if (score < 50)      generalState = 'Haftalık ciro hedeflerin altında ve trend zayıf.';
            else if (score < 75) generalState = 'Satışlar düzenli, ancak belirgin bir momentum yok.';
            else                 generalState = 'Düzenli satış akışı + olumlu trend birlikte çalışıyor.';
        } else if (key === 'product') {
            if (score < 50)      generalState = 'Popüler ürünlerin önemli bir kısmı kâr üretmiyor olabilir.';
            else if (score < 75) generalState = 'Ürün karması orta seviyede dengeli görünüyor.';
            else                 generalState = 'Lider ürünler sağlıklı kâr marjı koruyor.';
        } else if (key === 'ops') {
            if (score < 50)      generalState = 'Veri girişi düzensiz ilerliyor; analiz kalitesi etkileniyor.';
            else if (score < 75) generalState = 'Veri akışı genel olarak istikrarlı.';
            else                 generalState = 'İşlem disiplini istikrarlı, akış kesintisiz.';
        }

        // === Insight filtreleme (KPI key'ine göre) ===
        var KEYWORDS = {
            financial: /(kâr|kar|marj|gider|maliyet|kategori|kira|elektrik|fatura|ciro|gelir)/i,
            sales:     /(satış|sat[ıi]ş|ciro|gelir|trend|hafta|gün|momentum)/i,
            product:   /(ürün|reçete|stok|tedarik|lider|zarar|marj)/i,
            ops:       /(gün|veri|akış|düzen|girdi|giriş|işlem)/i
        };
        var pattern = KEYWORDS[key] || null;

        var weakeners = [];
        var strengtheners = [];

        insights.forEach(function (ins) {
            var t = String(ins.title || '');
            if (!t) return;
            if (pattern && !pattern.test(t)) return;
            if (ins.type === 'success') strengtheners.push(t);
            else weakeners.push(t);
        });

        // s.summary'i kontrollü ekle
        if (s.summary && s.summary !== 'Veri bekleniyor') {
            if (score < 70 && weakeners.indexOf(s.summary) === -1) {
                weakeners.unshift(s.summary);
            } else if (score >= 70 && strengtheners.indexOf(s.summary) === -1) {
                strengtheners.unshift(s.summary);
            }
        }

        weakeners = weakeners.slice(0, 3);
        strengtheners = strengtheners.slice(0, 3);

        // === Olası Risk ===
        var risk = '';
        if (!hasData) {
            risk = 'Veri eksikliği analiz kalitesini düşürür.';
        } else if (key === 'financial') {
            if (score < 50)      risk = 'Maliyet baskısı devam ederse kârlılık düşebilir.';
            else if (score < 75) risk = 'Kâr marjını korumak için gider takibi kritik.';
            else                 risk = 'Mevcut denge korunmalı; ani gider artışlarına dikkat.';
        } else if (key === 'sales') {
            if (score < 50)      risk = 'Trend devam ederse aylık hedefler riske girer.';
            else if (score < 75) risk = 'Momentum kaybedilmemeli, satış kanalları izlenmeli.';
            else                 risk = 'Sezonsal düşüşlere karşı hazırlıklı olunmalı.';
        } else if (key === 'product') {
            if (score < 50)      risk = 'Zarar yazan ürünler aylık kârı eritebilir.';
            else if (score < 75) risk = 'Düşük marjlı ürünler portföyü baskılayabilir.';
            else                 risk = 'Lider ürünün stok/tedarik kesintisi büyük etki yaratır.';
        } else if (key === 'ops') {
            if (score < 50)      risk = 'Veri eksikliği analiz kalitesini düşürür.';
            else if (score < 75) risk = 'Veri girişi düzeni bozulursa raporlar sapar.';
            else                 risk = 'Mevcut akış korunmalı; düzensizliğe izin verilmemeli.';
        }

        // === Önerilen Aksiyonlar (yönetici dili) ===
        var actions = [];
        if (!hasData) {
            actions = ['Düzenli satış ve gider verisi gir', 'Birkaç günlük veriyle analiz netleşir'];
        } else if (key === 'financial') {
            if (score < 75) {
                actions = ['Yüksek gider kategorilerini incele', 'Ürün fiyatlarını maliyet üzerinden gözden geçir', 'Kâr marjı düşük ürünleri analiz et'];
            } else {
                actions = ['Mevcut gider trendini izlemeye devam et', 'Marjı koruyacak fiyat politikasını sürdür'];
            }
        } else if (key === 'sales') {
            if (score < 75) {
                actions = ['Düşük günleri tespit edip aksiyon kur', 'Müşteri akışı için kampanya değerlendir', 'Satış kanallarını gözden geçir'];
            } else {
                actions = ['Mevcut satış stratejisini koru', 'Trendi düzenli takip et'];
            }
        } else if (key === 'product') {
            if (score < 75) {
                actions = ['Zarar yazan ürünleri tespit et', 'Maliyet/fiyat dengesini ürün bazında kontrol et', 'Reçete maliyetlerini güncel tut'];
            } else {
                actions = ['Lider ürünlerin stoğunu güvende tut', 'Ürün performansını haftalık izle'];
            }
        } else if (key === 'ops') {
            if (score < 75) {
                actions = ['Günlük satış girişini düzenli yap', 'Eksik gün varsa geriye dönük tamamla', 'Veri akışını alışkanlık haline getir'];
            } else {
                actions = ['Düzenli veri girişini sürdür'];
            }
        }
        actions = actions.slice(0, 3);

        return {
            headline: headline,
            generalState: generalState,
            weakeners: weakeners,
            strengtheners: strengtheners,
            risk: risk,
            actions: actions
        };
    },

    _buildKpiPanel: function (s, data) {
        var n = this._kpiNarrative(s, data);
        var color = this.getScoreColor(s.score);
        var label = this.getScoreLabel(s.score);
        var route = this._kpiRoute[s.key]; // null olabilir → CTA gizli

        var weakHtml = n.weakeners.length
            ? n.weakeners.map(function (t) {
                return '<div class="hp-factor weak"><span class="hp-factor-dot"></span><span>' + t + '</span></div>';
              }).join('')
            : '<div class="hp-factor empty">Bu kategoride şu an belirgin sorun tespit edilmedi.</div>';

        var strongHtml = n.strengtheners.length
            ? n.strengtheners.map(function (t) {
                return '<div class="hp-factor strong"><span class="hp-factor-dot"></span><span>' + t + '</span></div>';
              }).join('')
            : '<div class="hp-factor empty">Şu an belirgin güçlü taraf öne çıkmıyor.</div>';

        var actionsHtml = n.actions.length
            ? n.actions.map(function (t) {
                return '<div class="hp-action"><span class="hp-action-arrow">→</span><span>' + t + '</span></div>';
              }).join('')
            : '';

        var ctaHtml = route
            ? '<div class="hp-cta-row"><button class="hp-cta" onclick="window.HealthView._navigateFromPanel(\'' + route + '\')">İlgili Ekrana Git</button></div>'
            : '';

        return '<div class="hp-inner">' +
            '<button class="hp-close" onclick="window.HealthView.closeKpiPanel()" aria-label="Kapat">×</button>' +

            '<div class="hp-header">' +
                '<span class="hp-header-icon">' + s.icon + '</span>' +
                '<span class="hp-header-label">' + s.label + '</span>' +
            '</div>' +

            '<div class="hp-score-row">' +
                '<span class="hp-score-num" style="color:' + color + ';">' + s.score + '</span>' +
                '<span class="hp-score-dot" style="background:' + color + ';"></span>' +
                '<span class="hp-score-status" style="color:' + color + ';">' + label + '</span>' +
            '</div>' +
            '<div class="hp-progress">' +
                '<div class="hp-progress-fill" style="width:' + s.score + '%;background:' + color + ';"></div>' +
            '</div>' +

            '<div class="hp-headline">' + n.headline + '</div>' +

            '<div class="hp-section">' +
                '<div class="hp-section-title">Genel Durum</div>' +
                '<div style="font-size:13.5px;color:#334155;line-height:1.6;font-weight:500;">' + n.generalState + '</div>' +
            '</div>' +

            '<div class="hp-section">' +
                '<div class="hp-section-title">Skoru Düşüren Faktörler</div>' +
                weakHtml +
            '</div>' +

            '<div class="hp-section">' +
                '<div class="hp-section-title">Skoru Güçlendiren Faktörler</div>' +
                strongHtml +
            '</div>' +

            (n.risk ? '<div class="hp-section">' +
                '<div class="hp-section-title">Olası Risk</div>' +
                '<div class="hp-risk">' + n.risk + '</div>' +
            '</div>' : '') +

            (actionsHtml ? '<div class="hp-section">' +
                '<div class="hp-section-title">Önerilen Aksiyonlar</div>' +
                actionsHtml +
            '</div>' : '') +

            ctaHtml +
        '</div>';
    },

    openKpiPanel: function (key) {
        var self = this;
        if (!self._lastKpiData) return;
        var subs = (self._lastKpiData.subScores || []);
        var s = subs.find ? subs.find(function (x) { return x.key === key; }) : null;
        if (!s) {
            for (var i = 0; i < subs.length; i++) {
                if (subs[i].key === key) { s = subs[i]; break; }
            }
        }
        if (!s) return;

        self._injectPanelStyle();

        var backdrop = document.getElementById('hpBackdrop');
        var panel = document.getElementById('hpPanel');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'hpBackdrop';
            backdrop.className = 'hp-backdrop';
            backdrop.onclick = function () { self.closeKpiPanel(); };
            document.body.appendChild(backdrop);
        }
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'hpPanel';
            panel.className = 'hp-panel';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-modal', 'true');
            document.body.appendChild(panel);
        }

        panel.innerHTML = self._buildKpiPanel(s, self._lastKpiData);

        requestAnimationFrame(function () {
            backdrop.classList.add('open');
            panel.classList.add('open');
        });

        document.body.style.overflow = 'hidden';

        self._panelEscHandler = function (e) {
            if (e.key === 'Escape') self.closeKpiPanel();
        };
        document.addEventListener('keydown', self._panelEscHandler);
    },

    closeKpiPanel: function () {
        var backdrop = document.getElementById('hpBackdrop');
        var panel = document.getElementById('hpPanel');
        if (backdrop) backdrop.classList.remove('open');
        if (panel) panel.classList.remove('open');
        document.body.style.overflow = '';
        if (this._panelEscHandler) {
            document.removeEventListener('keydown', this._panelEscHandler);
            this._panelEscHandler = null;
        }
    },

    _navigateFromPanel: function (route) {
        this.closeKpiPanel();
        // Slide-out animasyonunun bitmesini bekle, sonra route
        setTimeout(function () { window.location.hash = route; }, 220);
    },

    _injectPanelStyle: function () {
        if (document.getElementById('health-panel-style')) return;
        var st = document.createElement('style');
        st.id = 'health-panel-style';
        st.textContent =
            '@keyframes hpItemFade { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }' +

            '.hp-backdrop {' +
                'position:fixed; inset:0; z-index:9998;' +
                'background:rgba(15,23,42,0.45);' +
                'backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px);' +
                'opacity:0; transition:opacity 0.25s ease;' +
                'pointer-events:none;' +
            '}' +
            '.hp-backdrop.open { opacity:1; pointer-events:auto; }' +

            '.hp-panel {' +
                'position:fixed; right:0; top:0; bottom:0; z-index:9999;' +
                'width:480px; max-width:100vw;' +
                'background:#ffffff;' +
                'box-shadow:-20px 0 60px rgba(15,23,42,0.18);' +
                'transform:translateX(100%);' +
                'transition:transform 0.32s cubic-bezier(0.4,0,0.2,1);' +
                'overflow-y:auto; overflow-x:hidden;' +
                'will-change:transform;' +
            '}' +
            '.hp-panel.open { transform:translateX(0); }' +

            '.hp-inner { padding:32px 28px 32px; }' +

            '.hp-close {' +
                'width:34px; height:34px; border:none; background:#f1f5f9; color:#475569;' +
                'border-radius:10px; cursor:pointer; font-size:20px; font-weight:700;' +
                'display:flex; align-items:center; justify-content:center;' +
                'margin-left:auto; margin-bottom:14px;' +
                'transition:background 0.18s ease;' +
            '}' +
            '.hp-close:hover { background:#e2e8f0; }' +

            '.hp-header { display:flex; align-items:center; gap:10px; margin-bottom:6px; }' +
            '.hp-header-icon { font-size:20px; }' +
            '.hp-header-label { font-size:11px; font-weight:800; color:#94a3b8; letter-spacing:0.10em; text-transform:uppercase; }' +

            '.hp-score-row {' +
                'display:flex; align-items:center; gap:14px;' +
                'padding:16px 20px; margin:14px 0 4px;' +
                'background:linear-gradient(180deg, #fafbfc 0%, #f8fafc 100%);' +
                'border:1px solid #eef2f7;' +
                'border-radius:14px;' +
            '}' +
            '.hp-score-num { font-size:42px; font-weight:900; letter-spacing:-0.03em; line-height:1; font-feature-settings:"tnum" 1, "lnum" 1; }' +
            '.hp-score-status { font-size:13.5px; font-weight:700; letter-spacing:-0.005em; }' +
            '.hp-score-dot { width:8px; height:8px; border-radius:50%; }' +

            '.hp-progress { height:4px; background:#f1f5f9; border-radius:999px; margin:14px 0 22px; overflow:hidden; }' +
            '.hp-progress-fill { height:100%; border-radius:999px; transition:width 0.6s cubic-bezier(0.4,0,0.2,1); }' +

            '.hp-headline {' +
                'font-size:15px; font-weight:600; color:#0f172a; line-height:1.55;' +
                'padding:14px 16px; margin-bottom:24px;' +
                'background:#fafbfc; border-left:3px solid #cbd5e1;' +
                'border-radius:0 10px 10px 0;' +
                'animation:hpItemFade 0.4s ease-out 0.1s backwards;' +
            '}' +

            '.hp-section { margin-bottom:22px; animation:hpItemFade 0.4s ease-out 0.16s backwards; }' +
            '.hp-section-title {' +
                'font-size:11px; font-weight:800; color:#64748b;' +
                'letter-spacing:0.10em; text-transform:uppercase; margin-bottom:10px;' +
                'display:flex; align-items:center; gap:10px;' +
            '}' +
            '.hp-section-title::after { content:""; flex:1; height:1px; background:linear-gradient(to right, #e2e8f0, transparent); }' +

            '.hp-factor { display:flex; align-items:flex-start; gap:10px; padding:7px 0; font-size:13.5px; color:#0f172a; line-height:1.5; font-weight:500; }' +
            '.hp-factor-dot { width:6px; height:6px; border-radius:50%; margin-top:7px; flex-shrink:0; }' +
            '.hp-factor.weak  .hp-factor-dot { background:#dc2626; }' +
            '.hp-factor.strong .hp-factor-dot { background:#16a34a; }' +
            '.hp-factor.empty { color:#94a3b8; font-style:italic; font-size:12.5px; }' +

            '.hp-risk {' +
                'padding:13px 16px; background:#fffbeb; border:1px solid #fde68a;' +
                'border-radius:12px; font-size:13px; font-weight:500; color:#78350f; line-height:1.55;' +
            '}' +

            '.hp-action { display:flex; align-items:flex-start; gap:10px; padding:8px 0; font-size:13.5px; color:#0f172a; font-weight:600; line-height:1.5; }' +
            '.hp-action-arrow { color:#64748b; font-weight:700; flex-shrink:0; }' +

            '.hp-cta-row { margin-top:8px; }' +
            '.hp-cta {' +
                'display:flex; align-items:center; justify-content:center; gap:8px;' +
                'width:100%; padding:14px 18px;' +
                'background:#0f172a; color:#fff; border:none; border-radius:12px;' +
                'font-size:14px; font-weight:700; cursor:pointer;' +
                'letter-spacing:-0.01em;' +
                'transition:transform 0.15s ease, box-shadow 0.18s ease;' +
                'box-shadow:0 1px 2px rgba(15,23,42,0.06), 0 4px 14px -6px rgba(15,23,42,0.18);' +
                'font-family:inherit;' +
            '}' +
            '.hp-cta:hover { transform:translateY(-1px); box-shadow:0 2px 6px rgba(15,23,42,0.08), 0 8px 20px -8px rgba(15,23,42,0.22); }' +

            '@media (max-width:560px) {' +
                '.hp-panel { width:100vw; }' +
                '.hp-inner { padding:24px 18px 24px; }' +
                '.hp-score-num { font-size:34px; }' +
                '.hp-score-row { padding:14px 16px; }' +
                '.hp-headline { font-size:14px; padding:12px 14px; }' +
            '}' +

            '@media (prefers-reduced-motion: reduce) {' +
                '.hp-panel, .hp-backdrop, .hp-progress-fill, .hp-section, .hp-headline { transition:none !important; animation:none !important; }' +
            '}';
        document.head.appendChild(st);
    },

    _injectMainStyle: function () {
        // v3 — premium NABIZ atmosfer: scan sweep, ring halo, floating stripe, action center
        var oldV2 = document.getElementById('health-main-style');
        if (oldV2 && oldV2.parentNode) oldV2.parentNode.removeChild(oldV2);
        if (document.getElementById('health-main-style-v3')) return;
        var st = document.createElement('style');
        st.id = 'health-main-style-v3';
        st.textContent =
            '@keyframes hFadeUp { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }' +
            '@keyframes hRingDraw { from { stroke-dasharray:0, 100; } }' +
            '@keyframes hBarGrow { from { width:0%; } }' +

            // === ATMOSFER ANIMASYONLARI ===
            '@keyframes hScanSweep { 0%{transform:translateY(-8%);opacity:0;} 18%{opacity:0.16;} 70%{opacity:0.10;} 100%{transform:translateY(108%);opacity:0;} }' +
            // Organik nefes — neredeyse hissedilmez, 4s yavaş
            '@keyframes hRingBreath { 0%,100%{transform:scale(1);} 50%{transform:scale(1.018);} }' +
            // İç halo: sıcak, sakin nefes
            '@keyframes hHaloInner  { 0%,100%{opacity:0.55;} 50%{opacity:0.85;} }' +
            // Dış halo: ultra soft, gecikmeli
            '@keyframes hHaloOuter  { 0%,100%{opacity:0.30;} 50%{opacity:0.55;} }' +
            '@keyframes hCriticalPulse { 0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,0.55);} 60%{box-shadow:0 0 0 10px rgba(220,38,38,0);} }' +
            '@keyframes hWarningPulse  { 0%,100%{box-shadow:0 0 0 0 rgba(217,119,6,0.45);}  60%{box-shadow:0 0 0 9px rgba(217,119,6,0);}  }' +

            '.health-wrap { max-width:1040px; margin:0 auto; }' +

            // === HERO ===
            '.health-hero {' +
                'background:linear-gradient(180deg, #0b1220 0%, #111a2e 100%);' +
                'border-radius:22px; padding:34px 38px;' +
                'display:flex; align-items:center; justify-content:space-between;' +
                'flex-wrap:wrap; gap:28px;' +
                'box-shadow:0 12px 36px rgba(15,23,42,0.20), 0 0 0 1px rgba(255,255,255,0.04) inset;' +
                'position:relative; overflow:hidden; animation:hFadeUp 0.7s ease-out;' +
            '}' +
            // grid pattern: çok hafif tarama hissi
            '.health-bg-grid { position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);background-size:40px 40px;mask-image:radial-gradient(ellipse at center, rgba(0,0,0,0.9) 30%, transparent 80%);-webkit-mask-image:radial-gradient(ellipse at center, rgba(0,0,0,0.9) 30%, transparent 80%); }' +
            // hero radial glow (skor rengiyle, opacity düşürüldü)
            '.health-hero::before { content:"";position:absolute;top:-50%;right:-12%;width:300px;height:300px;border-radius:50%;pointer-events:none;opacity:0.50; }' +
            '.health-hero::after  { content:"";position:absolute;bottom:-35%;left:-8%;width:180px;height:180px;background:radial-gradient(circle, rgba(99,102,241,0.030) 0%, transparent 70%);border-radius:50%;pointer-events:none; }' +
            // tek seferlik scan sweep
            '.health-bg-sweep { position:absolute;left:0;right:0;top:0;height:30%;background:linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%);pointer-events:none;animation:hScanSweep 1.6s cubic-bezier(0.4,0,0.2,1) 0.4s 1 forwards;will-change:transform,opacity;opacity:0; }' +
            // sağ-alt köşede semi-abstract akış motifi (medikal değil, dekoratif dalga)
            '.health-ekg { position:absolute;right:18px;bottom:14px;width:160px;height:36px;opacity:0.10;pointer-events:none; }' +

            '.health-hero-info { flex:1; min-width:240px; position:relative; z-index:1; }' +
            '.health-hero-title { font-size:13px; font-weight:800; color:rgba(226,232,240,0.55); margin:0 0 6px 0; letter-spacing:0.14em; text-transform:uppercase; }' +
            '.health-hero-score-line { display:flex; align-items:baseline; gap:10px; margin-bottom:12px; }' +
            '.health-hero-summary { font-size:14.5px; color:rgba(226,232,240,0.78); margin:0; line-height:1.6; max-width:560px; font-weight:500; }' +
            '.health-hero-badge { display:inline-flex; align-items:center; gap:7px; padding:6px 14px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; margin-top:14px; }' +
            '.health-hero-meta { display:flex; gap:18px; align-items:center; margin-top:14px; flex-wrap:wrap; font-size:12px; font-weight:600; color:rgba(226,232,240,0.55); letter-spacing:0.02em; }' +
            '.health-hero-meta-dot { display:inline-block;width:6px;height:6px;border-radius:50%; }' +

            // === RING — PREMIUM ÇEKİRDEK MODÜLÜ ===
            // Container: ring çevresi izole edilir (glass plate + inner shadow)
            // Animasyon: organik nefes (1 → 1.018 → 1, 4s)
            // 2 katmanlı halo: iç sıcak / dış ultra-soft
            '.health-ring-wrap {' +
                'position:relative; width:152px; height:152px; flex-shrink:0; z-index:1;' +
                'display:flex; align-items:center; justify-content:center;' +
                'animation:hRingBreath 4s ease-in-out infinite;' +
                'will-change:transform;' +
            '}' +
            // Glass plate — ring çevresinde sakin izolasyon
            '.health-ring-plate {' +
                'position:absolute; inset:0; border-radius:50%;' +
                'background:radial-gradient(circle at 50% 50%, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 55%, transparent 75%);' +
                'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.08);' +
                'pointer-events:none;' +
            '}' +
            // İç halo: sıcak, ring rengiyle (renk inline style ile injecte edilir)
            '.health-ring-halo-inner {' +
                'position:absolute; inset:-6px; border-radius:50%;' +
                'pointer-events:none;' +
                'animation:hHaloInner 3.6s ease-in-out infinite;' +
                'filter:blur(8px);' +
            '}' +
            // Dış halo: ultra soft, gecikmeli, daha geniş
            '.health-ring-halo-outer {' +
                'position:absolute; inset:-26px; border-radius:50%;' +
                'pointer-events:none;' +
                'animation:hHaloOuter 4.8s ease-in-out infinite 0.6s;' +
                'filter:blur(20px);' +
            '}' +
            '.health-ring-svg { width:152px; height:152px; transform:rotate(-90deg); position:relative; z-index:1; }' +
            '.health-ring-bg { fill:none; stroke:rgba(255,255,255,0.075); stroke-width:3.2; }' +
            '.health-ring-fill { fill:none; stroke-width:3.2; stroke-linecap:round; animation:hRingDraw 1s cubic-bezier(0.4,0,0.2,1) forwards; }' +
            '.health-ring-text { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; z-index:2; }' +
            // Skor tipografisi — daha ağır, daha optical balanced
            '.health-ring-score {' +
                'font-size:46px; font-weight:900; color:#f8fafc; line-height:0.95;' +
                'letter-spacing:-0.035em;' +
                'font-feature-settings:"tnum" 1, "lnum" 1;' +
                'text-shadow:0 2px 12px rgba(0,0,0,0.25);' +
            '}' +
            '.health-ring-label {' +
                'font-size:9.5px; font-weight:700; color:rgba(226,232,240,0.45);' +
                'text-transform:uppercase; letter-spacing:0.18em; margin-top:6px;' +
            '}' +
            // Micro status — ring altında küçük secondary durum
            '.health-ring-micro {' +
                'margin-top:10px; font-size:10.5px; font-weight:700;' +
                'letter-spacing:0.12em; text-transform:uppercase;' +
                'display:inline-flex; align-items:center; gap:6px;' +
                'opacity:0.85;' +
            '}' +
            '.health-ring-micro-dot {' +
                'width:5px; height:5px; border-radius:50%;' +
            '}' +
            '.health-ring-cluster { display:flex; flex-direction:column; align-items:center; flex-shrink:0; z-index:1; }' +

            // === KPI SUB CARDS ===
            '.health-subs { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:14px; margin-top:18px; }' +
            '.health-sub-card { background:#ffffff; border-radius:16px; padding:18px 18px 16px; border:1px solid #eef2f7; box-shadow:0 1px 2px rgba(15,23,42,0.03), 0 4px 14px -8px rgba(15,23,42,0.06); transition:transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease; animation:hFadeUp 0.5s ease-out backwards; position:relative; cursor:pointer; }' +
            '.health-sub-card:hover { transform:translateY(-2px); border-color:#dde5ee; box-shadow:0 4px 8px rgba(15,23,42,0.04), 0 12px 24px -10px rgba(15,23,42,0.10); }' +
            '.health-sub-card:nth-child(1) { animation-delay:0.06s; }' +
            '.health-sub-card:nth-child(2) { animation-delay:0.12s; }' +
            '.health-sub-card:nth-child(3) { animation-delay:0.18s; }' +
            '.health-sub-card:nth-child(4) { animation-delay:0.24s; }' +

            // floating left stripe (top/bottom margin — premium, full-height değil)
            '.health-sub-stripe { position:absolute; left:0; top:14px; bottom:14px; width:2px; border-radius:0 2px 2px 0; }' +

            '.health-sub-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }' +
            '.health-sub-head-left { display:flex; align-items:center; gap:8px; }' +
            '.health-sub-icon { font-size:15px; opacity:0.85; }' +
            '.health-sub-label { font-size:10.5px; font-weight:800; color:#64748b; text-transform:uppercase; letter-spacing:0.06em; }' +
            '.health-sub-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }' +
            '.health-sub-dot.critical { animation:hCriticalPulse 1.4s ease-in-out infinite; }' +

            '.health-sub-score-num { font-size:32px; font-weight:800; letter-spacing:-0.025em; line-height:1; transition:color 0.3s; display:block; margin-top:2px; }' +
            '.health-sub-status { display:inline-block; margin-top:4px; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; }' +

            '.health-sub-bar { height:3px; background:#f1f5f9; border-radius:999px; overflow:hidden; margin:14px 0 12px; }' +
            '.health-sub-bar-fill { height:100%; border-radius:999px; animation:hBarGrow 0.9s cubic-bezier(0.4,0,0.2,1) backwards; }' +

            '.health-sub-divider { height:1px; background:linear-gradient(90deg, transparent, #e2e8f0 18%, #e2e8f0 82%, transparent); margin:8px 0 10px; }' +
            '.health-sub-reason { font-size:12.5px; font-weight:600; color:#0f172a; line-height:1.5; }' +
            '.health-sub-effect { margin-top:4px; font-size:11.5px; font-weight:500; color:#64748b; line-height:1.5; }' +
            '.health-sub-cta { display:inline-flex; align-items:center; gap:4px; margin-top:12px; font-size:12px; font-weight:700; color:#0f172a; letter-spacing:-0.01em; }' +
            '.health-sub-cta::after { content:"→"; transition:transform 0.18s ease; }' +
            '.health-sub-card:hover .health-sub-cta::after { transform:translateX(3px); }' +

            // === ACTION CENTER ===
            '.health-actions { margin-top:24px; background:#ffffff; border:1px solid #eef2f7; border-radius:18px; box-shadow:0 1px 2px rgba(15,23,42,0.03), 0 4px 16px -10px rgba(15,23,42,0.06); overflow:hidden; animation:hFadeUp 0.5s ease-out 0.30s backwards; }' +
            '.health-actions-header { padding:16px 22px 12px; display:flex; align-items:center; gap:10px; border-bottom:1px solid #f1f5f9; }' +
            '.health-actions-title { font-size:13px; font-weight:800; color:#0f172a; letter-spacing:0.04em; text-transform:uppercase; }' +
            '.health-actions-count { margin-left:auto; font-size:11.5px; font-weight:700; color:#64748b; padding:3px 10px; background:#f8fafc; border-radius:999px; }' +
            '.health-action-row { display:grid; grid-template-columns:auto 1fr auto auto; align-items:center; gap:14px; padding:14px 22px; border-bottom:1px solid #f8fafc; cursor:pointer; transition:background 0.15s ease; position:relative; }' +
            '.health-action-row:last-child { border-bottom:none; }' +
            '.health-action-row::before { content:""; position:absolute; left:0; top:10px; bottom:10px; width:2px; background:transparent; border-radius:0 2px 2px 0; transition:background 0.15s ease; }' +
            '.health-action-row[onclick]:hover { background:#fafbfc; }' +
            '.health-action-row:not([onclick]):hover .health-action-arrow { transform:none; color:#94a3b8; }' +
            '.health-sub-card[onclick]:hover { transform:translateY(-2px); }' +
            '.health-sub-card:not([onclick]):hover { transform:none; box-shadow:0 1px 2px rgba(15,23,42,0.03), 0 4px 14px -8px rgba(15,23,42,0.06); }' +
            '.health-action-dot-wrap { width:10px; display:flex; justify-content:center; }' +
            '.health-action-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }' +
            '.health-action-dot.critical { animation:hCriticalPulse 1.4s ease-in-out infinite; }' +
            '.health-action-dot.warning  { animation:hWarningPulse  2.4s ease-in-out infinite; }' +
            '.health-action-body { min-width:0; }' +
            '.health-action-title { font-size:13.5px; font-weight:700; color:#0f172a; line-height:1.4; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; }' +
            '.health-action-desc  { margin-top:2px; font-size:12px; font-weight:500; color:#64748b; line-height:1.45; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; }' +
            '.health-action-impact { font-size:11px; font-weight:700; padding:3px 9px; border-radius:8px; white-space:nowrap; }' +
            '.health-action-chip { font-size:10px; font-weight:800; padding:4px 9px; border-radius:8px; letter-spacing:0.05em; white-space:nowrap; }' +
            '.health-action-arrow { font-size:14px; font-weight:700; color:#94a3b8; transition:transform 0.15s ease, color 0.15s ease; }' +
            '.health-action-row:hover .health-action-arrow { transform:translateX(3px); color:#0f172a; }' +

            '.health-actions-footer { padding:12px 22px; text-align:right; }' +
            '.health-actions-see-all { font-size:12px; font-weight:700; color:#0f172a; cursor:pointer; display:inline-flex; align-items:center; gap:4px; letter-spacing:-0.01em; }' +
            '.health-actions-see-all::after { content:"→"; transition:transform 0.18s ease; }' +
            '.health-actions-see-all:hover::after { transform:translateX(3px); }' +

            '.health-empty { background:#fafbfc; border:1px dashed #cbd5e1; border-radius:16px; padding:36px 28px; text-align:center; margin-top:22px; animation:hFadeUp 0.5s ease-out 0.2s backwards; }' +

            '.health-footer { margin-top:18px; padding:14px 22px; display:flex; align-items:center; gap:10px; font-size:12px; color:#94a3b8; font-weight:500; animation:hFadeUp 0.5s ease-out 0.36s backwards; }' +

            '@media (max-width:880px) {' +
                '.health-subs { grid-template-columns:repeat(2, 1fr); }' +
            '}' +
            '@media (max-width:640px) {' +
                '.health-hero { padding:26px 22px; border-radius:18px; gap:18px; }' +
                '.health-hero-title { font-size:12px; }' +
                '.health-ring-wrap { width:120px; height:120px; }' +
                '.health-ring-svg { width:120px; height:120px; }' +
                '.health-ring-score { font-size:34px; }' +
                '.health-ring-micro { font-size:9.5px; margin-top:8px; }' +
                '.health-subs { grid-template-columns:1fr; gap:10px; }' +
                '.health-sub-card { padding:16px; }' +
                '.health-action-row { grid-template-columns:auto 1fr auto; gap:10px; padding:12px 16px; }' +
                '.health-action-impact { display:none; }' +
                '.health-actions-header { padding:14px 16px 10px; }' +
                '.health-actions-footer { padding:10px 16px; }' +
            '}' +

            // Reduced motion: tüm atmosfer animasyonları kapanır
            '@media (prefers-reduced-motion: reduce) {' +
                '.health-bg-sweep, .health-ring-wrap, .health-ring-halo-inner, .health-ring-halo-outer, .health-sub-dot.critical, .health-action-dot.critical, .health-action-dot.warning { animation:none !important; }' +
                '.health-hero, .health-sub-card, .health-actions, .health-footer, .health-empty, .health-sub-bar-fill, .health-ring-fill { animation:none !important; }' +
            '}';
        document.head.appendChild(st);
    },

    /* ============================================================
       RENDER
       ============================================================ */
    render: async function (container) {
        this._isActive = true;
        var self = this;
        var CACHE_KEY = 'health_cache_v3';

        // Cache hit
        var cached = window.ViewCache ? window.ViewCache.get(CACHE_KEY) : null;
        if (cached) {
            container.innerHTML = cached.html;
            self.animateCounter(document.getElementById('healthMainScore'), cached.score, 800);
            var subNums = container.querySelectorAll('.health-sub-score-num');
            for (var ci = 0; ci < subNums.length; ci++) {
                var ct = parseInt(subNums[ci].getAttribute('data-target'), 10) || 0;
                self.animateCounter(subNums[ci], ct, 600 + ci * 80);
            }
            // Navbar beacon sync (cache hit'te de tek skor)
            if (window.HealthIndicator && typeof window.HealthIndicator.set === 'function') {
                window.HealthIndicator.set(cached.score, true);
            }
            // KPI panel için data restore — cache'te full data'yı da tutuyoruz
            if (cached.data) self._lastKpiData = cached.data;
            return;
        }

        self._injectLoaderStyle();
        container.innerHTML =
            '<div style="max-width:960px;margin:0 auto;padding:60px 0;text-align:center;">' +
                '<div class="health-loader-ring"></div>' +
                '<div style="font-size:14px;font-weight:600;color:#94a3b8;margin-top:14px;letter-spacing:0.04em;">Nabız taranıyor...</div>' +
            '</div>';

        var data = await this.fetchData();
        if (!this._isActive) return;

        var mainColor = self.getScoreColor(data.score);
        var mainGlow  = self.getScoreGlow(data.score);
        var scoreLabel = self.getScoreLabel(data.score);

        self._injectMainStyle();

        // === Hero dinamik glow (skor rengiyle) ===
        var html = '';
        html += '<style id="health-hero-dyn">' +
            '.health-hero::before { background:radial-gradient(circle, ' + mainGlow + ' 0%, transparent 70%) !important; }' +
            '.health-ring-svg { filter:drop-shadow(0 0 1.5px ' + mainGlow + '); }' +
        '</style>';

        // === Risk seviyesi & kritik problem sayısı (insights üzerinden türetilir) ===
        var critCount = 0, warnCount = 0;
        for (var ic = 0; ic < data.insights.length; ic++) {
            var t = data.insights[ic].type;
            if (t === 'danger') critCount++;
            else if (t === 'warning') warnCount++;
        }
        var riskLevel = '';
        var riskColor = '';
        if (critCount >= 2)       { riskLevel = 'Yüksek'; riskColor = '#ef4444'; }
        else if (critCount === 1) { riskLevel = 'Orta';   riskColor = '#f59e0b'; }
        else if (warnCount >= 2)  { riskLevel = 'Düşük';  riskColor = '#fbbf24'; }
        else                      { riskLevel = 'Sakin';  riskColor = '#22c55e'; }

        // === Semi-abstract akış motifi (sağ alt köşe) ===
        var ekgSvg =
            '<svg class="health-ekg" viewBox="0 0 320 60" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M0 30 L80 30 L100 18 L120 42 L140 30 L300 30" />' +
                '<circle cx="100" cy="18" r="2.2" fill="#cbd5e1" />' +
                '<circle cx="300" cy="30" r="1.8" fill="#cbd5e1" />' +
            '</svg>';

        // ============================================================
        // HERO
        // ============================================================
        html += '<div class="health-wrap">';
        html += '<div class="health-hero">' +
            '<div class="health-bg-grid"></div>' +
            '<div class="health-bg-sweep"></div>' +
            ekgSvg +

            '<div class="health-hero-info">' +
                '<div class="health-hero-title">SAĞLIK SKORU</div>' +
                '<p class="health-hero-summary">' + data.summary + '</p>' +
                '<div class="health-hero-badge" style="background:' + mainColor + '20; color:' + mainColor + '; border:1px solid ' + mainColor + '33;">' +
                    '<span style="width:7px;height:7px;border-radius:50%;background:' + mainColor + ';box-shadow:0 0 6px ' + mainColor + ';"></span>' +
                    scoreLabel +
                '</div>' +

                '<div class="health-hero-meta">' +
                    '<span style="display:inline-flex;align-items:center;gap:7px;">' +
                        '<span class="health-hero-meta-dot" style="background:' + riskColor + ';box-shadow:0 0 6px ' + riskColor + '88;"></span>' +
                        'Risk: ' + riskLevel +
                    '</span>' +
                    (critCount > 0
                        ? '<span style="opacity:0.85;">Kritik: ' + critCount + ' alan</span>'
                        : '<span style="opacity:0.6;">Kritik uyarı yok</span>') +
                '</div>' +
            '</div>' +

            // === RING CLUSTER — çekirdek modülü + micro status ===
            (function () {
                // Micro status — 4 katmanlı palet ile hizalı
                var microText = '';
                if (!data.hasData)         microText = 'Veri Bekleniyor';
                else if (data.score >= 90) microText = 'Mükemmel';
                else if (data.score >= 75) microText = 'Stabil';
                else if (data.score >= 50) microText = 'İzlenmeli';
                else                       microText = 'Kritik';

                return '<div class="health-ring-cluster">' +
                    '<div class="health-ring-wrap">' +
                        // Dış halo (ultra soft, geniş, geç)
                        '<div class="health-ring-halo-outer" style="background:radial-gradient(circle, ' + mainColor + '55 0%, ' + mainColor + '00 70%);"></div>' +
                        // İç halo (sıcak, dar)
                        '<div class="health-ring-halo-inner" style="background:radial-gradient(circle, ' + mainColor + '40 0%, ' + mainColor + '00 75%);"></div>' +
                        // Glass plate (izolasyon)
                        '<div class="health-ring-plate"></div>' +
                        // Ring SVG
                        '<svg class="health-ring-svg" viewBox="0 0 36 36">' +
                            '<circle class="health-ring-bg" cx="18" cy="18" r="15.5"></circle>' +
                            '<circle class="health-ring-fill" cx="18" cy="18" r="15.5" stroke="' + mainColor + '" stroke-dasharray="' + data.score + ', 100"></circle>' +
                        '</svg>' +
                        '<div class="health-ring-text">' +
                            '<div class="health-ring-score" id="healthMainScore">0</div>' +
                            '<div class="health-ring-label">/ 100</div>' +
                        '</div>' +
                    '</div>' +
                    // Micro status — ring çekirdeğin altında küçük secondary durum
                    '<span class="health-ring-micro" style="color:' + mainColor + ';">' +
                        '<span class="health-ring-micro-dot" style="background:' + mainColor + ';box-shadow:0 0 6px ' + mainColor + '88;"></span>' +
                        microText +
                    '</span>' +
                '</div>';
            })() +
        '</div>';

        // ============================================================
        // KPI SUB CARDS — anlam üreten yapı
        // ============================================================
        html += '<div class="health-subs">';
        for (var i = 0; i < data.subScores.length; i++) {
            var s = data.subScores[i];
            var sColor = self.getScoreColor(s.score);
            var sLabel = self.getScoreLabel(s.score);
            var critical = s.score < 50 && s.score > 0;
            // Tıklayınca → KPI detay paneli açılır (route'a değil — açıklama önce)
            var effect = self._kpiEffect(s.key, s.score);
            var clickAttr = 'onclick="window.HealthView.openKpiPanel(\'' + s.key + '\')"';

            html += '<div class="health-sub-card" ' + clickAttr + '>' +
                '<div class="health-sub-stripe" style="background:' + sColor + ';"></div>' +
                '<div class="health-sub-head">' +
                    '<div class="health-sub-head-left">' +
                        '<span class="health-sub-icon">' + s.icon + '</span>' +
                        '<span class="health-sub-label">' + s.label + '</span>' +
                    '</div>' +
                    '<span class="health-sub-dot' + (critical ? ' critical' : '') + '" style="background:' + sColor + ';"></span>' +
                '</div>' +
                '<span class="health-sub-score-num" style="color:' + sColor + ';" data-target="' + s.score + '">0</span>' +
                '<span class="health-sub-status" style="color:' + sColor + ';">' + sLabel + '</span>' +
                '<div class="health-sub-bar">' +
                    '<div class="health-sub-bar-fill" style="width:' + s.score + '%;background:' + sColor + ';animation-delay:' + (0.18 + i * 0.06) + 's;"></div>' +
                '</div>' +
                '<div class="health-sub-divider"></div>' +
                '<div class="health-sub-reason">' + s.summary + '</div>' +
                (effect ? '<div class="health-sub-effect">' + effect + '</div>' : '') +
                '<div class="health-sub-cta">Detayı Gör</div>' +
            '</div>';
        }
        html += '</div>';

        // ============================================================
        // ACTION CENTER (eski Akıllı Öneriler — sade, premium liste)
        // ============================================================
        var insightsCap = Math.min(5, data.insights.length);
        if (insightsCap > 0) {
            html += '<div class="health-actions">';
            html += '<div class="health-actions-header">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>' +
                '<span class="health-actions-title">Aksiyon Merkezi</span>' +
                '<span class="health-actions-count">' + insightsCap + ' durum</span>' +
            '</div>';

            for (var j = 0; j < insightsCap; j++) {
                var ins = data.insights[j];
                var pri = ins.priority || 0;
                var dotClass = '', chipText = '', chipBg = '', chipColor = '', impactBg = '', impactColor = '';
                if (pri > 50000) {
                    dotClass = 'critical'; chipText = 'KRİTİK'; chipBg = '#fef2f2'; chipColor = '#dc2626';
                    impactBg = '#fef2f2'; impactColor = '#dc2626';
                } else if (pri > 5000) {
                    dotClass = 'warning'; chipText = 'ÖNEMLİ'; chipBg = '#fffbeb'; chipColor = '#b45309';
                    impactBg = '#fffbeb'; impactColor = '#b45309';
                } else {
                    dotClass = ''; chipText = 'FIRSAT'; chipBg = '#f0fdf4'; chipColor = '#15803d';
                    impactBg = '#f0fdf4'; impactColor = '#15803d';
                }
                var dotColor = (pri > 50000) ? '#dc2626' : (pri > 5000 ? '#d97706' : '#22c55e');
                var stripeColor = (pri > 50000) ? '#ef4444' : (pri > 5000 ? '#f59e0b' : '#22c55e');

                // Route null ise: onclick yok, arrow yok, cursor default → fake CTA yasak
                var route = ins.route; // null olabilir (analysis bilgilendirme veya alert match yok)
                var clickAttr = route ? 'onclick="window.location.hash=\'' + route + '\'"' : '';
                var rowCursor = route ? '' : 'style="cursor:default;"';
                var arrowHtml = route ? '<span class="health-action-arrow">→</span>' : '<span class="health-action-arrow" style="visibility:hidden;">→</span>';
                var impactHtml = ins.impact
                    ? '<span class="health-action-impact" style="background:' + impactBg + ';color:' + impactColor + ';">' + ins.impact + '</span>'
                    : '';

                html += '<div class="health-action-row" ' + clickAttr + ' ' + rowCursor + '>' +
                    '<div class="health-action-dot-wrap"><span class="health-action-dot ' + dotClass + '" style="background:' + dotColor + ';"></span></div>' +
                    '<div class="health-action-body">' +
                        '<div class="health-action-title">' + (ins.title || '') + '</div>' +
                        (ins.description ? '<div class="health-action-desc">' + ins.description + '</div>' : '') +
                    '</div>' +
                    impactHtml +
                    '<span class="health-action-chip" style="background:' + chipBg + ';color:' + chipColor + ';">' + chipText + '</span>' +
                    arrowHtml +
                '</div>';
            }

            html += '</div>';
        } else if (data.hasData) {
            html += '<div class="health-empty">' +
                '<div style="font-size:30px;margin-bottom:10px;">✓</div>' +
                '<h3 style="margin:0 0 4px 0;font-size:15px;font-weight:700;color:#0f172a;">Aktif uyarı yok</h3>' +
                '<p style="margin:0;font-size:13px;color:#64748b;">İşletmen şu an stabil seyirde.</p>' +
            '</div>';
        } else {
            html += '<div class="health-empty">' +
                '<div style="font-size:30px;margin-bottom:10px;">○</div>' +
                '<h3 style="margin:0 0 4px 0;font-size:15px;font-weight:700;color:#0f172a;">Henüz analiz için yeterli veri yok</h3>' +
                '<p style="margin:0;font-size:13px;color:#64748b;">Satış, ürün ve gider verisi girdikçe burada öneri görünür.</p>' +
            '</div>';
        }

        // ============================================================
        // FOOTER (sade güven satırı)
        // ============================================================
        html += '<div class="health-footer">' +
            '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + mainColor + ';"></span>' +
            '<span>Skorlar gerçek verilerinize göre hesaplandı</span>' +
        '</div>';

        html += '</div>';

        container.innerHTML = html;

        // KPI detay paneli için tüm veri burada saklanır (subScores + insights)
        self._lastKpiData = data;

        if (window.ViewCache) {
            window.ViewCache.set(CACHE_KEY, { html: html, score: data.score, data: data }, 60000);
        }

        if (!self._isActive) return;

        self.animateCounter(document.getElementById('healthMainScore'), data.score, 1000);

        var subNums = container.querySelectorAll('.health-sub-score-num');
        for (var k = 0; k < subNums.length; k++) {
            var target = parseInt(subNums[k].getAttribute('data-target'), 10) || 0;
            self.animateCounter(subNums[k], target, 700 + k * 60);
        }

        // === NAVBAR BEACON SYNC — tek source of truth ===
        // Hero ile navbar arasında mismatch olmasın diye health view her render
        // sonunda navbar beacon'a aynı skoru basar.
        if (window.HealthIndicator && typeof window.HealthIndicator.set === 'function') {
            window.HealthIndicator.set(data.score, !!data.hasData);
        }
    }
};
