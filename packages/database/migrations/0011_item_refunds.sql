-- KitchOS 0011: refunds by item.
--
-- A refund can name the order lines it refunds, and how many of each. The
-- amount is then the lines' net price, worked out by the server, and a line
-- can never be refunded beyond its quantity. Append-only, like refunds.

CREATE TABLE refund_lines (
  org_id          uuid NOT NULL,
  refund_id       uuid NOT NULL,
  order_line_id   uuid NOT NULL,
  quantity        integer NOT NULL CHECK (quantity > 0),
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  -- The GST in that amount: the line's own share of the order's GST (none for a GST-free item).
  gst_cents       bigint NOT NULL CHECK (gst_cents >= 0 AND gst_cents <= amount_cents),
  PRIMARY KEY (refund_id, order_line_id),
  FOREIGN KEY (org_id, refund_id) REFERENCES refunds(org_id, id),
  FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines(org_id, id)
);
CREATE INDEX refund_lines_order_line ON refund_lines (order_line_id);
CREATE TRIGGER refund_lines_append_only BEFORE UPDATE OR DELETE ON refund_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

ALTER TABLE refund_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refund_lines
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());

GRANT SELECT, INSERT ON refund_lines TO kitchos_app;

-- The GST a refund returns, fixed when it is made: per item for a refund by item, a capped share
-- of the order's GST for a refund by amount. NULL for refunds made before this (and for deposit
-- releases), which the ledger keeps posting with the proportional rule.
ALTER TABLE refunds ADD COLUMN gst_cents bigint CHECK (gst_cents >= 0 AND gst_cents <= amount_cents);
