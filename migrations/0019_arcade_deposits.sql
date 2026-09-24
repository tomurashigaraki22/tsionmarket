-- Arcade deposits: crediting a game balance from a confirmed on-chain send.
--
-- The deposit address is shared and public, so it will receive transfers that
-- are not deposits: an airdrop, a mistake, someone's unrelated transfer. A
-- credit therefore requires BOTH a confirmed transfer AND a sender we can
-- attribute to an account. Anything else is recorded and left alone rather
-- than credited to whoever happens to be nearby.
CREATE TABLE arcade_deposits (
  -- The chain's own idempotency. A signature can only be inserted once, so a
  -- rescan of the same window cannot credit a transfer twice.
  signature VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Gross is what arrived; fee is what the house takes; net is what the
  -- player can play with. All three are stored so a player can be shown
  -- exactly where their money went.
  gross_amount DECIMAL(38,18) NOT NULL,
  fee_amount DECIMAL(38,18) NOT NULL DEFAULT 0,
  net_amount DECIMAL(38,18) NOT NULL DEFAULT 0,
  fee_bps SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- Null when the sender is not a verified address of any account.
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'unattributed',
  block_time TIMESTAMP(6) NULL,
  seen_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  credited_at TIMESTAMP(6) NULL,
  CONSTRAINT fk_arcade_deposits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_arcade_deposits_network FOREIGN KEY (network_id) REFERENCES networks(network_id),
  CONSTRAINT chk_arcade_deposit_status CHECK (status IN ('unattributed', 'credited', 'ignored')),
  INDEX idx_arcade_deposits_review (status, seen_at),
  INDEX idx_arcade_deposits_user (user_id, seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Where the scan resumes, so a restart does not re-read the whole history of
-- a public address.
CREATE TABLE arcade_deposit_cursor (
  address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  last_signature VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  last_scanned_at TIMESTAMP(6) NULL,
  last_error VARCHAR(500) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
