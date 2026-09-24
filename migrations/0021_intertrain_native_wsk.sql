ALTER TABLE networks DROP CHECK chk_network_family;
ALTER TABLE networks
  ADD CONSTRAINT chk_network_family CHECK (family IN ('evm', 'solana', 'intertrain'));

INSERT INTO networks (
  network_id, family, name, environment, chain_id, cluster,
  native_symbol, native_decimals, enabled, capabilities, sort_order
) VALUES (
  'intertrain-mainnet', 'intertrain', 'Intertrain', 'mainnet', 4683, 'intertrain-1',
  'WSK', 6, FALSE,
  JSON_OBJECT('balance', TRUE, 'tokens', FALSE, 'quotes', FALSE, 'intents', FALSE, 'submission', FALSE),
  140
)
ON DUPLICATE KEY UPDATE
  family=VALUES(family),
  name=VALUES(name),
  environment=VALUES(environment),
  chain_id=VALUES(chain_id),
  cluster=VALUES(cluster),
  native_symbol=VALUES(native_symbol),
  native_decimals=VALUES(native_decimals),
  capabilities=VALUES(capabilities),
  sort_order=VALUES(sort_order);
