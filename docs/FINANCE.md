# NOVA DASHBOARD — Finansal Anayasa v1.0

> **Status:** Canonical. Tum kod, RPC, trigger ve UI bu doku takip eder.  
> **Last updated:** FAZ 1.4 — KDV semantic consolidation.  
> **Scope:** Operational intelligence for restaurant / cafe / bar. NOT a tax accounting system.

---

## 0. TEK KURAL: KDV DAHIL GROSS MODEL

Bu sistemde tutulan **tum parasal alanlar KDV DAHIL brut tutardir**.

KDV ayri bir hesaplama duzleminde **degildir**. Vergi muhasebesi bu sistemin
**kapsamı disindadir**.

Tek istisna: `purchases.total_price` ve `purchase_items.unit_cost` —
fatura satirinda gosterilen KDV HARIC degerdir. Bu istisna acikca
isaretlenmistir ve trigger'lar tarafindan KDV DAHIL hale donusturulup
ilgili snapshot kolonlarina yazilir.

**Profit / kar bu sistemde:**

```
profit = gross_sales - gross_cost - gross_expenses
```

Uc bilesen de KDV DAHIL → **simetrik gross margin**.

---

## 1. CANONICAL KURALLAR (16 madde)

### KURAL 1 — `sales.total`
**KDV DAHIL** gross satis tutari (TRY).  
Kasaya giren para. Kullanici UI'da bu degeri menu fiyati uzerinden girer.  
Invariant: `COALESCE(cash,0) + COALESCE(card,0) = total`.

### KURAL 2 — `sales.cash` / `sales.card`
**KDV DAHIL** odeme dagilimi.  
Nakit ve kart toplamlari `sales.total`'a esit olmalidir.

### KURAL 3 — `product_sales.unit_price`
**KDV DAHIL** satir birim satis fiyati.  
Genelde `products.price` ile aynidir (satis aninda).

### KURAL 4 — `product_sales.total`
**KDV DAHIL** satir toplami.  
Formul: `quantity × unit_price`.

### KURAL 5 — `product_sales.cost`
**KDV DAHIL** satis ani IMMUTABLE maliyet snapshot'i.  
FAZ 1.1'de DB tarafindan `products.cost` lookup ile alinir.  
**Bir kez yazildiktan sonra hicbir trigger / RPC / restore tarafindan update edilmez.**  
Geçmiş satislarin maliyeti yeni alis / yeni recipe ile **degismez**.

### KURAL 6 — `products.price`
**KDV DAHIL** menu satis fiyati.  
Kullanici UI'da girer; kasada gostereceyi rakam.

### KURAL 7 — `products.cost`
**KDV DAHIL** urun maliyeti.

Iki kaynaktan yazilabilir:
- **Recipe motoru** (yeni canonical): `calculate_product_cost(product_id)` =
  `SUM(recipe.quantity × raw_materials.cost)`. raw_materials.cost KDV DAHIL
  oldugu icin sonuc da KDV DAHIL.
- **Legacy Akis A** (deprecated): `create_purchase_and_update_product_cost`
  RPC'si KDV HARIC `p_total`'dan KDV DAHIL `unit_cost` hesaplayip
  `products.cost`'a yazar. Geriye uyumluluk icin tutulur.

Iki yol da sonucta **KDV DAHIL** cost yazar.

### KURAL 8 — `raw_materials.cost`
**KDV DAHIL** son alis maliyeti, **base_unit** basina.  
Formul: `last purchase_items.base_unit_cost` (035 last-price model).  
Trigger zinciri (`trg_purchase_items_cost_sync` → `calculate_raw_material_wac`)
tarafindan otomatik guncellenir.

### KURAL 9 — `raw_materials.vat_rate`
Hammadde icin **varsayilan KDV orani (%)**.  
Hesap duzleminde **degil**, UI default'u olarak kullanilir.  
Default: 20 (Turkiye genel KDV orani).

### KURAL 10 — `purchase_items.unit_cost`
**KDV HARIC** alis birim fiyati (faturada yazan).  
Kullanici UI'da fatura satirini girerken bu degeri yazar.

### KURAL 11 — `purchase_items.line_total`
**KDV HARIC** satir toplami, **iskonto sonrasi, vergi oncesi**.  
Formul: `quantity × unit_cost × (1 - discount_rate/100)`.

### KURAL 12 — `purchase_items.vat_rate`
Satir seviyesi KDV orani (%).  
Default: 20.  
Constraint: `0 <= vat_rate <= 100`.

