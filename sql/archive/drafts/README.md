# sql/archive/drafts/

Bu klasor: **yarim kalmis / tamamlanmamis baseline taslaklari**.

> DO NOT RUN. Production veya fresh install icin kullanilmaz.

---

## Neden burada?

Bu dosyalar bir donem aktif `sql/` kokunde durmustu. Ancak:

- Tamamlanmadilar (sadece schema iskeleti var; FK / RLS / function / index eksik)
- Calistirilirsa tenant izolasyonu olmayan, eksik bir schema kurarlar
- Aktif kokte durmalari, isim benzerligi yuzunden **yanlislikla** calistirilma riski yaratiyor

---

## Source of truth

Production icin tek aktif baseline:

- [../../999_baseline.sql](../../999_baseline.sql)

Bu klasordeki hicbir dosya, fresh install veya production deploy akisinda calistirilmamalidir.

---

## Dosyalar

### `999_baseline_FULL_LAST_PRICE_v1.sql`

- Tarih: erken `raw_materials.cost = last_price` modelinin schema taslagi
- Durum: yarim kalmis (sadece 191 satir; FK yok, RLS yok, function yok)
- Yerine gecen: `999_baseline.sql` (tam consolidated baseline, 3277 satir)
- Tarihsel deger: last_price mantiginin erken sema kurgusu icin referans
