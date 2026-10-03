# Payments

Gateway adapters speak one provider's protocol; everything else (session
orchestration, webhook claim-once, payment application, refunds,
reconciliation) is written once and never branches on a gateway id, or on
whether a gateway is built in or an app's.

Payments act on orders through [`../order-kernel`](../order-kernel/README.md):
the state machine, the shipment claim, and the two locks this module's own
work takes on an order (the hosted-payment setup and refund-in-flight guards
live there because every order writer checks them). The order views that show
payment and refund facts are `../orders`'.

## Gateways

Every gateway implements the shared payment port
(`@scalius/shared/plugins/providers`, `PAYMENT_PORT`) through `PaymentGateway`
in `gateways/port.ts`: each operation takes its port input and a call context
(`{ settings, signal }`). Built-in gateways (Stripe, SSLCommerz) are adapter
files listed in `BUILT_IN_GATEWAYS`; app payment providers
(`<plugin id>:<provider id>`, e.g. `scalius.bkash:bkash`) are built per request
by the API (`apps/api/src/plugins/providers/payment.ts`) and run through the
plugin host in either loader.

- `PaymentProviders` (`gateways/registry.ts`) is one request's catalog:
  lookups, labels, currency eligibility and the pre-commit amount checks.
  `BUILT_IN_PAYMENT_PROVIDERS` serves code that never meets an app id.
- `PaymentProvidersSource` is the catalog or a loader called only when a row
  or a saved method names an app gateway (`paymentProvidersFor`), so work on
  built-in gateways never reads the plugin tables. Checkout reads app
  registrations inside the statements it already batches.
- `gateways/identity.ts` says what a stored id means without loading any
  adapter: built-in ids, qualified app ids (still online after the app is
  removed, so recovery and refunds fail closed instead of misclassifying),
  COD and the gift-card tender.

### Adding a built-in gateway

1. Write `gateways/<id>.ts` implementing `PaymentGateway`.
2. Add it to `BUILT_IN_GATEWAYS` and `BUILT_IN_PAYMENT_GATEWAY_IDS`.
3. Define its credential document in `settings/documents.ts` and its reader in
   `gateway-settings.ts` (storage only).

A third party builds the same thing as an app (`packages/plugin-sdk/README.md`,
"Build a payment provider"). `gateways/testing.ts` is a complete test-only app
gateway; the kernel suites in `gateways/gateway-kernel.test.ts` and
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
  terminal pre-dispatch failure); a port `ProviderError` that is certain the
  provider did nothing ends the attempt; any other error is an unknown outcome
  that reconciliation must resolve.
- Amounts go out in the gateway's declared wire form (`amountCodecs`,
  `encodeProviderAmount`); a charge or refund the wire form cannot carry
  exactly is refused before the call, never rounded up.

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
