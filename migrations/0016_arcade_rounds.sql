-- Arcade phase 2: the Last Man engine.
--
-- The rules: a round opens with a join window. Play proceeds in ticks; on each
-- tick every surviving player commits one of two choices before a deadline the
-- SERVER owns. Anyone who does not commit is eliminated. Among those who did,
-- the MINORITY choice survives and the majority is eliminated. A tie, or a
-- unanimous tick, eliminates nobody and repeats.
--
-- Minority rule is the bot-resistant choice. A reflex game rewards whoever has
-- the lowest latency and the tightest loop, which is a machine every time.
-- There is no dominant strategy here to encode: the right answer depends on
-- what everyone else picks, so a bot has no edge over a person, and choices
-- stay hidden until the tick resolves so nothing can be sniped at the wire.

CREATE TABLE arcade_rounds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  game_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  -- Stakes stay zero until phase 5. The columns exist now so the engine does
  -- not change shape when money arrives.
  entry_amount DECIMAL(38,18) NOT NULL DEFAULT 0,
  entry_asset VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  entry_network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  min_players SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  max_players SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  tick_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  current_tick SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- The one clock that counts. A client-reported deadline is advisory;
  -- otherwise the round is won by whoever lies best about their latency.
  tick_deadline_at TIMESTAMP(6) NULL,
  join_closes_at TIMESTAMP(6) NOT NULL,
  winner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  started_at TIMESTAMP(6) NULL,
  settled_at TIMESTAMP(6) NULL,
  CONSTRAINT fk_arcade_rounds_game FOREIGN KEY (game_id) REFERENCES arcade_games(id),
  CONSTRAINT fk_arcade_rounds_winner FOREIGN KEY (winner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_arcade_round_status CHECK (status IN ('open', 'running', 'settled', 'aborted')),
  INDEX idx_arcade_rounds_open (game_id, status, join_closes_at),
  -- The worker's sweep: rounds whose clock has run out.
  INDEX idx_arcade_rounds_due (status, tick_deadline_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE arcade_entries (
  round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'alive',
  eliminated_tick SMALLINT UNSIGNED NULL,
  joined_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- One entry per account per round, enforced by the key rather than checked.
  PRIMARY KEY (round_id, user_id),
  CONSTRAINT fk_arcade_entries_round FOREIGN KEY (round_id) REFERENCES arcade_rounds(id) ON DELETE CASCADE,
  CONSTRAINT fk_arcade_entries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_arcade_entry_status CHECK (status IN ('alive', 'eliminated', 'won', 'refunded')),
  INDEX idx_arcade_entries_alive (round_id, status),
  INDEX idx_arcade_entries_user (user_id, round_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE arcade_moves (
  round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tick SMALLINT UNSIGNED NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  choice TINYINT UNSIGNED NOT NULL,
  committed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- A move cannot be changed once made: the key rejects a second submission
  -- for the same tick rather than overwriting the first.
  PRIMARY KEY (round_id, tick, user_id),
  CONSTRAINT fk_arcade_moves_round FOREIGN KEY (round_id) REFERENCES arcade_rounds(id) ON DELETE CASCADE,
  CONSTRAINT fk_arcade_moves_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_arcade_move_choice CHECK (choice IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
