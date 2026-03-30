/* ============================================================
   APP.JS — Application Entry Point
   Supabase init + session check + tenant bootstrap + router init
   Environment-aware: DEV MODE only when ENV === 'development'
   ============================================================ */

(function () {
    'use strict';

    /* ============================================================
       HELPERS
    ============================================================ */

    function isDevMode() {
        if (!window.APP_CONFIG || window.APP_CONFIG.ENV !== 'development') return false;

        // Güvenlik: development modu sadece localhost'ta çalışır
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

    function bindMobileMenu() {
        var menuBtn = document.getElementById('mobileMenuBtn');
        var nav = document.getElementById('topbarNav');

        if (!menuBtn || !nav) return;

        menuBtn.addEventListener('click', function () {
            nav.classList.toggle('open');
        });
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

    /* ============================================================
       DEV MODE TENANT
       Sadece ENV === 'development' iken çalışır.
       Production'da asla aktif olmaz.
    ============================================================ */

    function loadDevTenant() {
        if (!isDevMode()) {
            // Production'da DEV tenant yüklenmez
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

        // Tenant cache'e yaz
        if (window.SupabaseService && window.SupabaseService.setTenantCache) {
            window.SupabaseService.setTenantCache('06b177ba-b248-4620-b25d-9364eb1af409');
        }

        applyUserAndTenantToUI();

        console.warn('⚠️ DEV MODE — Test tenant yüklendi (sadece development ortamı)');
        return true;
    }

    /* ============================================================
       BOOTSTRAP — Supabase + Auth + Tenant
    ============================================================ */

    async function bootstrapSupabase() {
        if (!window.SupabaseService) {
            console.error('SupabaseService not found');
            return loadDevTenant();
        }

        window.SupabaseService.init();

        if (!window.SupabaseService.isConnected()) {
            console.warn('Supabase bağlantısı kurulamadı');
            return loadDevTenant();
        }

        try {
            var user = await window.SupabaseService.getCurrentUser();

            if (!user) {
                return loadDevTenant();
            }

            // Auth var — kullanıcı bilgilerini al
            window.updateState('user.id', user.id);
            window.updateState('user.email', user.email || null);

            var client = window.SupabaseService.getClient();

            var userRes = await client
                .from('users')
                .select('tenant_id, full_name, role')
                .eq('id', user.id)
                .single();

            if (userRes.error) {
                console.error('User profile fetch error:', userRes.error.message);
                return loadDevTenant();
            }

            var userRow = userRes.data;

            if (!userRow || !userRow.tenant_id) {
                console.warn('Kullanıcı tenant bilgisi bulunamadı');
                return loadDevTenant();
            }

            window.updateState('user.name', userRow.full_name || 'Kullanıcı');
            window.updateState('user.role', userRow.role || 'owner');
            window.updateState('tenant.id', userRow.tenant_id);

            // Tenant detaylarını al
            var tenantRes = await client
                .from('tenants')
                .select('id, name, plan')
                .eq('id', userRow.tenant_id)
                .single();

            if (tenantRes.error) {
                console.error('Tenant fetch error:', tenantRes.error.message);
                return loadDevTenant();
            }

            var tenant = tenantRes.data;

            if (tenant) {
                window.updateState('tenant.id', tenant.id || null);
                window.updateState('tenant.name', tenant.name || 'İşletme');
                window.updateState('tenant.plan', tenant.plan || 'starter');
            }

            // Tenant cache'e yaz
            window.SupabaseService.setTenantCache(window.STATE.tenant.id);

            // Auth başarılı
            window.STATE.authenticated = true;
            window.STATE.devMode = false;

            applyUserAndTenantToUI();

            console.log('✅ Supabase session ve tenant bilgisi yüklendi');
            return true;

        } catch (err) {
            console.error('Bootstrap error:', err);
            return loadDevTenant();
        }
    }

    /* ============================================================
       AFTER LOGIN — Login başarılı olduktan sonra bootstrap tekrar
    ============================================================ */

    async function afterLogin() {
        var success = await bootstrapSupabase();

        if (success) {
            applyUserAndTenantToUI();
            window.location.hash = '#dashboard';
            // Router navigate'i hashchange üzerinden tetiklenecek
        } else {
            // Bootstrap başarısız — login'de kal
            if (window.Router && window.Router.showLoginError) {
                window.Router.showLoginError('Oturum açıldı ancak tenant bilgisi alınamadı.');
            }
        }
    }

    /* ============================================================
       LOGOUT — Çıkış Yap butonu handler
       1. SupabaseService.signOut() çağır (cache temizler + auth.signOut)
       2. STATE'i sıfırla (DEV MODE dahil güvenli çalışsın)
       3. Login'e yönlendir
    ============================================================ */

    async function logout() {
        try {
            // Supabase signOut — cache temizler, onAuthStateChange fire eder
            if (window.SupabaseService && typeof window.SupabaseService.signOut === 'function') {
                await window.SupabaseService.signOut();
            }
        } catch (err) {
            console.error('Logout error:', err);
        }

        // STATE'i manuel sıfırla (DEV MODE'da onAuthStateChange fire etmeyebilir)
        window.STATE.authenticated = false;
        window.STATE.devMode = false;
        window.STATE.tenant.id = null;
        window.STATE.tenant.name = '';
        window.STATE.tenant.plan = 'starter';
        window.STATE.user.id = null;
        window.STATE.user.email = null;
        window.STATE.user.name = '';
        window.STATE.user.role = 'owner';

        // Login'e yönlendir
        window.location.hash = '#login';
    }

    /* ============================================================
       LOGOUT BUTTON BINDING
    ============================================================ */

    function bindLogoutButton() {
        var logoutBtn = document.getElementById('logoutBtn');
        if (!logoutBtn) return;

        logoutBtn.addEventListener('click', function () {
            logout();
        });
    }

    /* ============================================================
       INIT
    ============================================================ */

    async function initApp() {
        setCurrentDate();
        bindMobileMenu();
        bindLogoutButton();
        await bootstrapSupabase();

        if (window.Router && typeof window.Router.init === 'function') {
            window.Router.init();
        } else {
            console.error('Router not found');
        }

        console.log('✅ Business Check-Up Dashboard initialized');
    }

    /* ============================================================
       PUBLIC API — afterLogin ve logout için Router'dan erişilebilir
    ============================================================ */
    window.AppBootstrap = {
        afterLogin: afterLogin,
        logout: logout
    };

    /* ============================================================
       START
    ============================================================ */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            initApp();
        });
    } else {
        initApp();
    }
})();
