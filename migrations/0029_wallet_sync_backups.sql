-- One encrypted wallet backup per user, so a wallet created on one device can
-- be restored on another after sign-in.
--
-- The server stores an OPAQUE ciphertext. The backup is the same portable
-- format the browser already exports (`tsionmarket-wallet-backup`): the data
-- key is wrapped with an Argon2id key derived from the user's wallet
-- passphrase, and every account secret and the recovery phrase are AES-GCM
-- encrypted under that data key. The server never holds the passphrase, the
-- data key, or anything that decrypts the backup, and the API rejects any
-- upload that carries a field outside the encrypted-envelope shape.
CREATE TABLE wallet_sync_backups (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  wallet_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  backup MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_wallet_sync_backups_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_wallet_sync_backup_size CHECK (CHAR_LENGTH(backup) <= 262144)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
