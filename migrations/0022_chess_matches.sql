-- Chess is launched as a signed-in, non-monetary game. Invite terms explicitly
-- bind the clock settings; stake fields are intentionally absent until the
-- custody, withdrawal, dispute, and responsible-play gates are approved.
UPDATE arcade_games
SET name = 'Chess',
    tagline = 'A quiet board, a worthy opponent. Invite someone and play a complete match.',
    category = 'skill',
    status = 'live',
    stake_asset = NULL,
    stake_network_id = NULL,
    entry_amount = 0,
    rake_bps = 0
WHERE id = 'chess';

CREATE TABLE chess_matches (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  white_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  black_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  invite_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL UNIQUE,
  invite_expires_at TIMESTAMP(6) NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'waiting',
  fen TEXT NOT NULL,
  pgn MEDIUMTEXT NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  time_control_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 600,
  white_time_ms INT UNSIGNED NOT NULL DEFAULT 600000,
  black_time_ms INT UNSIGNED NOT NULL DEFAULT 600000,
  turn_started_at TIMESTAMP(6) NULL,
  draw_offered_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NULL,
  termination VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  started_at TIMESTAMP(6) NULL,
  completed_at TIMESTAMP(6) NULL,
  CONSTRAINT fk_chess_match_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_chess_match_white FOREIGN KEY (white_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_chess_match_black FOREIGN KEY (black_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_chess_match_draw_offer FOREIGN KEY (draw_offered_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_chess_match_status CHECK (status IN ('waiting', 'active', 'complete', 'cancelled', 'declined', 'expired')),
  CONSTRAINT chk_chess_match_result CHECK (result IS NULL OR result IN ('1-0', '0-1', '1/2-1/2')),
  CONSTRAINT chk_chess_match_time_control CHECK (time_control_seconds IN (300, 600, 900)),
  INDEX idx_chess_match_white (white_user_id, created_at),
  INDEX idx_chess_match_black (black_user_id, created_at),
  INDEX idx_chess_match_invite_expiry (status, invite_expires_at),
  INDEX idx_chess_match_deadline (status, turn_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE chess_moves (
  match_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  color CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_square CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  to_square CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  promotion CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  captured_piece CHAR(1) CHARACTER SET ascii COLLATE ascii_bin NULL,
  san VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fen_after TEXT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (match_id, version),
  CONSTRAINT fk_chess_move_match FOREIGN KEY (match_id) REFERENCES chess_matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_chess_move_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_chess_move_color CHECK (color IN ('w', 'b')),
  CONSTRAINT chk_chess_move_captured CHECK (captured_piece IS NULL OR captured_piece IN ('p', 'n', 'b', 'r', 'q')),
  INDEX idx_chess_move_player (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
