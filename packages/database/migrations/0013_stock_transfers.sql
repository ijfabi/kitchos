-- KitchOS 0013: stock transfers between restaurants (ADR-0019).
--
-- The sending restaurant dispatches stock: transfer_out movements leave its
-- shelf and the value moves from Inventory to Stock in transit. The receiving
-- restaurant then records what actually arrived, once: transfer_in movements,
-- valued at the dispatch's unit cost, move value from Stock in transit into its
-- Inventory, and anything short is written off as a transfer shortage. So
-- Stock in transit clears to zero for every received transfer, whatever the
-- standard cost did in between.

CREATE TABLE stock_transfers (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                 uuid NOT NULL,
  from_restaurant_id     uuid NOT NULL,
  from_location_id       uuid NOT NULL,
  to_restaurant_id       uuid NOT NULL,
  to_location_id         uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'in_transit'
                           CHECK (status IN ('in_transit', 'received')),
  dispatched_by          uuid NOT NULL,
  dispatched_at          timestamptz NOT NULL DEFAULT now(),
  dispatch_business_date date NOT NULL,
  notes                  text CHECK (length(notes) <= 500),
  received_by            uuid,
  received_at            timestamptz,
  receive_business_date  date,
  receive_notes          text CHECK (length(receive_notes) <= 500),
  version                integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  CHECK (from_restaurant_id <> to_restaurant_id),
  CHECK ((status = 'received') = (received_by IS NOT NULL)),
  CHECK ((status = 'received') = (received_at IS NOT NULL)),
  CHECK ((status = 'received') = (receive_business_date IS NOT NULL)),
  FOREIGN KEY (org_id, from_restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, to_restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, from_location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, to_location_id) REFERENCES stock_locations(org_id, id),
  FOREIGN KEY (org_id, dispatched_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, received_by) REFERENCES users(org_id, id)
);
CREATE INDEX stock_transfers_from ON stock_transfers (from_restaurant_id, dispatched_at);
CREATE INDEX stock_transfers_to ON stock_transfers (to_restaurant_id, status, dispatched_at);

CREATE TABLE stock_transfer_lines (
  org_id             uuid NOT NULL,
  stock_transfer_id  uuid NOT NULL,
  inventory_item_id  uuid NOT NULL,
  quantity_sent      numeric(18,3) NOT NULL CHECK (quantity_sent > 0),
  -- What arrived; set once, when the transfer is received.
  quantity_received  numeric(18,3) CHECK (quantity_received >= 0 AND quantity_received <= quantity_sent),
  PRIMARY KEY (stock_transfer_id, inventory_item_id),
  FOREIGN KEY (org_id, stock_transfer_id) REFERENCES stock_transfers(org_id, id),
  FOREIGN KEY (org_id, inventory_item_id) REFERENCES inventory_items(org_id, id)
);

-- A received transfer is a record; transfers are never deleted. The only change
-- a transfer ever sees is being received, once.
CREATE FUNCTION app.guard_stock_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock transfers are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'in_transit' OR NEW.status <> 'received' THEN
    RAISE EXCEPTION 'stock transfer % is already received', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_transfers_guard BEFORE UPDATE OR DELETE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_transfer();

CREATE FUNCTION app.guard_stock_transfer_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock transfer lines are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.quantity_received IS NOT NULL OR NEW.quantity_received IS NULL THEN
    RAISE EXCEPTION 'stock transfer line already received' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_transfer_lines_guard BEFORE UPDATE OR DELETE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_stock_transfer_line();

