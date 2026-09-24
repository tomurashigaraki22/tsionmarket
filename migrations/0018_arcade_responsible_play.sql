-- Arcade phase 6: fairness, abuse and responsible play.
--
-- Last Man is now playable end to end, so it stops being a card that says
-- Coming soon. Stakes remain zero until the funding boundary is decided; the
-- entry terms shown above the join button say which of the two is in force.
UPDATE arcade_games SET status = 'live' WHERE id = 'last-man';

-- Controls a player sets on themselves, enforced at the door.
--
-- Required under most licences and correct regardless: the person best placed
-- to decide someone has played enough is the person, on a calmer day than the
-- one where the limit bites.
CREATE TABLE arcade_limits (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  -- Rounds per rolling 24 hours. NULL means unset, not unlimited-by-policy.
  daily_entry_limit SMALLINT UNSIGNED NULL,
  -- Net loss per rolling 24 hours, in the stake asset.
  daily_loss_limit DECIMAL(38,18) NULL,
  -- A self-exclusion cannot be shortened, only extended — see ArcadeLimits.
  self_excluded_until TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_arcade_limits_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Reading "what has this player staked and won in the last day" for the loss
-- limit, without scanning their whole history.
CREATE INDEX idx_arcade_ledger_recent ON arcade_ledger (user_id, created_at, entry_type);
