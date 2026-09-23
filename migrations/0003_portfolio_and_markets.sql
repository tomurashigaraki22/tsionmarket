CREATE TABLE networks (
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  family VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(100) NOT NULL,
  environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chain_id BIGINT UNSIGNED NULL,
  cluster VARCHAR(32) NULL,
  native_symbol VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  native_decimals TINYINT UNSIGNED NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities JSON NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_network_family CHECK (family IN ('evm', 'solana')),
  CONSTRAINT chk_network_environment CHECK (environment IN ('mainnet', 'testnet', 'devnet')),
  INDEX idx_networks_enabled (enabled, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO networks (network_id, family, name, environment, chain_id, cluster, native_symbol, native_decimals, enabled, capabilities, sort_order) VALUES
('ethereum-sepolia','evm','Ethereum Sepolia','testnet',11155111,NULL,'ETH',18,TRUE,JSON_OBJECT('balance',TRUE,'tokens',TRUE),10),
('arbitrum-sepolia','evm','Arbitrum Sepolia','testnet',421614,NULL,'ETH',18,TRUE,JSON_OBJECT('balance',TRUE,'tokens',TRUE),20),
('solana-devnet','solana','Solana Devnet','devnet',NULL,'devnet','SOL',9,TRUE,JSON_OBJECT('balance',TRUE,'tokens',TRUE),30),
('ethereum-mainnet','evm','Ethereum','mainnet',1,NULL,'ETH',18,FALSE,JSON_OBJECT('balance',TRUE,'tokens',TRUE),110),
('arbitrum-one','evm','Arbitrum One','mainnet',42161,NULL,'ETH',18,FALSE,JSON_OBJECT('balance',TRUE,'tokens',TRUE),120),
('solana-mainnet-beta','solana','Solana Mainnet-Beta','mainnet',NULL,'mainnet-beta','SOL',9,FALSE,JSON_OBJECT('balance',TRUE,'tokens',TRUE),130);

CREATE TABLE wallet_accounts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  address VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(100) NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_wallet_accounts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_accounts_network FOREIGN KEY (network_id) REFERENCES networks(network_id),
  CONSTRAINT uq_wallet_account UNIQUE (user_id, network_id, address),
  CONSTRAINT chk_wallet_account_status CHECK (status IN ('active','archived')),
  INDEX idx_wallet_accounts_user (user_id, status, network_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_markets (
  market_id VARCHAR(320) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  venue VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  network_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_symbol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quote_symbol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quote_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  decimals TINYINT UNSIGNED NOT NULL,
  price_usd DECIMAL(38,18) NULL,
  liquidity_usd DECIMAL(38,2) NULL,
  volume_24h_usd DECIMAL(38,2) NULL,
  icon_url VARCHAR(2048) NULL,
  chart_symbol VARCHAR(128) NULL,
  source_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMP(6) NOT NULL,
  synced_at TIMESTAMP(6) NOT NULL,
  CONSTRAINT fk_spot_markets_network FOREIGN KEY (network_id) REFERENCES networks(network_id),
  INDEX idx_markets_browse (active, network_id, venue, liquidity_usd, market_id),
  INDEX idx_markets_search (active, base_symbol, quote_symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE market_registry_status (
  route_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  last_attempt_at TIMESTAMP(6) NULL,
  last_success_at TIMESTAMP(6) NULL,
  last_error VARCHAR(500) NULL,
  market_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
