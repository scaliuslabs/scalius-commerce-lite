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
(`{ settings, signal }`). The built-in gateway (Stripe) is an adapter file
listed in `BUILT_IN_GATEWAYS`; app payment providers
(`<plugin id>:<provider id>`: `scalius.bkash:bkash`, the Bangladesh pack's
`scalius.bangladesh:sslcommerz`) are built per request by the API
(`apps/api/src/plugins/providers/payment.ts`) and run through the plugin host
in either loader. Cash on delivery is not a gateway.

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
  retired built-in ids, COD and the gift-card tender.
- A retired built-in id (`sslcommerz`, on orders and payments made before
  SSLCommerz moved into the Bangladesh pack;
  `integrations/retired-providers.ts`) resolves to the app provider that
  replaced it: `get()`, labels, refunds, reconciliation and the old callback
  URLs (`/webhooks/sslcommerz`, `/payment/sslcommerz/*`) reach the pack's
  gateway. While the app is not active it resolves to a stand-in that fails
  closed with "Activate Bangladesh pack in Apps to use it." (never offered,
  callbacks answer 503, refunds stop before any provider call).
  `paymentMethodAliases()` lets an order filter find both ids. The pack's
  activation moves the old `sslcommerz` document into its settings and
  repoints the checkout choice and the payments still under way
  (`retired-gateways.ts`); settled orders keep the old id.

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
  (Stripe: signature; the pack's SSLCommerz: server-to-server `val_id`
  validation).
- A hosted provider whose failed or cancelled return posts the merchant
  reference unsigned declares the form field (`returnCorrelationField`:
  SSLCommerz's `tran_id`); the platform releases the attempt it names
  without calling the app. A success return always goes through
  `verifyReturn`.
  Callback fields are expectations, never authority.
- A provider fact reached through a webhook and a buyer return yields the same
  `eventType` + `eventId`, so `webhook_events` claims it once.
- `refund()` validates inputs before any network call (a `ValidationError` is a
  terminal pre-dispatch failure); a port `ProviderError` that is certain the
  provider did nothing ends the attempt; any other error is an unknown outcome
  that reconciliation must resolve.
- One amount codec serves every payment path (MARKETS-DESIGN D2):
  `PaymentProviders.encodeAmount(methodId, amountMinor, currency)` returns the
  wire amount and the rounding it would drop; `amountIssue()` turns a
  non-zero rounding into a refusal. A gateway declares its wire forms
  (`amountCodecs`); cash on delivery uses its cash increment
  (`cashOnDeliveryIncrementMinor`: whole taka in BDT). Checkout precommit,
  session creation, refunds, storefront COD and staff (COD) quotes check it
  before the order commits or the provider is called, so the charge always
  equals the stored amount. Nothing is ever rounded up.
- Stripe declares `STRIPE_AMOUNT_CODECS` (ISK and UGX two-decimal; BHD, JOD,
  KWD, OMR and TND in tens; MGA whole units). Amounts a provider reports
  (events, refunds) are ISO minor units: an adapter whose wire form differs
  decodes them with `decodeProviderAmount`, and a value it cannot decode
  becomes `NaN`, which the kernel refuses.
- A payment method states the shipping countries it serves (`countries`:
  `"any"`, the default, or ISO codes; MARKETS-DESIGN step 3b). Cash on
  delivery serves `["BD"]` (`COD_COUNTRIES`). `PaymentProviders.countryIssue()`
  refuses a method for a delivery country it does not serve. Checkout config,
  the cart's methods, the agent quote and order placement apply it; staff
  orders do not (staff decide).

## Storage

`order_payments.payment_method` is the provider id. `provider_ref` is the
provider's unique payment reference (Stripe PaymentIntent, the pack
SSLCommerz's `val_id`); `UNIQUE(payment_method, provider_ref)` makes a
replayed or racing confirmation credit an order at most once.
`provider_secondary_ref` is the captured-transaction reference refunds use
(Stripe charge, SSLCommerz `bank_tran_id`). Refund rows never carry a
`provider_ref`.

Every row also records settlement (migration 0111, MARKETS-DESIGN D2):
`settlement_currency`, `settlement_amount_minor`, `settlement_rate` (a decimal
string) and `exchange_adjustment_minor`. A confirmed payment takes the
provider's report when the payment event carries `settlement`
(`paymentSettlement()` in `@scalius/shared/money-chain`); the adjustment is
the gain or loss against the order's locked `fx_rate` when it settled in the
shop currency, else 0. A gift-card tender in another store currency
(MARKETS-DESIGN step 6) settles in the card's currency: its debit, at the
locked rate. Without a report, and for COD, same-currency gift-card tenders,
refunds and imported refunds, a row settles as presented
(`presentedSettlement()`: same currency and amount, rate "1"). Refunds stay in
the presentment currency. No built-in adapter reports settlement yet.

## Flow

| Step | Code |
| --- | --- |
| Session | `POST /api/v1/payment/{provider}/session` → `apps/api/src/routes/payment/payment-session-create.ts`: assert payable → currency/limits → checkout policy → ready settings → plan → gateway switch → claim attempt → provider call under a deadline → record attempt |
| Webhook | `POST /api/v1/webhooks/{provider}` → adapter verification → `claimAndApplyPaymentEvent` (claims a `webhook_events` row holding the verified event) |
| Hosted return | `GET|POST /api/v1/payment/{provider}/success|fail|cancel` |
| Buyer reconcile | `POST /api/v1/payment/{provider}/reconcile` (gateways with `query`) |
| Apply | after the response, retried by the cron's `payment_event_drain` (6 attempts) → `processPaymentConfirmed` / `processPaymentFailed` / `releaseOrderInventory` |
| Refund | `processRefund` → allocation claim → `gateway.refund` |
| Reconcile | `reconcileDueRefundAttempts` (`gateway.refundStatus`), `reconcileExternalRefundWebhooks` (`gateway.listRefunds`, `refund.observed` events) |

COD is not a gateway: collection is recorded in `cod.ts` and COD refunds are
confirmed manual settlements.
