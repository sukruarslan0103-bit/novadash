-- ============================================================
-- BUSINESS CHECK-UP DASHBOARD — Tenant Auto-Assign: Recipe Tables
-- Version: 016
-- Target: Supabase (PostgreSQL 15+)
--
-- Amaç:
--   raw_materials ve product_recipes tablolarında client tarafından
--   tenant_id gönderilmese bile, auth.uid() üzerinden otomatik olarak
--   doldurulsun. Mevcut set_tenant_id() fonksiyonu yeniden kullanılır.
--
-- Depends on:
--   - tenant_auto_assign.sql      (set_tenant_id() fonksiyonu)
--   - 013_raw_materials.sql       (raw_materials tablosu)
--   - 014_product_recipes.sql     (product_recipes tablosu)
--
-- Güvenlik:
--   - Mevcut set_tenant_id() fonksiyonuna DOKUNULMAZ.
--   - Mevcut tablolara DOKUNULMAZ.
--   - DROP TRIGGER IF EXISTS + CREATE TRIGGER → idempotent, re-run güvenli.
-- ============================================================

-- ========================
-- raw_materials
-- ========================
DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON raw_materials;

CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON raw_materials
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();


-- ========================
-- product_recipes
-- ========================
DROP TRIGGER IF EXISTS set_tenant_id_before_insert ON product_recipes;

CREATE TRIGGER set_tenant_id_before_insert
BEFORE INSERT ON product_recipes
FOR EACH ROW
EXECUTE FUNCTION set_tenant_id();
