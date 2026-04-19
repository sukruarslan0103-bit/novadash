/* ============================================================
   TEST DATA SEEDER
   - 200 ürün
   - 2026-01-01 → 2026-04-30 arası her gün 1 satış (5-10 ürünlü)
   - her gün 2-4 gider

   KULLANIM:
     1) Dashboard'a login ol (tenant_id auth session'da olmalı)
     2) Tarayıcı konsolunda bu dosyayı yükle ya da <script src="scripts/seed-test-data.js"></script>
     3) Konsolda:  await SeedTestData.run()

   NOT:
   - Supabase client + giriş yapılmış session gerekli
   - tenant_id backend'de auth.uid() üzerinden resolve edilir
     (RLS + tablo DEFAULT + services/* üzerinden)
   ============================================================ */

(function () {
    'use strict';

    const START_DATE = '2026-01-01';
    const END_DATE   = '2026-04-30';
    const PRODUCT_COUNT = 200;

    const PRODUCT_INSERT_BATCH = 100;
    const PRODUCT_SALES_BATCH  = 500;
    const EXPENSE_BATCH        = 200;
    const SALE_BATCH           = 100;

    // ---------- util ----------
    function rnd(min, max) {
        return Math.random() * (max - min) + min;
    }
    function rndInt(min, max) {
        return Math.floor(rnd(min, max + 1));
    }
    function round2(n) {
        return Math.round(n * 100) / 100;
    }
    function pick(arr) {
        return arr[rndInt(0, arr.length - 1)];
    }
    function dateRange(startStr, endStr) {
        const out = [];
        const d = new Date(startStr + 'T00:00:00Z');
        const end = new Date(endStr + 'T00:00:00Z');
        while (d <= end) {
            out.push(d.toISOString().slice(0, 10));
            d.setUTCDate(d.getUTCDate() + 1);
        }
        return out;
    }

    const PRODUCT_WORDS_A = ['Latte','Espresso','Mocha','Cappuccino','Americano','Macchiato','Filtre','Türk','Çay','Sıcak','Soğuk','Buzlu','Karamel','Vanilya','Fındık','Çikolata','Bal','Limon','Portakal','Elma'];
    const PRODUCT_WORDS_B = ['Kahve','Çay','Kek','Kurabiye','Poğaça','Tost','Sandviç','Pasta','Pizza','Börek','Makarna','Salata','Çorba','Wrap','Bagel','Muffin','Donut','Croissant','Simit','Lokum'];
    const PRODUCT_WORDS_C = ['Klasik','Özel','Premium','Deluxe','Mini','Büyük','Orta','Double','Triple','Günlük','Haftalık','Ev','Menü'];

    const EXPENSE_TITLES = [
        'Elektrik faturası','Su faturası','Doğalgaz','İnternet','Kira','Personel maaşı','Muhasebe',
        'Temizlik malzemesi','Ambalaj','Nakliye','Tamirat','Vergi','SGK','Reklam','Sarf malzeme',
        'Ofis giderleri','Bakım onarım','Telefon','Güvenlik','Sigorta'
    ];

    function makeProductName(i) {
        return `${pick(PRODUCT_WORDS_C)} ${pick(PRODUCT_WORDS_A)} ${pick(PRODUCT_WORDS_B)} #${i + 1}`;
    }

    // ---------- supabase ----------
    function getClient() {
        if (!window.SupabaseService || !window.SupabaseService.getClient) {
            throw new Error('SupabaseService yok — dashboard sayfasında çalıştır.');
        }
        const c = window.SupabaseService.getClient();
        if (!c) throw new Error('Supabase client başlatılmamış.');
        return c;
    }

    async function getTenantId() {
        const tid = await window.SupabaseService.getTenantId();
        if (!tid) throw new Error('tenant_id alınamadı — login ol.');
        return tid;
    }

    async function getAuthUid() {
        const user = await window.SupabaseService.getCurrentUser();
        if (!user || !user.id) throw new Error('auth user yok — login ol.');
        return user.id;
    }

    async function batchInsert(client, table, rows, chunkSize) {
        const out = [];
        for (let i = 0; i < rows.length; i += chunkSize) {
            const slice = rows.slice(i, i + chunkSize);
            const { data, error } = await client.from(table).insert(slice).select('id');
            if (error) {
                throw new Error(`[${table}] insert hata @${i}: ${error.message || error}`);
            }
            if (Array.isArray(data)) out.push(...data);
            // küçük nefes
            await new Promise(r => setTimeout(r, 20));
        }
        return out;
    }

    // ---------- main ----------
    async function run(opts = {}) {
        const client = getClient();
        const tenantId = await getTenantId();
        const authUid  = await getAuthUid();

        const productCount = opts.productCount || PRODUCT_COUNT;
        const startDate = opts.startDate || START_DATE;
        const endDate   = opts.endDate   || END_DATE;

        console.log('🌱 Seed başlıyor', { tenantId, startDate, endDate, productCount });

        // 1) PRODUCTS
        console.log('→ Ürünler oluşturuluyor...');
        const productRows = [];
        for (let i = 0; i < productCount; i++) {
            const price = round2(rnd(50, 300));
            const costRatio = rnd(0.40, 0.60);
            const cost = round2(price * costRatio);
            productRows.push({
                tenant_id: tenantId,
                name: makeProductName(i),
                price: price,
                cost: cost,
                is_active: true,
                is_deleted: false
            });
        }
        const insertedProducts = await batchInsert(client, 'products', productRows, PRODUCT_INSERT_BATCH);

        // ürünlerin price/cost'unu id'ye bağla (insertedProducts sadece id döndü)
        // sıralı insert + select olduğu için index eşleşir
        const products = insertedProducts.map((p, idx) => ({
            id: p.id,
            price: productRows[idx].price,
            cost: productRows[idx].cost
        }));

        console.log(`✅ ${products.length} ürün oluşturuldu`);

        // 2) SALES (her gün 1)
        console.log('→ Satışlar oluşturuluyor...');
        const days = dateRange(startDate, endDate);

        // Her günün product_sales satırlarını geçici olarak tut, sale_id sonra bağlanacak
        const dailyPlan = days.map(date => {
            const lineCount = rndInt(5, 10);
            const lines = [];
            let total = 0;
            const usedIdx = new Set();
            for (let j = 0; j < lineCount; j++) {
                let pIdx;
                do { pIdx = rndInt(0, products.length - 1); } while (usedIdx.has(pIdx));
                usedIdx.add(pIdx);

                const prod = products[pIdx];
                const qty = rndInt(1, 5);
                const unitPrice = prod.price;
                const lineTotal = round2(qty * unitPrice);
                total = round2(total + lineTotal);

                lines.push({
                    product_id: prod.id,
                    quantity: qty,
                    unit_price: unitPrice,
                    total: lineTotal,
                    cost: prod.cost
                });
            }
            return { date, total, lines };
        });

        const saleRows = dailyPlan.map(p => ({
            tenant_id: tenantId,
            date: p.date,
            total: p.total,
            cash: round2(p.total * rnd(0.3, 0.7)),
            card: 0,
            notes: 'Seed test verisi',
            created_by: authUid,
            is_deleted: false
        }));
        // card = total - cash
        saleRows.forEach(s => { s.card = round2(s.total - s.cash); });

        const insertedSales = await batchInsert(client, 'sales', saleRows, SALE_BATCH);
        console.log(`✅ ${insertedSales.length} satış oluşturuldu`);

        // 3) PRODUCT_SALES
        console.log('→ Ürün-satış satırları oluşturuluyor...');
        const psRows = [];
        insertedSales.forEach((s, idx) => {
            const plan = dailyPlan[idx];
            plan.lines.forEach(line => {
                psRows.push({
                    tenant_id: tenantId,
                    sale_id: s.id,
                    product_id: line.product_id,
                    date: plan.date,
                    quantity: line.quantity,
                    unit_price: line.unit_price,
                    total: line.total,
                    cost: line.cost
                });
            });
        });

        await batchInsert(client, 'product_sales', psRows, PRODUCT_SALES_BATCH);
        console.log(`✅ ${psRows.length} product_sales satırı oluşturuldu`);

        // 4) EXPENSES (her gün 2-4)
        console.log('→ Giderler oluşturuluyor...');
        const expenseRows = [];
        for (const date of days) {
            const n = rndInt(2, 4);
            for (let k = 0; k < n; k++) {
                expenseRows.push({
                    tenant_id: tenantId,
                    date: date,
                    amount: round2(rnd(100, 2000)),
                    description: pick(EXPENSE_TITLES),
                    created_by: authUid
                });
            }
        }
        await batchInsert(client, 'expenses', expenseRows, EXPENSE_BATCH);
        console.log(`✅ ${expenseRows.length} gider oluşturuldu`);

        // cache invalidation
        if (window.ViewCache && typeof window.ViewCache.clear === 'function') {
            window.ViewCache.clear();
        }
        window.dispatchEvent(new Event('sales:updated'));
        window.dispatchEvent(new Event('expenses:updated'));
        window.dispatchEvent(new Event('products:updated'));
        window.dispatchEvent(new Event('dashboard:refresh'));

        console.log('🎉 Seed tamamlandı', {
            products: products.length,
            sales: insertedSales.length,
            product_sales: psRows.length,
            expenses: expenseRows.length
        });

        return {
            products: products.length,
            sales: insertedSales.length,
            product_sales: psRows.length,
            expenses: expenseRows.length
        };
    }

    window.SeedTestData = { run };
    console.log('ℹ️ SeedTestData yüklendi. Çalıştırmak için:  await SeedTestData.run()');
})();
