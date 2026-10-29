-- KitchOS 0008: cash drawers, drawer (till) sessions, cash movements, blind counts.
--
-- Every cash payment and cash refund belongs to an open drawer session. A
-- session's expected cash is derived from its facts (float, cash sales, cash
-- refunds, paid-ins, paid-outs, safe drops); the cashier counts blind and the
-- variance is computed after the count. Large variances need a second person.

ALTER TABLE restaurants
  ADD COLUMN cash_variance_threshold_cents bigint NOT NULL DEFAULT 500
    CHECK (cash_variance_threshold_cents >= 0);

CREATE TABLE cash_drawers (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  restaurant_id  uuid NOT NULL,
  code           text NOT NULL CHECK (code ~ '^[a-z0-9-]{2,32}$'),
  name           text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, code),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id)
);

CREATE TABLE drawer_sessions (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                uuid NOT NULL,
  restaurant_id         uuid NOT NULL,
  drawer_id             uuid NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_approval', 'closed')),
  opened_by             uuid NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  business_date         date NOT NULL,
  opening_float_cents   bigint NOT NULL CHECK (opening_float_cents >= 0),
  -- Snapshot taken at the blind count.
  counted_by            uuid,
  counted_at            timestamptz,
  counted_cents         bigint CHECK (counted_cents >= 0),
  expected_cents        bigint,
  variance_cents        bigint,
  approved_by           uuid,
  closed_at             timestamptz,
  close_notes           text CHECK (length(close_notes) <= 500),
  version               integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  CHECK ((status = 'open') = (counted_at IS NULL)),
  CHECK (status = 'open' OR (counted_cents IS NOT NULL AND expected_cents IS NOT NULL
                             AND variance_cents = counted_cents - expected_cents)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- A variance is approved by someone who neither ran nor counted the drawer.
  CHECK (approved_by IS NULL OR (approved_by <> counted_by AND approved_by <> opened_by)),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, drawer_id) REFERENCES cash_drawers(org_id, id),
  FOREIGN KEY (org_id, opened_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, counted_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, approved_by) REFERENCES users(org_id, id)
);
-- At most one session per drawer until it is fully closed.
CREATE UNIQUE INDEX drawer_sessions_one_active ON drawer_sessions (drawer_id) WHERE status <> 'closed';
-- ...and at most one per person per restaurant, so their cash has exactly one home.
CREATE UNIQUE INDEX drawer_sessions_one_per_user ON drawer_sessions (restaurant_id, opened_by)
  WHERE status <> 'closed';
CREATE INDEX drawer_sessions_restaurant_date ON drawer_sessions (restaurant_id, business_date);

CREATE TABLE drawer_movements (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  session_id     uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('paid_in', 'paid_out', 'safe_drop')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  recorded_by    uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, session_id) REFERENCES drawer_sessions(org_id, id),
  FOREIGN KEY (org_id, recorded_by) REFERENCES users(org_id, id)
);
CREATE INDEX drawer_movements_session ON drawer_movements (session_id);
CREATE TRIGGER drawer_movements_append_only BEFORE UPDATE OR DELETE ON drawer_movements
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- Cash payments and cash refunds belong to a drawer session.
ALTER TABLE payments ADD COLUMN drawer_session_id uuid;
ALTER TABLE payments ADD CONSTRAINT payments_drawer_session_fk
  FOREIGN KEY (org_id, drawer_session_id) REFERENCES drawer_sessions(org_id, id);
ALTER TABLE refunds ADD COLUMN drawer_session_id uuid;
ALTER TABLE refunds ADD CONSTRAINT refunds_drawer_session_fk
  FOREIGN KEY (org_id, drawer_session_id) REFERENCES drawer_sessions(org_id, id);
-- New cash rows must name a session. This is enforced on INSERT by the trigger
-- below rather than a NOT VALID CHECK: Postgres re-checks such a constraint on
-- every UPDATE, which would make cash payments taken before drawers existed
-- impossible to refund (the refund updates the payment row).
CREATE INDEX payments_drawer_session ON payments (drawer_session_id) WHERE drawer_session_id IS NOT NULL;
CREATE INDEX refunds_drawer_session ON refunds (drawer_session_id) WHERE drawer_session_id IS NOT NULL;

