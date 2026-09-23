# Pause and provider-outage runbook

The independent controls are `quotes_paused`, `intent_creation_paused`, and `transaction_submission_paused`.

- During a quote-provider integrity incident, pause quotes and intents. Preserve market reads, balances, history, and reconciliation.
- During an RPC broadcast incident, pause submission only. Continue checking already-recorded hashes through healthy fallback providers.
- Store the reason and operator identity when changing a control and emit the corresponding operational alert.
- Never clear an outage by deleting quotes, intents, or transaction records.
- Resume in order: provider health check, reconciliation backlog check, internal low-value canary, submission, intent creation, then quotes.
