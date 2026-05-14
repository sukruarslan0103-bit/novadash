# sql/archive/historical/

Bu klasor: **baseline'a folded edilmis ilk kusak migration zinciri**.

> DO NOT RUN. Production veya fresh install icin kullanilmaz.

---

## Icerik

- `001_*.sql` ... `045_*.sql` — numbered migration chain (001-045 arasi)
- `updated_*.sql` — chain icinde RPC yeniden yazimi olarak hazirlanmis SECURED versiyonlar (007 ve product_performance icin)

Bu dosyalarin **tum davranisi** [`../../999_baseline.sql`](../../999_baseline.sql) icinde consolidated olarak yer aliyor. Baseline'da her bolum hangi migration'i folded ettigini yorum satirinda belirtir (orn. `D.7 — SALES WRITE RPCs (004_idempotency + 044)`).

---

## Neden tutuluyor?

- **Audit izi**: production schema'nin nasil bu hale geldigi gorulebilir
- **Tarihsel referans**: belirli bir RPC'nin "neden bu sekilde tasarlandi" sorusu icin
- **Git history yedek**: `git log` zaten tutar, ama dosya seviyesinde de erisilebilir kalmasi tercih edildi

---

## Neden calistirilmamali?

- Cogu `CREATE OR REPLACE` ile ayni RPC'yi yeniden tanimlar -> sira hatasi prod davranisini bozar
- Bazi migration'lar ESKITILMIS (orn. 007 yerine `updated_expense_summary.sql`)
- Numbered chain icinde duplicate / superseded halkalar var; izolasyon olmadan calistirmak risklidir
- Tum logic zaten `999_baseline.sql`'de tek atimda kurulur

---

## Source of truth

[`../../999_baseline.sql`](../../999_baseline.sql)

Fresh install ve production icin yalnizca bu dosya calistirilir.

---

## Numbered chain'de eksik gorunenler

| # | Durum |
|---|---|
| 012, 023, 025, 026, 028, 029, 030, 039, 040, 042_full_backup | `../superseded/` altinda |
| 032, fix_user_trigger | `../one-off/` altinda |
| 042_alerts_master_diagnose | `../diagnose/` altinda |

Yani 001-045 chain'inin **tam topografyasi** icin `archive/` agacinin tamamina bakilmalidir.
