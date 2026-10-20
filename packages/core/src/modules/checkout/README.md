# Checkout Module

Storefront checkout, from the cart to the committed order: cart validation, the checkout authority and policy, delivery preflight and pricing (`prepare.ts`), idempotent checkout attempts, the one guarded commit and its post-commit side effects, the quote fingerprint, and abandoned-checkout snapshots. The order it commits is an `orders` record; nothing here edits an order after commit.

Public entries: `index.ts` (the server API) and `browser.ts` (the quote fingerprint).

## Files

| Path | Exports | Purpose |
|------|---------|---------|
| `cart-validation.ts` | `validateStorefrontCartItems()`, `presentStorefrontCartValidation()` | Batched buyer-cart freshness: products, SKUs, stock and server prices |
| `prepare.ts` | `createStorefrontOrder()`, `validateStorefrontDeliveryPreflight()`, `presentStorefrontDeliveryPreflight()` | Server-priced order payload, delivery preflight, checkout-policy snapshots |
| `authority.ts` | `loadStorefrontCheckoutAuthority()` | One read of everything a checkout is priced and validated against, with its revision |
| `policy.ts` | `assertStorefrontCheckoutPolicy()`, `assertGuestStorefrontCheckoutPolicy()` | Merchant checkout policy (guests, countries, methods) |
| `flow.ts` | `isCheckoutGatewayUsableForFlow()`, `getCheckoutFlowValidationIssues()` | Which payment methods a checkout mode and advance payment allow |
| `flow-settings.ts` | `getCheckoutFlowSettingsDocument()`, `saveCheckoutFlowSettingsDocument()` | The `checkout` settings document's revision-guarded admin read and save |
| `config.ts` | `getCheckoutConfig()` | The public checkout configuration: readiness, currency, countries and the usable gateways in the merchant's order |
| `attempts.ts` | `buildCheckoutAttemptIdentity()`, `resolveExistingCheckoutAttempt()`, `createAtomicCheckoutAttempt()`, ... | Database-backed submit replay and the atomic idempotency commit |
| `reads.ts` | `loadStorefrontCheckoutReads()` | The attempt, authority and commit reads in one batch |
| `commit.ts` | `commitStorefrontOrderPayload()` | The single guarded write batch: attempt, order, lines, stock (ledger v2), discounts, receipt, outboxes |
| `post-commit.ts` | `runStorefrontOrderPostCommitSideEffects()` | Notification send, Meta dispatch and cache work after commit |
| `quote-fingerprint.ts` | `buildStorefrontCheckoutQuoteFingerprint()` | The fingerprint that fences a quote to its commit |
| `created-notification-policy.ts` | `shouldCreateOrderCreatedNotification()` | Whether a committed order notifies the buyer |
| `abandoned/{snapshot,cleanup}.ts` | abandoned-checkout snapshots and retention cleanup | Recovery data for unfinished checkouts |
| `pricing.ts` | `priceStorefrontCheckout()`, `checkStorefrontCartRules()`, `resolveAppPaymentMethods()`, ... | The one price of a checkout: promotions or bundles, then the apps' functions, then tax (quote and order alike) |
| `app-functions.ts` | `buildAppFunctionCart()`, `resolveAppDiscounts()`, `applyAppShippingRateOperations()`, ... | The cart apps see and the pure rules that merge app function outputs |

The abandoned-checkout maintenance sweep sets `abandoned_at` once after 60 minutes without a snapshot update. The bounded update supplies the transactional `checkout.abandoned` trigger edge; resumed checkouts keep their first marker and never emit it again.

## Data Flow

