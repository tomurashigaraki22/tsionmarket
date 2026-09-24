-- Arcade phase 1: the catalogue.
--
-- Replaces a fixed nine-title mock in the frontend. Only games someone is
-- actually building are listed: a card for a game nobody is working on is a
-- promise nobody made.
CREATE TABLE arcade_games (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  tagline VARCHAR(160) NOT NULL,
  category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- 'live' requires something to play. A game still being built is
  -- 'coming_soon' so the card cannot offer a button that opens nothing.
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'coming_soon',
  cover_url VARCHAR(2048) NULL,
  -- Stakes are per game so adding WSK on Intertrain later is a row, not a
  -- migration of everything that came before.
  stake_asset VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  stake_network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_arcade_game_category CHECK (category IN ('skill', 'cards', 'draws')),
  CONSTRAINT chk_arcade_game_status CHECK (status IN ('live', 'coming_soon', 'disabled')),
  CONSTRAINT fk_arcade_games_network FOREIGN KEY (stake_network_id) REFERENCES networks(network_id),
  INDEX idx_arcade_games_listing (status, sort_order, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Last Man is the mock's 'last-position' under the name it is shipping with.
-- It stays coming_soon until the engine exists in phase 2.
INSERT INTO arcade_games (id, name, tagline, category, status, cover_url, stake_asset, stake_network_id, sort_order) VALUES
  ('last-man', 'Last Man',
   'Outlast every other player. The final one standing takes the pot.',
   'skill', 'coming_soon', '/last-man-cover-art.png', 'USDC', 'solana-mainnet-beta', 10),
  ('chess', 'Chess',
   'Staked head-to-head. Invite an opponent or take a quick match.',
   'skill', 'coming_soon', NULL, 'USDC', 'solana-mainnet-beta', 20);