### KURAL 13 — `purchase_items.discount_rate`
Satir seviyesi iskonto orani (%).  
`line_total` ve `base_unit_cost` hesaplamasina dahil edilir.  
Default: 0.  
Constraint: `0 <= discount_rate <= 100`.

### KURAL 14 — `purchase_items.base_unit_cost`
**KDV DAHIL** base_unit basina maliyet.  
Trigger (`trg_fn_purchase_items_fill_base`, FAZ 1.4 sonrasi) hesaplar:

```
v_line_net  := COALESCE(line_total, quantity × unit_cost) × (1 - discount_rate/100)
v_with_vat  := v_line_net × (1 + vat_rate/100)
base_unit_cost := v_with_vat / base_quantity
```

Bu deger `raw_materials.cost` → `products.cost` zincirinin tek girdisidir.

### KURAL 15 — `purchases.*` (Legacy Akis A)
Geriye uyumluluk icin tutulur. Yeni faturalar **purchase_items** (Akis B)
uzerinden gelmeli.

- `purchases.total_price` = **KDV HARIC** kullanici girdisi.
- `purchases.vat_rate` = KDV orani (%).
- `purchases.net_total` = `total_price × (1 + vat_rate/100)` → **KDV DAHIL**.
- `purchases.unit_cost` = `net_total / quantity` → **KDV DAHIL**.

Bu RPC'ye yeni feature eklenmez. FAZ 2'de deprecated edilecek.

### KURAL 16 — `expenses.amount`
**KDV DAHIL** gider tutari (kasadan cikan para).  
Vergi disi (kira gibi) giderler icin de ayni kolona yazilir; semantik
acidan **"fatura toplam" degil "odenen tutar"**dir.

---

## 2. PROFIT FORMULU

```
profit = sales.total
       - SUM(product_sales.cost)
       - SUM(expenses.amount)
```

Uc bilesen de **KDV DAHIL** oldugu icin profit **gross margin** anlamina gelir.

Bu, vergi-oncesi muhasebe karina **denk DEGILDIR**. Sistem bu rakami
"isletme tarafindan elde edilen efektif kar" olarak sunar.

---

## 3. UI SOZLESMESI

UI label'lari **canonical semantik**'i acikca gostermelidir:

| UI Konumu | Label | Anlam |
|---|---|---|
| Quick Sale modal | **Toplam Satis (KDV Dahil, TL)** | sales.total |
| Expense modal | **Odenen Tutar (KDV Dahil, TL)** | expenses.amount |
| Product create/edit | **Satis Fiyati (KDV Dahil, TL)** | products.price |
| Legacy purchase modal | **Alis Toplami (KDV Haric, TL)** | purchases.total_price |
| Purchase items modal | **Birim Fiyat (KDV Haric, TL)** | purchase_items.unit_cost |
| Purchase items modal | **KDV Orani (%)** | purchase_items.vat_rate |
| Purchase items modal | **Iskonto (%)** | purchase_items.discount_rate |

UI'da bu label'lar **kisaltilmaz / cevirilmez** — `"Toplam"`, `"Tutar"` gibi
mubelik kelimeler kullanilmaz.

---

## 4. SCOPE LIMITS (Sistem NE YAPMAZ)

NOVA DASHBOARD bu konularda **destek SAGLAMAZ**:

- KDV beyan / iade hesabi
- E-Fatura entegrasyonu
- Yasal vergi raporu uretimi
- KDV indirimleri (Stopaj, OTV vb.)
- Çoklu para birimi (yalniz TRY)
- Doviz kuru hesabi
- Yatirim amortismani
- Maaş bordrosu / SGK hesabi
- Banka rekonsiliasyonu

Bu konular icin **ayri bir muhasebe sistemi** (e.g., Mikro, Logo, Netsis,
Parasut) kullanilmalidir.

Bu sistem **operasyonel zeka** sunar:
- "Gunluk cirom ne?"
- "Hangi urun en cok kar getiriyor?"
- "Bu hafta ne kadar gider yaptim?"
- "Hammadde maliyetim arttiginda urun karim nasil etkilenir?"

---

## 5. INVARIANT ENFORCEMENT

Asagidaki invariant'lar **DB CHECK constraint** olarak enforce edilir:

