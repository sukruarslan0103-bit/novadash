-- ============================================================
-- MIGRATION 002 — Safety & Data Integrity Fixes
-- Target: Supabase (PostgreSQL 15+)
-- ============================================================

-- ========================
-- 1. product_sales → products: CASCADE → SET NULL
--    Ürün silinince tarihsel satış verisi korunsun
-- ========================
ALTER TABLE product_sales
    DROP CONSTRAINT IF EXISTS product_sales_product_id_fkey;

ALTER TABLE product_sales
    ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE product_sales
    ADD CONSTRAINT product_sales_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;

-- ========================
-- 2. sales tablosundaki UNIQUE(tenant_id, date) kaldır
--    Aynı güne birden fazla satış kaydı girilebilsin
--    (manuel + import aynı gün çakışma sorunu)
-- ========================
ALTER TABLE sales
    DROP CONSTRAINT IF EXISTS sales_tenant_id_date_key;

-- ========================
-- 3. products tablosuna is_deleted soft delete kolonu
--    Ürün silindiğinde veri kaybolmasın
-- ========================
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

-- Silinen ürünler artık listede görünmesin
CREATE INDEX IF NOT EXISTS idx_products_active
    ON products(tenant_id) WHERE is_deleted = false;

-- ========================
-- 4. sales tablosuna is_deleted soft delete kolonu
-- ========================
ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sales_active
    ON sales(tenant_id, date DESC) WHERE is_deleted = false;

-- ========================
-- 5. product_sales tablosuna index for sale_id lookup
--    (pagination page-scope fetch performansı)
-- ========================
CREATE INDEX IF NOT EXISTS idx_product_sales_sale_id
    ON product_sales(sale_id);
