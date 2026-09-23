# Security incident response

1. Classify scope: authentication, provider integrity, transaction mismatch, database, or secret exposure.
2. Pause only the affected write paths; preserve evidence and read/reconciliation access.
3. Rotate affected API credentials or authentication keys using overlap where supported. Revoke compromised sessions.
4. Export request IDs, pseudonymous user IDs, quote/intent/transaction IDs, security events, and control changes. Exclude cookies, bearer tokens, signed payloads, and wallet secrets.
5. Verify MySQL integrity and migration checksums. Restore only from a tested backup and retain point-in-time logs.
6. Document timeline, impact, containment, remediation, and release approval before resuming.
