# Payments

Multi-gateway payment processing supporting Stripe, SSLCommerz, Polar, and Cash on Delivery (COD).

## Exports

- `processPaymentConfirmed()` — idempotent payment recording, order status update, inventory deduction
- `processPaymentFailed()` — mark payment as failed if no prior payments exist
- `releaseOrderInventory()` — release reserved stock when an order is cancelled
- `recordWebhookEvent()` — idempotency tracking for webhook events
- Gateway-specific modules: `stripe.ts`, `sslcommerz.ts`, `polar.ts`, `cod.ts`
- `refund-service.ts` — refund processing across gateways
- Type definitions: `PaymentGateway`, `PaymentType`, `ProcessPaymentParams`, etc.

## Dependencies

- `@scalius/database` — `orders`, `orderItems`, `orderPayments`, `paymentPlans`, `webhookEvents` tables
- `inventory` module — stock release and inventory transitions
- `settings` module — currency configuration

## API Routes

- `POST /api/v1/payment/stripe/create-intent` — create Stripe payment intent
- `POST /api/v1/payment/sslcommerz/init` — initialize SSLCommerz session
- `POST /api/v1/webhooks/stripe` — Stripe webhook handler
- `POST /api/v1/webhooks/sslcommerz` — SSLCommerz IPN handler
