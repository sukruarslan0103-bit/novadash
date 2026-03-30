/* ============================================================
   ROUTER — Hash-based SPA navigation
   Auth guard: authenticated olmadan panel erişilemez
   ============================================================ */

window.Router = {
    routes: {
        'dashboard':  { view: 'DashboardView',  title: 'Ana Sayfa' },
        'sales':      { view: 'SalesView',      title: 'Satışlar' },
        'products':   { view: 'ProductsView',   title: 'Ürünler' },
        'expenses':   { view: 'ExpensesView',   title: 'Giderler' },
        'stock':      { view: 'StockView',      title: 'Stok' },
        'events':     { view: 'EventsView',     title: 'Etkinlikler' },
        'calendar':   { view: 'CalendarView',   title: 'Takvim & Görevler' },
        'tasks':      { view: 'TasksView',      title: 'Görevler' },
        'reports':    { view: 'ReportsView',     title: 'Raporlar' },
        'transfer':   { view: 'TransferView',   title: 'Aktarma' },
        'settings':   { view: 'SettingsView',    title: 'Ayarlar' }
    },

    init() {
        window.addEventListener('hashchange', () => this.navigate());
        this.navigate();
    },

    navigate() {
        const hash = (window.location.hash || '#dashboard').replace('#', '');

        /* ============================================================
           AUTH GUARD
           authenticated değilse login'e yönlendir.
           login hash'inde ise login view render et.
        ============================================================ */
        if (!window.STATE.authenticated) {
            if (hash !== 'login') {
                window.location.hash = '#login';
                return;
            }

            // Login view render
            this.renderLogin();
            return;
        }

        // Authenticated kullanıcı login sayfasına gelirse dashboard'a yönlendir
        if (hash === 'login') {
            window.location.hash = '#dashboard';
            return;
        }

        const route = this.routes[hash];

        if (!route) {
            window.location.hash = '#dashboard';
            return;
        }

        const viewObj = window[route.view];
        if (!viewObj || typeof viewObj.render !== 'function') {
            console.error('View not found:', route.view);
            return;
        }

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
        if (container) {
            container.innerHTML = '';
            viewObj.render(container);
        }
    },

    /* ============================================================
       LOGIN VIEW
       Basit, sade login ekranı.
       Supabase Auth ile email/password login.
    ============================================================ */
    renderLogin() {
        window.STATE.currentView = 'login';

        // Topbar ve sub-header'ı gizle
        this.setAppChrome(false);

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

        if (loginBtn) {
            loginBtn.addEventListener('click', function () {
                window.Router.handleLogin();
            });
        }

        // Enter tuşu ile login
        if (passwordInput) {
            passwordInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    window.Router.handleLogin();
                }
            });
        }

        if (emailInput) {
            emailInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    window.Router.handleLogin();
                }
            });
        }
    },

    async handleLogin() {
        var emailEl = document.getElementById('loginEmail');
        var passwordEl = document.getElementById('loginPassword');
        var errorEl = document.getElementById('loginError');
        var btnEl = document.getElementById('loginBtn');

        if (!emailEl || !passwordEl) return;

        var email = emailEl.value.trim();
        var password = passwordEl.value;

        if (!email || !password) {
            this.showLoginError('E-posta ve şifre zorunludur.');
            return;
        }

        // Button'u disable et
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = 'Giriş yapılıyor...';
        }

        // Error'u gizle
        if (errorEl) {
            errorEl.style.display = 'none';
        }

        try {
            var result = await window.SupabaseService.signInWithEmail(email, password);

            if (result.error) {
                this.showLoginError(result.error.message || 'Giriş başarısız.');
                if (btnEl) {
                    btnEl.disabled = false;
                    btnEl.textContent = 'Giriş Yap';
                }
                return;
            }

            // Login başarılı — bootstrap'i tekrar çalıştır
            await window.AppBootstrap.afterLogin();

        } catch (err) {
            this.showLoginError('Beklenmeyen bir hata oluştu.');
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = 'Giriş Yap';
            }
        }
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
