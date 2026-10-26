-- KitchOS 0003: waste registration, goods receipts, physical counts, standard costs.

-- ---------------------------------------------------------------------------
-- Movement types: add prepared-item waste.
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN (
  'receipt', 'production_consumption', 'waste_raw', 'waste_prepared', 'transfer_in',
  'transfer_out', 'staff_meal', 'complimentary_meal', 'count_adjustment',
  'return_to_stock', 'batch_production', 'correction'));

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_sign;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_sign CHECK (
  CASE movement_type
    WHEN 'receipt' THEN quantity_delta > 0
    WHEN 'transfer_in' THEN quantity_delta > 0
    WHEN 'return_to_stock' THEN quantity_delta > 0
    WHEN 'batch_production' THEN quantity_delta > 0
    WHEN 'production_consumption' THEN quantity_delta < 0
    WHEN 'waste_raw' THEN quantity_delta < 0
    WHEN 'waste_prepared' THEN quantity_delta < 0
    WHEN 'transfer_out' THEN quantity_delta < 0
    WHEN 'staff_meal' THEN quantity_delta < 0
    WHEN 'complimentary_meal' THEN quantity_delta < 0
    ELSE true
  END);

-- ---------------------------------------------------------------------------
-- Valuation at standard cost (interim; moving-average/FIFO later). Cents per
-- base unit with fractional precision; all arithmetic stays in numeric.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_items
  ADD COLUMN standard_unit_cost numeric(18,6) NOT NULL DEFAULT 0 CHECK (standard_unit_cost >= 0);

ALTER TABLE restaurants
  ADD COLUMN waste_approval_threshold_cents bigint NOT NULL DEFAULT 2000
    CHECK (waste_approval_threshold_cents >= 0),
  ADD COLUMN count_approval_threshold_cents bigint NOT NULL DEFAULT 5000
    CHECK (count_approval_threshold_cents >= 0);

-- ---------------------------------------------------------------------------
-- Waste
-- ---------------------------------------------------------------------------
CREATE TABLE waste_records (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  restaurant_id      uuid NOT NULL,
  location_id        uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('raw_ingredient', 'prepared_item')),
  inventory_item_id  uuid,
  product_id         uuid,
  order_line_id      uuid,
  -- Raw: base-unit quantity. Prepared: number of portions (whole numbers).
  quantity           numeric(18,3) NOT NULL CHECK (quantity > 0),
  reason             text NOT NULL CHECK (reason IN (
                       'expired', 'spoiled', 'dropped', 'spilled', 'burnt', 'incorrect_order',
                       'poor_quality', 'overproduction', 'equipment_failure', 'temperature_breach',
                       'cancelled_prepared_order', 'other')),
  remake             boolean NOT NULL DEFAULT false,
  station_id         uuid,
  recorded_by        uuid NOT NULL,
  notes              text CHECK (length(notes) <= 1000),
  photo_url          text,
  cost_cents         bigint NOT NULL CHECK (cost_cents >= 0),
  status             text NOT NULL CHECK (status IN ('recorded', 'pending_approval', 'approved', 'rejected')),
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  review_reason      text,
  business_date      date NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  CHECK ((kind = 'raw_ingredient') = (inventory_item_id IS NOT NULL)),
  CHECK (kind = 'prepared_item' OR (product_id IS NULL AND order_line_id IS NULL AND NOT remake)),
  CHECK (kind = 'raw_ingredient' OR product_id IS NOT NULL),
  CHECK (kind = 'raw_ingredient' OR quantity = trunc(quantity)),
  CHECK (NOT remake OR order_line_id IS NOT NULL),
  CHECK ((status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL)),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id),
  FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines(org_id, id),
  FOREIGN KEY (org_id, station_id) REFERENCES stations(org_id, id),
  FOREIGN KEY (org_id, recorded_by) REFERENCES users(org_id, id)
);
CREATE INDEX waste_records_restaurant_date ON waste_records (restaurant_id, business_date);

-- How each ingredient of a waste record was treated physically. Separates the
-- physical ledger (stock_movements) from financial classification (cost).
CREATE TABLE waste_record_lines (
  org_id             uuid NOT NULL,
  waste_record_id    uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  quantity           numeric(18,3) NOT NULL CHECK (quantity > 0),
  treatment          text NOT NULL CHECK (treatment IN ('deducted_now', 'already_consumed')),
  unit_cost          numeric(18,6) NOT NULL,
  cost_cents         bigint NOT NULL CHECK (cost_cents >= 0),
  PRIMARY KEY (waste_record_id, inventory_item_id),
  FOREIGN KEY (org_id, waste_record_id) REFERENCES waste_records(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);
CREATE TRIGGER waste_record_lines_append_only BEFORE UPDATE OR DELETE ON waste_record_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Goods receipts (direct receiving; purchase-order matching arrives in Phase 5)
-- ---------------------------------------------------------------------------
CREATE TABLE goods_receipts (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  location_id    uuid NOT NULL,
  supplier_name  text CHECK (length(supplier_name) <= 120),
  reference      text CHECK (length(reference) <= 120),
  received_by    uuid NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  business_date  date NOT NULL,
  notes          text CHECK (length(notes) <= 1000),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, received_by) REFERENCES users(org_id, id)
);

CREATE TABLE goods_receipt_lines (
  org_id             uuid NOT NULL,
  goods_receipt_id   uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  quantity           numeric(18,3) NOT NULL CHECK (quantity > 0),
  unit_cost          numeric(18,6),
  lot_code           text CHECK (length(lot_code) <= 64),
  expires_on         date,
  PRIMARY KEY (goods_receipt_id, inventory_item_id),
  FOREIGN KEY (org_id, goods_receipt_id) REFERENCES goods_receipts(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);
CREATE TRIGGER goods_receipts_append_only BEFORE UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER goods_receipt_lines_append_only BEFORE UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Physical counts
-- ---------------------------------------------------------------------------
CREATE TABLE stock_counts (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id            uuid NOT NULL,
  restaurant_id     uuid NOT NULL,
  location_id       uuid NOT NULL,
  counted_by        uuid NOT NULL,
  counted_at        timestamptz NOT NULL DEFAULT now(),
  business_date     date NOT NULL,
  variance_cents    bigint NOT NULL,
  approved_by       uuid,
  notes             text CHECK (length(notes) <= 1000),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, counted_by) REFERENCES users(org_id, id)
);

CREATE TABLE stock_count_lines (
  org_id             uuid NOT NULL,
  stock_count_id     uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  expected           numeric(18,3) NOT NULL,
  counted            numeric(18,3) NOT NULL CHECK (counted >= 0),
  variance           numeric(18,3) NOT NULL,
  variance_cents     bigint NOT NULL,
  PRIMARY KEY (stock_count_id, inventory_item_id),
  CHECK (variance = counted - expected),
  FOREIGN KEY (org_id, stock_count_id) REFERENCES stock_counts(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);
CREATE TRIGGER stock_counts_append_only BEFORE UPDATE OR DELETE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER stock_count_lines_append_only BEFORE UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['waste_records', 'waste_record_lines', 'goods_receipts',
                           'goods_receipt_lines', 'stock_counts', 'stock_count_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON waste_record_lines, goods_receipts, goods_receipt_lines,
  stock_counts, stock_count_lines TO kitchos_app;
GRANT SELECT, INSERT ON waste_records TO kitchos_app;
-- Only the review fields of a waste record may change after it is written.
GRANT UPDATE (status, reviewed_by, reviewed_at, review_reason, version) ON waste_records TO kitchos_app;
