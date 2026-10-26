# ADR-0010: Payments are separate from orders; sandbox provider only

- Status: Accepted (2026-10-26)

## Decision

- `payments` has its own state machine (`pending → authorized → captured → refunded…`, `failed`,
  `voided`) and is linked to, not merged with, the order. A captured payment moves the order
  from `pending_payment` to `accepted`; a failed payment leaves the order awaiting payment.
- KitchOS accepts **only provider tokens** (`tok_…`) produced client-side by a payment SDK. The
  contract rejects anything else, so PAN/CVV can never be submitted or stored (PCI DSS scope
  reduction — SAQ applicability to be confirmed by a QSA).
- The current provider is a deterministic **sandbox** (`tok_sandbox_approve`,
  `tok_sandbox_decline`, …). Payment collection is **not** revenue recognition; journal postings
  arrive with the accounting module (Phase 3).
- Payments are idempotent per order (`Idempotency-Key`), and a partial unique index allows at
  most one successful payment per order until split tender is implemented.