-- Valuation (ADR-0016): a transfer_in is valued at the unit cost its dispatch
-- was valued at, so what arrives leaves Stock in transit at exactly the value
-- that entered it. A transfer_in with no dispatch of the same item is refused.
CREATE OR REPLACE FUNCTION app.value_stock_movement() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_original_cost numeric(18,6);
BEGIN
  -- A correction that reverses a specific movement (source_key = that movement's
  -- id, e.g. a rejected waste record) is valued at the original movement's cost,
  -- so the reversal exactly undoes it even if the standard cost changed since.
  -- Reversing an unvalued (pre-valuation) movement stays unvalued.
  IF NEW.movement_type = 'correction'
     AND NEW.source_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT unit_cost INTO v_original_cost
      FROM stock_movements
     WHERE id = NEW.source_key::uuid AND inventory_item_id = NEW.inventory_item_id;
    IF FOUND THEN
      NEW.unit_cost := v_original_cost;
      NEW.value_cents := round(NEW.quantity_delta * v_original_cost)::bigint;  -- NULL stays NULL
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.movement_type = 'transfer_in' AND NEW.source_type = 'stock_transfer' THEN
    SELECT unit_cost INTO v_original_cost
      FROM stock_movements
     WHERE source_type = 'stock_transfer' AND source_id = NEW.source_id
       AND inventory_item_id = NEW.inventory_item_id AND movement_type = 'transfer_out';
    IF NOT FOUND OR v_original_cost IS NULL THEN
      RAISE EXCEPTION 'transfer % has no valued dispatch of item %', NEW.source_id, NEW.inventory_item_id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.unit_cost := v_original_cost;
    NEW.value_cents := round(NEW.quantity_delta * v_original_cost)::bigint;
    RETURN NEW;
  END IF;
  SELECT standard_unit_cost INTO NEW.unit_cost
    FROM inventory_items WHERE id = NEW.inventory_item_id;
  IF NEW.unit_cost IS NULL THEN
    RAISE EXCEPTION 'inventory item % not found', NEW.inventory_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.value_cents := round(NEW.quantity_delta * NEW.unit_cost)::bigint;
  RETURN NEW;
END $$;

-- Journal: transfer entry types and accounts.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'payment_receipt', 'sale_recognition', 'refund', 'drawer_float', 'drawer_movement', 'drawer_close',
  'cogs', 'waste', 'waste_reversal', 'goods_receipt', 'stock_count', 'opening_stock',
  'transfer_out', 'transfer_in', 'reversal', 'adjustment'));

CREATE OR REPLACE FUNCTION app.create_default_chart(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO accounts (org_id, code, name, type, normal_balance, system_key) VALUES
    (p_org, '1000', 'Cash on hand (drawers)',      'asset',     'debit',  'cash_on_hand'),
    (p_org, '1010', 'Card clearing',               'asset',     'debit',  'card_clearing'),
    (p_org, '1020', 'Cash in safe',                'asset',     'debit',  'cash_in_safe'),
    (p_org, '1200', 'Inventory',                   'asset',     'debit',  'inventory'),
    (p_org, '1210', 'Stock in transit',            'asset',     'debit',  'stock_in_transit'),
    (p_org, '2100', 'Customer deposits',           'liability', 'credit', 'customer_deposits'),
    (p_org, '2200', 'GST payable',                 'liability', 'credit', 'gst_payable'),
    (p_org, '2300', 'Goods received not invoiced', 'liability', 'credit', 'goods_received_not_invoiced'),
    (p_org, '3000', 'Opening balance equity',      'equity',    'credit', 'opening_balance_equity'),
    (p_org, '4000', 'Sales revenue',               'revenue',   'credit', 'sales_revenue'),
    (p_org, '4100', 'Discounts allowed',           'revenue',   'debit',  'sales_discounts'),
    (p_org, '4200', 'Sales returns',               'revenue',   'debit',  'sales_returns'),
    (p_org, '4900', 'Cash rounding',               'revenue',   'credit', 'cash_rounding'),
    (p_org, '5000', 'Cost of goods sold',          'expense',   'debit',  'cogs'),
    (p_org, '5100', 'Waste expense',               'expense',   'debit',  'waste_expense'),
    (p_org, '5200', 'Stock count variance',        'expense',   'debit',  'stock_variance'),
    (p_org, '5300', 'Transfer shortage',           'expense',   'debit',  'transfer_shortage'),
    (p_org, '6100', 'Cash over/short',             'expense',   'debit',  'cash_over_short'),
    (p_org, '6200', 'Petty cash expenses',         'expense',   'debit',  'petty_cash')
  -- No conflict target: an org that already uses one of these codes keeps its
  -- account rather than failing the migration (a missing system account then
  -- surfaces as a posting error naming it).
  ON CONFLICT DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION app.create_default_chart(uuid) FROM PUBLIC;
SELECT app.create_default_chart(id) FROM organisations;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_transfers', 'stock_transfer_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON stock_transfers, stock_transfer_lines TO kitchos_app;
GRANT UPDATE (status, received_by, received_at, receive_business_date, receive_notes, version)
  ON stock_transfers TO kitchos_app;
GRANT UPDATE (quantity_received) ON stock_transfer_lines TO kitchos_app;