-- Cash may only move through an open session of the same restaurant. The
-- FOR SHARE lock makes an in-flight count (which holds FOR UPDATE) finish
-- first, so cash can never land on a session after its expected cash was fixed.
CREATE FUNCTION app.require_open_drawer_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_session uuid;
  v_restaurant uuid;  -- restaurant of the inserted row (NULL for movements)
  v_status text;
  v_session_restaurant uuid;
BEGIN
  -- Separate statements: PL/pgSQL plans each one only when it runs.
  IF TG_TABLE_NAME = 'drawer_movements' THEN
    v_session := NEW.session_id;
  ELSE
    v_session := NEW.drawer_session_id;
    v_restaurant := NEW.restaurant_id;
    IF NEW.method = 'cash' AND v_session IS NULL THEN
      RAISE EXCEPTION 'cash requires a drawer session' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_session IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status, restaurant_id INTO v_status, v_session_restaurant
    FROM drawer_sessions WHERE id = v_session FOR SHARE;
  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'drawer session % is not open', v_session USING ERRCODE = 'check_violation';
  END IF;
  IF v_restaurant IS NOT NULL AND v_restaurant <> v_session_restaurant THEN
    RAISE EXCEPTION 'drawer session % belongs to another restaurant', v_session USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_open_drawer BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION app.require_open_drawer_session();
CREATE TRIGGER refunds_open_drawer BEFORE INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION app.require_open_drawer_session();
CREATE TRIGGER drawer_movements_open_drawer BEFORE INSERT ON drawer_movements
  FOR EACH ROW EXECUTE FUNCTION app.require_open_drawer_session();

-- Journal: drawer entry types and the accounts they use.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'payment_receipt', 'sale_recognition', 'refund', 'drawer_float', 'drawer_movement', 'drawer_close',
  'reversal', 'adjustment'));

CREATE OR REPLACE FUNCTION app.create_default_chart(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO accounts (org_id, code, name, type, normal_balance, system_key) VALUES
    (p_org, '1000', 'Cash on hand (drawers)', 'asset',     'debit',  'cash_on_hand'),
    (p_org, '1010', 'Card clearing',          'asset',     'debit',  'card_clearing'),
    (p_org, '1020', 'Cash in safe',           'asset',     'debit',  'cash_in_safe'),
    (p_org, '1200', 'Inventory',              'asset',     'debit',  'inventory'),
    (p_org, '2100', 'Customer deposits',      'liability', 'credit', 'customer_deposits'),
    (p_org, '2200', 'GST payable',            'liability', 'credit', 'gst_payable'),
    (p_org, '4000', 'Sales revenue',          'revenue',   'credit', 'sales_revenue'),
    (p_org, '4100', 'Discounts allowed',      'revenue',   'debit',  'sales_discounts'),
    (p_org, '4200', 'Sales returns',          'revenue',   'debit',  'sales_returns'),
    (p_org, '4900', 'Cash rounding',          'revenue',   'credit', 'cash_rounding'),
    (p_org, '5000', 'Cost of goods sold',     'expense',   'debit',  'cogs'),
    (p_org, '5100', 'Waste expense',          'expense',   'debit',  'waste_expense'),
    (p_org, '6100', 'Cash over/short',        'expense',   'debit',  'cash_over_short'),
    (p_org, '6200', 'Petty cash expenses',    'expense',   'debit',  'petty_cash')
  ON CONFLICT (org_id, system_key) DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION app.create_default_chart(uuid) FROM PUBLIC;
SELECT app.create_default_chart(id) FROM organisations;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_drawers', 'drawer_sessions', 'drawer_movements']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
  END LOOP;
END
$$;

GRANT SELECT ON cash_drawers TO kitchos_app;
GRANT SELECT, INSERT ON drawer_movements TO kitchos_app;
GRANT SELECT, INSERT ON drawer_sessions TO kitchos_app;
GRANT UPDATE (status, counted_by, counted_at, counted_cents, expected_cents, variance_cents,
              approved_by, closed_at, close_notes, version) ON drawer_sessions TO kitchos_app;
