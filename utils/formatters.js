/* ============================================================
   FORMATTERS — Currency, date, number formatting
   ============================================================ */

window.Formatters = {
    /**
     * Format as Turkish Lira
     * @param {number} amount
     * @returns {string} e.g., "₺125.430"
     */
    currency(amount) {
        if (amount == null || isNaN(amount)) return '₺0';
        return '₺' + new Intl.NumberFormat('tr-TR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(amount);
    },

    /**
     * Format with decimals
     */
    currencyDetail(amount) {
        if (amount == null || isNaN(amount)) return '₺0,00';
        return '₺' + new Intl.NumberFormat('tr-TR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(amount);
    },

    /**
     * Format percentage
     * @param {number} value
     * @returns {string} e.g., "+12.5%" or "-3.2%"
     */
    percent(value) {
        if (value == null || isNaN(value)) return '%0';
        const sign = value >= 0 ? '+' : '';
        return sign + value.toFixed(1) + '%';
    },

    /**
     * Format date for display
     * @param {string|Date} date
     * @returns {string} e.g., "24 Mart 2026"
     */
    date(date) {
        if (!date) return '';
        const d = new Date(date);
        return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
    },

    /**
     * Format date short
     * @param {string|Date} date
     * @returns {string} e.g., "24 Mar"
     */
    dateShort(date) {
        if (!date) return '';
        const d = new Date(date);
        return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
    },

    /**
     * Format number with thousands separator
     */
    number(value) {
        if (value == null || isNaN(value)) return '0';
        return new Intl.NumberFormat('tr-TR').format(value);
    },

    /**
     * Get ISO date string (YYYY-MM-DD) for today
     */
    today() {
        return new Date().toISOString().split('T')[0];
    },

    /**
     * Get first day of current month (YYYY-MM-DD)
     */
    monthStart() {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
    },

    /**
     * Get last day of current month
     */
    monthEnd() {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    },

    /**
     * Escape HTML entities — XSS koruması
     * Tüm innerHTML noktaları bu fonksiyonu kullanmalı
     */
    escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
};
