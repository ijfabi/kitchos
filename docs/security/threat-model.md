# Threat model (initial — Phase 0/1 scope)

Method: STRIDE over the implemented trust boundaries. Updated as features land.

## Trust boundaries

1. Browser / device → API (public internet). Customers are anonymous; staff hold JWTs.
2. API → PostgreSQL (runtime role `kitchos_app`, RLS enforced).
3. Migration/seed tooling → PostgreSQL (owner role, never used at runtime).

## Threats and controls

| STRIDE                 | Threat                                                     | Control (implemented unless noted)                                                                          |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Spoofing               | Staff credential stuffing                                  | argon2id, per-IP and per-account rate limits, uniform error + timing for unknown users; MFA _planned_       |
| Spoofing               | Forged/altered JWT                                         | HS256 signature, issuer/audience/expiry checks, roles reloaded from DB; asymmetric OIDC _planned_           |
| Tampering              | Client-supplied prices or totals                           | Pricing exclusively from server-side published menu; unknown fields ignored (tested)                        |
| Tampering              | Rewriting stock/audit history                              | Runtime role lacks UPDATE/DELETE; triggers block even the owner (tested)                                    |
| Tampering              | Changing a published menu/recipe after orders reference it | Immutability triggers (tested)                                                                              |
| Repudiation            | Manager denies cancelling a prepared order                 | Append-only `audit_log` with actor, reason, permission used                                                 |
| Information disclosure | Cross-tenant data access (IDOR)                            | RLS on every tenant table + tenant derived server-side; 404 for foreign restaurants (tested)                |
| Information disclosure | Card data exposure                                         | Token-only contract; PAN-shaped input rejected (tested); no card data stored beyond brand/last4             |
| Information disclosure | Guest order enumeration                                    | 128-bit random order tokens; pickup board exposes order numbers only                                        |
| Information disclosure | Secrets in logs                                            | pino redaction of authorization, cookies, passwords, payment tokens                                         |
| Denial of service      | Oversized or abusive requests                              | Zod limits (≤40 lines, qty ≤50, ≤20 modifiers), statement timeout 10 s; global rate limiting _planned_      |
| Elevation of privilege | Crew performing manager actions                            | Permission per route + contextual check (cancel after production needs `orders.cancel_after_prep`) (tested) |
| Elevation of privilege | Platform staff browsing tenant data                        | `platform_administrator` has no implicit tenant permissions                                                 |

## Known gaps (see RISKS.md)

MFA and re-authentication for high-risk actions; device identity; CSRF considerations once
cookie sessions are introduced (current API uses bearer tokens only, `credentials: false`);
dependency scanning in CI (`pnpm audit` job added, not yet gating); security headers on the
web app.
