# ADR-0004: Money and quantity representation

- Status: Accepted (2026-10-26)

## Decision

- **Money** is an integer number of minor units (cents), `bigint` in PostgreSQL and a branded
  `Cents` number in TypeScript. Every arithmetic result is checked with `Number.isSafeInteger`.
  Any division (tax extraction, allocation) is performed in `bigint` with explicit
  round-half-away-from-zero (`divRoundHalfUp`), never floating-point division.
- Prices are **GST-inclusive** (Australian retail norm). Tax = `amount × rate / (10000 + rate)`
  in basis points (`1000` = 10% → amount/11). Allocation uses largest-remainder so parts always
  sum to the whole (property-tested).
- **Inventory quantities** are `numeric(18,3)` in the item's base unit (`each`, `g`, `ml`). In
  TypeScript they are integer milli-units, converted with exact string parsing
  (`parseDecimalQty`). ESLint bans `parseFloat`.

## Consequences

- Per-line vs per-order GST rounding: currently computed once on the taxable order total. A
  specialist must confirm receipt/BAS treatment (docs/compliance/assumptions.md, A-03).
