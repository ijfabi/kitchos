# ADR-0009: Staff authentication and authorisation (interim)

- Status: Accepted as interim (2026-10-26)

## Decision

- Staff sign in with email + password (argon2id via `@node-rs/argon2`). Unknown emails verify
  against a real dummy hash so timing does not reveal account existence.
- The API issues a short-lived (8 h) **HS256 JWT** with OIDC-style claims (`sub`, `iss`, `aud`,
  `exp`, plus `org`). Roles are **not** read from the token: the user and role assignments are
  reloaded on every request, so revocation and role changes are immediate.
- RBAC (role → permissions) combined with ABAC on the restaurant hierarchy
  (assignment scope must cover the target restaurant).
- Login is rate-limited per IP and per (IP, email) — in-process for now.

## Planned (tracked in FEATURE_MATRIX / RISKS)

- External OIDC provider (e.g. Cognito) with asymmetric signing, MFA for privileged roles,
  refresh/rotation, device identity for POS/KDS/kiosk, staff PIN login with hashed PINs,
  Redis-backed shared rate limiting, re-authentication for high-risk actions.