### Storefront Order Creation (synchronous, idempotent)
1. **Storefront cart freshness** -- The cart page revalidates persisted local cart items through `/api/v1/orders/cart-validation` on load, cart edits, and submit. The `/buy/{slug}` quick-buy route also validates the resolved SKU, quantity, price, and availability before writing `quickBuyData` to session storage or firing quick-buy analytics; if that storage write cannot be proven, cart renders a storage-specific error instead of silently showing an empty cart. Multi-gateway cart checkout must persist and read back the required `scalius_checkout_data` transfer before navigating to `/checkout`, while the optional gateway snapshot can fall back to fresh public checkout config. The checkout page revalidates the transferred snapshot on load and immediately before payment/order submit; stale results write a one-shot repair payload and send the buyer back to `/cart?checkoutIssues=1` so the existing row-level actions can repair the cart, while missing/unreadable transfer data shows an explicit Return to cart recovery state instead of a silent bounce. Deleted/inactive products, products without persisted inventory variants, literal legacy `default` variant ids, deleted variants, variant/product mismatches, non-default no-option SKUs, low stock, and price changes are returned per item with buyer actions (`remove`, `reduce_quantity`, `refresh_item`, or `select_variant`). If the freshness check itself cannot be read, the storefront fails closed with a top-of-cart retry message instead of clearing issues and allowing checkout. `validateStorefrontCartItems()` returns an in-memory proof marker; `createStorefrontOrder()` rejects forged prevalidated cart objects instead of trusting plain object literals.
2. **Storefront POST /orders** -- The storefront sends a stable `checkoutRequestId` for the checkout session and includes cart line metadata (`cartKey`, product name, variant label) so late validation issues can map back to the exact local cart row. The API route builds a canonical request hash from the order input, does a read-only `checkout_attempts` lookup so committed or active legacy same-key retries return before mutable checkout policy or rate-limit checks, then runs `validateStorefrontCartItems()` and delivery preflight again for new/non-replay attempts. The API enforces the merchant include/exclude phone-country policy before gateway readiness, rate limits, or order writes. If a customer session token is present, the API resolves it even when guest checkout is enabled; the authenticated customer ID owns the order while the separately validated checkout phone remains the editable delivery, notification, and immutable order contact. The order's phone follows the shared contact rule (`assertOrderContact()` in `contact-fields.ts`, `orderContactNeeds()` in `@scalius/shared/customer-auth-policy`): it is required unless the merchant opted in and the order has only digital or service lines, is paid in full online and is placed outside Bangladesh. Then e-mail is required (`details.reason = "phone_required"` and `details.phoneRequiredBecause` otherwise). An order with nothing to ship sends its market's country as `shippingCountryCode`; only a country an active market sells to counts, and none means Bangladesh. A stale session returns `CUSTOMER_SESSION_STALE` so the storefront proxy can clear stale customer cookies before the buyer retries as a real guest or signs in again.
3. **Atomic attempt behavior** -- A new request creates its canonical `orderId`, private `chk_` receipt token, and derived non-bearer `cst_` status token in memory only. It does not acquire a preliminary database lease. A committed same-key/same-payload retry replays the stored response. A still-active legacy processing row returns `202` with only its `orderId` and `cst_` polling token; `chk_` proof never enters status URLs. A stale/failed legacy row reuses its original identities. Same-key/different-payload reuse is rejected as `409`. If two fresh requests race, their final transactions contend on the unique request key: exactly one can commit, and the loser rereads and returns the winner's durable response.
4. **Order build** -- `createStorefrontOrder()` validates prices server-side from the prevalidated cart snapshot, verifies discounts, checks partial-payment rules, rejects inactive/deleted products, product/variant mismatches, and variantless buyer lines, resolves active city/zone/area names from the database, and builds the order payload using the in-memory attempt identities. Every checkout, including a product-level free-delivery waiver, requires one active selected shipping method; its ID, name, description, configured fee, effective fee, waiver state, and buyer-selected contact phone are bound into the reviewed quote/order facts. Order, receipt, account, admin, invoice, notification, and delivery reads use those order facts rather than mutable customer or shipping settings. A submitted code owned by the typed promotion authority is evaluated there even when inactive/ineligible; only a code absent from typed authority may enter the legacy compatibility path. The same private customer session is forwarded to tax quoting and final submit, so authenticated promotion identity cannot change when the buyer edits the delivery phone. Account ownership is carried only from that authoritative customer session identity; a guest checkout does not acquire account ownership merely because its submitted phone matches an existing profile. Delivery and checkout-policy snapshots carry unforgeable in-memory proof markers, avoiding duplicate reads while plain object forgeries fail closed. Every payment method must take the amount exactly (`PaymentProviders.amountIssue`, MARKETS-DESIGN D2): cash on delivery collects whole taka in BDT, so a paisa amount due is refused before commit (`details.reason = "cash_on_delivery_amount"`), and a gateway's first charge must fit its wire form (`precommitIssue`).
5. **One authoritative commit** -- `commitStorefrontOrderPayload()` performs read-only customer/inventory preparation, then one atomic database batch commits the checkout attempt and collision guard, inventory CAS plus ledger-v2 edges, customer/order/items/tax/COD facts, durable receipt, promotion/discount effects, and applicable outbox claims. Checkout/manual-order line counts are capped at 99, and multi-row order-item, tax-snapshot, and promotion-allocation inserts are chunked so every statement stays below D1's 100-bound-parameter ceiling without weakening the batch transaction. A new order's reservation generation is transactionally known to be one; legacy retry identities keep historical recovery reads. Authenticated payloads fresh-read the active claimed customer, while guest checkout creates or reuses only an unclaimed CRM profile and never gains account ownership by phone matching. Promotion/discount limits remain database-enforced. Any guard, stock, trigger, or order failure rolls back the entire attempt/order/inventory transaction, so no compensating reservation release or separate attempt finalization is needed. The buyer receives `201` only after all authoritative facts and the replay response exist. The order row carries its money chain (`orderMoneyChainColumns()` from `@scalius/shared/money-chain`): a same-currency order has `fx_rate` "1", `fx_source` "same_currency" and shop amounts equal to its presentment amounts.
   Every new commit requires the prepared `checkoutAuthorityRevision` and guards it inside the final batch, including online payments, discounts, agent checkout, and reservation-replay recovery. A changed catalog/delivery/tax/checkout policy rolls back the whole commit and asks the buyer to review again; an already-committed order remains replayable after authority changes.
