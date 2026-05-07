/* ============================================================
   APP.JS — Application Entry Point
   Production-safe: hiçbir dev fallback yok.
   Auth yoksa → #login.
   ============================================================ */

(function () {
    'use strict';

    function setCurrentDate() {
        var dateEl = document.getElementById('currentDate');
        if (!dateEl) return;

        var now = new Date();
        var options = {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        };

        dateEl.textContent = now.toLocaleDateString('tr-TR', options);
    }

    function bindMobileMenu() {
        var menuBtn = document.getElementById('mobileMenuBtn');
        var nav = document.getElementById('topbarNav');

        if (!menuBtn || !nav) return;

        menuBtn.onclick = function () {
            nav.classList.toggle('open');
        };
    }

    function applyUserAndTenantToUI() {
        var businessNameEl = document.getElementById('businessName');
        if (businessNameEl) {
            businessNameEl.textContent = (window.STATE && window.STATE.tenant && window.STATE.tenant.name)
                ? window.STATE.tenant.name
                : 'İşletme';
        }

        var profileNameEl = document.querySelector('.profile-name');
        if (profileNameEl) {
            profileNameEl.textContent = (window.STATE && window.STATE.user && window.STATE.user.name)
                ? window.STATE.user.name
                : 'Kullanıcı';
        }

        var avatarEl = document.querySelector('.profile-avatar');
        if (avatarEl) {
            var firstChar = (window.STATE && window.STATE.user && window.STATE.user.name)
                ? window.STATE.user.name.charAt(0)
                : 'K';

            avatarEl.textContent = firstChar.toUpperCase();
        }
    }

    /**
     * Auth yoksa veya herhangi bir adım başarısızsa çağrılır.
     * STATE'i temizler ve login ekranına yönlendirir.
     * Geri dönüş: false (bootstrap başarısız)
     */
    function redirectToLogin() {
        if (window.STATE) {
            window.STATE.authenticated = false;
            if (window.STATE.tenant) {
                window.STATE.tenant.id = null;
                window.STATE.tenant.name = '';
            }
            if (window.STATE.user) {
                window.STATE.user.id = null;
                window.STATE.user.email = null;
                window.STATE.user.name = '';
            }
        }

        if (window.SupabaseService && window.SupabaseService.invalidateTenantCache) {
            window.SupabaseService.invalidateTenantCache();
        }

        if (window.location.hash !== '#login') {
            window.location.hash = '#login';
        }

        return false;
    }

    async function bootstrapSupabase() {
        if (!window.SupabaseService) {
            return redirectToLogin();
        }

        window.SupabaseService.init();

        if (!window.SupabaseService.isConnected()) {
            return redirectToLogin();
        }

        try {
            var user = await window.SupabaseService.getCurrentUser();
            if (!user) return redirectToLogin();

            window.updateState('user.id', user.id);
            window.updateState('user.email', user.email || null);

            var client = window.SupabaseService.getClient();

            var userRes = await client
                .from('users')
                .select('tenant_id, full_name, role')
                .eq('id', user.id)
                .single();

            if (userRes.error) return redirectToLogin();

            var userRow = userRes.data;
            if (!userRow || !userRow.tenant_id) return redirectToLogin();

            window.updateState('user.name', userRow.full_name || 'Kullanıcı');
            window.updateState('user.role', userRow.role || 'owner');
            window.updateState('tenant.id', userRow.tenant_id);

            var tenantRes = await client
                .from('tenants')
                .select('id, name, plan')
                .eq('id', userRow.tenant_id)
                .single();

            if (tenantRes.error) return redirectToLogin();

            var tenant = tenantRes.data;
            if (!tenant) return redirectToLogin();

            window.updateState('tenant.name', tenant.name);
            window.updateState('tenant.plan', tenant.plan);

            window.SupabaseService.setTenantCache(window.STATE.tenant.id);

            window.STATE.authenticated = true;
            window.STATE.devMode = false;

            applyUserAndTenantToUI();

            return true;

        } catch (err) {
            console.warn('[app] bootstrap failed:', err && err.message ? err.message : err);
            return redirectToLogin();
        }
    }

    async function afterLogin() {
        var success = await bootstrapSupabase();

        if (success) {
            // safeNavigate: aktif sayfayi (#expenses, #products vs.) override etmez
            if (typeof window.safeNavigateToDashboard === 'function') {
                window.safeNavigateToDashboard();
            } else if (!window.location.hash || window.location.hash === '#login') {
                window.location.hash = '#dashboard';
            }
        }
    }

    async function logout() {
        if (window.SupabaseService && window.SupabaseService.signOut) {
            await window.SupabaseService.signOut();
        }

        redirectToLogin();
    }

    function bindLogoutButton() {
        var logoutBtn = document.getElementById('logoutBtn');
        if (!logoutBtn) return;

        logoutBtn.onclick = function () {
            logout();
        };
    }

    async function initApp() {
        setCurrentDate();
        bindMobileMenu();
        bindLogoutButton();
        await bootstrapSupabase();

        if (window.Router && window.Router.init) {
            window.Router.init();
        }
    }

    window.AppBootstrap = {
        afterLogin: afterLogin,
        logout: logout,
        redirectToLogin: redirectToLogin
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initApp);
    } else {
        initApp();
    }
})();
