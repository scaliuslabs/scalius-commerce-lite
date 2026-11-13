# Payments

Gateway adapters speak one provider's protocol; everything else (session
orchestration, webhook claim-once, payment application, refunds,
reconciliation) is written once and never branches on a gateway id, or on
whether a gateway is built in or an app's.

Payments act on orders through `order-kernel`:
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

How to add a built-in gateway: `docs/ARCHITECTURE.md`. `gateways/testing.ts` is a complete test-only app
gateway the kernel suites run against.

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
- A payment method states the countries it serves (`countries`: `"any"`, the
  default, or ISO codes; MARKETS-DESIGN step 3b). Cash on delivery serves
  `["BD"]` (`COD_COUNTRIES`). `PaymentProviders.countryIssue()` refuses a
  method for the country the order is handed over in, checkout's
  `paymentCountryOf()`: the delivery country, or the store's own (its default
  location's, the tax origin) for a pickup or an order that ships nothing; an
  unknown store country fits only `"any"` methods. The cart's methods, the
  tax quote, quick checkout, the agent quote and order placement apply it;
  staff orders do not (staff decide).

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
string), `exchange_adjustment_minor` and `settlement_provenance` (0188: `reported` or `assumed`).
Historical rows and movements without a usable provider report are explicitly assumed; identical
presentment numbers do not establish what a provider paid out. A confirmed payment takes the
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

