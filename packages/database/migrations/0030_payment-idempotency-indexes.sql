-- Payment idempotency: unique partial indexes prevent duplicate payment records.
-- First clean up any existing duplicate rows (keep earliest record per combo).

DELETE FROM order_payments
WHERE stripe_payment_intent_id IS NOT NULL
AND id NOT IN (
  SELECT MIN(id) FROM order_payments
  WHERE stripe_payment_intent_id IS NOT NULL
  GROUP BY order_id, stripe_payment_intent_id
);

DELETE FROM order_payments
WHERE sslcommerz_tran_id IS NOT NULL
AND id NOT IN (
  SELECT MIN(id) FROM order_payments
  WHERE sslcommerz_tran_id IS NOT NULL
  GROUP BY order_id, sslcommerz_tran_id
);

DELETE FROM order_payments
WHERE polar_checkout_id IS NOT NULL
AND id NOT IN (
  SELECT MIN(id) FROM order_payments
  WHERE polar_checkout_id IS NOT NULL
  GROUP BY order_id, polar_checkout_id
);

-- Now safe to create unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_stripe_unique
  ON order_payments(order_id, stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_sslcommerz_unique
  ON order_payments(order_id, sslcommerz_tran_id)
  WHERE sslcommerz_tran_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_polar_unique
  ON order_payments(order_id, polar_checkout_id)
  WHERE polar_checkout_id IS NOT NULL;
