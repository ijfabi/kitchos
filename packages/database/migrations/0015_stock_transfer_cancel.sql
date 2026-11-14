-- KitchOS 0015: cancelling a stock transfer in transit (ADR-0020).
--
-- The sender may cancel a transfer that has not been received: its stock comes
-- back to the sender's shelf as return_to_stock movements, valued at the cost
-- the dispatch was recorded at, and the value leaves Stock in transit back into
-- the sender's Inventory. A transfer is then either received or cancelled, once.

ALTER TABLE stock_transfers DROP CONSTRAINT stock_transfers_status_check;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_status_check
  CHECK (status IN ('in_transit', 'received', 'cancelled'));

ALTER TABLE stock_transfers
  ADD COLUMN cancelled_by          uuid,
  ADD COLUMN cancelled_at          timestamptz,
  ADD COLUMN cancel_business_date  date,
  ADD COLUMN cancel_reason         text CHECK (length(cancel_reason) BETWEEN 3 AND 500),
  ADD CONSTRAINT stock_transfers_cancelled_by_fk
    FOREIGN KEY (org_id, cancelled_by) REFERENCES users(org_id, id),
  ADD CONSTRAINT stock_transfers_cancel_complete CHECK (
    (status = 'cancelled') = (cancelled_by IS NOT NULL)
    AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
    AND (status = 'cancelled') = (cancel_business_date IS NOT NULL)
    AND (status = 'cancelled') = (cancel_reason IS NOT NULL));

-- One change only: in transit to received (every line recorded) or to cancelled.
CREATE OR REPLACE FUNCTION app.guard_stock_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock transfers are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'in_transit' OR NEW.status NOT IN ('received', 'cancelled') THEN
    RAISE EXCEPTION 'stock transfer % is already %', OLD.id, replace(OLD.status, '_', ' ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'received' AND EXISTS (
       SELECT 1 FROM stock_transfer_lines
        WHERE stock_transfer_id = NEW.id AND quantity_received IS NULL) THEN
    RAISE EXCEPTION 'stock transfer % has lines with nothing recorded as arrived', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'cancelled' AND EXISTS (
       SELECT 1 FROM stock_transfer_lines
        WHERE stock_transfer_id = NEW.id AND quantity_received IS NOT NULL) THEN
    RAISE EXCEPTION 'stock transfer % has lines recorded as arrived', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Valuation (ADR-0016, ADR-0019): what comes back to the sender on a cancel is
-- valued like what arrives at the receiver, at the dispatch's unit cost, so a
-- cancel clears exactly what the dispatch put into transit. Otherwise as 0013.
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
  IF NEW.movement_type IN ('transfer_in', 'return_to_stock') AND NEW.source_type = 'stock_transfer' THEN
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

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'payment_receipt', 'sale_recognition', 'refund', 'drawer_float', 'drawer_movement', 'drawer_close',
  'cogs', 'waste', 'waste_reversal', 'goods_receipt', 'stock_count', 'opening_stock',
  'transfer_out', 'transfer_in', 'transfer_cancel', 'reversal', 'adjustment'));

GRANT UPDATE (cancelled_by, cancelled_at, cancel_business_date, cancel_reason)
  ON stock_transfers TO kitchos_app;