6. **Post-commit work** -- The durable notification/Meta claims and initial COD state are already part of the authoritative commit when applicable. Notification send, Meta dispatch, semantic product-availability cache invalidation run after commit through `executionCtx.waitUntil()` when available. Their failure cannot turn a committed checkout into a false `500`; durable claims or database fallback remain available for retry and repair.
7. **Recovery and guest support** -- `GET /orders/status/:token` accepts only derived `cst_` status tokens and receipt validation accepts only private `chk_` receipt tokens. Both read the database only (`checkout_attempts` plus the committed `orders` row, and `order_receipts`); there are no KV hints, and raw receipt proof never enters URL paths or cache keys. `GET /orders/receipt/:id` returns buyer-safe receipt facts plus eligible support-request actions and reuses its receipt order projection for support-action eligibility instead of rereading the order. `POST /orders/receipt/:id/support-requests` accepts the private receipt token and creates a cancellation, return, or refund request in the same support-request ledger used by customer accounts. Its support-request `customerId` comes only from `orders.accountOwnerCustomerId`, never from the broader CRM link. It never directly mutates payment, shipment, inventory, COD, or order status.

## App functions (plugin platform phase 2b)

Installed apps ([plugin SDK](../../../../plugin-sdk/README.md)) can declare checkout function
points. The API builds one runner per request (`apps/api/src/plugins/
checkout-functions.ts`) from the active registrations, read in a wave the
request already makes (the checkout read batch, or the first `Promise.all`
of the quote, cart-validation and discount-preview routes). No app: no
points, no app call, no extra read. An app runs only at points its approved
grant names. Outputs are memoized per point and input for the request; the
order runs the apps again and the quote fingerprint compares the totals, so
an app answering differently at placement sends the buyer back to review.
Any app that throws, times out (1.5 s) or answers invalid output is skipped
and logged on its page (fail-open); a semantic problem (an unknown line or
rate) is logged the same way. An app registered with `onError: "block"`
(cart.validate and checkout.payment_methods only) instead stops checkout on
every channel: `400 details.reason = "checkout_app_unavailable"` with the
store's `checkoutAppUnavailableText` (`store-copy.ts`, the active checkout
language with the merchant's edits).

- **The cart apps see** (`functionCartSchema`): lines keyed by the tax
  allocation line id, unit price and the line total after the platform's
  discounts, SKU, category with ancestors, collections, brand, buyer inputs;
  the signed-in customer's order count and spend (no tags exist yet: always
  empty); the delivery region (city and thana names) when something ships;
  the typed codes. One extra read batch, only when an app implements a point.
