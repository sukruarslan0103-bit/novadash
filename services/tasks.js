/* ============================================================
   TASKS SERVICE — Faz 6 Skeleton
   ============================================================ */

window.TasksService = (function() {
    'use strict';

    // TODO: Implement in Faz 6
    async function getAll() { return { data: [], error: null }; }
    async function create(task) { return { data: null, error: 'Not implemented' }; }
    async function update(id, updates) { return { data: null, error: 'Not implemented' }; }
    async function remove(id) { return { error: 'Not implemented' }; }

    return { getAll, create, update, remove };
})();