```
sales:
  COALESCE(cash,0) + COALESCE(card,0) = total

product_sales:
  total >= 0 AND unit_price >= 0 AND cost >= 0 AND quantity >= 0

expenses:
  amount >= 0

purchase_items:
  0 <= vat_rate <= 100
  0 <= discount_rate <= 100

purchases:
  total_price >= 0
  0 <= vat_rate <= 100
```

UI seviyesi validasyon **ek bir katmandir**, asil garanti DB CHECK'tir.

---

## 6. IMMUTABILITY GUARANTEES

Asagidaki alanlar **yazildiktan sonra DEGISMEZ**:

| Alan | Garanti |
|---|---|
| `product_sales.cost` | FAZ 1.1 — satis ani snapshot, immutable |
| `product_sales.unit_price` | Satir UPDATE'i yok; sadece soft delete |
| `product_sales.total` | Aynı |
| `sales.idempotency_key` | UNIQUE (tenant_id, idempotency_key) — replay safety |
| `expenses.idempotency_key` | Aynı |
| `purchases.idempotency_key` | Aynı |

`raw_materials.cost` ve `products.cost` **mutable**'dir; live trigger
zinciriyle yeniden hesaplanir. Ancak geçmis `product_sales.cost`
snapshot'lari bu degisimlerden **etkilenmez**.

---

## 7. KDV ASIMETRI TARIHCESI (legacy data)

FAZ 1.4 oncesinde:

- `purchase_items.base_unit_cost` trigger'i KDV **eklemiyordu** → recipe'li
  urunlerin cost'u **KDV HARIC** olarak akıyordu → satis kari **%20 yapay
  yuksek** gozukuyordu.

FAZ 1.4'te:

- 050 migration: COMMENT + CHECK + DEFAULT (semantic dokumantasyonu).
- 051 migration: Trigger VAT-aware + discount-aware.
- 052 migration: Geçmis `purchase_items.base_unit_cost` rebackfill
  (geçmis satislarin `product_sales.cost`'u immutable kalir; sadece live
  `raw_materials.cost` ve `products.cost` duzeltilir).

Bu degisiklik sonrasinda **recipe'li urunlerin gosterilen kari %20'ye
varan miktarda dusebilir**. Bu **gercek degere yaklasmadir**, kayip
degil.

---

## 8. MIGRATION HISTORY

| Migration | Konu |
|---|---|
| 046 | DB-side authoritative cost snapshot (frontend cost ignore) |
| 047 | create_sales_atomic SECURITY DEFINER hardening |
| 048 | Tenant-scoped composite UNIQUE idempotency (sales/expenses/purchases) |
| 049 | Legacy expense index cleanup (unique_expense_idem + unique_expense_guard_idx) |
| 050 | Canonical finance invariants (COMMENT + CHECK + DEFAULT) — FAZ 1.4 |
| 051 | VAT-aware purchase_items trigger (R1 + R3 fix) — FAZ 1.4 |
| 052 | Historical purchase_items base_unit_cost rebackfill — FAZ 1.4 |

---

## 9. CHANGE POLICY

Bu doku **canonical**'dir. Asagidaki gibi degisiklikler **yalniz**
yeni bir surum (`v2.0`, `v3.0`) ile yapilabilir:

- Bir kolonun KDV semantiginin degisimi
- Profit formulunun degisimi
- Yeni canonical kolon eklenmesi
- Scope limit'lerin gevsemesi

Her surum degisikligi **migration** ile birlikte gelir. Doku ile kod
birbirinden ayri donmez.

---

## 10. PILOT MUSTERI DUYURUSU TEMPLATE

```
Sevgili NOVA DASHBOARD Kullanicisi,

Bugun maliyet hesaplama sistemimizi guncelledik. Eski sistemde recipe'li
urunlerin maliyetleri KDV oraninda eksik hesaplaniyordu; yeni sistem KDV
dahil gercek maliyeti yansitir.

Etki:
- Recipe'li urunlerinizin gosterilen kari %0-20 araliginda dusebilir.
- Bu **kayip degildir** — gercek karinizi gormeye basladiniz.
- Gecmis satislariniz dokunulmadi; sadece bugunden itibaren olan
  satislarda yeni maliyet gecerlidir.

Bu sistem operasyonel zeka icindir — yasal vergi muhasebesi icin
ayri bir muhasebe sistemi kullaniniz.

Sorulariniz icin destek hattimiz acik.
```

---

**Doku Sonu — v1.0 (FAZ 1.4)**