Entry points: `apps/api/src/routes/payment/` (session, hosted return, reconcile), the webhook route
(`claimAndApplyPaymentEvent` claims a `webhook_events` row holding the verified event), the apply after the
response (retried by the cron's `payment_event_drain`), `processRefund` and the refund reconcilers.

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

A `refund_observed` event is checked when it arrives (`verifyObservedRefund`,
read-only): when every refund the provider lists is already recorded (the
merchant's own refund) it is processed at once; otherwise it waits for
`reconcileExternalRefundWebhooks`, which imports refunds made in the provider
dashboard but never while one of the order's own refunds is still settling
(`local_refund_in_progress`). The order page lists only a refund made outside
Scalius (`external_refund`), never the order's own.

A confirmed or authorized event the provider flagged (`review: { reason }`,
e.g. SSLCommerz `risk_level` 1) still counts as paid. `payment-review.ts`
keeps the reason in the payment's metadata and writes a platform hold on the
order in the payment's own batch, so nothing ships or is handed over until
staff release it; the dashboard payments read returns `review` per payment.

COD is not a gateway: collection is recorded in `cod.ts` and COD refunds are
confirmed manual settlements.

A gateway's charge limits come from `gatewayAmountLimits(gateway, currency)`:
an app provider's single-currency `amountLimits`, or a built-in's
per-currency `amountLimitsFor` (Stripe's published minimums and its
eight-digit maximum; a currency Stripe publishes no minimum for has none).
Precommit, session creation, saved-method charges, the advance-payment
setting and the public checkout config all read the same limits, so a charge
Stripe would refuse is refused before the order commits.

A refund fills the order's captures in one order (newest first, gift-card
tenders last; `allocateRefundAcrossSources`, `@scalius/shared/refund-sources`).
`listRefundSources()` returns those sources with what each still refunds and
how it settles (`provider`, `manual`, `gift_card`); the dashboard payments
read carries them so the refund dialog asks staff to confirm exactly the share
paid back by hand (COD and recorded transfers), never guessing from the
order's method.

## Saved methods, off-session charges, authorizations

Core runs no subscription logic; it gives apps the primitives (the stable
app API's `payment_methods.*` and `payments.charge|capture|void`,
`apps/api/src/routes/admin/resources-payment-methods.ts`). A provider opts in
with descriptor capabilities: `vault` (`chargeSavedMethod`,
`deleteSavedMethod`) and `manualCapture` (`capture`, `void`);
`gatewayHasCapability()` checks both. Built-in Stripe declares neither yet.

- **Saved methods** (`customer_payment_methods`, migration 0173,
  `saved-payment-methods.ts`): the provider's opaque reference plus brand,
  last four digits, expiry and a label; never a card number or CVC, and the
  reference never leaves the store. A session asks the provider to keep the
  method (`savePaymentMethod`) when the gateway vaults, the buyer is the
  order's account customer and a line carries `_purchase_option`. The
  confirmed or authorized event's `savedPaymentMethod` is upserted in the
  batch that applies the payment, for the account customer only, never moved
  to another customer. Removing detaches at the provider first.
- **Ownership** (migration 0175, security audit N3): a method belongs to the
  app whose purchase option kept it (`owner_plugin_id`, plus the option and
  its title when the order named exactly one; options of two apps own
  nothing). `SavedMethodActor` decides reach: an app lists, charges and
  removes only its own (another's reads as not found), staff reach every
  method, and the buyer lists and removes their own
  (`/customer-auth/payment-methods`; staff on the customer page). The app
  scope is the Sensitive `write_payment_methods`
  (`orders.charge_saved_methods`), separate from recording a payment.
- **Authorizations**: an `authorized` event records an `order_payments` row
  `authorized` (`processPaymentAuthorized`): money held, nothing paid (the
  ledger counts `succeeded` only); an open checkout it holds is placed. Like
  `pending`, it is money in flight: the order cannot be cancelled, switch
  gateway, or take another charge. A capture's confirmed event (same provider
  reference) promotes the row through `processPaymentConfirmed`; a void, or a
  verified `failed`/`cancelled` event naming the reference, marks it
  `cancelled` (`releaseAuthorization`).
- **Commands** (`saved-method-charges.ts`): `chargeSavedPaymentMethod`,
  `captureAuthorizedPayment`, `voidAuthorizedPayment` claim a
  `payment_session_attempts` row before the provider call (its per-order
  single-flight index and lease are the hosted-payment lock). The charge key
  derives from the caller's Idempotency-Key and is the provider's
  idempotency key; capture and void keys are the authorization's own
  (`capture:<payment id>`), so one hold is captured once whoever asks. Outcomes
  are recorded and replayed: `succeeded`, `authorized`, `pending` (a webhook
  follows), `declined` (422 `payment_declined`). No answer leaves the attempt
  `uncertain` (503 `payment_outcome_unknown`): the same request asks the
  provider again under the same key; meanwhile (and while `pending`, or while
  another command of the order calls its provider) the order takes no other
  charge. Events go through the one `webhook_events` claim and the kernel, as
  webhooks do.
- **Convergence** (`command-attempts.ts`): the batch that lands a payment
  closes the pending commands it names (provider reference or correlation
  id), and a failure settles the ones it names after its write; replays, new charges and the minute sweep
  (`reconcilePaymentCommand`, inside the payment-event drain) settle what the
  ledger already decided, look referenced payments up (`queryPayment`) and
  expire a command three days after its last answer. A dead invocation's
  `processing` command becomes `uncertain`.
- **Turning a gateway off** stops checkout and new charges only:
  refunds, captures, voids, lookups and callbacks need readable credentials
  (`canOperateExistingPayments`).
- **Invoices**: a provider payment lands on a `net_terms` order while nothing
  is paid on it (`acceptsProviderPayment`); the landed payment switches the
  order to the provider in its own batch, a decline changes nothing. An
  invoice partly paid by recorded payments keeps taking recorded payments;
  cash on delivery never switches.

## Refund records and lines (0172)

Refunds are records with lines: COMMERCE-HOOKS H9.

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
  against an invoice, or against an order paid as it was placed (staff's
  Mark as paid, a point-of-sale sale: `orders.payment_method` `manual`, no
  terms, never an invoice): an `order_payments` row with `payment_method`
  `manual` (`RECORDED_PAYMENT_METHOD`) and the order's new paid amount in one
  guarded batch, idempotent by the caller's key. Its insert emits
  `payment.updated`, a full payment `order.paid`; a refund of it is a manual
  settlement (`isManualSettlementMethod`). An app deferred method's own
  provider events still credit the order through the kernel as for any
  gateway.
- Overdue: `overdueOrderCondition()` (orders), the orders list view
  `overdue`, the stable list's `overdue=true` and Home's to-do.
