ALTER TABLE spot_markets
  ADD COLUMN market_category VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'market' AFTER venue,
  ADD CONSTRAINT chk_spot_market_category CHECK (market_category IN ('market', 'meme')),
  ADD INDEX idx_markets_category (active, market_category, network_id, liquidity_usd, market_id);
