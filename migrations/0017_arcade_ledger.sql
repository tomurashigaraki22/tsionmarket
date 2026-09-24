-- Arcade phase 5: stakes and settlement.
--
-- SCOPE, stated here because it is a decision and not an omission:
--
-- This migration builds the ACCOUNTING — a per-user game balance, a
-- double-entry ledger behind every movement, escrow on join, payout on
-- settlement, and refunds on abort. Every invariant the plan asks for is
-- testable against it without a chain.
--
-- It does NOT move funds on chain. Paying a winner out of a pooled address
-- requires a key the backend can sign with, and this backend holds no keys at
-- all today: every signature in the product happens on the user's device. A
-- server-side hot wallet makes the platform a custodian and is the single
-- largest change in risk posture in the system, so it is not something to
-- introduce as a side effect of a game. Funding and withdrawal are therefore
-- the boundary of this phase, and a balance is credited only by an
-- administrator until that decision is taken deliberately.

-- What a game costs to enter, alongside the asset it is already declared in.
ALTER TABLE arcade_games
  ADD COLUMN entry_amount DECIMAL(38,18) NOT NULL DEFAULT 0 AFTER stake_network_id,
  -- Basis points the house keeps. Zero by default, and whatever it is must be
  -- shown before entry: a silent rake is the fastest way to lose a community.
  ADD COLUMN rake_bps SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER entry_amount;

-- The rate in force when the round opened, so changing the house rate cannot
-- retroactively alter a round already in play.
ALTER TABLE arcade_rounds
  ADD COLUMN rake_bps SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER entry_network_id;

CREATE TABLE arcade_balances (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Split so an escrowed stake cannot be spent twice: joining moves value
  -- from one column to the other, it does not merely mark it.
  available DECIMAL(38,18) NOT NULL DEFAULT 0,
  escrowed DECIMAL(38,18) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, asset, network_id),
  CONSTRAINT fk_arcade_balances_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_arcade_balances_network FOREIGN KEY (network_id) REFERENCES networks(network_id),
  -- A balance can never go negative. The application checks first; this is
  -- the backstop that turns a logic error into a failed write rather than
  -- money that did not exist.
  CONSTRAINT chk_arcade_balance_available CHECK (available >= 0),
  CONSTRAINT chk_arcade_balance_escrowed CHECK (escrowed >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every movement, append only. The balances above are derived state kept in
-- step inside the same transaction; this is the record that settles a dispute.
CREATE TABLE arcade_ledger (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  entry_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Signed: negative leaves the player, positive arrives. Every round's rows
  -- must sum to zero across its players and the house.
  amount DECIMAL(38,18) NOT NULL,
  memo VARCHAR(200) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_arcade_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_arcade_ledger_round FOREIGN KEY (round_id) REFERENCES arcade_rounds(id) ON DELETE SET NULL,
  CONSTRAINT chk_arcade_ledger_type CHECK (
    entry_type IN ('deposit', 'stake', 'payout', 'refund', 'rake', 'withdrawal')
  ),
  INDEX idx_arcade_ledger_user (user_id, created_at),
  INDEX idx_arcade_ledger_round (round_id, entry_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Settling a round exactly once, even if two workers sweep it together or one
-- retries after a crash. The row is written in the same transaction as the
-- payout, so a second attempt collides rather than paying twice.
CREATE TABLE arcade_settlements (
  round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  pot DECIMAL(38,18) NOT NULL,
  rake DECIMAL(38,18) NOT NULL,
  paid_out DECIMAL(38,18) NOT NULL,
  settled_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_arcade_settlements_round FOREIGN KEY (round_id) REFERENCES arcade_rounds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
