# Phase 2 Delivery Status

## Implemented

- Direct-SQL MySQL tables for users, credentials, sessions, challenges, and security events.
- Case-normalized email registration with current-terms acceptance and enumeration-resistant duplicate responses.
- Argon2id password hashing with a server-held pepper, weak-password checks, bounded input length, and rehash-on-login support.
- One-time hashed email-verification and password-reset challenges with expiry and invalidation of prior active challenges.
- Generic resend and forgot-password responses.
- Constant-work unknown-user login behavior, per-IP route limits, per-account failed-attempt tracking, and escalating temporary lockout.
- Signed short-lived HS256 access tokens containing only user ID, session ID, token version, and standard claims.
- Access-token `kid` validation with a configured previous-key overlap path.
- High-entropy opaque refresh tokens stored only as keyed hashes.
- Transactional refresh rotation using `SELECT ... FOR UPDATE`, replay detection, and token-family revocation.
- `HttpOnly` refresh cookie, double-submit CSRF cookie/header, strict SameSite policy, and allowed-Origin enforcement.
- Login, refresh, logout, logout-all, session list/revoke, password change, forgot/reset password, verification, and `/me` routes.
- Immediate database-backed session and token-version validation on protected requests.
- Password change/reset revokes all sessions and increments the user token version.
- Structured security-event writes without raw credentials or tokens.
- Fail-closed authentication boundary for future `/v1` routes.

## Validation completed

- Formatting, lint, strict TypeScript, production build, and production dependency audit.
- Argon2id hashing/verification and password-policy tests.
- Access-token signature/key validation and stale-token-version tests.
- Duplicate registration masking and refresh-reuse behavior tests.
- Cookie, CSRF, Origin, strict-body, and fail-closed route tests.

## Environment-dependent validation pending

- Apply `0002_auth.sql` to the containerized MySQL service and run full database-backed registration/login/rotation/recovery tests.
- Configure and verify the production HTTP email provider.
- Docker is unavailable on the implementation host, so these checks must run on a Docker-enabled CI or staging host.
