# NOVA DASHBOARD — SQL

## Source of truth

[`999_baseline.sql`](999_baseline.sql) — **tek aktif baseline**.

Production schema (tables, indexes, RLS, functions, triggers, grants) bu dosya tarafindan butunuyle temsil edilir. Diger her SQL dosyasi tarihseldir.

---

## Fresh install

Yeni bir Supabase projesinde sistemi sifirdan kurmak icin:

1. Supabase Dashboard -> SQL Editor
2. `999_baseline.sql` icerigini yapistir + RUN
3. Frontend `js/config.js`'te `SUPABASE_URL` ve `SUPABASE_ANON_KEY` guncelle
4. `start-dashboard.bat` ile statik server'i baslat

Tek dosya, tek run. Baska hicbir SQL dosyasi calistirilmaz.

---

## Yeni degisiklik akisi

Schema veya RPC degisikligi yapilacaksa:

1. Yeni dosya: `NNN_kisa_isim.sql` (NNN = bir sonraki numara, su an 046)
2. Supabase Dashboard'da uygula
3. Ayni degisikligi `999_baseline.sql`'in ilgili bolumune **fold** et
4. NNN dosyasini `archive/historical/` altina tasi (ileride toplu)

Hedef: aktif kokte her zaman **sadece** `999_baseline.sql` ve bu README.

---

## Archive yapisi

```
sql/
  999_baseline.sql           ← tek aktif kaynak
  README.md                  ← bu dosya

  archive/
    drafts/                  ← yarim kalmis baseline taslaklari (DO NOT RUN)
    superseded/              ← zincirde yenisi tarafindan gecersiz kilinmis migration'lar
    shadow/                  ← baseline'in ayni davranisi zaten icerdigi eski dosyalar
    one-off/                 ← tek seferlik data backfill / fix script'leri
    diagnose/                ← psql-only debug script'leri (migration degil)
    historical/              ← (gelecek faz) baseline'a folded ilk kusak 001-045
```

### Kategori tanimlari

| Klasor | Anlam | Calistirilir mi? |
|---|---|---|
| `drafts/` | Yarim kalmis schema taslagi (FK/RLS/function eksik) | **HAYIR** |
| `superseded/` | Ayni RPC'nin eski kusagi (orn. 5 nesil `restore_full_backup`) | **HAYIR** |
| `shadow/` | Baseline'da karsiligi tam olan eski standalone dosyalar | **HAYIR** |
| `one-off/` | Bir kez calistirilmis data backfill / fix | **HAYIR** (tarihsel) |
| `diagnose/` | psql meta-command iceren tanilama script'leri | Sadece manuel debug icin |
| `historical/` | Baseline'a folded numbered migration'lar | **HAYIR** |

---

## Kritik kural

> **Archive altindaki hicbir dosya production veya fresh install akisinda calistirilmaz.**

Bu dosyalar git history yedegi gibi degerlendirilmeli. Mevcut prod schema'yi temsil eden tek kaynak `999_baseline.sql`'dir.
