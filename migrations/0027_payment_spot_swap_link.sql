ALTER TABLE payment_operations
  ADD UNIQUE KEY uq_payment_operations_id_user (id, user_id);

ALTER TABLE swap_quotes
  ADD COLUMN source_payment_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER request_hash,
  ADD CONSTRAINT fk_swap_quotes_source_payment
    FOREIGN KEY (source_payment_operation_id, user_id)
    REFERENCES payment_operations(id, user_id)
    ON DELETE CASCADE,
  ADD INDEX idx_swap_quotes_source_payment (source_payment_operation_id, created_at);
