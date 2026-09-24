-- Floor phase 1: a public identity that is safe to display.
--
-- Until now the only human-readable identifier an account had was its email
-- address, which must never appear on a feed. Every social feature depends on
-- this table existing first.

-- 'verified' and 'admin' may post links; 'user' may not. A single ladder
-- rather than a separate boolean because the only distinction the Floor draws
-- today is "trusted enough to publish a URL beside a trading ticket".
ALTER TABLE users
  ADD COLUMN role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'user' AFTER status,
  ADD CONSTRAINT chk_users_role CHECK (role IN ('user', 'verified', 'admin'));

CREATE TABLE user_profiles (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  -- ascii_general_ci, unlike the market symbol columns: two handles differing
  -- only by case are the same handle, and letting both exist is an
  -- impersonation vector.
  handle VARCHAR(20) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  display_name VARCHAR(50) NOT NULL,
  bio VARCHAR(160) NULL,
  -- Deterministic identicon seed. No uploads yet: an avatar pipeline needs
  -- storage, resizing and a moderation queue that none of this has.
  avatar_seed CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_user_profiles_handle UNIQUE (handle),
  CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Handles held back from open registration. A row with reserved_for_user_id
-- set is a reservation the named account can still claim; a row without one is
-- simply blocked.
CREATE TABLE reserved_handles (
  handle VARCHAR(20) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY,
  reserved_for_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reason VARCHAR(120) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_reserved_handles_user FOREIGN KEY (reserved_for_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Impersonating support is the cheapest scam on any feed, so the obvious
-- names are taken before anyone can register them.
INSERT INTO reserved_handles (handle, reason) VALUES
  ('admin', 'impersonation'),
  ('administrator', 'impersonation'),
  ('support', 'impersonation'),
  ('help', 'impersonation'),
  ('helpdesk', 'impersonation'),
  ('mod', 'impersonation'),
  ('moderator', 'impersonation'),
  ('official', 'impersonation'),
  ('staff', 'impersonation'),
  ('team', 'impersonation'),
  ('security', 'impersonation'),
  ('tsion', 'brand'),
  ('tsionmarket', 'brand'),
  ('intertrain', 'brand'),
  ('floor', 'route'),
  ('spot', 'route'),
  ('trade', 'route'),
  ('wallet', 'route'),
  ('portfolio', 'route'),
  ('memecoins', 'route'),
  ('arcade', 'route'),
  ('activity', 'route'),
  ('requests', 'route'),
  ('settings', 'route'),
  ('login', 'route'),
  ('signup', 'route'),
  ('api', 'route'),
  ('me', 'route');
