-- ============================================================
-- 006 — Category Name Snapshot
-- Kategori silinince isim kaybolmasin
-- ============================================================

-- Expenses: category_name kolonu
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS category_name TEXT;

-- Products: category_name kolonu
ALTER TABLE products
ADD COLUMN IF NOT EXISTS category_name TEXT;

-- Mevcut kayitlari doldur (backfill)
UPDATE expenses e
SET category_name = c.name
FROM categories c
WHERE e.category_id = c.id
  AND e.category_name IS NULL;

UPDATE products p
SET category_name = c.name
FROM categories c
WHERE p.category_id = c.id
  AND p.category_name IS NULL;
