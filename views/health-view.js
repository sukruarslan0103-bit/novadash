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

        // Priority sort + max 5
        var typeWeight = { danger: 100000, warning: 10000, success: 1000 };
        insights.sort(function (x, y) {
            var wa = (typeWeight[x.type] || 0) + (x.priority || 0);
            var wb = (typeWeight[y.type] || 0) + (y.priority || 0);
            return wb - wa;
        });
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
    getScoreColor: function (score) {
        if (score >= 70) return '#059669';
        if (score >= 40) return '#d97706';
        return '#dc2626';
    },

    getScoreGlow: function (score) {
        if (score >= 70) return 'rgba(5,150,105,0.24)';
        if (score >= 40) return 'rgba(217,119,6,0.24)';
        return 'rgba(220,38,38,0.24)';
    },

    getScoreLabel: function (score) {
        if (score >= 80) return 'Mükemmel';
        if (score >= 70) return 'İyi';
        if (score >= 50) return 'Orta';
        if (score >= 30) return 'Zayıf';
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

    _injectMainStyle: function () {
        if (document.getElementById('health-main-style')) return;
        var st = document.createElement('style');
        st.id = 'health-main-style';
        st.textContent =
            '@keyframes hFadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }' +
            '@keyframes hSlideIn { from { opacity:0; transform:translateX(-16px); } to { opacity:1; transform:translateX(0); } }' +
            '@keyframes hRingDraw { from { stroke-dasharray:0, 100; } }' +
            '@keyframes hBarGrow { from { width:0%; } }' +

            '.health-wrap { max-width:960px; margin:0 auto; }' +

            '.health-hero {' +
                'background:linear-gradient(180deg, #0b1220 0%, #111a2e 100%);' +
                'border-radius:20px; padding:32px 36px;' +
                'display:flex; align-items:center; justify-content:space-between;' +
                'flex-wrap:wrap; gap:24px;' +
                'box-shadow:0 10px 32px rgba(15,23,42,0.18), 0 0 0 1px rgba(255,255,255,0.04) inset;' +
                'position:relative; overflow:hidden; animation:hFadeUp 0.8s ease-out;' +
            '}' +
            '.health-hero::before { content:"";position:absolute;top:-50%;right:-12%;width:260px;height:260px;border-radius:50%;pointer-events:none;opacity:0.55; }' +
            '.health-hero::after  { content:"";position:absolute;bottom:-35%;left:-8%;width:180px;height:180px;background:radial-gradient(circle, rgba(99,102,241,0.035) 0%, transparent 70%);border-radius:50%;pointer-events:none; }' +
            '.health-hero-info { flex:1; min-width:220px; position:relative; z-index:1; }' +
            '.health-hero-title { font-size:26px; font-weight:800; color:#f8fafc; margin:0 0 10px 0; letter-spacing:-0.02em; }' +
            '.health-hero-sub { font-size:14px; color:rgba(226,232,240,0.65); margin:0; line-height:1.6; max-width:540px; }' +
            '.health-hero-badge { display:inline-flex; align-items:center; gap:7px; padding:6px 14px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; margin-top:14px; }' +

            '.health-score-reason { margin-top:14px; padding:11px 16px; background:rgba(255,255,255,0.035); border:1px solid rgba(255,255,255,0.06); border-radius:10px; font-size:12.5px; color:rgba(226,232,240,0.55); line-height:1.55; font-weight:500; animation:hFadeUp 0.8s ease-out 0.2s backwards; }' +

            '.health-ring-wrap { position:relative; width:120px; height:120px; flex-shrink:0; z-index:1; border-radius:50%; }' +
            '.health-ring-svg { width:120px; height:120px; transform:rotate(-90deg); }' +
            '.health-ring-bg { fill:none; stroke:rgba(255,255,255,0.07); stroke-width:3.5; }' +
            '.health-ring-fill { fill:none; stroke-width:3.5; stroke-linecap:round; animation:hRingDraw 1s cubic-bezier(0.4,0,0.2,1) forwards; }' +
            '.health-ring-text { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }' +
            '.health-ring-score { font-size:34px; font-weight:800; color:#f8fafc; line-height:1; letter-spacing:-0.02em; }' +
            '.health-ring-label { font-size:10px; font-weight:600; color:rgba(226,232,240,0.42); text-transform:uppercase; letter-spacing:0.14em; margin-top:5px; }' +

            '.health-subs { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:16px; margin-top:22px; }' +
            '.health-sub-card { background:linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%); border-radius:16px; padding:22px 24px; border:1px solid #e2e8f0; box-shadow:0 1px 2px rgba(15,23,42,0.03), 0 2px 6px rgba(15,23,42,0.02); transition:transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; animation:hFadeUp 0.6s ease-out backwards; position:relative; overflow:hidden; }' +
            '.health-sub-card:hover { transform:scale(1.015); border-color:#cbd5e1; box-shadow:0 2px 4px rgba(15,23,42,0.04), 0 6px 16px rgba(15,23,42,0.06); }' +
            '.health-sub-card:nth-child(1) { animation-delay:0.1s; }' +
            '.health-sub-card:nth-child(2) { animation-delay:0.18s; }' +
            '.health-sub-card:nth-child(3) { animation-delay:0.26s; }' +
            '.health-sub-card:nth-child(4) { animation-delay:0.34s; }' +
            '.health-sub-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }' +
            '.health-sub-icon { font-size:22px; opacity:0.75; filter:grayscale(0.1); transition:opacity 0.2s ease; }' +
            '.health-sub-card:hover .health-sub-icon { opacity:1; }' +
            '.health-sub-score-num { font-size:32px; font-weight:800; letter-spacing:-0.02em; line-height:1; transition:color 0.3s; }' +
            '.health-sub-label { font-size:12px; font-weight:700; color:#475569; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:12px; }' +
            '.health-sub-bar { height:5px; background:#eef2f7; border-radius:999px; overflow:hidden; margin-bottom:12px; }' +
            '.health-sub-bar-fill { height:100%; border-radius:999px; animation:hBarGrow 0.6s cubic-bezier(0.4,0,0.2,1) backwards; }' +
            '.health-sub-summary { font-size:13px; color:#475569; line-height:1.55; font-weight:500; }' +

            '.health-insights { margin-top:22px; }' +
            '.health-insights-title { font-size:20px; font-weight:800; color:#0f172a; margin:0 0 16px 0; }' +
            '.health-insight { display:flex; align-items:flex-start; gap:16px; padding:20px 22px; border-radius:16px; border:1.5px solid; margin-bottom:14px; transition:transform 0.2s ease, box-shadow 0.2s ease; animation:hSlideIn 0.6s ease-out backwards; position:relative; }' +
            '.health-insight:nth-child(2) { animation-delay:0.1s; }' +
            '.health-insight:nth-child(3) { animation-delay:0.18s; }' +
            '.health-insight:nth-child(4) { animation-delay:0.26s; }' +
            '.health-insight:nth-child(5) { animation-delay:0.34s; }' +
            '.health-insight:nth-child(6) { animation-delay:0.42s; }' +
            '.health-insight:hover { transform:translateX(2px); box-shadow:0 4px 14px rgba(0,0,0,0.05); }' +
            '.health-insight-dot { width:12px; height:12px; border-radius:50%; margin-top:4px; flex-shrink:0; }' +
            '.health-insight-body { flex:1; }' +
            '.health-insight-head { font-size:15px; font-weight:700; margin-bottom:5px; }' +
            '.health-insight-desc { font-size:13px; line-height:1.55; }' +
            '.health-insight-btn { flex-shrink:0; align-self:center; padding:10px 20px; border:none; border-radius:12px; font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; transition:transform 0.15s, box-shadow 0.15s; box-shadow:0 2px 8px rgba(0,0,0,0.1); }' +
            '.health-insight-btn:hover { transform:scale(1.01); box-shadow:0 3px 10px rgba(0,0,0,0.1); }' +

            '.health-insight-impact { display:inline-flex; align-items:center; gap:6px; margin-top:10px; padding:8px 14px; background:linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border:1px solid #f59e0b33; border-radius:10px; font-size:12px; font-weight:700; color:#92400e; }' +
            '.health-insight-impact.critical { background:linear-gradient(135deg, #fee2e2 0%, #fecaca 100%); border-color:#ef444433; color:#991b1b; }' +
            '.health-insight-impact.positive { background:linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%); border-color:#22c55e33; color:#166534; }' +

            '.health-empty { background:linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border:1.5px dashed #cbd5e1; border-radius:18px; padding:48px 32px; text-align:center; margin-top:22px; animation:hFadeUp 0.6s ease-out 0.2s backwards; }' +

            '.health-footer { margin-top:22px; background:#fff; border-radius:16px; border:1px solid #e2e8f0; padding:18px 24px; display:flex; align-items:center; gap:10px; box-shadow:0 2px 12px rgba(15,23,42,0.04); animation:hFadeUp 0.6s ease-out 0.3s backwards; }' +

            '@media (max-width:640px) {' +
                '.health-hero { padding:24px 20px; border-radius:16px; }' +
                '.health-hero-title { font-size:22px; }' +
                '.health-ring-wrap { width:96px; height:96px; }' +
                '.health-ring-svg { width:96px; height:96px; }' +
                '.health-ring-score { font-size:26px; }' +
                '.health-subs { grid-template-columns:1fr 1fr; gap:10px; }' +
                '.health-sub-card { padding:18px; }' +
            '}';
        document.head.appendChild(st);
    },

    /* ============================================================
       RENDER
       ============================================================ */
    render: async function (container) {
        this._isActive = true;
        var self = this;
        var CACHE_KEY = 'health_cache_v2';

        // Cache hit
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

        self._injectLoaderStyle();
        container.innerHTML =
            '<div style="max-width:960px;margin:0 auto;padding:60px 0;text-align:center;">' +
                '<div class="health-loader-ring"></div>' +
                '<div style="font-size:15px;font-weight:600;color:#94a3b8;margin-top:16px;">Sağlık raporu hazırlanıyor...</div>' +
            '</div>';

        var data = await this.fetchData();
        if (!this._isActive) return;

        var mainColor = self.getScoreColor(data.score);
        var mainGlow = self.getScoreGlow(data.score);
        var scoreLabel = self.getScoreLabel(data.score);

        self._injectMainStyle();

        // dinamik hero glow (her render'da değişebilir) — küçük bir data-attribute ile çöz
        var html = '';
        html += '<style id="health-hero-dyn">' +
            '.health-hero::before { background:radial-gradient(circle, ' + mainGlow + ' 0%, transparent 70%) !important; }' +
            '.health-ring-wrap { box-shadow:0 0 6px ' + mainGlow + '; }' +
            '.health-ring-svg { filter:drop-shadow(0 0 2px ' + mainGlow + '); }' +
        '</style>';

        // HERO
        html += '<div class="health-wrap">';
        html += '<div class="health-hero">' +
            '<div class="health-hero-info">' +
                '<h2 class="health-hero-title">SAĞLIK RAPORU</h2>' +
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

        // SUB CARDS
        html += '<div class="health-subs">';
        for (var i = 0; i < data.subScores.length; i++) {
            var s = data.subScores[i];
            var sColor = self.getScoreColor(s.score);
            html += '<div class="health-sub-card">' +
                '<div class="health-sub-top">' +
                    '<span class="health-sub-icon">' + s.icon + '</span>' +
                    '<span class="health-sub-score-num" style="color:' + sColor + ';" data-target="' + s.score + '">0</span>' +
                '</div>' +
                '<div class="health-sub-label">' + s.label + '</div>' +
                '<div class="health-sub-bar">' +
                    '<div class="health-sub-bar-fill" style="width:' + s.score + '%;background:linear-gradient(90deg, ' + sColor + 'dd 0%, ' + sColor + 'aa 100%);animation-delay:' + (0.2 + i * 0.08) + 's;"></div>' +
                '</div>' +
                '<div class="health-sub-summary">' + s.summary + '</div>' +
            '</div>';
        }
        html += '</div>';

        // INSIGHTS
        if (data.insights.length > 0) {
            html += '<div class="health-insights"><h3 class="health-insights-title">Akıllı Öneriler</h3>';
            for (var j = 0; j < data.insights.length; j++) {
                var ins = data.insights[j];
                var st = self.getInsightStyle(ins.type);
                var impactClass = (ins.type === 'danger') ? ' critical' : (ins.type === 'success' ? ' positive' : '');
                var impactHtml = ins.impact ? '<div class="health-insight-impact' + impactClass + '">💰 ' + ins.impact + '</div>' : '';

                var priorityLabel = '';
                var priorityColor = '';
                if ((ins.priority || 0) > 50000) { priorityLabel = 'KRITIK'; priorityColor = '#dc2626'; }
                else if ((ins.priority || 0) > 5000) { priorityLabel = 'ONEMLI'; priorityColor = '#d97706'; }
                else { priorityLabel = 'FIRSAT'; priorityColor = '#059669'; }

                html += '<div class="health-insight" style="background:' + st.bg + '; border-color:' + st.border + '; box-shadow:0 4px 20px ' + st.glow + ';">' +
                    '<div class="health-insight-dot" style="background:' + st.dot + '; box-shadow:0 0 8px ' + st.dot + '44;"></div>' +
                    '<div class="health-insight-body">' +
                        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:5px;">' +
                            '<div class="health-insight-head" style="color:' + st.text + ';">' + ins.title + '</div>' +
                            '<span style="font-size:10px;font-weight:800;padding:4px 8px;border-radius:8px;background:' + priorityColor + '22;color:' + priorityColor + ';border:1px solid ' + priorityColor + '55;">' +
                                priorityLabel +
                            '</span>' +
                        '</div>' +
                        (ins.description ? '<div class="health-insight-desc" style="color:' + st.text + 'cc;">' + ins.description + '</div>' : '') +
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
                '<h3 style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:#334155;">Şimdilik Öneri Yok</h3>' +
                '<p style="margin:0;font-size:14px;color:#64748b;">Her şey yolunda görünüyor.</p>' +
            '</div>';
        } else {
            html += '<div class="health-empty">' +
                '<div style="font-size:36px;margin-bottom:14px;">📊</div>' +
                '<h3 style="margin:0 0 6px 0;font-size:17px;font-weight:700;color:#334155;">Henüz Analiz İçin Yeterli Veri Yok</h3>' +
                '<p style="margin:0;font-size:14px;color:#64748b;">Satış, ürün ve gider verileri girdikçe akıllı öneriler burada görünecek.</p>' +
            '</div>';
        }

        // FOOTER
        html += '<div class="health-footer">' +
            '<div style="width:8px;height:8px;border-radius:50%;background:#6366f1;box-shadow:0 0 6px rgba(99,102,241,0.5);"></div>' +
            '<span style="font-size:13px;color:#94a3b8;font-weight:500;">Skorlar gerçek verilerinize göre hesaplandı</span>' +
        '</div>';

        html += '</div>';

        container.innerHTML = html;

        if (window.ViewCache) {
            window.ViewCache.set(CACHE_KEY, { html: html, score: data.score }, 60000);
        }

        if (!self._isActive) return;

        self.animateCounter(document.getElementById('healthMainScore'), data.score, 1000);

        var subNums = container.querySelectorAll('.health-sub-score-num');
        for (var k = 0; k < subNums.length; k++) {
            var target = parseInt(subNums[k].getAttribute('data-target'), 10) || 0;
            self.animateCounter(subNums[k], target, 700 + k * 60);
        }
    }
};
