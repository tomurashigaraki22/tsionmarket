ALTER TABLE transaction_intents DROP CHECK chk_transaction_intent_status;
ALTER TABLE transaction_intents
  ADD CONSTRAINT chk_transaction_intent_status CHECK (status IN ('created','awaiting_approval','awaiting_signature','broadcasting','submitted','expired','failed','confirmed','unknown'));

CREATE TABLE transaction_records (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quote_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chain_family VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tx_hash VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  to_address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  signed_payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  summary JSON NOT NULL,
  provider VARCHAR(32) NULL,
  failure_code VARCHAR(100) NULL,
  failure_detail VARCHAR(500) NULL,
  reconcile_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_reconcile_at TIMESTAMP(6) NULL,
  submitted_at TIMESTAMP(6) NULL,
  confirmed_at TIMESTAMP(6) NULL,
  finalized_at TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_transaction_records_intent FOREIGN KEY (intent_id) REFERENCES transaction_intents(id),
  CONSTRAINT fk_transaction_records_quote FOREIGN KEY (quote_id) REFERENCES swap_quotes(id),
  CONSTRAINT fk_transaction_records_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_transaction_records_account FOREIGN KEY (account_id) REFERENCES wallet_accounts(id),
  CONSTRAINT uq_transaction_record_intent UNIQUE (intent_id),
  CONSTRAINT uq_transaction_record_hash UNIQUE (network_id, tx_hash),
  CONSTRAINT chk_transaction_record_status CHECK (status IN ('broadcasting','submitted','confirmed','failed','dropped','replaced','expired','unknown')),
  INDEX idx_transaction_history (user_id, created_at, id),
  INDEX idx_transaction_reconcile (status, next_reconcile_at, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO operational_controls(control_name,enabled,reason) VALUES
('quotes_paused',FALSE,'Initial safe default'),
('intent_creation_paused',FALSE,'Initial safe default'),
('transaction_submission_paused',FALSE,'Initial safe default')
ON DUPLICATE KEY UPDATE control_name=VALUES(control_name);