- **Buyer UI and checkout attributes** (`attributes.ts`, shared `plugins/buyer-ui.ts`): private cart/quote/receipt/account responses carry declarative `buyer.ui` blocks. Active declarations validate values; unknown keys are dropped, invalid values return `attribute_invalid`, and required fields are checked only on placement so the initial quote can draw them. The accepted map (at most 8 KiB) joins quote/replay identity and the existing order insert. Attributes never enter events or URLs. Buyer UI sees only its app's attributes; object snapshots are shared within the request.
- **`cart.validate`**: on the cart page (catalog totals, no codes), the quote
  and the order. Errors land on their line (`index`, `cartKey`) or the whole
  cart; any error blocks: `400 details.reason = "cart_rules"` with
  `ruleErrors`.
- **`checkout.discounts`**, stacking rules (`app-functions.ts` header):
  platform discounts first (promotions or bundles, whichever the interplay
  picks); then apps in priority order (then app id), each app's discounts in
  order; each takes from what is left, so no line or delivery charge goes
  below zero; percentages of what is left, half-up to the store's price
  increment (whole taka by default in BDT); fixed amounts and caps floored to
  the increment; `order` and `lines` targets spread by remaining value
  (largest remainder, in increments);
  `shipping` lowers delivery only; gift-card lines never take one; a
  code-driven discount needs its code typed and claims it (no longer
  `not_found`); a discount naming a line not in the cart is skipped. Tax is
  quoted after every discount (the platform and app allocations together).
- **Snapshot commits** (`checkout.discounts` with `snapshot`): the API reads
  the signed-in buyer's record in the declared collection and passes it in
  with its revision; an answer's `commit` becomes an `AppObjectCommit`
  (checked and indexed by the platform). `resolveAppDiscounts` keeps the
  commits of apps whose discounts applied; the order payload carries them as
  `appObjectCommits` and `commitStorefrontOrderPayload` writes them in the
  same batch behind revision guards (`plugins/storage.ts`). A record changed
  since pricing fails the whole order with `app_offer_changed` and the store's
  `checkoutAppOfferChangedText`: a balance is never spent twice. Staff orders
  price without a signed-in buyer, so no commit can arise there.
