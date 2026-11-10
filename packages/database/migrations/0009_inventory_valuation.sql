-- Inventory valuation in the journal (ADR-0016).
--
-- Every stock movement carries the value it moved, fixed when it was
-- recorded: the item's standard unit cost (cents per base unit) at that
-- moment and the extended value in cents (signed like the quantity, rounded
-- half away from zero). The journal posts these values per operation, so the
-- Inventory account reconciles to the stock ledger to the cent.

ALTER TABLE stock_movements
  ADD COLUMN unit_cost   numeric(18,6) CHECK (unit_cost >= 0),
  ADD COLUMN value_cents bigint;
-- Rows recorded before valuation existed keep NULLs: their value at the time is
-- unknown and they were never posted. Every new row is valued by the trigger.

CREATE FUNCTION app.value_stock_movement() RETURNS trigger
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
  SELECT standard_unit_cost INTO NEW.unit_cost
    FROM inventory_items WHERE id = NEW.inventory_item_id;
  IF NEW.unit_cost IS NULL THEN
    RAISE EXCEPTION 'inventory item % not found', NEW.inventory_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.value_cents := round(NEW.quantity_delta * NEW.unit_cost)::bigint;
  RETURN NEW;
END $$;
-- Values are always computed here, never supplied by the caller.
CREATE TRIGGER stock_movements_value BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION app.value_stock_movement();

CREATE INDEX stock_movements_restaurant_date ON stock_movements (restaurant_id, business_date);

-- Journal: inventory entry types and accounts.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'payment_receipt', 'sale_recognition', 'refund', 'drawer_float', 'drawer_movement', 'drawer_close',
  'cogs', 'waste', 'waste_reversal', 'goods_receipt', 'stock_count', 'opening_stock',
  'reversal', 'adjustment'));

CREATE OR REPLACE FUNCTION app.create_default_chart(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO accounts (org_id, code, name, type, normal_balance, system_key) VALUES
    (p_org, '1000', 'Cash on hand (drawers)',      'asset',     'debit',  'cash_on_hand'),
    (p_org, '1010', 'Card clearing',               'asset',     'debit',  'card_clearing'),
    (p_org, '1020', 'Cash in safe',                'asset',     'debit',  'cash_in_safe'),
    (p_org, '1200', 'Inventory',                   'asset',     'debit',  'inventory'),
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
    (p_org, '6100', 'Cash over/short',             'expense',   'debit',  'cash_over_short'),
    (p_org, '6200', 'Petty cash expenses',         'expense',   'debit',  'petty_cash')
  -- No conflict target: an org that already uses one of these codes keeps its
  -- account rather than failing the migration (a missing system account then
  -- surfaces as a posting error naming it).
  ON CONFLICT DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION app.create_default_chart(uuid) FROM PUBLIC;
SELECT app.create_default_chart(id) FROM organisations;

-- Cutover: the ledger now consumes stock and kitchen events. Everything emitted
-- before this migration concerns unvalued movements that stay outside the
-- journal, so mark those events handled instead of replaying the whole history.
INSERT INTO inbox_events (consumer, event_id, org_id)
SELECT 'ledger', id, org_id FROM outbox_events
 WHERE event_type IN ('order.accepted', 'kitchen.task.started', 'kitchen.task.completed',
                      'inventory.waste_recorded', 'inventory.waste_rejected',
                      'inventory.goods_received', 'inventory.counted', 'inventory.opening_stock')
ON CONFLICT DO NOTHING;
