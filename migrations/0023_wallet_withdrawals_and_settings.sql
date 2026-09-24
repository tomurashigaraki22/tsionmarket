-- Persist user-facing preferences and permit signed wallet-transfer intents.
CREATE TABLE user_settings (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  display_name VARCHAR(60) NOT NULL DEFAULT '',
  transaction_updates_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  product_updates_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Existing Floor handles become free TsionMarket IDs that can resolve to a
-- verified Intertrain wallet. This is an app directory, not a chain name.
ALTER TABLE user_profiles
  ADD COLUMN intertrain_account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER avatar_seed,
  ADD CONSTRAINT uq_user_profiles_intertrain_account UNIQUE (intertrain_account_id),
  ADD CONSTRAINT fk_user_profiles_intertrain_account FOREIGN KEY (intertrain_account_id) REFERENCES wallet_accounts(id) ON DELETE SET NULL;

ALTER TABLE transaction_intents DROP CHECK chk_transaction_intent_type;
ALTER TABLE transaction_intents
  ADD CONSTRAINT chk_transaction_intent_type CHECK (intent_type IN ('swap','erc20_approval','withdrawal'));
