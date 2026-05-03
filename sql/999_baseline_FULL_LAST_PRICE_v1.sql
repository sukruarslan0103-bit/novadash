-- ========================================
-- 999 BASELINE SCHEMA
-- ========================================

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========================================
-- CATEGORIES
-- ========================================
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  color text DEFAULT '#6B7280',
  sort_order integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- PRODUCTS
-- ========================================
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  category_id uuid,
  category_name text,
  price numeric NOT NULL DEFAULT 0,
  cost numeric DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_deleted boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- EXPENSES
-- ========================================
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  date date NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  category_id uuid,
  category_name text,
  description text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- PRODUCT SALES
-- ========================================
CREATE TABLE product_sales (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sale_id uuid,
  date date NOT NULL,
  quantity integer NOT NULL DEFAULT 0,
  unit_price numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  cost numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- PURCHASE ITEMS (EN KRİTİK TABLO)
-- ========================================
CREATE TABLE purchase_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,

  raw_material_id uuid NOT NULL,

  quantity numeric NOT NULL,
  unit text NOT NULL,

  unit_cost numeric NOT NULL,
  line_total numeric NOT NULL,

  base_quantity numeric,
  base_unit_cost numeric,

  vat_rate numeric NOT NULL DEFAULT 0,
  discount_rate numeric NOT NULL DEFAULT 0,

  general_discount_amount numeric DEFAULT 0,
  general_discount_type text DEFAULT 'amount',

  note text,

  invoice_no bigint,
  invoice_date date,

  is_deleted boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- PURCHASES
-- ========================================
CREATE TABLE purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  product_id uuid NOT NULL,

  quantity numeric NOT NULL,
  total_price numeric NOT NULL,

  vat_rate numeric NOT NULL DEFAULT 0,
  net_total numeric NOT NULL,
  unit_cost numeric NOT NULL,

  general_discount_amount numeric DEFAULT 0,
  general_discount_type text DEFAULT 'amount',

  idempotency_key text,

  created_at timestamptz DEFAULT now()
);

-- ========================================
-- DELETED RECORDS (AUDIT)
-- ========================================
CREATE TABLE deleted_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  record_data jsonb NOT NULL,
  deleted_by uuid,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- EVENTS
-- ========================================
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  type text,
  date date NOT NULL,
  start_time time,
  end_time time,
  venue text,
  description text,
  est_cost numeric DEFAULT 0,
  est_revenue numeric DEFAULT 0,
  actual_cost numeric,
  actual_revenue numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- PRODUCT RECIPES
-- ========================================
CREATE TABLE product_recipes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  raw_material_id uuid NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========================================
-- INDEX (PERFORMANS)
-- ========================================
CREATE INDEX idx_purchase_items_rm 
ON purchase_items (raw_material_id)
WHERE is_deleted = false;

CREATE INDEX idx_purchase_items_invoice 
ON purchase_items (tenant_id, invoice_date);

CREATE INDEX idx_product_sales_sale 
ON product_sales (sale_id);

CREATE INDEX idx_expenses_date 
ON expenses (tenant_id, date);
