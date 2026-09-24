-- Floor phase 4: reports and blocks.
--
-- A feed sitting beside a trading ticket is a pump-and-dump and scam-link
-- surface by default. Phases 2 and 3 are not shippable without this.

CREATE TABLE floor_reports (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  post_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reporter_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  detail VARCHAR(500) NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  resolved_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  resolved_at TIMESTAMP(6) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- One report per person per post: a brigade should raise the number of
  -- distinct reporters, never let one account inflate the count alone.
  CONSTRAINT uq_floor_report_once UNIQUE (post_id, reporter_id),
  CONSTRAINT fk_floor_reports_post FOREIGN KEY (post_id) REFERENCES floor_posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_floor_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_floor_reports_resolver FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_floor_report_reason CHECK (reason IN ('spam', 'scam', 'abuse', 'impersonation', 'other')),
  CONSTRAINT chk_floor_report_status CHECK (status IN ('open', 'actioned', 'dismissed')),
  INDEX idx_floor_reports_queue (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Blocking hides in both directions. Hiding only the blocker's view leaves
-- the person they blocked able to read and reply to them, which is the part
-- that makes blocking worth having.
CREATE TABLE floor_blocks (
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blocked_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, blocked_user_id),
  CONSTRAINT fk_floor_blocks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_floor_blocks_blocked FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_floor_block_not_self CHECK (user_id <> blocked_user_id),
  INDEX idx_floor_blocks_reverse (blocked_user_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
