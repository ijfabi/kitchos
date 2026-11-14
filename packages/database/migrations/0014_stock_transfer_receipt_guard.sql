-- KitchOS 0014: the database, not only the API, keeps a transfer receipt whole
-- (ADR-0019). A line records what arrived only while its transfer is in
-- transit, and a transfer becomes received only once every line says what
-- arrived. The API writes the lines and then the status in one transaction.

CREATE OR REPLACE FUNCTION app.guard_stock_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock transfers are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'in_transit' OR NEW.status <> 'received' THEN
    RAISE EXCEPTION 'stock transfer % is already received', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_transfer_lines
              WHERE stock_transfer_id = NEW.id AND quantity_received IS NULL) THEN
    RAISE EXCEPTION 'stock transfer % has lines with nothing recorded as arrived', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_stock_transfer_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock transfer lines are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.quantity_received IS NOT NULL OR NEW.quantity_received IS NULL THEN
    RAISE EXCEPTION 'stock transfer line already received' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_transfers
                  WHERE id = NEW.stock_transfer_id AND status = 'in_transit') THEN
    RAISE EXCEPTION 'stock transfer % is already received', NEW.stock_transfer_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
