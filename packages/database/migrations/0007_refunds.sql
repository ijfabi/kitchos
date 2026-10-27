-- KitchOS 0007: refunds and payment reversal.
--
-- A refund is an append-only fact against a captured payment. Its accounting
-- treatment is fixed when it is created:
--   deposit_release — the order was never handed over (e.g. cancelled after
--                     payment): the customer deposit is returned;
--   sales_return    — revenue was already recognised: a sales return with its
--                     share of GST.
-- Refunds never restore stock (invariant 11); there is no inventory effect.

ALTER TABLE payments
  ADD COLUMN refunded_cents bigint NOT NULL DEFAULT 0
    CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents);
GRANT UPDATE (refunded_cents) ON payments TO kitchos_app;

CREATE TABLE refunds (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id               uuid NOT NULL,
  restaurant_id        uuid NOT NULL,
  order_id             uuid NOT NULL,
  payment_id           uuid NOT NULL,
  method               text NOT NULL CHECK (method IN ('card', 'cash')),
  -- Amount applied against the payment / order.
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  -- payments.refunded_cents before this refund, captured under the payment
  -- lock: makes cumulative cash rounding and GST shares independent of clocks.
  refunded_before_cents bigint NOT NULL CHECK (refunded_before_cents >= 0),
  -- Cash only: cash handed back minus amount (rounding to the restaurant increment).
  cash_rounding_cents  bigint NOT NULL DEFAULT 0,
  treatment            text NOT NULL CHECK (treatment IN ('deposit_release', 'sales_return')),
  reason               text NOT NULL CHECK (reason IN (
                         'cancelled_order', 'order_error', 'quality', 'customer_complaint',
                         'duplicate_charge', 'other')),
  note                 text CHECK (length(note) <= 500),
  provider_reference   text,
  requested_by         uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (method = 'cash' OR cash_rounding_cents = 0),
  FOREIGN KEY (org_id, restaurant_id) REFERENCES restaurants(org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES orders(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  FOREIGN KEY (org_id, requested_by) REFERENCES users(org_id, id)
);
CREATE INDEX refunds_payment ON refunds (payment_id);
CREATE INDEX refunds_restaurant_created ON refunds (restaurant_id, created_at);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refunds
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
GRANT SELECT, INSERT ON refunds TO kitchos_app;

-- Journal: refund entries and the sales-returns contra-revenue account.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN (
  'payment_receipt', 'sale_recognition', 'refund', 'reversal', 'adjustment'));

CREATE OR REPLACE FUNCTION app.create_default_chart(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO accounts (org_id, code, name, type, normal_balance, system_key) VALUES
    (p_org, '1000', 'Cash on hand',          'asset',     'debit',  'cash_on_hand'),
    (p_org, '1010', 'Card clearing',         'asset',     'debit',  'card_clearing'),
    (p_org, '1200', 'Inventory',             'asset',     'debit',  'inventory'),
    (p_org, '2100', 'Customer deposits',     'liability', 'credit', 'customer_deposits'),
    (p_org, '2200', 'GST payable',           'liability', 'credit', 'gst_payable'),
    (p_org, '4000', 'Sales revenue',         'revenue',   'credit', 'sales_revenue'),
    (p_org, '4100', 'Discounts allowed',     'revenue',   'debit',  'sales_discounts'),
    (p_org, '4200', 'Sales returns',         'revenue',   'debit',  'sales_returns'),
    (p_org, '4900', 'Cash rounding',         'revenue',   'credit', 'cash_rounding'),
    (p_org, '5000', 'Cost of goods sold',    'expense',   'debit',  'cogs'),
    (p_org, '5100', 'Waste expense',         'expense',   'debit',  'waste_expense')
  ON CONFLICT (org_id, system_key) DO NOTHING
$$;
REVOKE EXECUTE ON FUNCTION app.create_default_chart(uuid) FROM PUBLIC;
SELECT app.create_default_chart(id) FROM organisations;
