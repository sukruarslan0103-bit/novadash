/* ============================================================
   PURCHASES SERVICE
   Alış kaydı + maliyet güncelleme (SON FİYAT MODELİ)
   ============================================================ */

window.PurchasesService = {

    /* ============================================================
       CREATE PURCHASE
       ============================================================ */
    async createPurchase({ product_id, quantity, total_price, vat_rate, idempotency_key }) {

        if (!product_id || !quantity || !total_price) {
            throw new Error('Eksik veri');
        }

        quantity = Number(quantity);
        total_price = Number(total_price);
        vat_rate = Number(vat_rate || 0);

        if (isNaN(quantity) || isNaN(total_price) || isNaN(vat_rate)) {
            throw new Error('Geçersiz sayısal değer');
        }

        if (quantity <= 0 || total_price <= 0) {
            throw new Error('Geçersiz değer');
        }

        // ATOMIC RPC — insert + cost update tek transaction
        var client = window.SupabaseService.getClient();
        if (!client) throw new Error('Supabase not initialized');

        var { data, error } = await client.rpc('create_purchase_and_update_product_cost', {
            p_product_id: product_id,
            p_quantity: quantity,
            p_total: total_price,
            p_vat: vat_rate,
            p_idempotency_key: idempotency_key || null
        });

        if (error) {
            window.SupabaseService.logEvent('purchase', 'fail', error.message || 'RPC error', {
                product_id: product_id, quantity: quantity
            });
            throw new Error(error.message || 'Purchase failed');
        }

        // Duplicate kontrolü
        if (data && data.duplicate) {
            console.warn('Duplicate purchase (idempotency key)');
        }

        // UI GÜNCELLE
        window.dispatchEvent(new CustomEvent('products:updated'));

        return data;
    },

    /* ============================================================
       HELPER — hesaplama (UI için)
       ============================================================ */
    calculate: function (opts) {

        var quantity = Number(opts.quantity || 0);
        var total_price = Number(opts.total_price || 0);
        var unit_price = Number(opts.unit_price || 0);
        var vat_rate = Number(opts.vat_rate || 0);

        var result = {
            quantity: quantity,
            total_price: total_price,
            unit_price: unit_price,
            net_total: 0,
            unit_cost: 0
        };

        var vatMultiplier = 1 + (vat_rate / 100);

        // toplamdan birim hesapla (total_price = KDV hariç)
        if (quantity > 0 && total_price > 0) {
            var net_total = total_price * vatMultiplier;
            var unit_cost = net_total / quantity;

            result.total_price = total_price;
            result.unit_price = unit_cost;
            result.net_total = net_total;
            result.unit_cost = unit_cost;
        }

        // birimden toplam hesapla (unit_price = KDV dahil birim)
        if (quantity > 0 && unit_price > 0 && total_price === 0) {
            var net = unit_price * quantity;
            var gross = net / vatMultiplier;

            result.total_price = gross;
            result.unit_price = unit_price;
            result.net_total = net;
            result.unit_cost = unit_price;
        }

        return result;
    }

};
