-- KitchOS 0016: follow-ups to transfer cancel (ADR-0020).
--
-- The line guard from 0014 named every settled transfer "received"; a cancelled
-- one is now named as such. And the daily Stock in transit reconciliation finds
-- the transfers a restaurant received on a day by that day, so it needs an index
-- that does not grow with every transfer the restaurant has ever received.

CREATE OR REPLACE FUNCTION app.guard_stock_transfer_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock transfer lines are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.quantity_received IS NOT NULL OR NEW.quantity_received IS NULL THEN
    RAISE EXCEPTION 'stock transfer line already received' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO v_status FROM stock_transfers WHERE id = NEW.stock_transfer_id;
  IF v_status IS DISTINCT FROM 'in_transit' THEN
    RAISE EXCEPTION 'stock transfer % is already %', NEW.stock_transfer_id, replace(v_status, '_', ' ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX stock_transfers_received_on
  ON stock_transfers (to_restaurant_id, receive_business_date)
  WHERE status = 'received';
