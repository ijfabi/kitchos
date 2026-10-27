-- KitchOS 0006: double-entry journal, chart of accounts, accounting periods,
-- and the event-consumer bookkeeping (failures / dead letters).
--
-- Invariants enforced here:
--   * every journal entry has >= 2 lines and balances (deferred constraint trigger);
--   * journal entries and lines are append-only (corrections are reversing entries);
--   * nothing posts into a closed accounting period;
--   * one entry per (source, entry type): replaying an event cannot double-post.

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL REFERENCES organisations(id),
  code            text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance  text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  -- Stable key used by posting rules; codes and names stay editable per tenant.
  system_key      text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code),
  UNIQUE (org_id, system_key),
  UNIQUE (org_id, id)
);

-- Default chart for a tenant (idempotent). Called by the seed and for existing orgs below.
CREATE FUNCTION app.create_default_chart(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO accounts (org_id, code, name, type, normal_balance, system_key) VALUES
    (p_org, '1000', 'Cash on hand',          'asset',     'debit',  'cash_on_hand'),
    (p_org, '1010', 'Card clearing',         'asset',     'debit',  'card_clearing'),
    (p_org, '1200', 'Inventory',             'asset',     'debit',  'inventory'),
    (p_org, '2100', 'Customer deposits',     'liability', 'credit', 'customer_deposits'),
    (p_org, '2200', 'GST payable',           'liability', 'credit', 'gst_payable'),
    (p_org, '4000', 'Sales revenue',         'revenue',   'credit', 'sales_revenue'),
    (p_org, '4100', 'Discounts allowed',     'revenue',   'debit',  'sales_discounts'),
    (p_org, '4900', 'Cash rounding',         'revenue',   'credit', 'cash_rounding'),
    (p_org, '5000', 'Cost of goods sold',    'expense',   'debit',  'cogs'),
    (p_org, '5100', 'Waste expense',         'expense',   'debit',  'waste_expense')
  ON CONFLICT (org_id, system_key) DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION app.create_default_chart(uuid) FROM PUBLIC;

SELECT app.create_default_chart(id) FROM organisations;

CREATE TABLE accounting_periods (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL REFERENCES organisations(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at     timestamptz,
  closed_by     uuid,
  UNIQUE (org_id, period_start),
  CHECK (period_end >= period_start),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id             uuid NOT NULL,
  restaurant_id      uuid NOT NULL,
  business_date      date NOT NULL,
  entry_type         text NOT NULL CHECK (entry_type IN ('payment_receipt', 'sale_recognition', 'reversal', 'adjustment')),
  source_type        text NOT NULL,
  source_id          uuid NOT NULL,
  source_event_id    uuid,
  description        text NOT NULL,
  reverses_entry_id  uuid,
  posted_at          timestamptz NOT NULL DEFAULT now(),
  -- Transaction that created the entry; lines may only be added by that same
  -- transaction, so a posted entry can never gain lines later.
  created_txid       xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (org_id, source_type, source_id, entry_type),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, reverses_entry_id) REFERENCES journal_entries(org_id, id)
);
CREATE INDEX journal_entries_restaurant_date ON journal_entries (restaurant_id, business_date);

CREATE TABLE journal_lines (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id        uuid NOT NULL,
  entry_id      uuid NOT NULL,
  account_id    uuid NOT NULL,
  debit_cents   bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents  bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo          text,
  CHECK ((debit_cents > 0) <> (credit_cents > 0)),
  FOREIGN KEY (org_id, entry_id) REFERENCES journal_entries(org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES accounts(org_id, id)
);
CREATE INDEX journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_account ON journal_lines (account_id);

CREATE FUNCTION app.guard_line_same_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries e
                 WHERE e.id = NEW.entry_id AND e.created_txid = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'KITCHOS_APPEND_ONLY: lines can only be added when their journal entry is created'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_lines_same_transaction BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_line_same_transaction();

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- Checked at commit, after all lines of the entry have been inserted.
CREATE FUNCTION app.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid;
  v_debit bigint;
  v_credit bigint;
  v_lines integer;
BEGIN
  -- Separate branches: PL/pgSQL resolves every NEW.field in an expression.
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_entry := NEW.id;
  ELSE
    v_entry := NEW.entry_id;
  END IF;
  SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
    INTO v_debit, v_credit, v_lines
    FROM journal_lines WHERE entry_id = v_entry;
  IF v_lines < 2 OR v_debit <> v_credit OR v_debit = 0 THEN
    RAISE EXCEPTION 'KITCHOS_UNBALANCED: journal entry % has % line(s), debits %, credits %',
      v_entry, v_lines, v_debit, v_credit USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();

CREATE FUNCTION app.guard_closed_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_periods p
             WHERE p.org_id = NEW.org_id AND p.status = 'closed'
               AND NEW.business_date BETWEEN p.period_start AND p.period_end) THEN
    RAISE EXCEPTION 'KITCHOS_PERIOD_CLOSED: % falls in a closed accounting period', NEW.business_date
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_open_period BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app.guard_closed_period();

-- ---------------------------------------------------------------------------
-- Event consumers
-- ---------------------------------------------------------------------------

CREATE TABLE event_consumer_failures (
  consumer         text NOT NULL,
  event_id         uuid NOT NULL,
  org_id           uuid NOT NULL REFERENCES organisations(id),
  attempts         integer NOT NULL CHECK (attempts > 0),
  last_error       text NOT NULL,
  next_attempt_at  timestamptz NOT NULL,
  dead_at          timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- The one cross-tenant read a worker needs: which tenants have work for a
-- consumer. Returns ids only; all processing happens inside withTenant (RLS).
CREATE FUNCTION app.orgs_with_pending_events(p_consumer text, p_event_types text[])
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT o.org_id
  FROM outbox_events o
  WHERE o.event_type = ANY (p_event_types)
    AND NOT EXISTS (SELECT 1 FROM inbox_events i WHERE i.consumer = p_consumer AND i.event_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM event_consumer_failures f
                    WHERE f.consumer = p_consumer AND f.event_id = o.id
                      AND (f.dead_at IS NOT NULL OR f.next_attempt_at > now()))
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'accounting_periods', 'journal_entries', 'journal_lines',
                           'event_consumer_failures']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
  END LOOP;
END
$$;

GRANT SELECT ON accounts, accounting_periods TO kitchos_app;
GRANT SELECT, INSERT ON journal_entries, journal_lines TO kitchos_app;
-- Retry bookkeeping, not a ledger: rows are cleared once an event finally succeeds.
GRANT SELECT, INSERT, UPDATE, DELETE ON event_consumer_failures TO kitchos_app;
REVOKE EXECUTE ON FUNCTION app.orgs_with_pending_events(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.orgs_with_pending_events(text, text[]) TO kitchos_app;
REVOKE EXECUTE ON FUNCTION app.guard_line_same_transaction() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.guard_closed_period() FROM PUBLIC;

-- Supports the dispatcher's per-type scans; a per-consumer high-water mark is
-- the follow-up once outbox retention lands (RISKS R-015).
CREATE INDEX outbox_events_type_org ON outbox_events (event_type, org_id, restaurant_id, store_sequence);