- **Persistence**: no schema change. Line `discount_amount_minor` is the
  platform part plus the app part; each app discount is an immutable
  `app_discount` row in `order_events` (`order-kernel/app-facts.ts`: app id and
  name, title, code, target, amounts, per-order-item parts), inserted in the
  commit batch. The commit check, refund reconciliation
  (`readPromotionRefundSnapshot`), the order discount lines (receipts,
  account order, dashboard, invoice) and the amendment guard (an app-discounted
  order's items are not editable, like a promotion order) all read it. The
  order timeline leaves app facts out.
- **`checkout.shipping_rates`**: hide, rename, price (the rate's own charge,
  cash-rounded; a rate the platform makes free stays free) and reorder the
  rates offered for the address. Apps never add a rate. The quote returns
  `shippingRates` when an app changed them; a hidden chosen rate is refused
  with `delivery_rate_unavailable` and the visible options. The order keeps
  the renamed/priced rate as reviewed.
- **`checkout.payment_methods`**: hide, rename and reorder the methods the
  merchant's policy and readiness already allow; apps never add or enable
  one. The quote returns `paymentMethods`; placement refuses a hidden method
  (`payment_method_unavailable`). Gift-card cover is tender, never hidden.
  A `gated` method (the invoice, when the merchant lets apps decide who pays
  later) is offered only when an app answers `{ op: "allow" }`; without an
  answer it stays hidden, and a hide wins over an allow
  (`payment-terms.ts`, payments README "Deferred payment").
- **Order risk is an event, not a function** (a decision inside a request is
  a function, a provider of a capability is a port, a reaction after commit
  is an event). An app handles `order.created` and calls the host actions
  `ctx.orders.riskHistory` (the buyer's earlier order counts),
  `ctx.orders.assessRisk` (one `app_risk` order fact per app, shown on the
  dashboard order next to the courier fraud check) and `ctx.orders.hold`
  (one hold per app, `orders/holds.ts`): the order is not shipped, handed
  over, auto-fulfilled or moved on by status edits until staff release it;
  cancelling stays possible. A redelivered event adds nothing.
- **Channels**: every channel runs the same merge rules. Buyer agents
  (`channel: "agent"`, `agent-storefront/`): the quote and submit price
  through `priceStorefrontCheckout`/`createStorefrontOrder` with the apps the
  route builds; the quote adds `appDiscounts`, `shippingRates` and
  `paymentMethods`, submit re-runs the apps under the quote fingerprint and
  refuses a hidden method, and applying a code only an app answers to is
  allowed. Staff orders (`channel: "admin"`, `orders/admin/app-functions.ts`):
  the staff discount takes the place of promotions in stacking rule 1, the
  quote carries `appDiscounts`, rule errors and a hidden cash on delivery
  refuse the quote and the order, the order records `app_discount` facts; an
  app prices the chosen delivery method only when staff kept its own fee (a
  typed charge is an override), a rename always applies, hiding it refuses.
  Amendments run no apps (an app-discounted order is not amendable).
  `order.created` reaches apps for every channel's order, once it is real.

## Order lines (Wave A)

- **Line types.** Cart validation reads each SKU's `fulfillment_kind` and the
  product's `is_gift_card`; the delivery preflight turns physical lines into
  `ship` (a delivery rate) or `pickup` (a pickup rate). A cart with nothing
  physical has no method, no fee and no address. A line whose type has no
  fulfiller (`fulfilment/registry.ts`) fails closed with `fulfilment_unavailable`.
- **Address.** Required only when a line ships (`orders.requires_shipping`,
  also a trigger). Without one the tax destination is null: only store-wide
  rates apply. Cash on delivery needs a line handed over in person.
- **Buyer inputs.** `items[].properties` are resolved against
  `products.customization_schema` (`@scalius/shared/line-properties`) in cart
  validation and again at commit. The unit price is base + surcharges; the
  labelled snapshot, the surcharge and the base price are frozen on the line.
  Stock is checked per SKU across lines. The quote fingerprint and the attempt
  hash include properties only when a line has them, so older payloads hash as
  before.
- **Commit budget.** A 99-line commit is one batch of 39 statements, each
  within D1's 100 bound values (`wave-a-checkout.d1.test.ts`).
- **Market** (MARKETS-DESIGN step 2). The `checkout_authority` row of the
  authority batch also carries the backup market's price increment (no extra
  statement). The order insert writes `orders.market_id` itself
  (`orderMarketIdSql()`): the active market of the shipping country, else
  the backup market. A change of a
  market's status, increment or countries bumps `checkout_authority` (0112
  triggers). The checkout config reads the presence's market joined with its
  settings documents, in the statement it already ran.

- **Shipping country** (MARKETS-DESIGN step 3a). The order takes
  `shippingCountryCode` (absent: Bangladesh) and the canonical address
  fields. The `checkout_authority` row also carries the countries of the
  active markets (`sellingCountriesSql()`); another country is refused with
  `details.reason = "shipping_country_unavailable"`. The address follows its
  country's rules (`resolveStorefrontShippingAddress()`), and the phone is
  read in the address country (E.164). Bangladesh keeps City/Thana/Area.
  The phone countries checkout accepts are the merchant's customer-country
  policy united with the countries of the active markets
  (`acceptedPhoneCountryPolicy()`): the authority snapshot's `allowedCountries`
  and the config's `allowedCountries` already hold that list, so the API, the
  agent checkout and the storefront apply one rule.
  Delivery rates come from the address's shipping zone (step 3b): the rate
  statement carries the destination country's regions, and a foreign
  destination adds its admin area and postal code. No zone means no
  delivery rate (`delivery_rate_unavailable`), never a wrong fee. A payment
  method that does not serve the delivery country (cash on delivery:
  Bangladesh) is refused with `payment_method_unavailable`.
  The order insert writes the snapshot (`orderShippingAddressInsertColumns()`
  leaves absent values out, so no extra bound parameter). No address-book
  write: trigger `orders_seed_customer_address` gives a new guest record its
  first address.
