# Compliance assumptions requiring specialist verification

KitchOS is configured for an Australian initial context. **Nothing here is legal, tax, payroll,
food-safety or PCI advice, and no part of KitchOS is certified compliant.** Each assumption below
must be verified by an appropriately qualified specialist before production use.

| ID   | Area          | Assumption in the current implementation                                                                 | Verify with                   |
| ---- | ------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| A-01 | GST           | Menu prices are GST-inclusive; GST rate 10% configured per restaurant (`tax_rate_bp = 1000`)             | Tax adviser                   |
| A-02 | GST           | Products carry a `taxable` flag; GST-free food classification is a per-product configuration decision    | Tax adviser                   |
| A-03 | GST           | GST is computed once on the taxable order total (round half up), not per line                            | Tax adviser                   |
| A-04 | Tax invoices  | Digital receipts/tax invoice content requirements (ABN, "tax invoice" wording, thresholds) not yet built | Tax adviser                   |
| A-05 | Payments      | Token-only card handling keeps PAN/CVV out of KitchOS; actual PCI DSS SAQ type depends on provider/setup | PCI QSA                       |
| A-06 | Food safety   | Allergen data on products is informational and seeded synthetically                                      | Food safety officer (FSANZ)   |
| A-07 | Privacy       | Guest orders store an optional first name only; retention periods not yet configured                     | Privacy adviser (Privacy Act) |
| A-08 | Business days | Business date = local time minus a configurable cutoff (default 04:00) in the restaurant's IANA timezone | Finance / operations          |
| A-09 | Workforce     | Future Fair Work / award logic will be configurable, effective-dated and labelled unverified             | Employment law / payroll      |

## Industry standards vs KitchOS proposals

- **Industry standard practice** reflected here: GST-inclusive retail pricing in Australia;
  tokenised card payments; append-only ledgers for stock and money; recipe-based theoretical
  usage; kitchen display station routing; transactional outbox (AWS Prescriptive Guidance).
- **KitchOS-specific design choices**: per-recipe-version configurable consumption point;
  database-enforced exactly-once consumption keyed by order line; immutable ingredient snapshot
  per order line; RLS-first multi-tenancy with 404 semantics for foreign tenants.
- No proprietary source, workflows or assets from Toast, Square, Oracle MICROS, NCR Voyix,
  Lightspeed or Odoo were used.
