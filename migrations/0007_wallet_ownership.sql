ALTER TABLE wallet_accounts
  ADD COLUMN ownership_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unverified' AFTER status,
  ADD COLUMN verified_at TIMESTAMP(6) NULL AFTER ownership_status,
  ADD CONSTRAINT chk_wallet_account_ownership_status CHECK (ownership_status IN ('unverified','verified'));

CREATE TABLE wallet_ownership_challenges (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nonce VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  statement TEXT NOT NULL,
  signature_scheme VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issued_at TIMESTAMP(6) NOT NULL,
  expires_at TIMESTAMP(6) NOT NULL,
  consumed_at TIMESTAMP(6) NULL,
  failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  CONSTRAINT fk_wallet_challenge_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_challenge_network FOREIGN KEY (network_id) REFERENCES networks(network_id),
  INDEX idx_wallet_challenge_owner (user_id, id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE wallet_account_ownership (
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  challenge_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  verified_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (network_id, address),
  UNIQUE KEY uq_wallet_ownership_account (account_id),
  CONSTRAINT fk_wallet_ownership_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_ownership_account FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_ownership_challenge FOREIGN KEY (challenge_id) REFERENCES wallet_ownership_challenges(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE wallet_registration_idempotency (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, idempotency_key),
  CONSTRAINT fk_wallet_idempotency_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_idempotency_account FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