- **Billing address** (migration 0119, Shopify's rule;
  `resolveCheckoutBillingAddress()` in `orders/billing-address.ts`). An
  order that ships is billed at its shipping address. An order that ships
  nothing needs one: by default its country (absent: the store's only
  selling country) plus the admin area and postal code its rules require;
  with Settings → Checkout `requireFullBillingAddress`, a full one (a
  shipped order then may send `billingSameAsShipping: false` and an
  address). A pickup order needs none unless the merchant requires it. The
  country must be one an active market sells to. The order is taxed at its
  billing address and placed in its country's market (`taxAddressSource()`
  in `tax/region-match.ts`). The insert writes both billing flags as SQL
  literals (`orderBillingAddressInsertColumns()`), so a shipped order binds
  nothing more.

- **Market currency** (MARKETS-DESIGN step 6). `StorefrontCartValidationResult.money` is the order's
  presentment currency and its locked rate: the cart, the delivery preflight (`deliveryRateInCurrency`),
  promotions (`candidatesInCurrency`), apps and tax price in it. The order insert writes its fx snapshot
  (`orderData.fx`) and exact shop amounts. Gateways are filtered by `chargeCurrencies`; deposits stay in the
  shop currency. A gift card in the shop currency pays at the rate; its debit is the tender's settlement.

## Quantity bundles (catalogue slice 1c)

- **Reads.** The authority batch carries the cart products' active
  `product_bundles` rows (`selectActiveProductBundleRows`, one `json_each`
  parameter); `validateStorefrontCartItems()` reads them beside the product
  rows. Every tier write bumps `checkout_authority` (0090 triggers), so a
  prepared order priced from old tiers fails its commit guard.
- **Pricing.** `bundleLineSavings()` (via `resolveCartBundleSavings()`) groups the lines of one product
  (any SKU, any buyer inputs) and prices them with `bundleGroupPricing`
  (`@scalius/shared/product-bundles`) from the catalog unit price after
  catalog discounts, before surcharges. Each line gets `bundleDiscountMinor`;
  gift cards never bundle. Savings are on the store's price increment (whole
  taka by default in BDT).
- **With promotions** (`resolveBundlePromotionInterplay` in
  `bundle-discounts.ts`, one rule for the tax quote, the order, the agent
  quote and the cart's discount preview `POST /discounts/validate`, which
  prices bundles with `previewStorefrontBundleSavings`): an order is priced
  by its promotions or by its bundles, never both. Promotions (automatic and
  typed codes) are evaluated at catalog prices as always; the buyer gets
  whichever saves more in total (promotions on a tie). Losing promotions step
  aside (no snapshot, no discount lines; offers and code feedback stay), and
  each typed code the bundle beat stays listed as `lower_savings` with
  `bundleSavesMore` ("Bundle saving applied: better than CODE"), never
  silently dropped and never redeemed. Delivery
  thresholds read the catalog subtotal. Bundle savings land in the lines'
  `discount_amount_minor` with no `order_discount_allocations` rows, so the
  commit check (it refuses a payload that mixes both), refund reconciliation
  and receipt lines keep reading promotion allocations only. Stacking needs a
  recorded bundle part per line (a lead-numbered migration); then only the
  interplay function changes.

### Calculated delivery rates

A zone rate can name a courier's optional `rates` operation. The existing
shipping and location reads carry its service/fallback and external place ids;
SKU weights ride the existing cart read. One preflight calls at most three
providers within two seconds, memoizes each, and uses a versioned ten-minute
Cache API hint. Failure hides the method unless the merchant saved a fallback.
Functions adjust the resulting rates after carriers finish.

The response's body-only `shippingRateToken` signs the method, service, amount,
currency, destination/parcel hashes and cash-collection mode for fifteen minutes
under the `checkout-rate-quote` HKDF purpose. Commit consumes a matching token
without carrier calls or quote rows. Its signed cash-collection mode must match
the final payment policy, including an online deposit's outstanding balance;
otherwise checkout refuses before writing and asks the buyer to review delivery.
Changed or expired tokens re-quote, with the existing fingerprint guarding totals.
