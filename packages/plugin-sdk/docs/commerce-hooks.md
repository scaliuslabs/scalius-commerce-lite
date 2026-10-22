# Commerce hooks

How an app takes part in commerce: what it may read and write, what it is told, where it decides inside checkout, and which promises do not change. [Apps](apps.md) covers the manifest and the lifecycle; the SDK [README](../README.md) has worked code for each part.

**The seam rule.** A decision inside a request is a **function** (six checkout points). A provider of a capability is a **port** (a payment gateway, a courier). A reaction after a write commits is an **event** handler. Buyer UI on private pages is a **storefront extension**, not a function. Order risk is an event: handle `order.created` (see [Apps](apps.md#order-timeline-and-risk)).

## 1. Access, event payloads and ports

### Scopes and contact data

Scopes come in three tiers: access scopes (grant store permissions), contact data scopes (reveal one kind of buyer contact data) and one capability scope (`send_messages_any`). The full table and the consent rules are in [Apps](apps.md#access-and-consent).

Contact data is protected in one place and projected everywhere:

- Operation outputs mark protected fields `x-scalius-protected`. Without the matching `read_customer_*` scope they read `null`. A filter or search by such a field is refused with 403 `contact_scope_required`.
- Webhook `data` is projected through the endpoint's chosen customer data (none by default).
- Provider inputs are projected from the app's grant. A port declares the contact data it needs; a manifest that declares the port without those scopes is refused, and the host refuses a port whose stored grant lacks them (`provider_customer_data_not_approved`).
- Function inputs and event facts never carry contact data.

### Event payloads

- An event's `facts` carry ids, states and quantities. Never contact data, credentials or money.
- A webhook delivery adds `data`: the resource's sealed representation (`EVENT_REPRESENTATION_SCHEMAS` in `@scalius/shared/events`) for one of 17 resource types: order, return, product, variant, customer, purchase order, inventory transfer, fulfillment, refund, shipment, payment, checkout, discount, review, gift card, gift card transaction and object.
- A representation has ids, states, ISO 8601 times, money as integer minor units beside its currency, lines by id and quantity (at most 500 listed) and discount codes as a count.
- Representations only grow within `EVENTS_API_VERSION` (`2026-10`): a field may be added, never removed, retyped, made nullable or stripped of its protection. Published schemas never close an object, so tolerate fields you do not know.
- App event handlers get facts only. Read the resource with `ctx.api` (`orders.get` returns the same representation).

### Provider ports

Fourteen ports are typed and validated on both sides. Each has a tier (`PROVIDER_PORT_TIERS`):

| Tier | Ports | Meaning |
| --- | --- | --- |
| `stable` | `payment`, `courier`, `sms`, `courier_history` | Real providers implement them. Sealed; changes are additive only. |
| `beta` | `email`, `tax`, `messaging`, `push`, `translation`, `ai`, `search`, `address`, `fx`, `identity` | Any app may implement them. The consent screen labels them Beta. Their schemas may still change. |

A port is promoted by changing its tier, never demoted.

- A provider runs only when it is ready: the app is active and approved for the port, its own settings are complete and readable, and no value is an obvious placeholder ("test", "your api key"). One provider's broken settings never stop its siblings.
- A provider may reach its service through `ctx.http` on approved hosts. `ctx.messaging` is refused inside a provider operation.
- Fail with `ProviderError(category, message, { uncertain?, code? })`: `declined` (nothing happened; not retried), `retryable` (add `uncertain: true` if the call may have reached the provider; the platform reconciles and never repeats an uncertain call blindly) or `misconfigured` (the provider is not ready; the platform fails closed). A throw that is not a `ProviderError`, a timeout or an invalid answer counts as retryable and uncertain. A message is at most 300 characters and safe for a merchant.
- Courier `rates` get parcel and destination facts without contact details. A missing usable rate fails checkout closed. A tax provider failure refuses checkout with `tax_unavailable`.

The SDK README walks through building a payment provider, a courier, SMS, email, courier history and the service ports.

## 2. The checkout-function interface

A function is pure: `(input, settings) => output`, with no I/O. The host validates the input and the output (schemas in `@scalius/shared/plugins/functions`) and applies the result through the store's own checkout rules.

### Points

They run in this order: `cart.transform`, then `cart.line_prices`, then `cart.validate`, `checkout.discounts` and `checkout.shipping_rates` together, then `checkout.payment_methods`. They run for the online store and buyer agents. Staff orders run all but `cart.transform` and `cart.line_prices` (staff set lines and prices).

| Point | Input beyond `cart` and `reads` | Answer |
| --- | --- | --- |
| `cart.transform` | | `{ operations: [{ op: "expand", lineId, title?, components: [{ variantId, quantity }] } \| { op: "merge", lineIds, title }] }` (50 operations; 20 components) |
| `cart.line_prices` | `lines: [{ lineId, source, bundle }]` | `{ prices?: [{ lineId, unitPriceMinor }], adjustments?: [{ lineId, amountMinor, title }] }` |
| `cart.validate` | | `{ errors: [{ code, message, lineId? }] }` (20) |
| `checkout.discounts` | | `{ discounts: [{ title, code?, target, value, maxAmountMinor?, combinesWith? }], commit?: [{ as, record }] }` (10 discounts) |
| `checkout.shipping_rates` | `rates: [{ rateId, name, amountMinor, kind }]` | `{ operations: [hide \| rename \| price \| reorder] }` |
| `checkout.payment_methods` | `methods: [{ methodId, name, gated? }]` | `{ operations: [hide \| allow \| rename \| reorder] }` |

- **`cart.transform`.** A bundle's components become real order lines (stock, tax and refunds per SKU); the buyer sees one line at the summed price. Lines with buyer inputs, gift cards and carts above 99 lines are never changed.
- **`cart.line_prices`.** `prices` set a line's unit price. The one price precedence is: purchase-option price (only the app that declares the option) > sale > segment > market list > app price > FX > base. A one-time line takes an app price only when no price list prices it, and the first app by priority wins. `adjustments` are add-ons (below).
- **`checkout.discounts`.** A discount targets `{ kind: "order" }`, `{ kind: "lines", lineIds }` or `{ kind: "shipping" }`, worth `{ type: "percentage", percent }` or `{ type: "fixed_amount", amountMinor }`. Size it against `cart.lines[].lineTotalMinor`.
- **`checkout.payment_methods`.** Hide, rename and reorder the methods checkout allows. A method marked `gated: true` is offered to this buyer only if an app answers `{ op: "allow", methodId }` (for an app's own deferred method, only that app). A hide wins over an allow.

### The cart

Every point gets `cart` (`FunctionCart`):

- Money: `currency`, `decimalPlaces`, `subtotalMinor`, and per line `unitPriceMinor` and `lineTotalMinor` (after the platform's own discounts, before app discounts). All integer minor units.
- Who and where: `channel` (`online_store`, `admin`, `pos`, `agent`, `app`), `salesChannelId`, `market: { id, country }` (country is null before an address is known), `destination: { country, city, zone }` (region only), `discountCodes`.
- `customer` (null for guests): `id`, `tags` (at most 50), `segmentIds` (the segments of the market's live segment price lists that price this buyer, at most 50), `orderCount`, `totalSpentMinor`, and `roles`: the roles **your** app gave this customer.
- `lines` (at most 250): `lineId`, `productId`, `variantId`, `sku`, `title`, `quantity`, `categoryIds`, `collectionIds`, `brandId`, `properties` (buyer inputs), `requiresShipping`, `weightGrams` (null when unset) and `purchaseOption` (`<app id>.<key>` or null).
- `attributes`: **only your own app's** accepted checkout attributes, keyed `<app id>.<key>`. A function never sees another app's buyer answers. Reading another app's answers is not offered; if it ever is, it will be a declared read the merchant consents to.

Core cart facts (lines, customer, market, destination, codes, channel) are the same for every app.

### Checkout attributes

An app declares up to 10 typed buyer inputs in `checkout.attributes` (`text`, `multiline`, `number`, `boolean`, `date`, `choice`). A Buyer UI `field` draws one; core owns the input, validation and storage. The host drops undeclared keys and caps all of an order's attributes at 8 KiB. Values travel in request bodies, never in URLs, logs or event facts. They are part of the quote fingerprint and are stored on the order.

### Declared reads

A function reads your app's own data through the manifest, never through I/O. Up to four `reads` per function, and four across all of an app's storefront extensions.

```ts
{ point: "cart.validate", onError: "block", reads: [
  { as: "member",  object: "members",   key: "customer" },
  { as: "company", object: "companies", key: { from: "member.company_id" } },
  { as: "moq",     object: "moq",       key: "line.variantId", max: 50 },
  { as: "fields",  customFields: ["product:min_qty"], max: 48 },
] }
```

- Keys: `customer`, `line.variantId`, `line.productId`, `attribute.<key>` (the buyer's answer to one of your checkout attributes), or one hop `{ from: "<as>.<field>" }` along a `single_line_text` or `object_reference` field of an earlier single-key read.
- Objects are your declared types. A custom-field read names up to 10 of your own fields of one owner type (`product`, `variant` or `customer`) and is keyed by that owner.
- `input.reads[as]` is `{ revision, data } | null` for a single key, or `Record<key, { revision, data }>` (existing records only) per line. `readOne(reads, as)` and `readMany(reads, as)` read them typed. Custom-field records have revision 0. Data is in the same wire form `ctx.objects` reads (money as `{ amountMinor, currency }`). Weak references are not resolved.
- Bounds, checked before anything is read: 100 keys per function (a per-line read counts its distinct SKUs or products, at most its `max`) and 256 KiB of resolved JSON. Over a bound, the function does not run and `onError` applies.
- Cost: reads ride the read batch checkout already sends. They add statements, never a round trip. A store whose apps declare no reads pays nothing.

### Commits

A `checkout.discounts` answer may carry `commit: [{ as, record }]` (up to four) for single-key object reads whose key resolved to an id. Each is the next version of a record you read. The platform writes it in the order's own commit batch, guarded at the revision you saw (or "must not exist"), and only when one of your discounts applied. If the record changed meanwhile, the order fails with `app_offer_changed` and the buyer reviews it. A commit naming anything else invalidates the whole answer. So a spent balance can never be spent twice.

### Line add-ons

`cart.line_prices` may answer `adjustments: [{ lineId, amountMinor, title }]`: add-ons to each unit (an engraving, gift wrap).

- They apply after the whole price precedence, so sale, segment and price-listed lines take them too.
- Every app's add-ons apply, in priority order, at most five per line. Each rounds half-up to the market's price increment. Gift cards and bundle lines take none.
- They are part of `unitPriceMinor`: quote, tax, discounts, totals and refunds include them. The buyer sees "Add-on: <title> (+price)" in the cart, checkout, receipt and emails.

### Failure policy and limits

- A function that throws, times out, answers invalidly (`function_invalid_output`) or exceeds its read bounds is left out: `onError: "skip"` (the default).
- Only `cart.transform`, `cart.line_prices`, `cart.validate` and `checkout.payment_methods` may declare `onError: "block"`. Checkout then stops with the store's buyer-safe text.
- Wall budget: the smaller of `limits.wallMs` and 1.5 s. CPU: 50 ms in an isolate.
- `priority` (0 to 1000, default 100): lower runs first among apps at the same point.

### Testing

`harness.fn(point, input)` is typed by point, parses the input with the point's schema (a mismatch throws) and checks the answer exactly as the host does. An invalid answer returns `ok: false` with `function_invalid_output`. `fixtures.checkoutDiscountsInput`, `fixtures.cart` and `fixtures.cartLine` build valid inputs. Pass `reads` as the host would resolve them.

### Buyer UI extensions

Buyer UI is a storefront extension, not a function. Declare `storefront.extensions: [{ target, reads }]`, one per UI slot, and implement `extensions[target]` as a pure render returning `{ ui }` (a buyer-surface `ui` tree) or `{ ui: null }`. It has no priority and no `onError`; a failed render is omitted and never blocks checkout.

- The input carries the target, `language`, `locale`, `currency`, the `cart` (where the slot has one), the `order` (id, status, payment status, lines), the `customer` id, your declared `reads`, and your own checkout attributes: `attributes` by bare key and `cart.attributes` by `<app id>.<key>`. It never carries another app's answers.
- Fields are editable only in checkout slots. Buttons run cart operations in checkout slots and the cart drawer. Order and account slots are read-only.
- Test with `harness.extension(fixtures.storefrontExtensionInput(target, overrides?))`. The fixture builds a complete, valid input for the slot's page.

The slot list is in [Storefront](storefront.md#slots).

## 3. The stable app API

`ctx.api.call(name, { path?, query?, body?, idempotencyKey? })` calls an operation and answers `{ ok, status, data, error }`. It goes through the same validation, permissions, idempotency and audit as the dashboard. 60 calls a minute.

### Tiers

| Tier | Who calls it | Change rule |
| --- | --- | --- |
| `stable` | Any app | Additive only; sealed |
| `beta` | Bundled first-party apps | May change in any release |
| `internal` | No app | Private |

A third-party app calling a beta or internal operation gets `api_operation_not_stable`. One its approved scopes do not cover gets `api_operation_forbidden`. The whole storefront API is beta or internal for now.

### Rules every stable operation follows

- **Names.** `<resource>.<verb>`: `orders.get`, `products.create`, `objects.upsert`, `variants.bulk_set_stock`. One sealed table (`@scalius/shared/plugins/app-operations`) maps each name to its operation. A dashboard operation id is refused with `api_unknown_operation`, whose message names the app name. `stableContract.operations` in `@scalius/plugin-sdk/testing` lists them all.
- **Lists.** `cursor` and `limit` in; `{ <plural>, nextCursor }` out. Lists page in `updatedAt, id` order; `updatedSince` starts a sync. An unknown cursor is `invalid_cursor`.
- **Instants.** Every instant is an ISO 8601 date-time string, in and out.
- **Errors.** Every code is lower_snake (`price_changed`, `api_operation_not_stable`); an area prefix is `<area>_<code>`. `APP_ERROR_CODES` lists every code with its HTTP status. A code is only ever added and its status never changes.
- **Money.** Integer `*Minor` fields with an ISO 4217 `currency` beside them. No stable operation takes a decimal amount.
- **One representation.** A `*.get` or `*.list` returns the same shape as a webhook's `data`. A single resource answers `{ <singular>: Resource }`. Addresses are the `PostalAddress` shape. States are closed enums: decide money from `paymentStatus` and hand-over from `fulfillmentStatus`, not from the order's `status`.
- **One retry key.** Every stable mutation takes `idempotencyKey` (sent as the `Idempotency-Key` header, 8 to 200 printable characters). Stock moves require it.
  - A repeat by the same caller for the same operation within 24 hours returns the first response (`Idempotent-Replayed: true`).
  - The same key for a different request is 422 `idempotency_key_reused`. One still running is 409 `idempotency_in_progress`.
  - If the first answer was lost, a repeat after two minutes never acts twice: a keyed write answers its first result, a revision-guarded write refuses as stale, and a create with no key of its own answers 409 `idempotency_outcome_unknown` (read to check, and create with a new key only if it is missing).
  - No request body carries a key.
- **Revision preconditions.** A write that is not a create takes the revision it was based on (`expectedRevision`, `expectedVersion`, `expectedAggregateRevision` or `expectedStockVersion`). A stale value is 409 and changes nothing. A few writes take none yet; adding one later is additive.
- **Contact data.** Protected fields read `null` without their scope; filtering by them is refused (`contact_scope_required`).

### What the stable tier covers

| Area | Operations |
| --- | --- |
| Orders | `orders.create`, `get`, `list`, `set_status`, `mark_delivered`, `mark_pickup_ready`; `order_timeline.list` |
| Payments | `payments.create`, `list`, `charge`, `capture`, `void`; `payment_methods.list`, `delete` |
| Refunds and returns | `refunds.create`, `list`; `returns.get`, `list` |
| Fulfilment | `fulfillments.create`, `list`, `void`; `shipments.create`, `get`, `list` |
| Products | `products.create`, `batch_create`, `get`, `list`, `update`, `trash`, `restore`, `set_publications`, `bulk_set_status`, `bulk_publish`; `variants.get`, `lookup`, `retire`, `bulk_set_prices`, `bulk_set_stock` |
| Inventory | `inventory.adjust`, `set_stock`; `inventory_locations.list` |
| Catalogue | `categories.*`, `brands.*`, `collections.*` (including `batch_create` for categories and brands, `collections.update_products`) |
| Customers | `customers.create`, `get`, `list`, `update`, `set_tags`, `bulk_tag` |
| Discounts and prices | `discounts.create`, `get`, `update`, `activate`, `pause`, `archive`; `price_lists.*` |
| Gift cards | `gift_cards.create`, `get`, `list`, `update`, `adjust` |
| Content and media | `pages.create`, `get`, `update`; `media.get`, `list`, `update`, `trash`, `import_url` |
| Objects and custom fields | `object_types.*`, `objects.get`, `list`, `upsert`, `delete`; `custom_field_definitions.get`, `list`; `custom_fields.get_<owner>_values`, `set_<owner>_values` |
| Store building | `theme.get`, `apply_template`, `set_section_settings`; `menus.get`, `create`, `update`; `app_content.delete` |
| Other | `webhook_subscriptions.*`, `bulk_runs.get`, `list`, `sales_channels.list_products`, `languages.list`, `delivery_locations.import` |

`custom_fields.*` operations show an app only the merchant's `custom` namespace; your own fields go through `ctx.customFields`. The order timeline is written only with `ctx.timeline.add`.

**Apps place orders.** `orders.create` places a confirmed order for a `customerId` with channel `app`, filed under that customer's account; the app needs no contact scope. `paymentMethod` is `cod` (default) or `net_terms` (see [Deferred payment](#4-deferred-payment)).

**Apps sync products.** `products.create` makes a product with options and SKUs, with minor-unit prices and stock 0. Quantities move through `variants.bulk_set_stock` or `inventory.*` under `write_inventory`. `products.update` patches under `expectedRevision`.

**Gift cards** (`read_gift_cards`, Sensitive `write_gift_cards`) issue, adjust and update under `expectedVersion`. The code never reaches the app; the store delivers it to the owning customer. What one app issues and tops up a day stays within the merchant's limit (403 `app_gift_card_limit`).

**Bulk runs.** `variants.bulk_set_prices`, `variants.bulk_set_stock`, `customers.bulk_tag`, `products.bulk_set_status` and `products.bulk_publish` take up to 5,000 items and support a dry run. 250 items finish inline; a larger run answers 202 and drains in the background (`bulk_runs.get`).

### Testing against the contract

`createContractApi({ handlers })` answers `ctx.api.call` in tests from the stable operations sealed with your SDK release. It refuses what production refuses: an unknown operation, an ungranted scope, a missing or unsupported `idempotencyKey`, an undeclared body field, and any value or response the schema rejects. A repeat with the same key replays the first answer.

## 4. Deferred payment

An order can be placed unpaid and paid later (net terms).

- A deferred order commits `pending` and `unpaid`, with stock reserved as for cash on delivery, and a due date: placement plus `days` (1 to 365).
- The built-in method is `net_terms`. The merchant decides who may use it (customer tags, segments, or an app's `checkout.payment_methods` `allow` while the method is `gated`). Guests are never offered it.
- `orders.create` with `paymentMethod: "net_terms"` and `paymentTerms: { kind: "net", days }` places an invoice order (omit `paymentTerms` for the store's default days).
- An app's own deferred method is a payment provider with `flow: "deferred"` and `dueInDays` (1 to 365). It is offered only to signed-in buyers, and only when your own `checkout.payment_methods` answers `allow` for that buyer; a manifest with a deferred provider and no such function is refused. If your function fails, the method stays hidden.
- Money received is recorded with `payments.create` (`write_payments`; `amountMinor`, `via`: `bank_transfer`, `cash`, `cheque`, `card_terminal`, `mobile_wallet` or `other`; optional `reference`; Idempotency-Key required). It emits `payment.updated`, and `order.paid` once paid in full. An order an app marks paid keeps its gift cards and downloads on a staff review hold.
- An order is overdue once its due date passes with money still due: `orders.list` with `overdue=true`.
- A provider payment is accepted on an unpaid `net_terms` order and switches it to that provider.

## 5. Line facts and refunds

Reactions that move units (splitting stock or payouts per seller) need to know which order lines an event covers.

- `order.fulfilled`, `fulfillment.created`, `fulfillment.voided`, `refund.created` and `refund.updated` carry `lines: [{ orderItemId, variantId, quantity }]` (at most 500, sorted by order line). Quantities only; read prices from the representation.
- A refund is a record. Its status is `pending`, then `refunded`, `failed` or `partial`.
- `refunds.create` (Sensitive `write_refunds`) takes `amountMinor` and optional `lines: [{ orderItemId, quantity }]`; each line's quantity is at most what earlier refunds that did not fail left. An amount-only refund has no lines. Money goes back through the payments it came from or as store credit, never to a destination the app names.
- `order.refunded` still fires per completed refund payment, including refunds made at a provider outside Scalius, which have no refund record.

## 6. Payment port optional parts, purchase options, discount classes

### Saved methods and authorizations

A payment provider may declare two optional capabilities, each with its operations:

- `vault`: `chargeSavedMethod` and `deleteSavedMethod`.
- `manualCapture`: `capture` and `void`.

How they work:

- A session for a signed-in customer may carry `savePaymentMethod: { customerId, usage: "off_session" }`. The provider's confirmed or `authorized` event then names `savedPaymentMethod: { ref, brand?, last4?, expiryMonth?, expiryYear?, label? }`: an opaque reference plus display facts, never card data. The store keeps it for that customer. Checkout asks to save only for a signed-in buyer whose order has a purchase-option line and a vaulting gateway.
- An `authorized` payment holds money without counting as paid. A held order cannot be cancelled or switched until it is captured or voided.
- `payments.charge` charges a saved method without the buyer (`capture: "manual"` only authorizes); `payments.capture` and `payments.void` settle an authorization; `payment_methods.list` and `payment_methods.delete` manage saved methods. All need the Sensitive `write_payment_methods` and reach only the methods kept for your own purchase options. The mutations need an Idempotency-Key.
- Each command claims a payment attempt before any provider call, keyed from the caller's Idempotency-Key. An unanswered call stays uncertain; a repeat under the same key asks again instead of charging twice (`payment_outcome_unknown`).

Core runs no subscription logic. A renewal is your `orders.create` plus `payments.charge`.

### Purchase options

An app declares `checkout.purchaseOptions` (up to 10, `{ key, title, description? }`): ways to buy a line, such as a subscription or a rental.

- A cart line names one as `<app id>.<key>`. An option no active app declares is refused (`purchase_option_unavailable`).
- The option is part of the line's identity: the same SKU one-time and under an option are two lines. Functions see `line.purchaseOption`. The order line freezes it, and the order representation carries `purchaseOption`.
- Core prices nothing for it. Your `cart.line_prices` price wins over every list for that line; without your answer it keeps its one-time price. `checkout.discounts` and `cart.validate` handle the rest.
- The product page's buy form lists every active app's options. A Buyer UI button (`ui.cart.addLine`) and an island's `context.addLine` may add a line under one of your own options, never another app's.
- The app needs a checkout function or a payment provider; a manifest with neither is refused.

### Discount classes

An app discount's class follows its target: `lines` is a product discount, `order` an order discount, `shipping` a shipping discount. It may declare `combinesWith: { product?, order?, shipping? }` (each defaults to true). It applies only if it and every discount already applied, the store's own included, combine with each other's class. A skipped discount claims no code and commits nothing.

## 7. App writes for building a store

An app can stock and dress a store. It never publishes the shared theme.

- **Batch create.** `products.batch_create`, `categories.batch_create` and `brands.batch_create` take `{ items }`, each the single create's body plus your `key`, and answer `created`, `replayed` or `failed` per item. An item's id derives from its key, so a retry never creates twice. The bound is a plan value: Free 4 products, 12 categories or 19 brands a call; Paid 20, 50, 50.
- **Ownership.** Items an app creates are recorded as its own. `app_content.delete` permanently deletes only what the app created, from the trash.
- **Handles.** Collections have a unique handle (`slug`; omitted, it derives from the name). Templates, page presets and section settings may name content by handle: `@category:<handle>` and `@collection:<handle>` in id lists, `{ "kind": "collection", "handle": "…" }` as a product source, `/collections/@<handle>` as a link. Handles resolve when a template is applied or listed. A homepage section naming a missing handle is left out and reported.
- **Theme** (Sensitive `write_themes`). `theme.get`, `theme.apply_template` (your own template only; the replaced draft is kept as a restore point) and `theme.set_section_settings` (a merge into one section, revalidated) change the shared draft under `expectedRevision` (the draft's revision) and `basePublishedRevision`. Staff publish.
- **Menus** (Sensitive `write_navigation`). `menus.get`, `menus.create` and `menus.update` write a menu and all its links (a flat list in tree order, three levels, 150 links) under `expectedRevision`, and publish it with `publish: true`. A refused publish keeps the links and says why. Where a menu shows stays the merchant's choice.
- **Customer roles** and **jobs** let an app gate prices or portals on roles and run long imports. See [Apps](apps.md#customer-roles).
- **Safe publishing.** Publishing a draft that draws with parts of an inactive app, or parts an app no longer declares, is refused (`theme_apps_unavailable`, naming each app, why and its parts). Deactivating or uninstalling an app lists the live parts that would fall back to the store's design.

## 8. The contract seal

The plugin API is the one part of Scalius that keeps backward compatibility. These parts are sealed by snapshot tests:

- the manifest JSON Schema;
- the SDK's declarations;
- the storefront protocol (component ABI, slots, data shapes, limits);
- the event catalogue and webhook representations;
- function and Buyer UI schemas;
- stable provider port schemas, port tiers and scopes;
- the stable app operations, their names and schemas;
- the error codes (`APP_ERROR_CODES`).

**What may change within a version.** Only additions: a new optional manifest field, a new `ctx` method, a new event, a new function point, a new provider operation, a new stable operation, a new optional input or new output field, a new error code, a new optional field on a storefront data shape. A port may move from beta to stable.

**What may not change.** Removing, renaming or retyping a field; making an output field nullable; removing a field's contact-data protection; changing an error code's meaning or status; moving a stable port back to beta; changing a stable operation's name.

**What is not sealed.** Beta operations and beta ports may change in any release. Internal operations are private.

A breaking change needs a new `apiVersion`. The platform then runs the old and the new side by side for at least 12 months.

What this means for you:

- Tolerate fields you do not know, in webhook bodies, representations and function inputs.
- Branch on error `code`, never on `message`.
- Pin your manifest's `apiVersion` and test with `createContractApi`, which checks calls against the operations sealed with your SDK release.
