/* ============================================================
   CONFIG.JS — Application Configuration
   Single source of truth for public frontend config
   ============================================================ */

window.APP_CONFIG = {
    SUPABASE_URL: 'https://czbovdurwdjpdxgpobqn.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_4SYCpNuY_ftBkWS4Sn-5Qg_cQW2sR9p',

    /**
     * Environment flag
     * 'development' — DEV MODE tenant fallback aktif (SADECE LOCAL)
     * 'production'  — auth zorunlu, fallback yok
     *
     * ÖNEMLİ: Production deploy öncesi 'production' yapılmalıdır.
     * Hostname kontrolü: localhost/127.0.0.1 dışında development çalışmaz.
     */
    ENV: 'development'
};

/* ============================================================
   DEBUG FLAG
   - Production: false (default) → console.log sessiz
   - Geçici aç: window.__DEBUG__ = true; (DevTools console)
   - console.error ve console.warn etkilenmez
   ============================================================ */
window.__DEBUG__ = false;
