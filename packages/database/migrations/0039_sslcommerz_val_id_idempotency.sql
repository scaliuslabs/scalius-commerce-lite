-- SSLCommerz confirmed IPNs are uniquely identified by canonical val_id.
-- tran_id is merchant-controlled and may be reused across split payment legs
-- for legacy sessions, so it must remain a correlation field rather than the
-- local idempotency key.

DELETE FROM order_payments
WHERE sslcommerz_val_id IS NOT NULL
AND id NOT IN (
  SELECT MIN(id) FROM order_payments
  WHERE sslcommerz_val_id IS NOT NULL
  GROUP BY order_id, sslcommerz_val_id
);

DROP INDEX IF EXISTS idx_order_payments_sslcommerz_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_sslcommerz_val_unique
  ON order_payments(order_id, sslcommerz_val_id)
  WHERE sslcommerz_val_id IS NOT NULL;

UPDATE payment_plans
SET status = 'completed',
    updated_at = unixepoch()
WHERE status = 'fully_paid';
