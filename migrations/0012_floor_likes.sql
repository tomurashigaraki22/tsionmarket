-- Floor phase 3: likes.
--
-- The composite primary key is the idempotency: a double-tap, a retried
-- request or two tabs racing all collapse to the same single row rather than
-- counting twice.
CREATE TABLE floor_post_likes (
  post_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (post_id, user_id),
  CONSTRAINT fk_floor_likes_post FOREIGN KEY (post_id) REFERENCES floor_posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_floor_likes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  -- Reading "which of these posts have I liked" for a page of the feed.
  INDEX idx_floor_likes_user (user_id, post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
