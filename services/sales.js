/* ============================================================
   SALES SERVICE — CRUD Operations
   Safe sale + product_sales write flow
   + COST SNAPSHOT (KRİTİK)
   ============================================================ */

window.SalesService = (function() {
    'use strict';

    // ============================================================
    // Compact MD5 (idempotency_key uretimi icin)
    // ============================================================
    function _md5(str) {
        function ad(a,b){var l=(a&0xFFFF)+(b&0xFFFF),m=(a>>16)+(b>>16)+(l>>16);return (m<<16)|(l&0xFFFF);}
        function rl(n,c){return (n<<c)|(n>>>(32-c));}
        function cm(q,a,b,x,s,t){return ad(rl(ad(ad(a,q),ad(x,t)),s),b);}
        function ff(a,b,c,d,x,s,t){return cm((b&c)|((~b)&d),a,b,x,s,t);}
        function gg(a,b,c,d,x,s,t){return cm((b&d)|(c&(~d)),a,b,x,s,t);}
        function hh(a,b,c,d,x,s,t){return cm(b^c^d,a,b,x,s,t);}
        function ii(a,b,c,d,x,s,t){return cm(c^(b|(~d)),a,b,x,s,t);}
        function rh(n){var s='',j;for(j=0;j<=3;j++)s+=((n>>(j*8+4))&0x0F).toString(16)+((n>>(j*8))&0x0F).toString(16);return s;}
        function ce(s){var b=[],i,c;for(i=0;i<s.length;i++){c=s.charCodeAt(i);if(c<128)b.push(c);else if(c<2048){b.push(192|(c>>6));b.push(128|(c&63));}else{b.push(224|(c>>12));b.push(128|((c>>6)&63));b.push(128|(c&63));}}return b;}
        var bytes=ce(String(str==null?'':str)),nbl=bytes.length,nbi=((nbl+8)>>6)+1,x=new Array(nbi*16),i;
        for(i=0;i<nbi*16;i++)x[i]=0;
        for(i=0;i<nbl;i++)x[i>>2]|=bytes[i]<<((i%4)*8);
        x[nbl>>2]|=0x80<<((nbl%4)*8); x[nbi*16-2]=nbl*8;
        var a=1732584193,b=-271733879,c=-1732584194,d=271733878,aa,bb,cc,dd;
        for(i=0;i<x.length;i+=16){
            aa=a;bb=b;cc=c;dd=d;
            a=ff(a,b,c,d,x[i],7,-680876936);d=ff(d,a,b,c,x[i+1],12,-389564586);c=ff(c,d,a,b,x[i+2],17,606105819);b=ff(b,c,d,a,x[i+3],22,-1044525330);
            a=ff(a,b,c,d,x[i+4],7,-176418897);d=ff(d,a,b,c,x[i+5],12,1200080426);c=ff(c,d,a,b,x[i+6],17,-1473231341);b=ff(b,c,d,a,x[i+7],22,-45705983);
            a=ff(a,b,c,d,x[i+8],7,1770035416);d=ff(d,a,b,c,x[i+9],12,-1958414417);c=ff(c,d,a,b,x[i+10],17,-42063);b=ff(b,c,d,a,x[i+11],22,-1990404162);
            a=ff(a,b,c,d,x[i+12],7,1804603682);d=ff(d,a,b,c,x[i+13],12,-40341101);c=ff(c,d,a,b,x[i+14],17,-1502002290);b=ff(b,c,d,a,x[i+15],22,1236535329);
            a=gg(a,b,c,d,x[i+1],5,-165796510);d=gg(d,a,b,c,x[i+6],9,-1069501632);c=gg(c,d,a,b,x[i+11],14,643717713);b=gg(b,c,d,a,x[i],20,-373897302);
            a=gg(a,b,c,d,x[i+5],5,-701558691);d=gg(d,a,b,c,x[i+10],9,38016083);c=gg(c,d,a,b,x[i+15],14,-660478335);b=gg(b,c,d,a,x[i+4],20,-405537848);
            a=gg(a,b,c,d,x[i+9],5,568446438);d=gg(d,a,b,c,x[i+14],9,-1019803690);c=gg(c,d,a,b,x[i+3],14,-187363961);b=gg(b,c,d,a,x[i+8],20,1163531501);
            a=gg(a,b,c,d,x[i+13],5,-1444681467);d=gg(d,a,b,c,x[i+2],9,-51403784);c=gg(c,d,a,b,x[i+7],14,1735328473);b=gg(b,c,d,a,x[i+12],20,-1926607734);
            a=hh(a,b,c,d,x[i+5],4,-378558);d=hh(d,a,b,c,x[i+8],11,-2022574463);c=hh(c,d,a,b,x[i+11],16,1839030562);b=hh(b,c,d,a,x[i+14],23,-35309556);
            a=hh(a,b,c,d,x[i+1],4,-1530992060);d=hh(d,a,b,c,x[i+4],11,1272893353);c=hh(c,d,a,b,x[i+7],16,-155497632);b=hh(b,c,d,a,x[i+10],23,-1094730640);
            a=hh(a,b,c,d,x[i+13],4,681279174);d=hh(d,a,b,c,x[i],11,-358537222);c=hh(c,d,a,b,x[i+3],16,-722521979);b=hh(b,c,d,a,x[i+6],23,76029189);
            a=hh(a,b,c,d,x[i+9],4,-640364487);d=hh(d,a,b,c,x[i+12],11,-421815835);c=hh(c,d,a,b,x[i+15],16,530742520);b=hh(b,c,d,a,x[i+2],23,-995338651);
            a=ii(a,b,c,d,x[i],6,-198630844);d=ii(d,a,b,c,x[i+7],10,1126891415);c=ii(c,d,a,b,x[i+14],15,-1416354905);b=ii(b,c,d,a,x[i+5],21,-57434055);
            a=ii(a,b,c,d,x[i+12],6,1700485571);d=ii(d,a,b,c,x[i+3],10,-1894986606);c=ii(c,d,a,b,x[i+10],15,-1051523);b=ii(b,c,d,a,x[i+1],21,-2054922799);
            a=ii(a,b,c,d,x[i+8],6,1873313359);d=ii(d,a,b,c,x[i+15],10,-30611744);c=ii(c,d,a,b,x[i+6],15,-1560198380);b=ii(b,c,d,a,x[i+13],21,1309151649);
            a=ii(a,b,c,d,x[i+4],6,-145523070);d=ii(d,a,b,c,x[i+11],10,-1120210379);c=ii(c,d,a,b,x[i+2],15,718787259);b=ii(b,c,d,a,x[i+9],21,-343485551);
            a=ad(a,aa);b=ad(b,bb);c=ad(c,cc);d=ad(d,dd);
        }
        return rh(a)+rh(b)+rh(c)+rh(d);
    }

    function getTenantId() {
        return window.STATE?.tenant?.id || null;
    }

    function toNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    function normalizeDate(value) {
        if (!value) return '';
        return String(value).slice(0, 10);
    }

    function extractProductLines(sale) {
        if (!sale || typeof sale !== 'object') return [];

        const candidates = [
            sale.product_sales,
            sale.productSales,
            sale.products,
            sale.items,
            sale.lines
        ];

        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return candidate.filter(Boolean);
            }
        }

        return [];
    }

    function buildSalePayload(sale) {
        const payload = { ...(sale || {}) };

        delete payload.product_sales;
        delete payload.productSales;
        delete payload.products;
        delete payload.items;
        delete payload.lines;

        return payload;
    }

    async function loadProductCostMap() {
        const { data, error } = await window.ProductsService.getAll();
        if (error || !Array.isArray(data)) return new Map();

        const map = new Map();
        data.forEach(p => {
            map.set(p.id, toNumber(p.cost));
        });

        return map;
    }

    function buildProductSalesPayload(lines, saleRecord, costMap) {
        const saleDate = normalizeDate(saleRecord?.date);
        const saleId = saleRecord?.id || null;

        return lines
            .map((line) => {
                const quantity = toNumber(
                    line.quantity ?? line.qty ?? line.adet
                );

                const unitPrice = toNumber(
                    line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat
                );

                const total = toNumber(
                    line.total ?? line.line_total ?? line.lineTotal ?? (quantity * unitPrice)
                );

                const productId =
                    line.product_id ??
                    line.productId ??
                    line.id ??
                    null;

                if (!productId || quantity <= 0 || !saleId) {
                    return null;
                }

                const cost = toNumber(costMap.get(productId) || 0);

                return {
                    sale_id: saleId,
                    date: saleDate,
                    product_id: productId,
                    quantity,
                    unit_price: unitPrice,
                    total,
                    cost
                };
            })
            .filter(Boolean);
    }

    async function getAll(options = {}) {
        var baseFilters = [
            { op: 'eq', column: 'is_deleted', value: false }
        ];

        if (Array.isArray(options.filters)) {
            baseFilters = baseFilters.concat(options.filters);
        }

        return await window.SupabaseService.query('sales', {
            ...options,
            filters: baseFilters,
            order: { column: 'date', asc: false },
            select: options.select || 'id,date,total,cash,card,created_at'
        });
    }

    function computeEndExclusive(endStr) {
        if (!endStr) return '';
        var d = new Date(endStr + 'T00:00:00Z');
        if (isNaN(d.getTime())) return endStr;
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
    }

    async function getByDateRange(startDate, endDate, options = {}) {
        var startStr = normalizeDate(startDate);
        var endStr   = normalizeDate(endDate);

        var page = Number(options.page) > 0 ? Number(options.page) : 1;
        // Sayfa belirtilmediyse büyük limit (toplu görünüm/export için)
        var pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 5000;
        var offset = (page - 1) * pageSize;

        try {
            var client = window.SupabaseService.getClient();
            if (!client) {
                return { data: [], count: 0, error: { message: 'Supabase not initialized' }, totalPages: 0, page: page, pageSize: pageSize, from: 0, to: 0 };
            }

            var res = await client.rpc('get_sales_paginated', {
                p_start: startStr || null,
                p_end:   endStr   || null,
                p_limit: pageSize,
                p_offset: offset
            });

            if (res.error) {
                return { data: [], count: 0, error: res.error, totalPages: 0, page: page, pageSize: pageSize, from: 0, to: 0 };
            }

            var rows = Array.isArray(res.data) ? res.data : [];
            var totalCount = rows.length > 0 ? Number(rows[0].total_count || 0) : 0;
            // total_count alanını dış katmanlardan gizle (RPC artifact)
            var data = rows.map(function (r) {
                return {
                    id: r.id,
                    date: r.date,
                    total: r.total,
                    cash: r.cash,
                    card: r.card,
                    cost: r.cost,
                    profit: r.profit,
                    created_at: r.created_at
                };
            });

            var totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;
            var fromIdx = totalCount > 0 ? offset + 1 : 0;
            var toIdx   = totalCount > 0 ? Math.min(offset + data.length, totalCount) : 0;

            return {
                data: data,
                count: totalCount,
                error: null,
                totalPages: totalPages,
                page: page,
                pageSize: pageSize,
                from: fromIdx,
                to: toIdx
            };
        } catch (err) {
            return { data: [], count: 0, error: err, totalPages: 0, page: page, pageSize: pageSize, from: 0, to: 0 };
        }
    }

    async function getAllByDateRange(startDate, endDate) {
        const PAGE_SIZE = 1000;
        let page = 1;
        let all = [];
        let total = 0;

        var startStr = normalizeDate(startDate);
        var endStr   = normalizeDate(endDate);
        var endExclusive = computeEndExclusive(endStr);

        var baseFilters = [
            { op: 'eq', column: 'is_deleted', value: false }
        ];
        if (startStr) baseFilters.push({ op: 'gte', column: 'date', value: startStr });
        if (endExclusive) baseFilters.push({ op: 'lt',  column: 'date', value: endExclusive });

        while (true) {
            const res = await window.SupabaseService.query('sales', {
                filters: baseFilters,
                order: { column: 'date', asc: false },
                select: 'id,date,total,cash,card,created_at',
                page: page,
                pageSize: PAGE_SIZE,
                count: true
            });

            if (res.error) return { data: [], error: res.error, count: 0 };

            const chunk = Array.isArray(res.data) ? res.data : [];
            all = all.concat(chunk);
            total = Number(res.count || 0);

            if (chunk.length < PAGE_SIZE || all.length >= total) break;
            page++;
        }

        return { data: all, error: null, count: total };
    }

    function buildProductsForRpc(lines, costMap) {
        return lines
            .map(function (line) {
                const quantity = toNumber(line.quantity ?? line.qty ?? line.adet);
                const unitPrice = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
                const total = toNumber(line.total ?? line.line_total ?? line.lineTotal ?? (quantity * unitPrice));
                const productId = line.product_id ?? line.productId ?? line.id ?? null;

                if (!productId || quantity <= 0) return null;

                const cost = toNumber(costMap.get(productId) || 0);

                return {
                    product_id: productId,
                    quantity: quantity,
                    unit_price: unitPrice,
                    total: total,
                    cost: cost
                };
            })
            .filter(Boolean);
    }

    async function create(sale) {
        const tenantId = getTenantId();

        if (!tenantId) {
            return { data: null, error: 'Tenant bulunamadı' };
        }

        const salePayload = buildSalePayload(sale);
        const lines = extractProductLines(sale);

        let computedTotal = 0;
        lines.forEach(line => {
            const q = toNumber(line.quantity ?? line.qty ?? line.adet);
            const p = toNumber(line.unit_price ?? line.unitPrice ?? line.price ?? line.birim_fiyat);
            computedTotal += q * p;
        });

        if (computedTotal > 0) {
            salePayload.total = computedTotal;
        }

        // === IDEMPOTENCY KEY (frontend-side, deterministik) ===
        // md5(tenant_id | date | total | cash | card | notes)
        const _saleIdemKey = salePayload.idempotency_key || _md5(
            tenantId + '|' +
            normalizeDate(salePayload.date) + '|' +
            toNumber(salePayload.total) + '|' +
            toNumber(salePayload.cash) + '|' +
            toNumber(salePayload.card) + '|' +
            (salePayload.notes || '')
        );
        salePayload.idempotency_key = _saleIdemKey;

        if (!lines.length) {
            // RPC-only — REST fallback YOK
            const _client = window.SupabaseService.getClient();
            if (!_client || typeof _client.rpc !== 'function') {
                return { data: null, error: 'Supabase RPC client yok' };
            }

            const _rpcRes = await _client.rpc('create_sale_empty', {
                p_payload: {
                    date: normalizeDate(salePayload.date),
                    total: toNumber(salePayload.total),
                    cash: toNumber(salePayload.cash),
                    card: toNumber(salePayload.card),
                    notes: salePayload.notes || null,
                    idempotency_key: _saleIdemKey
                }
            });

            if (_rpcRes.error) {
                return { data: null, error: _rpcRes.error.message || _rpcRes.error };
            }

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + tenantId);
                window.ViewCache.invalidate('dashboard:' + tenantId);
            }

            window.dispatchEvent(new Event('sales:updated'));

            return { data: _rpcRes.data || null, error: null };
        }

        let costMap;
        try {
            costMap = await loadProductCostMap();
        } catch (e) {
            return { data: null, error: 'Ürün maliyet verisi yüklenemedi' };
        }

        const products = buildProductsForRpc(lines, costMap);

        if (!products.length) {
            return { data: null, error: 'Geçerli ürün satırı bulunamadı' };
        }

        const client = window.SupabaseService.getClient();
        if (!client) {
            return { data: null, error: 'Supabase client bulunamadı' };
        }

        try {
            const { data, error } = await client.rpc('create_sales_atomic', {
                p_sales: [{
                    date: normalizeDate(salePayload.date),
                    total: toNumber(salePayload.total),
                    cash: toNumber(salePayload.cash),
                    card: toNumber(salePayload.card),
                    notes: salePayload.notes || null,
                    created_by: salePayload.created_by || null,
                    idempotency_key: _saleIdemKey,
                    products: products
                }]
            });

            if (error) {
                return { data: null, error: error.message || error };
            }

            const result = Array.isArray(data) ? data[0] : data;

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + tenantId);
                window.ViewCache.invalidate('dashboard:' + tenantId);
            }

            window.dispatchEvent(new Event('sales:updated'));

            return { data: result || null, error: null };
        } catch (err) {
            return { data: null, error: err?.message || 'Satış oluşturulurken hata oluştu' };
        }
    }

    async function update(id, updates) {
        const client = window.SupabaseService.getClient();
        if (!client || typeof client.rpc !== 'function') {
            return { data: null, error: 'Supabase RPC client yok' };
        }
        const res = await client.rpc('update_sale', {
            p_id: id,
            p_updates: updates || {}
        });
        if (res.error) {
            return { data: null, error: res.error.message || res.error };
        }
        return { data: res.data, error: null };
    }

    async function remove(id) {
        const client = window.SupabaseService.getClient();
        if (!client || typeof client.rpc !== 'function') {
            return { data: null, error: 'Supabase RPC client yok' };
        }
        const res = await client.rpc('soft_delete_sale', { p_id: id });
        if (res.error) {
            return { data: null, error: res.error.message || res.error };
        }
        return { data: res.data, error: null };
    }

    async function getFullBackup() {
        const tenantId = getTenantId();

        if (!tenantId) {
            return { ok: false, message: 'Tenant bulunamadı' };
        }

        try {
            const salesResult = await window.SupabaseService.query('sales', {
                filters: [{ op: 'eq', column: 'is_deleted', value: false }]
            });

            const productSalesResult = await window.SupabaseService.query('product_sales', {
                filters: []
            });

            const expensesResult = await window.SupabaseService.query('expenses', {
                filters: []
            });

            const productsResult = await window.SupabaseService.query('products', {
                filters: []
            });

            if (salesResult.error || productSalesResult.error || expensesResult.error || productsResult.error) {
                return { ok: false, message: 'Veri çekilemedi' };
            }

            return {
                ok: true,
                data: {
                    sales: salesResult.data || [],
                    product_sales: productSalesResult.data || [],
                    expenses: expensesResult.data || [],
                    products: productsResult.data || []
                }
            };

        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    async function restoreFromBackup(backupData) {
        const tenantId = getTenantId();

        if (!tenantId) {
            return { ok: false, message: 'Tenant bulunamadı' };
        }

        if (!backupData || typeof backupData !== 'object') {
            return { ok: false, message: 'Geçersiz backup dosyası' };
        }

        const client = window.SupabaseService.getClient();
        if (!client) {
            return { ok: false, message: 'Supabase client yok' };
        }

        try {
            const { data, error } = await client.rpc('restore_full_backup', {
                backup: backupData,
                tenant: tenantId
            });

            if (error) {
                return { ok: false, message: error.message };
            }

            if (!data || data.success !== true) {
                return { ok: false, message: 'Restore başarısız' };
            }

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:' + tenantId);
                window.ViewCache.invalidate('dashboard:' + tenantId);
            }

            window.dispatchEvent(new Event('sales:updated'));
            window.dispatchEvent(new Event('expenses:updated'));
            window.dispatchEvent(new Event('products:updated'));
            window.dispatchEvent(new Event('dashboard:refresh'));

            var ins = data.inserted || {};
            var skp = data.skipped || {};
            var msg = (ins.products || 0) + ' ürün, ' +
                      (ins.sales || 0) + ' satış, ' +
                      (ins.product_sales || 0) + ' ürün-satış, ' +
                      (ins.expenses || 0) + ' gider eklendi';
            var skTotal = (skp.products || 0) + (skp.sales || 0) + (skp.product_sales || 0) + (skp.expenses || 0);
            if (skTotal > 0) {
                msg += ' | ' + skTotal + ' kayıt zaten mevcuttu (atlandı)';
            }

            return {
                ok: true,
                message: msg
            };

        } catch (err) {
            return { ok: false, message: err.message };
        }
    }

    return {
        getAll,
        getByDateRange,
        getAllByDateRange,
        create,
        update, 
        remove,
        getFullBackup,
        restoreFromBackup
    };
})();