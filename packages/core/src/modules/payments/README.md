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
(`<plugin id>:<provider id>`: `scalius.bangladesh:bkash`, the Bangladesh pack's
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
| Apply | after the response, retried by the cron's `payment_event_drain` (6 attempts) → `processPaymentConfirmed` / `processPaymentFailed` (failed and cancelled alike) |
| Refund | `processRefund` → allocation claim → `gateway.refund` |
| Reconcile | `reconcileDueRefundAttempts` (`gateway.refundStatus`), `reconcileExternalRefundWebhooks` (`gateway.listRefunds`, `refund.observed` events) |

A failed or cancelled event ends one attempt and never touches stock. It
applies only when its provider is the order's payment method, it names the
order's newest session attempt (by correlation id or provider session
reference), and the order is open (`incomplete`/`pending`) and unpaid; any
other is recorded as `*_ignored`. The open order keeps its reservation for
the buyer's retry until it is cancelled (staff or the stale-checkout sweep).
A confirmed payment on an open order whose stock was released reserves it
again first; when the units are gone the payment is still recorded and the
event goes to manual reconciliation (`confirmed_stock_unavailable`, no
automatic fulfilment).

COD is not a gateway: collection is recorded in `cod.ts` and COD refunds are
confirmed manual settlements.

## Deferred payment (net terms)

`@scalius/shared/payment-terms` is the vocabulary; migration 0161 adds
`orders.payment_terms_days` and `orders.payment_due_at` (placement + days).
Migration 0163's partial index `orders_payment_due_idx`
(`deleted_at, payment_due_at, id` where money is due) serves the overdue
count, list and App API read; `overdueOrderCondition` repeats its WHERE and
`list-scale.d1.test.ts` pins the plans.

- The built-in invoice (`net_terms`, not a gateway) is enabled like cash on
  delivery in the `payment_methods` document, whose `netTerms` holds the
  merchant's net days (7/15/30/60) and who may use it: customer tags,
  segments, or an app's decision. An app's own deferred method is a payment
  provider declared `flow: "deferred"` with `dueInDays`
  (`PaymentProviders.isDeferred()` / `declaredTermsDays()`).
- Eligibility (`checkout/payment-terms.ts`): never a guest; the invoice for a
  signed-in customer the settings name; with "apps decide" it is `gated` in
  `checkout.payment_methods` until an app answers `{ op: "allow" }` (fail
  closed). The tax quote offers it; placement re-checks it and passes the
  terms in the trusted policy snapshot (a deferred order without them is
  refused).
- A deferred order commits `pending`, payment `unpaid`, stock reserved as
  for cash on delivery, no COD tracking, no advance deposit, no rider cash
  (`codAmountMinor` 0); it may be marked delivered before it is paid, and
  completes once paid.
- `recordOrderPayment()` (`recorded-payment.ts`) records money received
  against an invoice: an `order_payments` row with `payment_method`
  `manual` (`RECORDED_PAYMENT_METHOD`) and the order's new paid amount in one
  guarded batch, idempotent by the caller's key. Its insert emits
  `payment.updated`, a full payment `order.paid`; a refund of it is a manual
  settlement (`isManualSettlementMethod`). An app deferred method's own
  provider events still credit the order through the kernel as for any
  gateway.
- Overdue: `overdueOrderCondition()` (orders), the orders list view
  `overdue`, the stable list's `overdue=true` and Home's to-do.
