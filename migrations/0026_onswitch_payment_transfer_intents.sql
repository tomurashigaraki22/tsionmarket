ALTER TABLE transaction_intents DROP CHECK chk_transaction_intent_type;

ALTER TABLE transaction_intents
  ADD CONSTRAINT chk_transaction_intent_type
  CHECK (intent_type IN ('swap','erc20_approval','withdrawal','payment_transfer'));
