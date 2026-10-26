-- KitchOS 0004: POS cash tender, change and cash rounding.
--
-- Australia withdrew 1c and 2c coins; cash totals are rounded to the nearest
-- 5c while card totals are not. The order total (revenue) is unchanged; the
-- rounding difference is recorded separately on the payment so finance can
-- post it to a rounding account. Increment is configurable per restaurant
-- (1 = no rounding) and is a compliance assumption to verify (A-10).

ALTER TABLE restaurants
  ADD COLUMN cash_rounding_increment_cents integer NOT NULL DEFAULT 5
    CHECK (cash_rounding_increment_cents BETWEEN 1 AND 100);

ALTER TABLE payments
  ADD COLUMN tendered_cents bigint,
  ADD COLUMN change_cents bigint,
  -- Cash payable minus order total: negative when rounded down, positive when up.
  ADD COLUMN cash_rounding_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN received_by uuid,
  ADD CONSTRAINT payments_cash_fields CHECK (
    CASE method
      WHEN 'cash' THEN tendered_cents IS NOT NULL
                   AND change_cents IS NOT NULL
                   AND change_cents >= 0
                   AND tendered_cents = amount_cents + cash_rounding_cents + change_cents
      ELSE tendered_cents IS NULL AND change_cents IS NULL AND cash_rounding_cents = 0
    END),
  ADD CONSTRAINT payments_cash_provider CHECK ((method = 'cash') = (provider = 'cash')),
  ADD CONSTRAINT payments_received_by_fk FOREIGN KEY (org_id, received_by) REFERENCES users(org_id, id);

-- Parked POS orders are listed by channel and status.
CREATE INDEX orders_restaurant_channel_status ON orders (restaurant_id, channel, status, placed_at);
