CREATE TABLE service_metadata (
  metadata_key VARCHAR(100) NOT NULL PRIMARY KEY,
  metadata_value VARCHAR(500) NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE operational_controls (
  control_name VARCHAR(100) NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reason VARCHAR(500) NULL,
  changed_by VARCHAR(100) NULL,
  changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_operational_controls_enabled CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO service_metadata (metadata_key, metadata_value)
VALUES ('schema_owner', 'tsionmarket-backend');

INSERT INTO operational_controls (control_name, enabled, reason)
VALUES ('market_execution_paused', FALSE, 'Initial safe default');
