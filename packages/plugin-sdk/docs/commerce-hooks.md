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
- Function inputs and event facts carry no contact data, with one exception: `cart.validate`'s `contact` (below), whose fields are projected from your grant like an operation's output.

### Event payloads

- An event's `facts` carry ids, states and quantities. Never contact data, credentials or money.
- A webhook delivery adds `data`: the resource's sealed representation (`EVENT_REPRESENTATION_SCHEMAS` in `@scalius/shared/events`) for one of 19 resource types: order, return, product, variant, customer, purchase order, inventory transfer, fulfillment, refund, shipment, payment, checkout, discount, review, gift card, gift card transaction, object, conversation and payout.
- A representation has ids, states, ISO 8601 times, money as integer minor units beside its currency, lines by id and quantity (at most 500 listed) and discount codes as a count.
- Representations only grow within `EVENTS_API_VERSION` (`2026-10`): a field may be added, never removed, retyped, made nullable or stripped of its protection. Published schemas never close an object, so tolerate fields you do not know.
- App event handlers get facts only. Read the resource with `ctx.api` (`orders.get` returns the same representation).

### Provider ports

Fifteen ports are typed and validated on both sides. Each has a tier (`PROVIDER_PORT_TIERS`):

| Tier | Ports | Meaning |
| --- | --- | --- |
| `stable` | `payment`, `courier`, `sms`, `courier_history` | Real providers implement them. Sealed; changes are additive only. |
| `beta` | `email`, `tax`, `messaging`, `push`, `translation`, `ai`, `search`, `address`, `fx`, `identity`, `payout` | Any app may implement them. The consent screen labels them Beta. Their schemas may still change. |

A port is promoted by changing its tier, never demoted.

- A provider runs only when it is ready: the app is active and approved for the port, its own settings are complete and readable, and no value is an obvious placeholder ("test", "your api key"). One provider's broken settings never stop its siblings.
- A provider may reach its service through `ctx.http` on approved hosts. `ctx.messaging` is refused inside a provider operation.
- Fail with `ProviderError(category, message, { uncertain?, code? })`: `declined` (nothing happened; not retried), `retryable` (add `uncertain: true` if the call may have reached the provider; the platform reconciles and never repeats an uncertain call blindly) or `misconfigured` (the provider is not ready; the platform fails closed). A throw that is not a `ProviderError`, a timeout or an invalid answer counts as retryable and uncertain. A message is at most 300 characters and safe for a merchant.
- A `messaging` provider that declares `verifyWebhook` brings its chat channels into the store's inbox. The channel pushes to `/api/v1/webhooks/messaging/{app id}:{provider id}` (GET for the subscription check, answered with your `reply`; POST for pushes). Authenticate the push, then answer its buyer messages (`messageId` is the channel's own id: each is filed once per provider and id, in the thread of its channel and contact; attachments are references, `ref` or an https `url`) and delivery receipts (`providerRef` is what `send` answered; statuses only move forward). A message on a channel you do not declare is ignored. Staff and app replies in a chat thread go out through `send` once, as text, keyed by the message id; declare `dedupesOnIdempotencyKey` if a lost answer may be sent again.
- A `payout` provider moves money to a payee (`createPayout`, `payoutStatus`, optional `verifyWebhook` at `/api/v1/webhooks/payouts/{app id}:{provider id}`). The platform commits the payout `pending` before it calls you, with the same `payoutId` on every retry: apply a payout once per `payoutId`. A lost answer: raise `ProviderError("retryable", …, { uncertain: true })`; the payout stays pending and the next `payouts.create` with the same key asks `payoutStatus` first. Statuses move forward only: `processing`, then `paid` or `failed` (with `failureCode`).
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
| `cart.validate` | `contact` | `{ errors: [{ code, message, lineId? }], commit?: [{ as, record }] }` (20 errors) |
| `checkout.discounts` | | `{ discounts: [{ title, code?, target, value, maxAmountMinor?, combinesWith? }], commit?: [{ as, record }] }` (10 discounts) |
| `checkout.shipping_rates` | `rates: [{ rateId, name, amountMinor, kind }]` | `{ operations: [hide \| rename \| price \| reorder] }` |
| `checkout.payment_methods` | `methods: [{ methodId, name, gated? }]` | `{ operations: [hide \| allow \| rename \| reorder] }` |

