/* ============================================================
   STATE MANAGEMENT — window.STATE
   Cross-module accessible state
   ============================================================ */

window.STATE = {
    // Auth status
    authenticated: false,
    devMode: false,

    // Tenant hydration readiness — true ONLY after bootstrap fetched tenant row.
    // Tenant-scoped mutations (settings save, logo update, vb.) bu flag false iken
    // calismamali. authenticated=true tek basina yeterli degil.
    tenantReady: false,

    // Current tenant
    tenant: {
        id: null,
        name: '',
        plan: 'starter'
    },

    // Current user
    user: {
        id: null,
        email: null,
        name: '',
        role: 'owner'
    },

    // Current view
    currentView: 'dashboard',

    // Chart instances (for destroy/recreate pattern)
    charts: {},

    // Cache for dashboard data
    dashboardData: {
        monthlySales: 0,
        monthlyExpenses: 0,
        monthlyProfit: 0,
        todaySales: 0,
        salesTrend: 0,
        expenseTrend: 0,
        topProducts: [],
        alerts: [],
        weeklySales: [],
        expenseCategories: []
    },

    // Loading states
    loading: {
        dashboard: false,
        sales: false,
        expenses: false,
        products: false
    }
};

/**
 * Update state and optionally trigger callback
 * @param {string} path - dot-separated path (e.g., 'tenant.name')
 * @param {*} value
 */
window.updateState = function(path, value) {
    const keys = path.split('.');
    let obj = window.STATE;
    for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
};

/**
 * Safely destroy a Chart.js instance
 * @param {string} chartKey
 */
window.destroyChart = function(chartKey) {
    if (window.STATE.charts[chartKey]) {
        window.STATE.charts[chartKey].destroy();
        window.STATE.charts[chartKey] = null;
    }
};
