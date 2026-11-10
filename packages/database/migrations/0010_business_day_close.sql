-- KitchOS 0010: business-day close and drawer administration (ADR-0017).
--
-- Closing a business day records an immutable snapshot of its totals and drawer
-- results, and from then on no journal entry can be dated to that day at that
-- restaurant. Corrections post on the day they are made.

CREATE TABLE business_day_closes (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  business_date  date NOT NULL,
  closed_by      uuid NOT NULL,
  closed_at      timestamptz NOT NULL DEFAULT now(),
  notes          text CHECK (length(notes) <= 500),
  totals         jsonb NOT NULL,
  drawers        jsonb NOT NULL,
  warnings       jsonb NOT NULL,
  UNIQUE (restaurant_id, business_date),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, closed_by) REFERENCES users(org_id, id)
);
CREATE TRIGGER business_day_closes_append_only BEFORE UPDATE OR DELETE ON business_day_closes
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Set when an entry belonged to a day that had already closed: it posts to the
-- first open day instead, and says which day it came from. Reconciliation leaves
-- it out of that day's comparison, because its source is dated to the closed day.
ALTER TABLE journal_entries ADD COLUMN posted_late_from date;

-- Serialises posting to a day with closing it: entries hold this shared until
-- they commit, and the close holds it exclusively while it checks the day, so
-- the close sees every entry that got in and later ones see the close.
CREATE FUNCTION app.business_day_lock_key(p_restaurant uuid, p_day date) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended(p_restaurant::text || ':' || p_day::text, 0)
$$;

-- A closed day takes no more entries. One that still arrives (say, from a
-- transaction that outlived the close) moves to the first open day from today,
-- so a closed day can never turn a real fact into a permanent dead letter.
CREATE FUNCTION app.guard_closed_business_day() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_day date := NEW.business_date;
BEGIN
  LOOP
    PERFORM pg_advisory_xact_lock_shared(app.business_day_lock_key(NEW.restaurant_id, v_day));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM business_day_closes c
                          WHERE c.restaurant_id = NEW.restaurant_id AND c.business_date = v_day);
    v_day := greatest(v_day + 1, app.business_date(NEW.restaurant_id, now()));
  END LOOP;
  IF v_day <> NEW.business_date THEN
    NEW.posted_late_from := NEW.business_date;
    NEW.business_date := v_day;
  END IF;
  RETURN NEW;
END
$$;
-- Named to run before journal_entries_open_period, which then checks the final date.
CREATE TRIGGER journal_entries_open_business_day BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_closed_business_day();
REVOKE EXECUTE ON FUNCTION app.guard_closed_business_day() FROM PUBLIC;

ALTER TABLE business_day_closes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_day_closes
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());

GRANT SELECT, INSERT ON business_day_closes TO kitchos_app;
GRANT EXECUTE ON FUNCTION app.business_day_lock_key(uuid, date) TO kitchos_app;

-- Drawer administration: drawers can be added and retired, never renamed in place or deleted.
GRANT INSERT ON cash_drawers TO kitchos_app;
GRANT UPDATE (active) ON cash_drawers TO kitchos_app;
