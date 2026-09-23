CREATE TABLE portfolio_valuation_snapshots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  total_value_usd DECIMAL(38,8) NOT NULL,
  priced_value_usd DECIMAL(38,8) NOT NULL,
  unpriced_asset_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  stale BOOLEAN NOT NULL DEFAULT FALSE,
  price_as_of TIMESTAMP(6) NULL,
  positions JSON NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_portfolio_valuation_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_portfolio_valuation_history (user_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
