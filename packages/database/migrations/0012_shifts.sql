-- KitchOS 0012: shifts and shift close (ADR-0018).
--
-- A shift is a period of trading under one person in charge at one restaurant,
-- across several drawers and cashiers. At most one is open per restaurant.
-- Orders, payments, refunds, discounts and drawer sessions are stamped with the
-- shift open when they are written, so a shift's figures are exactly its rows,
-- whatever the timing of concurrent commits. A shift that opens takes in drawer
-- sessions already running. A shift closes only when all of its drawers are
-- counted and approved, and then stores an immutable snapshot of its figures.

CREATE TABLE shifts (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by      uuid NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  business_date  date NOT NULL,
  closed_by      uuid,
  closed_at      timestamptz,
  notes          text CHECK (length(notes) <= 500),
  -- Snapshot taken at the close: totals, drawers and people, as they were.
  summary        jsonb,
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((status = 'closed') = (closed_by IS NOT NULL)),
  CHECK ((status = 'closed') = (summary IS NOT NULL)),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, opened_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, closed_by) REFERENCES users(org_id, id)
);
-- One open shift per restaurant: racing opens get a unique violation.
CREATE UNIQUE INDEX shifts_one_open ON shifts (restaurant_id) WHERE status = 'open';
CREATE INDEX shifts_restaurant_date ON shifts (restaurant_id, business_date);

-- A closed shift is a record: nothing about it changes again, and shifts are never deleted.
CREATE FUNCTION app.guard_closed_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shifts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'shift % is closed', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_closed_immutable BEFORE UPDATE OR DELETE ON shifts
  FOR EACH ROW EXECUTE FUNCTION app.guard_closed_shift();

-- Serialises shift changes with everything stamped with a shift: shift open
-- and close hold it exclusively, every stamped insert holds it shared until it
-- commits. A close therefore sees every row stamped with its shift, and a row
-- written after the close finds no open shift.
CREATE FUNCTION app.shift_lock_key(p_restaurant uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('shift:' || p_restaurant::text, 0)
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'payments', 'refunds', 'order_discounts', 'drawer_sessions']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN shift_id uuid', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id, shift_id) REFERENCES shifts(org_id, id)',
                   t, t || '_shift_fk');
    EXECUTE format('CREATE INDEX %I ON %I (shift_id) WHERE shift_id IS NOT NULL', t || '_shift', t);
  END LOOP;
END
$$;

-- Stamps a new row with its restaurant's open shift, whatever the writer says.
-- Writers that also lock a drawer session take the shift lock first
-- (resolveCashSession, drawer open), so this never waits behind a shift open
-- that is itself waiting for their session.
CREATE FUNCTION app.stamp_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_restaurant uuid;
BEGIN
  -- Separate statements: PL/pgSQL plans each one only when it runs.
  IF TG_TABLE_NAME = 'order_discounts' THEN
    SELECT restaurant_id INTO v_restaurant FROM orders WHERE id = NEW.order_id;
  ELSE
    v_restaurant := NEW.restaurant_id;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(app.shift_lock_key(v_restaurant));
  NEW.shift_id := (SELECT id FROM shifts WHERE restaurant_id = v_restaurant AND status = 'open');
  RETURN NEW;
END $$;

-- A stamp never changes. A drawer session with none may join an open shift of its
-- own restaurant (taken in when the shift opens), once.
CREATE FUNCTION app.guard_shift_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.shift_id IS NOT DISTINCT FROM OLD.shift_id THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'drawer_sessions' AND OLD.shift_id IS NULL AND EXISTS (
       SELECT 1 FROM shifts s
        WHERE s.id = NEW.shift_id AND s.status = 'open' AND s.restaurant_id = NEW.restaurant_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% % cannot change shift', TG_TABLE_NAME, OLD.id USING ERRCODE = 'check_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['orders', 'payments', 'refunds', 'order_discounts', 'drawer_sessions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app.stamp_shift()',
                   t || '_stamp_shift', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF shift_id ON %I FOR EACH ROW EXECUTE FUNCTION app.guard_shift_stamp()',
                   t || '_shift_stamp_fixed', t);
  END LOOP;
END
$$;

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shifts
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());

GRANT SELECT, INSERT ON shifts TO kitchos_app;
GRANT UPDATE (status, closed_by, closed_at, notes, summary, version) ON shifts TO kitchos_app;
GRANT UPDATE (shift_id) ON drawer_sessions TO kitchos_app;
GRANT EXECUTE ON FUNCTION app.shift_lock_key(uuid) TO kitchos_app;
