-- Jupiter's v2 token list publishes 24h price change and market cap per token.
-- Both are nullable on purpose: LI.FI, which serves the EVM routes, returns
-- neither, so an Ethereum or Arbitrum market has no honest value to store and
-- the UI must render an absence rather than a zero.
ALTER TABLE spot_markets
  ADD COLUMN price_change_24h_pct DECIMAL(18,6) NULL AFTER volume_24h_usd,
  ADD COLUMN market_cap_usd DECIMAL(38,2) NULL AFTER price_change_24h_pct;
