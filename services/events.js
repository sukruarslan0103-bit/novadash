/* ============================================================
   EVENTS SERVICE — Faz 5 Skeleton
   ============================================================ */

window.EventsService = (function() {
    'use strict';

    // TODO: Implement in Faz 5
    async function getAll() { return { data: [], error: null }; }
    async function create(event) { return { data: null, error: 'Not implemented' }; }
    async function update(id, updates) { return { data: null, error: 'Not implemented' }; }
    async function remove(id) { return { error: 'Not implemented' }; }

    return { getAll, create, update, remove };
})();