- **`cart.transform`.** A bundle's components become real order lines (stock, tax and refunds per SKU); the buyer sees one line at the summed price. Lines with buyer inputs, gift cards and carts above 99 lines are never changed.
- **`cart.line_prices`.** `prices` set a line's unit price. The one price precedence is: purchase-option price (only the app that declares the option) > override; otherwise a sale only lowers segment > market list > app price > FX > base. A one-time line takes an app price under a sale or when no price list prices it, and the first app in the checkout order wins. `adjustments` are add-ons (below).
- **`cart.validate`.** Any error blocks checkout and is shown to the buyer (on its line with `lineId`). `commit` holds capacity with the order (Commits, below). `contact` is the buyer's contact as the order keeps it: `{ name, email, phone, address: { line1, line2, dependentLocality } }`, each field `null` unless your grant holds its scope (`read_customer_names`, `read_customer_emails`, `read_customer_phones`, `read_customer_addresses`; the region is `cart.destination`). `contact` itself is `null` on quotes and cart checks (no contact yet) and on staff orders, so a fraud check decides at placement and blocks with an error before the order exists.
- **`checkout.discounts`.** A discount targets `{ kind: "order" }`, `{ kind: "lines", lineIds }` or `{ kind: "shipping" }`, worth `{ type: "percentage", percent }` or `{ type: "fixed_amount", amountMinor }`. Size it against `cart.lines[].lineTotalMinor`.
- **`checkout.payment_methods`.** Hide, rename and reorder the methods checkout allows. A method marked `gated: true` is offered to this buyer only if an app answers `{ op: "allow", methodId }` (for an app's own deferred method, only that app). A hide wins over an allow. An order paid as it is placed (staff mark it paid, a point-of-sale sale; payment method `manual`) does not run it: the money is already in.

### The cart

Every point gets `cart` (`FunctionCart`):

- Money: `currency`, `decimalPlaces`, `subtotalMinor`, and per line `unitPriceMinor` and `lineTotalMinor` (after the platform's own discounts, before app discounts), all integer minor units of `currency`, the currency the buyer pays in. `storeCurrency: { code, decimalPlaces }` is the store's own currency, the one your settings' amounts are in; it is `currency` unless the market sells in another.
- Who and where: `channel` (`online_store`, `admin`, `pos`, `agent`, `app`), `salesChannelId`, `market: { id, country }` (country is null before an address is known), `destination: { country, city, zone }` (region only), `discountCodes`.
- `customer` (null for guests): `id`, `tags` (at most 50), `segmentIds` (the segments of the market's live segment price lists that price this buyer, at most 50), `orderCount`, `totalSpentMinor`, and `roles`: the roles **your** app gave this customer.
- `lines` (at most 250): `lineId`, `productId`, `variantId`, `sku`, `title`, `quantity`, `categoryIds`, `collectionIds`, `brandId`, `properties` (buyer inputs: the product's own and **your** line inputs under `<app id>.<key>`, never another app's, each exactly as the order line freezes it, up to 1,000 characters), `requiresShipping`, `weightGrams` (null when unset) and `purchaseOptions` (the line's options, `<app id>.<key>`, at most one per app, sorted; empty for a one-time purchase).
- `attributes`: **only your own app's** accepted checkout attributes, keyed `<app id>.<key>`. A function never sees another app's buyer answers. Reading another app's answers is not offered; if it ever is, it will be a declared read the merchant consents to.

Core cart facts (lines, customer, market, destination, codes, channel) are the same for every app.

### The buyer's language

Every point's input carries `language`, the buyer's language as a BCP 47 tag (`bn`): the language of the storefront presence the order is placed on (`/bn/`), or the page language the quote or cart comes from, else the store's default, as the buyer's emails speak it. A staff, agent or direct API order runs in the store's default. Answer everything the buyer reads in it (an add-on's `title`, an error's `message`, a rate's or method's name) with `textFor` from `@scalius/plugin-sdk`:

```ts
import { textFor } from "@scalius/plugin-sdk";

const COPY = { en: { unavailable: "This item can't be gift-wrapped." }, bn: { unavailable: "এই পণ্যটি গিফট র‍্যাপ করা যায় না।" } };

"cart.validate": ({ cart, language }) => ({
  errors: cart.lines.filter(cannotWrap).map((line) => ({ code: "no_wrap", message: textFor(language, COPY).unavailable, lineId: line.lineId })),
}),
```

`textFor(language, texts)` picks the exact tag, then its language (`pt-BR` → `pt`), then `en`. Your manifest's own buyer words (attributes, line inputs, purchase options) are translated in `translations` ([Apps](apps.md#translations)); a storefront extension's input already names its page's `language` and formatting `locale`.

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
- A composite key `{ join: ["attribute.day", "attribute.window"] }` (2 to 4 of your attributes) names the record whose id joins their answers with `:`.
- A list read `{ as, object, list: { where?, orderBy?, direction?, from?: "now", limit } }` answers up to 50 of your records through one declared index (`readList`), from the run's clock with `from: "now"` (an `integer` epoch-ms or `date_time` order field). Every input carries `now`, the minute the run started.
- An extension may offer computed choices on a `text` attribute: `ui.field("day", { choices })` (at most 50). The store draws a select; the answer is still text your `cart.validate` checks.
- Objects are your declared types. A custom-field read names up to 10 of your own fields of one owner type (`product`, `variant` or `customer`) and is keyed by that owner.
- `input.reads[as]` is `{ revision, data } | null` for a single key, or `Record<key, { revision, data }>` (existing records only) per line. `readOne(reads, as)` and `readMany(reads, as)` read them typed. Custom-field records have revision 0. Data is in the same wire form `ctx.objects` reads (money as `{ amountMinor, currency }`). Weak references are not resolved.
- Bounds: a function declares at most four reads. Each read asks for at most 100 keys (a per-line read counts its distinct SKUs or products, at most its `max`), checked before anything is read, so four reads of a 99-line cart all run. The resolved JSON of the function's reads may total 256 KiB, measured after the records are read and decoded. Over a bound, the function does not run and `onError` applies.
- Cost: reads ride the read batch checkout already sends. They add statements, never a round trip. A store whose apps declare no reads pays nothing.

### Commits

A `checkout.discounts` or `cart.validate` answer may carry `commit: [{ as, record }]` (up to four) for single-key object reads whose key resolved to an id. Each is the next version of a record you read. The platform writes it in the order's own commit batch, guarded at the revision you saw (or "must not exist"). If the record changed meanwhile, the order fails with `app_offer_changed` and the buyer reviews it. So a spent balance is never spent twice and a last place is never sold twice.

- A discount's commit is written only when one of your discounts applied.
- A `cart.validate` commit is a hold: it is written with every order placed (an order is placed only when no rule error remains) and never on a quote, a cart check or an order that fails. Use it for capacity: a delivery slot the buyer picked (`key: "attribute.slot"`), a seat, a per-buyer limit (`key: "customer"`). Refuse a full slot with an error; answer one more place taken with `commit`. Release a place yourself (an `order.cancelled` handler).
- A commit the platform cannot take (an undeclared, per-line or empty read, an invalid record) is a failed answer: your `onError` applies. A hold that must never be skipped registers `onError: "block"`.
- Committing one record from both your hold and your discount is refused (`checkout_app_unavailable`).

```ts
"cart.validate": ({ cart, reads }) => {
  const slot = readOne<{ capacity: number; taken: number }>(reads, "slot");
  if (!slot) return { errors: [{ code: "slot_unknown", message: "Choose a delivery slot." }] };
  if (slot.data.taken >= slot.data.capacity) return { errors: [{ code: "slot_full", message: "That slot is full." }] };
  return { errors: [], commit: [{ as: "slot", record: { ...slot.data, taken: slot.data.taken + 1 } }] };
},
```

### How apps combine at a point

Several apps at one point run and merge in one order: the merchant's (Apps → Checkout order), else your manifest `priority` (lower first), then app id. An app the merchant has not placed (installed after they ordered the point) runs after the ones they placed. Answers merge in this order whatever order they arrive in. The rule per point (`PLUGIN_FUNCTION_COMPOSITION`):

| Point | Rule | Meaning |
| --- | --- | --- |
| `cart.transform` | `first` | A line is in the first operation that names it; a later one is skipped and logged. |
| `cart.line_prices` | `first` | The first app that prices a one-time line wins it; both apps' logs say which price was used. Add-ons from every app apply. |
| `cart.validate` | `all` | Every app's errors block; every app's holds commit. |
| `checkout.discounts` | `stack` | Each discount from what the ones before left; one that does not combine with one already applied is skipped. |
| `checkout.shipping_rates`, `checkout.payment_methods` | `sequence` | Operations in order, a later rename, price or reorder over an earlier; a hide always wins. |

The dashboard shows the merchant, per point, which apps run, in what order, and which app wins where the first wins. Do not rely on running first: the merchant decides.

### Line add-ons

`cart.line_prices` may answer `adjustments`: add-ons to each unit (an engraving, gift wrap, a protection plan). Each is one of:

- `{ lineId, amountMinor, title }`: a fixed amount in the cart's currency, or with `currency: "store"` in the store's (`cart.storeCurrency`). Core converts a store amount with the catalogue's own conversion at the checkout's one locked rate, the market's price adjustment included, then rounds it half-up to the market's increment. It takes neither the market's rounding step nor its ending: those make the item's price point, and an add-on ending again would stack a second charm price and can double a small fee (in a USD market at 0.0082, +10%, ending .99, a ৳50 wrap is $0.45, not $0.99). In the store's own currency it still takes the adjustment and rounds to the increment (৳50.50 at whole taka is ৳51). A fee from your settings is a store amount: answer it with `currency: "store"` and it is right in every market. An amount in the cart's currency is final: it is not adjusted, since you may have computed it from cart prices that already carry the market's adjustment. Answer a free extra as `amountMinor: 0`: the order line records it ("Add-on: Gift wrap", no price), so you deliver from what checkout sold, never from today's settings.
- `{ lineId, percent, title }`: a share (at most two decimals, up to 1,000) of the item's unit price as checkout charges it: after every list, sale and app price (a subscription's), with the buyer-input surcharges, before add-ons and discounts. It is right in every market and on any app's price.

Rules:

- They apply after the whole price precedence, so sale, segment, app and price-listed lines take them too.
- Every app's add-ons apply, in priority order, at most five per line. Each rounds half-up to the market's price increment; a positive one never rounds to nothing (it takes one increment).
- A gift card takes none: the answer is skipped and logged. A bundle line (the `bundle` of the function's `lines` input) or a sixth add-on refuses checkout (`add_on_unavailable`): checkout never freezes an extra the buyer chose without its price. Answer a bundle line's paid extra anyway, so checkout asks the buyer to remove it; never skip it, which freezes the extra unpaid.
- They are part of `unitPriceMinor`: quote, tax, discounts, totals and refunds include them. The buyer sees "Add-on: <title> (+price)" in the cart, checkout, receipt and emails, and the order line keeps it as `adjustments: [{ appId, title, amountMinor }]`.
- `prices` take `currency: "store"` too, and convert exactly as a product price does, rounding step and ending included (৳1,200 is $10.99 in that market, from your app as from the catalogue). When two apps price one one-time line, the first in the checkout order wins and both apps' logs say which price was used.

### Failure policy and limits

- A function that throws, times out, answers invalidly (`function_invalid_output`) or exceeds its read bounds is left out: `onError: "skip"` (the default).
- Only `cart.transform`, `cart.line_prices`, `cart.validate` and `checkout.payment_methods` may declare `onError: "block"`. Checkout then stops with the store's buyer-safe text. The merchant approves it as access of its own ("can pause checkout"): an update that adds `onError: "block"` to a function pauses the app until the store owner approves it.
- Wall budget: the smaller of `limits.wallMs` and 1.5 s. CPU: the smaller of your manifest `limits.cpuMs` and the plan ceiling (50 ms on the default, up to 200 ms on Paid), with a fixed 50 ms cap for `buyer.ui`.
- `priority` (0 to 1000, default 100): lower runs first among apps at the same point, until the merchant orders the point.
- Sandboxed (Paid) apps run at once, up to four per checkout, so each added app does not add its wall time. A run that never returns (it held the thread) leaves its in-flight mark: run alone, the next checkout stops the app; run beside other apps, each of them runs alone once more, and only the one that hangs again is stopped.

### Testing

`harness.fn(point, input)` is typed by point, parses the input with the point's schema (a mismatch throws) and checks the answer exactly as the host does. Every run hears `language: "en"` unless the harness was made with `createPluginTestHarness(app, { language: "bn" })` or the input names its own. An invalid answer returns `ok: false` with `function_invalid_output`. `fixtures.checkoutDiscountsInput`, `fixtures.cart` and `fixtures.cartLine` build valid inputs. Pass `reads` as the host would resolve them.

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
- **Revision preconditions.** A write that is not a create takes the revision it was based on (`expectedRevision`, or `expectedStockVersion` for a SKU's stock). A stale value is 409 and changes nothing. A few writes take none yet; adding one later is additive.
- **Contact data.** Protected fields read `null` without their scope; filtering by them is refused (`contact_scope_required`).
- **Named refusals.** A refusal names what happened, so an app can tell a stale read from a lost race from a mistake:
  - a stale revision: `order_revision_conflict`, `return_revision_conflict`, `segment_revision_conflict`, `supplier_revision_conflict`, `purchase_order_revision_conflict`, `inventory_transfer_revision_conflict` (read again, then retry with the new revision);
  - a document past that step: `purchase_order_state_conflict`, `inventory_transfer_state_conflict`; more than is still open: `quantity_exceeds_open`; stock already promised: `stock_committed`; a retired SKU: `variant_retired`; a supplier with open purchase orders: `supplier_has_open_purchase_orders`;
  - another command on the same order still running: `return_command_in_progress` (retry with the same key); a segment name in use: `segment_name_taken`;
  - costs without their scope: `cost_scope_required` (purchase orders, and a webhook subscription to their topics, need `read_product_costs`).
- **Checkout refusals.** What your functions answer can refuse a buyer's checkout, with the store's words for the buyer and these reasons for you: `properties_invalid` (an answer your line input refuses, or a key no active app declares), `purchase_option_unavailable` (an option no active app offers, or two of one app on a line), `checkout_app_unavailable` (an option's owning app did not answer its line), `purchase_options_conflict` (two owners priced one line) and `add_on_unavailable` (an add-on the line cannot take).

### What the stable tier covers

[The stable app API reference](operations.md) lists every stable operation by area, each with its method and path, the scopes that cover it, its idempotency and revision rules, its parameters, body and response, and the resources it answers. It is generated from the contract this SDK release is sealed with (`stableContract.operations` in `@scalius/plugin-sdk/testing`, the same contract `createContractApi` checks your calls against), so it never lists an operation the platform lacks or misses one it has. [The event reference](events.md) does the same for every event topic and its facts.

`custom_fields.*` operations show an app only the merchant's `custom` namespace; your own fields go through `ctx.customFields`. The order timeline is written only with `ctx.timeline.add`.

**Apps place orders.** `orders.create` places a confirmed order for a `customerId` with channel `app`, filed under that customer's account; the app needs no contact scope. `paymentMethod` is `cod` (default) or `net_terms` (see [Deferred payment](#4-deferred-payment)).

**Point of sale.** Declare your own sales channel in the manifest (`salesChannels: [{ id: "counter", name: "Shop counter" }]`, channel id `<app id>:counter`); it sells from every active location until the merchant unlinks one. `orders.create` with `salesChannelId` set to that channel, `shippingMinor: 0` and `pointOfSale: { locationId, staffMemberId?, tenders: [{ via, amountMinor, reference? }] }` rings up an in-person sale (channel `pos`): `via` is `cash`, `card_terminal`, `mobile_wallet` or `other` (a card your terminal charged names its transaction in `reference`). The tenders cover the total and only cash gives change. The order is paid (each tender less the change is a payment of its `via`), handed over at that location's counter and delivered, and its stock leaves that location. It answers `{ order }` whose `pointOfSale` is the receipt: the location, the cashier, each tender, `tenderedMinor` and `changeMinor`. Refusals write nothing: `pos_tender_short`, `pos_change_without_cash`, `pos_staff_unknown`, `pos_location_unavailable`, `pos_location_not_on_channel`, `inventory_location_shortfall` (the location lacks the units, whatever the store holds elsewhere) and 403 `pos_sales_channel_not_owned`. Send the till's own sale id as the Idempotency-Key: a retry returns the same order and repeats nothing. A walk-in buyer still needs a contact with a phone, or a `customerId` (a store "Walk-in" customer). Before taking money, `orders.quote` prices the same body (tenders optional) through the same path and writes nothing: `{ quote }` with the lines, discounts, tax, `totalMinor` and `pointOfSale: { tenderedMinor, changeMinor, dueMinor }`, refusing what the sale would refuse. Send the quoted total as `expectedTotalMinor` on the sale: a total that moved since is 409 `manual_order_total_changed`. `inventory_locations.list` with `salesChannelId` lists the counters your channel sells from. The [`pos` example](../examples/pos) is a complete till, quote included, with its tests.

**Staff.** `staff.list` and `staff.get` (`read_staff`) read the directory to attribute work: each member's id, name, roles, whether they are the owner and whether they are active. Removed staff stay listed as inactive, so past sales keep a name. Nothing to sign in with ever appears: no email, phone, session or permissions.

**Affiliates and referrals.** `orders.list?discountCode=REF-NADIA` lists the orders that redeemed a code at checkout, matched without regard to case or surrounding spaces, read from the code's indexes and paged like any order list. Read `discountApplications` on each order to confirm the code before paying commission.

**Reviews.** `reviews.list` (by product, status or customer; `updatedSince`), `reviews.get`, `reviews.create` and `reviews.set_status`: `read_reviews` reads, `write_reviews` imports and moderates; the reviewer's name needs `read_customer_names`. `reviews.create` requires an Idempotency-Key and takes the review's id from it, so re-running an import writes nothing twice. A review is a verified purchase only when it names a delivered order line (`orderItemId`) of its customer: `verified: true` without one is refused with `review_not_verifiable`, a line not yet delivered with `review_not_eligible`. Imported history names no line, shows without "Verified purchase", keeps its `createdAt`, and never blocks the buyer's own review. `status: "published"` holds only if the store's content check passes; otherwise the review waits as `pending`. `reviews.set_status` publishes, or rejects with a content reason, at `expectedRevision` (`review_revision_conflict` when stale). Truncated `review.*` webhooks point at `reviews.get`. Because the review's id derives from the key, running an import again after the 24-hour replay window still finds each review and writes nothing: keep each source review's own id as its key. A review's title is at most 120 characters, its body 5,000 and its display name 60 (characters, as the contract's `maxLength` counts them). The [`reviews` example](../examples/reviews) imports and moderates.

**Digital goods.** `digital_assets.list`/`get` (`read_products`) return files and licence-key pools with limits, sizes and key counts, never a link or a key. `digital_access.list` (`read_orders`) lists an order's or a customer's access with a sealed `status`. `digital_access.grant` (`write_digital_access`, Idempotency-Key required) gives a paid line's buyer an item the line's product delivers: an owed line is delivered exactly as the store would, revoked access comes back, and a repeat grants nothing twice. `digital_access.revoke` (`write_digital_access`) stops downloads and key reveals at once; assigned keys are never reissued. Revoking has no undo, so the consent screen shows `write_digital_access` as destructive; `write_orders` reaches neither. Refusals are named codes such as `digital_access_order_unpaid` and `digital_keys_exhausted`.

**Store settings and sales.** `read_settings` reads `markets.list`/`get`, `shipping_zones.list`/`get` and `tax_regions.list`/`get`: amounts in integer minor units beside a `currency`, rates in basis points. Local pickup is the zone `pickup`. A destination takes its most specific zone or region; none matching means no delivery and no tax. `read_analytics` reads `analytics.get_summary({ from, to, granularity? })` over at most 366 store-calendar days with day, week or month buckets: orders, gross sales, discounts, refunds, net sales, shipping, taxes, units and average order value. It carries no sessions or visitors: the store does not record them.

**Apps sync products.** `products.create` makes a product with options and SKUs, with minor-unit prices and stock 0. Quantities move through `variants.bulk_set_stock` or `inventory.*` under `write_inventory`. `products.update` patches under `expectedRevision`.

**Gift cards** (`read_gift_cards`, Sensitive `write_gift_cards`) issue, adjust and update under `expectedRevision`. Each answers `{ giftCard, transactions }`: the card as a `gift_card` webhook carries it and its newest 200 ledger entries, each as a `gift_card_transaction` webhook carries it; `gift_cards.list` lists the same cards. The code never reaches the app; the store delivers it to the owning customer. What one app issues and tops up a day stays within the merchant's limit (403 `app_gift_card_limit`).

**The inbox** (Sensitive `read_conversations`, `write_conversations`). Threads are order, store and chat-channel threads (`channel`: whatsapp, messenger, …), synced by `updatedAt`. `conversations.create_message` posts a public reply (the thread then waits on the buyer) or an internal note; the line names your app. A public reply in a chat thread is refused (422 `conversation_channel_unavailable`) while its messaging app is not ready. Handle `conversation.message_received` (facts: `conversationId`, `messageId`, `seq`, `channel`) to react to buyers.

**Payouts** (Sensitive `write_payouts`). `payouts.create` takes `providerId`, `payeeRef` (your seller id), `payeeAccountRef`, `amountMinor`, `currency` and a required Idempotency-Key: one key sends one payout. It answers 201 with the payout (`processing`, `paid`, or `failed` with `failureCode`); 503 `payout_outcome_unknown` (`details.payoutId`) means the provider's answer was lost: repeat the same request with the same key and it is resubmitted, never sent twice. The key with another request is refused (422 `idempotency_key_reused` within the key's 24 hours, 409 `payout_request_mismatch` after); a provider that is not ready is 422 `payout_provider_unavailable` with nothing recorded. `payout.created` and `payout.updated` reach only your app.

**Bulk runs.** `variants.bulk_set_prices`, `variants.bulk_set_stock`, `customers.bulk_tag`, `products.bulk_set_status` and `products.bulk_publish` take up to 5,000 items and support a dry run. 250 items finish inline; a larger run answers 202 and drains in the background (`bulk_runs.get`).

### Testing against the contract

`createContractApi({ handlers })` answers `ctx.api.call` in tests from the stable operations sealed with your SDK release. It refuses what production refuses: an unknown operation, an ungranted scope, a missing or unsupported `idempotencyKey`, an undeclared body field, and a value or response that breaks the operation's schema. The checker covers a JSON Schema subset (types, enums, lengths, patterns, required fields) and ignores `format` and other keywords it does not know, so it is weaker than the production routes: a malformed date-time that production rejects can pass here. Test production refinements and format checks against a host. A repeat with the same key replays the first answer. Build a handler's answer with `sample("order", { id: "ord_1", lines: [{ quantity: 2 }] })`: every field you leave out comes from the same contract, so a field the platform adds never breaks your test.

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
- A confirmed or `authorized` event may carry `review: { reason }` when the provider flagged the payment (its fraud or risk screen). A confirmed payment still counts as paid; an `authorized` one records held funds and credits nothing until it is captured. Either way the store holds the order for staff review in the same write, so nothing ships or is handed over until staff release the hold.
- An `authorized` payment holds money without counting as paid. A held order cannot be cancelled or switched until it is captured or voided.
- `payments.charge` charges a saved method without the buyer (`capture: "manual"` only authorizes); `payments.capture` and `payments.void` settle an authorization; `payment_methods.list` and `payment_methods.delete` manage saved methods. All need the Sensitive `write_payment_methods` and reach only the methods kept for your own purchase options. The mutations need an Idempotency-Key.
- Each command claims a payment attempt before any provider call, keyed from the caller's Idempotency-Key. An unanswered call stays uncertain; a repeat under the same key asks again instead of charging twice (`payment_outcome_unknown`).

Core runs no subscription logic. A renewal is your `orders.create` plus `payments.charge`.

### Purchase options

An app declares `checkout.purchaseOptions` (up to 10, `{ key, title, description? }`): ways to buy a line, such as a subscription or a rental.

- A cart line names its options in `purchaseOptions` as `<app id>.<key>`, at most one of each app: your subscription and another app's protection plan can share a line. An option no active app declares, or two of one app, is refused (`purchase_option_unavailable`).
- The options are part of the line's identity: the same SKU one-time and under an option are two lines. Functions see `line.purchaseOptions` (test with `includes`). The order line freezes each, and the order representation carries `purchaseOptions`.
- Core prices nothing for it. Answer every line carrying your option in `cart.line_prices`: a price (it wins over every list) or an add-on. Without your answer checkout is refused; if another app whose option the line carries prices it too, checkout refuses (`purchase_options_conflict`), so an option that adds to the price answers with an add-on. An add-on the line cannot take (a bundle line, a gift card, a line already holding five add-ons) refuses it as `purchase_option_unavailable`. `checkout.discounts` and `cart.validate` handle the rest.
- A method kept for a renewal belongs to the one app owning every option of its order. An add-on that bills nothing later (a protection plan paid once) is a line input, not a purchase option.
- The product page's buy form lists every active app's options. A Buyer UI button (`ui.cart.addLine`) and an island's `context.addLine` may add a line under one of your own options, never another app's.
- The app needs a checkout function, a storefront extension or a payment provider (checkout reads the option through one); a manifest with none is refused.

### Line inputs

An app declares `checkout.lineInputs` (up to 10): inputs the buyer fills per line, such as a gift message, a device serial for a protection plan or a delivery date for a booking.

- Each is `{ key, label, help?, type, maxLength?, options?, products? }`, with the product's own input types: `text` (up to 200 characters), `textarea` (up to 1,000), `select` (`options: [{ value, label }]`, up to 20) or `checkbox` (sends `"true"`), or `file` (the buyer uploads files: see below).
- The buy form draws them after the product's own inputs, under `<app id>.<key>`; the cart edits them; they are part of the line, and the order line freezes them with your app's id.
- `products: { customField }` shows an input only on products whose flag is true: one of your own `customFields`, a `product` `boolean` with `storefrontVisible: true`. Checkout does not read the flag.
- An app input is never required: a card's quick add, an island or an order form adds a line without the product page, so ask for a missing one in `cart.validate` with an error on the line.
- Core prices nothing for them. Add to the line with `cart.line_prices` `adjustments`. A function that fails is left out (`onError: "skip"`), which sells the input without your add-on: declare `onError: "block"` when an input must never sell unpaid (a protection plan), and read your add-on from the order line (`lines[].adjustments`) before you deliver what it paid for.
- Translate the label, help and option labels in `translations.<tag>.checkout.lineInputs` ([Apps](apps.md#translations)): the buy form, cart and checkout draw them in the page's language and the order line freezes what the buyer saw.
- Your functions see the product's inputs and your own in `line.properties`, never another app's; `orders.get` and your own webhooks show you the same. An island's `context.addLine({ variantId, inputs: { gift_message: "…" } })` sets your own by key.

### Buyer uploads

A `file` line input or checkout attribute lets the buyer upload files: a photo to print, a logo to engrave, a prescription.

```ts
checkout: {
  lineInputs: [{ key: "photo", label: "Your photo", type: "file", accept: ["image/jpeg", "image/png"], maxBytes: 2 * 1024 * 1024, maxFiles: 2 }],
}
```

- `accept` is any of `image/jpeg`, `image/png`, `image/webp`, `application/pdf` (default all); `maxBytes` at most 20 MB; `maxFiles` at most 10 (default 1). The store's plan bounds both again (Free: 5 MB, 3 files) and the lower value wins; the buy form and checkout show the bounds that apply.
- The store types each file from its bytes (never its name), keeps it private and answers an upload id. The answer of the input is the ids joined by commas: your functions see it in `line.properties` (or the attribute) and the order line shows "2 files". You never receive the bytes in a function; price the input with a `cart.line_prices` add-on like any other.
- Each upload is bound to your input, its product and one order: an id copied from another buyer, another product or an earlier order refuses checkout (`upload_unavailable`).
- After the order, `order_uploads.list` (`read_orders`) answers your inputs' files on an order: `{ id, key, target, orderItemId, filename, mediaType, sizeBytes, url, urlExpiresAt }`. `url` streams the file for 5 minutes: fetch it when you need it, hand it to your print partner at once, never store or log it. You never see another app's files.
- Files no order takes are deleted after 72 hours; ordered ones a year after the order, and when the store erases the customer. Keep your own copy only if your service needs one, under your own privacy terms.
- Without JavaScript a file input cannot upload; a `file` input is never required on a line.

#### Example: an engraving priced per letter

A complete app: it declares a line input, prices it with a store-currency add-on (right in every market), and reads the buyer's answer back from the order. It is `packages/plugin-sdk/src/examples/engraving.ts`, which the SDK's tests type-check with `tsc` and run in the strict harness.

It never delivers an engraving the buyer did not pay for:

- `onError: "block"`: if its pricing fails, checkout stops with the store's buyer-safe text. The default, `"skip"`, would leave the add-on out while the order line still freezes the engraving the buyer typed.
- It answers every engraved line, a bundle line too. Checkout refuses an add-on a line can't take (`add_on_unavailable`: "This item can't take one of the extras chosen for it"), so the buyer removes the engraving. Skipping the line instead would freeze the engraving without its fee.
- It answers a free engraving as a 0 add-on, so the order line records every engraving sold, and it records an engraving only when the order line carries its add-on. It decides from what checkout froze, never from today's `per_letter`: raising the price later never drops an engraving that was free when bought.

<!-- example:engraving -->
```ts
// A complete app that asks the buyer one line input, prices it and reads it back on the order.
import { defineManifest, definePlugin, PLUGIN_API_VERSION, textFor, type OrderRepresentation } from "@scalius/plugin-sdk";

const APP_ID = "acme.engraving";
const TEXT = `${APP_ID}.text`;

export const manifest = defineManifest({
  id: APP_ID,
  name: "Engraving",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Engrave a name on any item, priced per letter.",
  author: { name: "Acme" },
  scopes: ["read_orders"],
  events: ["order.created"],
  settings: [{ key: "per_letter", label: "Price per letter (store currency)", type: "number", default: 20 }],
  // "block": if pricing fails, checkout stops. The default, "skip", would sell the engraving without its fee.
  functions: [{ point: "cart.line_prices", onError: "block" }],
  checkout: {
    // Drawn on the buy form after the product's own inputs, under `acme.engraving.text`.
    lineInputs: [{ key: "text", label: "Engraving", type: "text", maxLength: 20, help: "Up to 20 letters." }],
  },
  objects: {
    engravings: {
      name: "Engravings",
      fields: [
        { key: "order_id", name: "Order", type: "order_reference", required: true },
        { key: "text", name: "Text", type: "single_line_text", required: true },
      ],
      indexes: ["order_id"],
    },
  },
  // Every word in Bangla too: a Bangla buyer's buy form, cart and order line, and a Bangla dashboard.
  translations: {
    bn: {
      name: "খোদাই",
      description: "যেকোনো পণ্যে নাম খোদাই করুন, দাম প্রতি অক্ষরে।",
      settings: { per_letter: { label: "প্রতি অক্ষরের দাম (স্টোরের মুদ্রায়)" } },
      checkout: { lineInputs: { text: { label: "খোদাই", help: "সর্বোচ্চ ২০টি অক্ষর।" } } },
      objects: { engravings: { name: "খোদাই", fields: { order_id: { name: "অর্ডার" }, text: { name: "লেখা" } } } },
    },
  },
});

export default definePlugin({
  manifest,
  functions: {
    // The fee is the merchant's, in the store's currency: checkout converts it for any market.
    // Every engraved line is answered, a free one as 0 and a bundle line too: the order line
    // records what was sold, and checkout refuses an add-on a line can't take.
    "cart.line_prices": ({ cart, language }, settings) => {
      const perLetter = Math.max(0, Math.round(Number(settings.per_letter ?? 0) * 10 ** cart.storeCurrency.decimalPlaces) || 0);
      return {
        prices: [],
        adjustments: cart.lines.flatMap((line) => {
          const letters = (line.properties[TEXT] ?? "").replace(/\s/gu, "").length;
          if (letters === 0) return [];
          // The add-on's title is the buyer's, in their language (`input.language`).
          const title = textFor(language, { en: `Engraving, ${letters} letters`, bn: `খোদাই, ${letters}টি অক্ষর` });
          return [{ lineId: line.lineId, amountMinor: perLetter * letters, currency: "store" as const, title }];
        }),
      };
    },
  },
  events: {
    // Read the answer back from the order line: yours and the store's, never another app's.
    "order.created": async (event, ctx) => {
      const read = await ctx.api.call<{ order: OrderRepresentation }>("orders.get", { path: { id: event.resource.id } });
      if (!read.ok || !read.data) throw new Error(`orders.get failed: ${read.error?.code ?? read.status}`);
      const order = read.data.order;
      for (const line of order.lines) {
        const text = line.properties.find((property) => property.key === TEXT)?.value;
        // Engrave only what checkout sold: your add-on is on the line (0 when it was free).
        const sold = line.adjustments.some((adjustment) => adjustment.appId === APP_ID);
        // Keyed by the order line: a redelivered event writes the same record again.
        if (text && sold) await ctx.objects.engravings.put(line.id, { order_id: order.id, text });
      }
    },
  },
});
```
<!-- /example:engraving -->

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
