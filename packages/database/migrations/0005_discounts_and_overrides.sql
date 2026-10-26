-- KitchOS 0005: order discounts and manager overrides.

ALTER TABLE restaurants
  -- Crew may self-approve a discount up to BOTH limits; beyond either, an
  -- authorised approver (or a manager override) is required.
  ADD COLUMN discount_self_approval_bp integer NOT NULL DEFAULT 1000
    CHECK (discount_self_approval_bp BETWEEN 0 AND 10000),
  ADD COLUMN discount_self_approval_cents bigint NOT NULL DEFAULT 500
    CHECK (discount_self_approval_cents >= 0);

-- Portion of the order discount allocated to each line (largest remainder),
-- so tax and reporting stay exact when taxable and GST-free lines are mixed.
ALTER TABLE order_lines ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0);
GRANT UPDATE (discount_cents) ON order_lines TO kitchos_app;

-- A manager re-authenticated at a terminal to authorise one specific action.
-- Only a hash of the secret handed to the terminal is stored. Single use.
CREATE TABLE manager_overrides (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id              uuid NOT NULL,
  restaurant_id       uuid NOT NULL,
  action              text NOT NULL CHECK (action IN ('order.discount')),
  order_id            uuid NOT NULL,
  approver_user_id    uuid NOT NULL,
  requested_by        uuid NOT NULL,
  -- The exact discount the approver authorised; using the override requires
  -- an identical discount, so approval for "15%" cannot authorise a comp.
  discount_kind       text NOT NULL CHECK (discount_kind IN ('percent', 'amount')),
  discount_value      bigint NOT NULL CHECK (discount_value > 0),
  discount_reason     text NOT NULL,
  discount_cents      bigint NOT NULL CHECK (discount_cents > 0),
  secret_hash         text NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (approver_user_id <> requested_by),
  CHECK (expires_at > created_at),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, id),
  FOREIGN KEY (org_id, approver_user_id) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, requested_by) REFERENCES users(org_id, id)
);

-- One discount per order in this slice; immutable once written.
CREATE TABLE order_discounts (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id          uuid NOT NULL,
  order_id        uuid NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('percent', 'amount')),
  -- Basis points for percent (10000 = 100%), cents for amount.
  value           bigint NOT NULL CHECK (value > 0),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  reason          text NOT NULL CHECK (reason IN (
                    'customer_service', 'promotion', 'staff_meal', 'complimentary',
                    'price_match', 'other')),
  note            text CHECK (length(note) <= 500),
  applied_by      uuid NOT NULL,
  approved_by     uuid NOT NULL,
  override_id     uuid UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (kind <> 'percent' OR value <= 10000),
  CHECK ((override_id IS NULL) = (approved_by = applied_by)),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, id),
  FOREIGN KEY (org_id, applied_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, approved_by) REFERENCES users(org_id, id),
  FOREIGN KEY (org_id, override_id) REFERENCES manager_overrides(org_id, id)
);
CREATE TRIGGER order_discounts_append_only BEFORE UPDATE OR DELETE ON order_discounts
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['manager_overrides', 'order_discounts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON order_discounts, manager_overrides TO kitchos_app;
GRANT UPDATE (consumed_at) ON manager_overrides TO kitchos_app;
-- Totals change when a discount is applied to an unpaid order.
GRANT UPDATE (discount_cents, total_cents, tax_cents) ON orders TO kitchos_app;
