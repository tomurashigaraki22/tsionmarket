-- Floor phase 2: persisted posts.
--
-- A reply is a post with reply_to_id set — one table, one renderer. Depth is
-- capped at one level in the service, because threads-of-threads need collapse
-- UI and pagination-within-pagination that this does not have.
CREATE TABLE floor_posts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  author_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body VARCHAR(500) NOT NULL,
  -- A citation that does not resolve to a real market is not stored as a
  -- citation, so a chip can never imply the platform knows a market it does not.
  cited_market_id VARCHAR(320) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reply_to_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- Denormalised, written in the same transaction as the row they count. A
  -- COUNT(*) per post per page does not survive a real feed.
  like_count INT UNSIGNED NOT NULL DEFAULT 0,
  reply_count INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'visible',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  deleted_at TIMESTAMP(6) NULL,
  CONSTRAINT fk_floor_posts_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_floor_posts_market FOREIGN KEY (cited_market_id) REFERENCES spot_markets(market_id) ON DELETE SET NULL,
  CONSTRAINT fk_floor_posts_parent FOREIGN KEY (reply_to_id) REFERENCES floor_posts(id) ON DELETE CASCADE,
  CONSTRAINT chk_floor_post_status CHECK (status IN ('visible', 'removed')),
  -- The feed reads top-level posts newest-first; the id tiebreak makes the
  -- cursor total, since TIMESTAMP(6) can still collide under load.
  INDEX idx_floor_posts_feed (status, reply_to_id, created_at, id),
  INDEX idx_floor_posts_popular (status, reply_to_id, like_count, created_at),
  INDEX idx_floor_posts_author (author_id, created_at),
  INDEX idx_floor_posts_market (cited_market_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
