/* ============================================================
   ROUTER — Hash-based SPA navigation
   Auth guard: authenticated olmadan panel erişilemez
   ============================================================ */

/* ============================================================
   GLOBAL HASH OVERRIDE GUARD
   Kullanicinin son navigation'ini takip eder.
   safeNavigateToDashboard() aktif sayfayi ASLA bozmaz.
   ============================================================ */
window.__lastUserNavigation = window.location.hash || null;

window.addEventListener('hashchange', function () {
    window.__lastUserNavigation = window.location.hash || null;
});

/**
 * Dashboard'a guvenli yonlendirme.
 * Sadece su iki durumda izin verir:
 *   - hash hic yok (ilk yukleme)
 *   - hash === '#login' (authenticated user yanlis sayfada)
 *
 * Diger TUM durumlar (#expenses, #products, ...)
 * korunur, override edilmez.
 */
window.safeNavigateToDashboard = function () {
    var h = window.location.hash || '';
    if (!h || h === '#login') {
        window.location.hash = '#dashboard';
    }
};

window.Router = {
    routes: {
        'dashboard':  { view: 'DashboardView',  title: 'Ana Sayfa' },
        'sales':      { view: 'SalesView',      title: 'Satışlar' },
        'products':   { view: 'ProductsView',   title: 'Ürünler' },
        'raw-materials': { view: 'RawMaterialsView', title: 'Ham Maddeler' },
        'expenses':   { view: 'ExpensesView',   title: 'Giderler' },
        'stock':      { view: 'StockView',      title: 'Stok' },
        'health':     { view: 'HealthView',      title: 'Nabız' },
        'settings':   { view: 'SettingsView',    title: 'Ayarlar' }
    },

    currentViewInstance: null,
    _hashBound: false,
    _initialized: false,
    _loginHandlers: null,

    init() {
        // hashchange listener: yalnizca tek sefer bind et
        if (!this._hashBound) {
            window.addEventListener('hashchange', () => this.navigate());
            this._hashBound = true;
        }

        /* ============================================================
           RE-INIT GUARD
           Router.init() yeniden cagrilirsa (focus, visibilitychange,
           re-bootstrap vs.) ve kullanici ZATEN gecerli bir sayfadaysa
           SAKIN navigate() tetikleme.
        ============================================================ */
        if (this._initialized) {
            var existingHash = (window.location.hash || '').replace('#', '');
            if (existingHash && existingHash !== 'login' && this.routes[existingHash]) {
                if (window.__DEBUG__) console.log('[Router] re-init skipped, already on', existingHash);
                return;
            }
        }

        this._initialized = true;
        this.navigate();
    },

    navigate() {
        // EXTRA GUARD: hash dolu ve login degilse ve route gecerliyse
        // re-entrant cagrilarda bu metodu tekrar tetiklemenin anlami yok.
        // (init guard'i atlatan exotic cagrilar icin son savunma.)
        var rawHash = window.location.hash || '';

        if (!rawHash) {
            // Bos hash -> guvenli fallback (asla override degil, ilk set)
            if (window.STATE && window.STATE.authenticated) {
                window.safeNavigateToDashboard();
            } else {
                window.location.hash = '#login';
            }
            return;
        }

        const hash = rawHash.replace('#', '');
        if(window.__DEBUG__)console.log('[Router] navigate →', hash);

        /* ============================================================
           AUTH GUARD
        ============================================================ */
        if (!window.STATE.authenticated) {
            if (hash !== 'login') {
                window.location.hash = '#login';
                return;
            }

            this._destroyCurrentView();
            this.renderLogin();
            return;
        }

        // Authenticated kullanici #login'da -> safe redirect
        // (#login override edilebilir; safeNavigate izin verir.)
        if (hash === 'login') {
            window.safeNavigateToDashboard();
            return;
        }

        const route = this.routes[hash];

        // Bilinmeyen route -> safe redirect
        if (!route) {
            window.safeNavigateToDashboard();
            return;
        }

        const viewObj = window[route.view];
        if (!viewObj || typeof viewObj.render !== 'function') {
            console.error('[Router] View not found:', route.view, 'hash:', hash,
                '| window.' + route.view + ' =', window[route.view]);
            return;
        }
        if(window.__DEBUG__)console.log('[Router] rendering view:', route.view);

        // Destroy previous view
        this._destroyCurrentView();

        window.STATE.currentView = hash;

        // Show topbar and sub-header (login'de gizlenmiş olabilir)
        this.setAppChrome(true);

        // Update active nav link in topbar
        document.querySelectorAll('.nav-link').forEach(item => {
            item.classList.toggle('active', item.dataset.view === hash);
        });

        // Destroy chart instances
        Object.keys(window.STATE.charts).forEach(key => {
            window.destroyChart(key);
        });

        // Close mobile menu if open
        const nav = document.getElementById('topbarNav');
        if (nav) nav.classList.remove('open');

        // Render
        const container = document.getElementById('viewContainer');
        if (!container) {
            console.error('[Router] #viewContainer bulunamadı');
            return;
        }

        if (container) {
            container.innerHTML = '';
            viewObj.render(container);

            if (typeof viewObj.init === 'function') {
                viewObj.init(container);
            }

            this.currentViewInstance = viewObj;
        }
    },

    _destroyCurrentView() {
        if (this.currentViewInstance && typeof this.currentViewInstance.destroy === 'function') {
            try {
                this.currentViewInstance.destroy();
            } catch (e) {
                console.error('View destroy error:', e);
            }
        }
        this.currentViewInstance = null;
    },

    /* ============================================================
       LOGIN VIEW
       Basit, sade login ekranı.
       Supabase Auth ile email/password login.
    ============================================================ */
    renderLogin() {
        window.STATE.currentView = 'login';
        this.currentViewInstance = null;

        // Topbar ve sub-header'ı gizle
        this.setAppChrome(false);

        // Remove previous login handlers
        this._cleanupLoginHandlers();

        var container = document.getElementById('viewContainer');
        if (!container) return;

        container.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 20px);padding:20px;">' +
                '<div style="background:#fff;border-radius:20px;padding:40px;max-width:400px;width:100%;box-shadow:0 12px 40px rgba(15,23,42,0.12);">' +
                    '<div style="text-align:center;margin-bottom:32px;">' +
                        '<svg width="48" height="48" viewBox="0 0 28 28" fill="none" style="margin-bottom:16px;">' +
                            '<rect width="28" height="28" rx="8" fill="#34C759"/>' +
                            '<path d="M8 14.5L12 18.5L20 10.5" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                        '</svg>' +
                        '<h1 style="margin:0 0 4px 0;font-size:24px;font-weight:800;color:#0f172a;">Business Check-Up</h1>' +
                        '<p style="margin:0;color:#64748b;font-size:14px;">İşletme kontrol paneline giriş yapın</p>' +
                    '</div>' +
                    '<div id="loginError" style="display:none;padding:12px 16px;border-radius:12px;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;font-size:13px;font-weight:600;margin-bottom:16px;"></div>' +
                    '<div style="margin-bottom:16px;">' +
                        '<label style="display:block;font-size:13px;font-weight:700;color:#475569;margin-bottom:6px;">E-posta</label>' +
                        '<input type="email" id="loginEmail" placeholder="ornek@isletme.com" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:12px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;">' +
                    '</div>' +
                    '<div style="margin-bottom:24px;">' +
                        '<label style="display:block;font-size:13px;font-weight:700;color:#475569;margin-bottom:6px;">Şifre</label>' +
                        '<input type="password" id="loginPassword" placeholder="••••••••" style="width:100%;padding:12px 16px;border:1px solid #d1d5db;border-radius:12px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;">' +
                    '</div>' +
                    '<button id="loginBtn" type="button" style="width:100%;padding:14px;border:none;background:#0f172a;color:#fff;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;">Giriş Yap</button>' +
                '</div>' +
            '</div>';

        var loginBtn = document.getElementById('loginBtn');
        var emailInput = document.getElementById('loginEmail');
        var passwordInput = document.getElementById('loginPassword');

        var btnHandler = function () { window.Router.handleLogin(); };
        var enterHandler = function (e) { if (e.key === 'Enter') window.Router.handleLogin(); };

        this._loginHandlers = [];

        if (loginBtn) {
            loginBtn.addEventListener('click', btnHandler);
            this._loginHandlers.push({ el: loginBtn, event: 'click', fn: btnHandler });
        }

        if (passwordInput) {
            passwordInput.addEventListener('keydown', enterHandler);
            this._loginHandlers.push({ el: passwordInput, event: 'keydown', fn: enterHandler });
        }

        if (emailInput) {
            emailInput.addEventListener('keydown', enterHandler);
            this._loginHandlers.push({ el: emailInput, event: 'keydown', fn: enterHandler });
        }
    },

    _cleanupLoginHandlers() {
        if (!this._loginHandlers) return;
        this._loginHandlers.forEach(function (h) {
            h.el.removeEventListener(h.event, h.fn);
        });
        this._loginHandlers = null;
    },

    async handleLogin() {
        var emailEl = document.getElementById('loginEmail');
        var passwordEl = document.getElementById('loginPassword');
        var btnEl = document.getElementById('loginBtn');

        if (!emailEl || !passwordEl) return;

        var email = emailEl.value.trim();
        var password = passwordEl.value;

        // 1) Eski hatayi her denemede temizle
        this.clearLoginError();

        if (!email || !password) {
            this.showLoginError('E-posta ve şifre zorunludur.');
            return;
        }

        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = 'Giriş yapılıyor...';
        }

        // 2) Login isteğini izole try/catch'te tut — sadece signInWithEmail
        var result;
        try {
            result = await window.SupabaseService.signInWithEmail(email, password);
        } catch (err) {
            this.showLoginError('Bağlantı hatası. Tekrar deneyin.');
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Giriş Yap'; }
            return;
        }

        if (result && result.error) {
            this.showLoginError((result.error && result.error.message) || 'Giriş başarısız.');
            if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Giriş Yap'; }
            return;
        }

        // 3) SUCCESS — tenant hydrate AWAIT, sonra TEK NOKTADAN navigation.
        //    authenticated bayragini BURADA set etmiyoruz; bootstrap kendi
        //    set ediyor (tenant satiri geldikten sonra). Boylece:
        //      authenticated=true & tenant=null
        //    araligi yok.
        this._cleanupLoginHandlers();

        var bootstrapOk = false;
        try {
            if (window.AppBootstrap && typeof window.AppBootstrap.afterLogin === 'function') {
                bootstrapOk = await window.AppBootstrap.afterLogin();
            } else {
                // AppBootstrap yoksa fallback (degismez minimum)
                window.STATE.authenticated = true;
                bootstrapOk = true;
            }
        } catch (e) {
            if (window.__DEBUG__) console.error('[Router] afterLogin failed:', e);
            bootstrapOk = false;
        }

        if (bootstrapOk && window.STATE && window.STATE.authenticated) {
            // EXPLICIT NAVIGATION — hashchange race'e bel baglamiyoruz.
            //   1) Hash zaten #dashboard degilse set et (gerekiyorsa hashchange
            //      fire eder, navigate'i o da tetikler — bizim ikinci cagrimiz
            //      idempotent oldugu icin zararsiz)
            //   2) Router.navigate'i DOGRUDAN cagir (hashchange race'inden
            //      bagimsiz). Tek-source-of-truth: SIGNED_IN listener artik
            //      navigation yapmiyor.
            if (window.location.hash !== '#dashboard') {
                window.location.hash = '#dashboard';
            }
            if (window.Router && typeof window.Router.navigate === 'function') {
                try { window.Router.navigate(); } catch (e) { /* noop */ }
            }
        } else {
            // Bootstrap fail — login formu DOM'da hala duruyor olabilir.
            // Buton'u re-enable, kullaniciya net mesaj ver.
            if (btnEl && document.body.contains(btnEl)) {
                btnEl.disabled = false;
                btnEl.textContent = 'Giriş Yap';
            }
            if (typeof this.showLoginError === 'function') {
                this.showLoginError('Oturum hazırlanamadı. Tekrar deneyin.');
            }
        }
    },

    clearLoginError() {
        var el = document.getElementById('loginError');
        if (!el) return;
        el.textContent = '';
        el.style.display = 'none';
    },

    showLoginError(message) {
        var el = document.getElementById('loginError');
        if (!el) return;
        el.textContent = message;
        el.style.display = 'block';
    },

    /* ============================================================
       APP CHROME (topbar + sub-header) show/hide
    ============================================================ */
    setAppChrome(visible) {
        var topbar = document.querySelector('.topbar');
        var subHeader = document.querySelector('.sub-header');

        if (topbar) {
            topbar.style.display = visible ? '' : 'none';
        }
        if (subHeader) {
            subHeader.style.display = visible ? '' : 'none';
        }
    }
};
