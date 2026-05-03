-- ========================================
-- EXTENSIONS
-- ========================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========================================
-- RAW MATERIALS (EKLENDİ)
-- ========================================
CREATE TABLE raw_materials (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,

  cost numeric DEFAULT 0,          -- SON ALIŞ
  prev_cost numeric,               -- ÖNCEKİ FİYAT

  last_purchase_at timestamptz,    -- SON ALIŞ ZAMANI

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ========================================
-- PURCHASE ITEMS
-- ========================================
CREATE TABLE purchase_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,

  raw_material_id uuid NOT NULL,

  quantity numeric NOT NULL,
  unit text NOT NULL,

  unit_cost numeric NOT NULL,
  line_total numeric NOT NULL,

  invoice_date date,

  is_deleted boolean DEFAULT false,

  created_at timestamptz DEFAULT now()
);

-- ========================================
-- LAST PRICE FUNCTION
-- ========================================
CREATE OR REPLACE FUNCTION update_raw_material_last_price()
RETURNS trigger AS $$
DECLARE
  v_prev numeric;
BEGIN

  -- mevcut cost'u al
  SELECT cost INTO v_prev
  FROM raw_materials
  WHERE id = NEW.raw_material_id
  FOR UPDATE;

  -- güncelle
  UPDATE raw_materials
  SET
    prev_cost = v_prev,
    cost = NEW.unit_cost,
    last_purchase_at = now(),
    updated_at = now()
  WHERE id = NEW.raw_material_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- TRIGGER
-- ========================================
CREATE TRIGGER trg_last_price_update
AFTER INSERT ON purchase_items
FOR EACH ROW
EXECUTE FUNCTION update_raw_material_last_price();

-- ========================================
-- CHANGE PERCENT FUNCTION
-- ========================================
CREATE OR REPLACE FUNCTION get_cost_change_percent(
  p_cost numeric,
  p_prev numeric
)
RETURNS numeric AS $$
BEGIN
  IF p_prev IS NULL OR p_prev = 0 THEN
    RETURN 0;
  END IF;

  RETURN ROUND(((p_cost - p_prev) / p_prev) * 100, 2);
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- ALERT VIEW (SENİN DASHBOARD)
-- ========================================
CREATE OR REPLACE VIEW raw_material_alerts AS
SELECT
  name,
  cost,
  prev_cost,
  get_cost_change_percent(cost, prev_cost) AS change_percent,

  CASE
    WHEN cost = 0 THEN 'COST_MISSING'
    WHEN prev_cost IS NULL THEN 'NEW'
    WHEN get_cost_change_percent(cost, prev_cost) > 25 THEN 'HIGH_INCREASE'
    WHEN get_cost_change_percent(cost, prev_cost) < -20 THEN 'PRICE_DROP'
    ELSE 'OK'
  END AS status

FROM raw_materials;