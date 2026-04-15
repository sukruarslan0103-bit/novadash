/* ============================================================
   APP.JS — Application Entry Point
   ============================================================ */

(function () {
    'use strict';

    function isDevMode() {
        if (!window.APP_CONFIG || window.APP_CONFIG.ENV !== 'development') return false;

        var host = window.location.hostname;
        if (host !== 'localhost' && host !== '127.0.0.1' && host !== '') return false;

        return true;
    }

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

    // 🔥 FIX
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

    function loadDevTenant() {
        if (!isDevMode()) {
            console.warn('Auth oturumu bulunamadı. Login gerekli.');
            return false;
        }

        window.updateState('user.id', 'dev-user');
        window.updateState('user.email', 'dev@local.test');
        window.updateState('user.name', 'Anka');
        window.updateState('user.role', 'owner');

        window.updateState('tenant.id', '06b177ba-b248-4620-b25d-9364eb1af409');
        window.updateState('tenant.name', 'Holly Stone Adana');
        window.updateState('tenant.plan', 'starter');

        window.STATE.authenticated = true;
        window.STATE.devMode = true;

        if (window.SupabaseService && window.SupabaseService.setTenantCache) {
            window.SupabaseService.setTenantCache('06b177ba-b248-4620-b25d-9364eb1af409');
        }

        applyUserAndTenantToUI();

        console.warn('⚠️ DEV MODE aktif');
        return true;
    }

    async function bootstrapSupabase() {
        if (!window.SupabaseService) {
            return loadDevTenant();
        }

        window.SupabaseService.init();

        if (!window.SupabaseService.isConnected()) {
            return loadDevTenant();
        }

        try {
            var user = await window.SupabaseService.getCurrentUser();

            if (!user) return loadDevTenant();

            window.updateState('user.id', user.id);
            window.updateState('user.email', user.email || null);

            var client = window.SupabaseService.getClient();

            var userRes = await client
                .from('users')
                .select('tenant_id, full_name, role')
                .eq('id', user.id)
                .single();

            if (userRes.error) return loadDevTenant();

            var userRow = userRes.data;

            window.updateState('user.name', userRow.full_name || 'Kullanıcı');
            window.updateState('user.role', userRow.role || 'owner');
            window.updateState('tenant.id', userRow.tenant_id);

            var tenantRes = await client
                .from('tenants')
                .select('id, name, plan')
                .eq('id', userRow.tenant_id)
                .single();

            if (tenantRes.error) return loadDevTenant();

            var tenant = tenantRes.data;

            window.updateState('tenant.name', tenant.name);
            window.updateState('tenant.plan', tenant.plan);

            window.SupabaseService.setTenantCache(window.STATE.tenant.id);

            window.STATE.authenticated = true;
            window.STATE.devMode = false;

            applyUserAndTenantToUI();

            return true;

        } catch (err) {
            return loadDevTenant();
        }
    }

    async function afterLogin() {
        var success = await bootstrapSupabase();

        if (success) {
            window.location.hash = '#dashboard';
        }
    }

    async function logout() {
        if (window.SupabaseService && window.SupabaseService.signOut) {
            await window.SupabaseService.signOut();
        }

        window.STATE.authenticated = false;
        window.STATE.tenant.id = null;
        window.STATE.user.id = null;

        window.location.hash = '#login';
    }

    // 🔥 FIX
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
        afterLogin,
        logout
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initApp);
    } else {
        initApp();
    }
})();