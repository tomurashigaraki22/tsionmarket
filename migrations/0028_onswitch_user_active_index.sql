ALTER TABLE payment_operations
  ADD INDEX idx_payment_operations_user_status (user_id, status);
