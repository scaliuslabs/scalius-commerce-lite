# Payments

Gateway adapters speak one provider's protocol; everything else (session
orchestration, webhook claim-once, payment application, refunds,
reconciliation) is written once and never branches on a gateway id.

## Adding a gateway

1. Write `gateways/<id>.ts` implementing `PaymentGateway` from `gateways/port.ts`.
2. Add one line to `PAYMENT_GATEWAYS` in `gateways/registry.ts`.
3. Define the gateway's credential document in `settings/documents.ts` and its
   reader in `gateway-settings.ts` (storage only).

`gateways/testing.ts` registers a complete test-only adapter this way; the
kernel suites in `gateways/gateway-kernel.test.ts` and
`apps/api/src/routes/payment/payment-routes.test.ts` run against it.

## Port rules

- Money crosses the port as integer minor units plus an ISO 4217 code.
- `readiness()` fails closed: missing, unreadable, or placeholder credentials
  are not configured. Adapters never call a provider with unreadable secrets.
- `verifyWebhook` / `verifyReturn` authenticate before any state change
  (Stripe: signature; SSLCommerz: server-to-server `val_id` validation).
  Callback fields are expectations, never authority.
- A provider fact reached through a webhook and a buyer return yields the same
  `eventType` + `eventId`, so `webhook_events` claims it once.
- `refund()` validates inputs before any network call (a `ValidationError` is a
  terminal pre-dispatch failure); any other error is an unknown outcome that
  reconciliation must resolve.

## Storage

`order_payments.payment_method` is the provider id. `provider_ref` is the
provider's unique payment reference (Stripe PaymentIntent, SSLCommerz
`val_id`); `UNIQUE(payment_method, provider_ref)` makes a replayed or racing
confirmation credit an order at most once. `provider_secondary_ref` is the
captured-transaction reference refunds use (Stripe charge, SSLCommerz
`bank_tran_id`). Refund rows never carry a `provider_ref`.

## Flow

| Step | Code |
| --- | --- |
| Session | `POST /api/v1/payment/{provider}/session` → `apps/api/src/routes/payment/payment-session-create.ts`: assert payable → currency/limits → checkout policy → ready settings → plan → gateway switch → claim attempt → provider call under a deadline → record attempt |
| Webhook | `POST /api/v1/webhooks/{provider}` → adapter verification → `claimAndEnqueuePaymentEvent` |
| Hosted return | `GET|POST /api/v1/payment/{provider}/success|fail|cancel` |
| Buyer reconcile | `POST /api/v1/payment/{provider}/reconcile` (gateways with `query`) |
| Apply | queue message `payment.event` → `processPaymentConfirmed` / `processPaymentFailed` / `releaseOrderInventory` |
| Refund | `processRefund` → allocation claim → `gateway.refund` |
| Reconcile | `reconcileDueRefundAttempts` (`gateway.refundStatus`), `reconcileExternalRefundWebhooks` (`gateway.listRefunds`, `refund.observed` events) |

COD is not a gateway: collection is recorded in `cod.ts` and COD refunds are
confirmed manual settlements.
