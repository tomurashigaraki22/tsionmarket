# Transaction recovery runbook

1. Pause new submissions by setting `transaction_submission_paused=TRUE` in `operational_controls`; keep reconciliation and read APIs running.
2. Locate the record by transaction ID, intent ID, or chain hash. Never request a user's private key or wallet unlock secret.
3. Check the configured primary and fallback RPCs independently for the recorded hash.
4. If either provider reports final success or failure, update through the reconciliation path. Do not rebroadcast a record already in `broadcasting`, `submitted`, or `unknown`.
5. If the hash is absent after the network-specific replacement window, classify it as dropped only after checking the sender nonce or Solana blockhash lifetime.
6. Record every manual determination in the incident log with provider evidence, operator, timestamp, and affected IDs.
7. Resume submissions only after a fresh quote-to-confirmation canary succeeds.
