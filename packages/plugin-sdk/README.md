# @scalius/plugin-sdk

The SDK for Scalius apps (plugins), for plugin authors. An app declares what it may do (the manifest) and writes the handlers the platform calls. The package is private to this monorepo.

Real apps in `plugins/`: `bkash` and `nagad` (payment providers) and `bangladesh` (SMS, fraud, courier and payment providers, place seeding). Worked examples that no store bundles are test fixtures in `apps/api/src/plugins/testing/apps/`: `hello` (events, routes, cron, storage, admin pages), `bulk-discount` (checkout functions), `loyalty` (atomic storage and order commits), `wishlist` (storefront blocks), `order-tagger` (timeline entries) and `notes` (checkout and account blocks). The versioned contract is `packages/shared/src/plugins`, the host is `apps/api/src/plugins`, and installed-app state is `packages/core/src/modules/plugins`.

## Extension points

| Point | Declare | Implement |
| --- | --- | --- |
| Events | `events` | `events[topic](event, ctx)` |
| Checkout functions | `functions: [{ point, … }]` | `functions[point](input, settings)` |
| Providers (14 ports) | `providers.<port>` | `define<Port>Provider({ … })` |
| Admin routes, pages, cards, actions, widgets | `routes.admin`, `admin.*` | `routes.admin[name]` with `ui.*` |
| Admin list columns and filters | `admin.listColumns` | storage records or your custom fields (no code) |
| Order timeline entries | `timeline` | `ctx.timeline.add(…)` |
| Custom fields, metaobjects | `customFields`, `metaobjects` | `ctx.customFields`, `ctx.api` (`dashboard.metaobjects.*`) |
| Theme sections, product blocks, checkout and account blocks | `storefront.sections`, `productBlocks`, `blocks` | a public route that answers `{ html }` |
| Storefront components: sections, header, footer, product card, templates | `storefront.sections` (no `route`), `slots`, `templates` | `defineStorefront` in `src/storefront.tsx` (`@scalius/plugin-sdk/storefront`) |
| Client islands, stylesheet, public files | `storefront.islands`, `stylesheet`, `connect` | `src/islands/<name>.ts` (`defineIsland`), `src/storefront.css`, `public/` |
| Scripts, head, proxy | `storefront.scripts`, `head`, `proxy` | |
| Public routes, webhooks | `routes.public`, `routes.webhooks` | `routes.public[name]`, `routes.webhooks[name]` |
| Cron, data updates, lifecycle | `cron`, `migrations` | `cron[name]`, `migrations[version]`, `lifecycle.*` |
| Sales channels | `salesChannels` | read your channel's products with `ctx.api` |

## A minimal app

```ts
import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.tally",                  // <vendor>.<name>
  name: "Order tally",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Counts paid orders.",
  author: { name: "Acme" },
  events: ["order.paid"],
  storage: { seen: {}, tally: {} },
} satisfies PluginManifestInput;

export default definePlugin({
  manifest,
  events: {
    "order.paid": async (event, ctx) => {
      if (await ctx.storage.seen!.get(event.id)) return; // delivery is at least once
      const tally = await ctx.storage.tally!.getVersion("paid");
      await ctx.storage.batch([
        { op: "put", collection: "seen", id: event.id, record: { orderId: event.resource.id }, expectedRevision: null },
        { op: "put", collection: "tally", id: "paid", record: { count: Number(tally?.data.count ?? 0) + 1 }, expectedRevision: tally?.revision ?? null },
      ]);
    },
  },
});
```

Test it with the harness. It runs the platform's runtime over an in-memory bridge and enforces the manifest (declared collections, indexed queries, unique indexes, revisions, allowed hosts).

```ts
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import tally from "./index";

const harness = createPluginTestHarness(tally);
await harness.event("order.paid", { type: "order", id: "ord_1" }, {}, { id: "evt_1" });
harness.records.get("tally")?.get("paid"); // { count: 1 }
```

`createPluginTestHarness(module, { settings, store, api, fetch })` answers `ctx.api` and `ctx.http` from the callbacks you pass. Methods: `event`, `fn`, `route`, `render`, `cron`, `lifecycle`, `provider`. State: `records`, `kv`, `customFields`, `logs`, `sent` (recorded messages).

## Build and install

```sh
pnpm plugin create acme.tally   # scaffold plugins/tally
pnpm install
pnpm plugin add plugins/tally   # pack, check, record in scalius.plugins.json
pnpm run deploy                 # compile the app into the API Worker
```

`pnpm plugin` keeps `scalius.plugins.json` and the generated files in `apps/api/src/plugins/` in step: `bundled.gen.ts`, `sandbox-runtime.gen.ts`, `assets.gen.ts` (the listing images) and `catalog.gen.ts` (the first-party apps in `plugins/` that the lockfile does not list). Do not edit them by hand. Other subcommands:

- `create <vendor.name>` scaffolds an app with an event, a checkout function, a storefront section, an admin page, a data update and a test. `validate [path]` checks the manifest, compatibility, handlers, permissions, images and bundle size, one line each.
- `keygen <dir>` makes an Ed25519 signing key (keep it out of every repository). `pack <path> [--key <pem>] [--developer <name>]` writes `dist/` and, with a key, `signature.json` and the upload ZIP. `index <dist>... --out <dir> --name <name>` builds or extends a static registry. `add <vendor.name> --registry <index URL>` installs a signed release into the fork; `trust <name> <public key>` adds a developer key to the lockfile's `trustedKeys`.
- The harness also runs data updates (`runMigration(version)`, `runMigrations()`) and whole events (`deliver`); `@scalius/plugin-sdk/fixtures` builds typed events, checkout inputs and admin requests.
- `build [plugin id ...]` packs the listed apps (all by default) again. `list` shows each bundled app and whether it is current. `remove <plugin id>` stops bundling one.
- `sandbox <on|off>` records whether deploys bind the Worker Loader.
- `wrangler-config [--local] [--plan paid]` prints the API Wrangler config path. A generated config is `wrangler.deploy.gen.json` (`wrangler.local.deploy.gen.json` with `--local`); Free without the sandbox uses the committed config.

After the deploy, the app shows on the Apps page as not active. A Super Admin reviews its requests and activates it. A first-party app in `plugins/` that is not in `scalius.plugins.json` shows under "Available to install" with its `pnpm plugin add` command.

## Two loaders

One module uses the same handler contract in both loaders. Harness tests verify
that contract; they do not prove equivalent isolation, deployment behavior or
performance. Bundled code is trusted code in the host Worker; the Dynamic Worker
has a separate execution boundary. Verify loader-specific behavior separately.

- **Bundled** runs in the API Worker on any plan, from `scalius.plugins.json`. Values crossing the bridge are structured-cloned.
- **Sandbox** needs Workers Paid. Each app version runs in its own Dynamic Worker (binding `LOADER`), cached by id, version and SHA-256. It has no network (`globalOutbound: null`), and the CPU limit `limits.cpuMs` within the plan's ceiling.

An installation with `source` `bundled` uses the bundled loader. `registry` and `upload` use the sandbox; they install from the dashboard (see "Install, update and trust"). A Free deploy has no `LOADER` binding, so sandbox calls fail as `unavailable` (provider calls as `misconfigured`). `pnpm plugin sandbox on` and `pnpm run deploy --plugin-sandbox` bind the loader. [docs/FREE-PLAN.md](../../docs/FREE-PLAN.md) owns the plan rules (the sandbox implies `--plan paid`).

## The manifest

`parsePluginManifest` (`@scalius/plugin-sdk/manifest`) validates it. Unknown keys fail. Limits are in parentheses.

- `id`, `name`, `version` (semver), `apiVersion` (`PLUGIN_API_VERSION`, `2026-10`), `description`, `author`: identity. Uploaded apps cannot use `scalius.*` ids.
- `permissions` (80): RBAC names. Every `ctx.api` call is checked against them. `team`, `agent_access`, `webhooks` and `apps` are never grantable.
- `allowedHosts` (20): hosts `ctx.http` may reach, exact or `*.example.com`. `host:port` names one non-default port. No IP literals or localhost. Empty means no network.
- `events` (40): topics, `<resource>.*` or `*`.
- `functions` (5): `{ point, priority, onError, snapshot }`.
- `timeline` (10): `{ kind, title }`, the kinds of order timeline entries the app writes.
- `metaobjects` (10): content types in the app's namespace (`<plugin id>.<type>`), with custom-field typed fields. They sync on activation and update; the merchant writes their entries.
- `providers` (24 in all): provider declarations, grouped by port. A regional pack (`plugins/bangladesh`) bundles a country's integrations in one app.
- `routes`: `admin` (40) and `public` (20) entries `{ name, methods }`; `webhooks` (10) names.
- `cron` (10): `{ name, schedule }`.
- `storage` (20 collections): `indexes` (4) and `unique` (2), each with up to 4 fields.
- `customFields` (50): fields in the app's namespace on a product, variant, customer, order, category, collection, brand or page.
- `salesChannels` (3): sales channels the app sells through (`{ id, name }`), Shopify's sales-channel apps. Each becomes the channel `<plugin id>:<id>`, active while the app is. Merchants publish products to it; the app pages them from `GET /api/v1/admin/settings/sales-channels/<channel id>/products` (`products.view`) and follows `product.publication_changed`.
- `settings` (40): the merchant's form. Types: `text`, `textarea`, `number`, `boolean`, `select`, `multiselect`, `secret`, `url` (https), `email`, `color`.
- `admin`: `pages` (10), `cards` (20), `actions` (20), `widgets` (5), each naming an admin route; `listColumns` (see "List columns").
- `storefront`: `sections` (20), `productBlocks` (10), `blocks` (checkout and account targets), `scripts` (5, https; `pages` is `all`, `home`, `product`, `listing` or `cart`: app JavaScript never runs on checkout, the receipt or an account page; their hosts join the storefront CSP), `head` and `proxy` flags.
- `limits`: `cpuMs` 5-200 (default 50), `wallMs` 100-30,000 (default 10,000).
- `translations`: text by BCP 47 tag (`bn`, `fr`, `pt-BR`; up to 20) for `name`, `tagline`, `description` and the admin titles.

### Listing

These fields describe the app on the Apps page. They give no access, and a change to them needs no new approval. All are optional.

- `icon`: a square SVG or PNG file in the app package, for example `assets/icon.svg`. 64 KiB or less.
- `tagline` (100 characters): one line under the name. Keep it different from `description`.
- `categories` (3): `payments`, `shipping`, `orders`, `inventory`, `returns`, `checkout`, `pricing`, `marketing`, `loyalty`, `store-design`, `content`, `notifications`, `analytics`, `finances`, `support`, `operations`, `compliance`. Put the main one first. The list follows the Shopify App Store subcategories.
- `screenshots` (6): PNG, JPEG or WebP files in the app package, 512 KiB or less each.
- `support`: `{ url?, email? }`. Give at least one.
- `privacyPolicyUrl`, `documentationUrl`, `changelogUrl`: https addresses.
- `countries`: ISO 3166-1 alpha-2 codes, upper case, of the countries the app serves. Leave it out for every country.
- `minPlatformVersion`: the oldest Scalius release the app runs on (semver). A manifest that asks for a newer release than this code does not parse.

Paths are relative to the app package, in lower case, without `..`. The packer reads each file and refuses it when:

- its bytes do not match its type, or it is larger than its limit;
- an SVG has elements other than drawing elements (no `script`, `foreignObject`, `image` or `a`), an `on*` attribute, a reference that is not to its own `#id`, a `url()` to another file, `@import`, a DOCTYPE or an entity.

The packer adds the digests of the images to the end of the bundle as a comment. Thus the bundle SHA-256 changes when only an image changes. The API serves the images to the dashboard at `/api/v1/admin/apps/<id>/assets/<icon | screenshot-N>` on the dashboard origin. It checks each image again, and sends it with `nosniff` and `Content-Security-Policy: sandbox`. An address with the current fingerprint (`?v=`) is cached for one year. A bundled app's images are compiled into the Worker (`assets.gen.ts`). A sandboxed app's images are in R2 at `private/plugins/<id>/<version>/<sha256>/assets/<path>`; `pnpm plugin` writes them to `dist/assets/` beside `dist/plugin.js`.

Activation shows a Super Admin everything the manifest asks for. An update that asks for more access stays inactive until a Super Admin approves it.

A `secret` setting is encrypted with a key derived from `CREDENTIAL_ENCRYPTION_KEY` and masked everywhere. It appears decrypted only in `ctx.settings`. A secret that cannot be opened reads as `null`.

## Handlers

Definition keys match the manifest. The host rejects an undeclared handler, and a declared item without one, when the app is packed and when it loads.

- `events["order.paid"]`, `["order.*"]`, `["*"]`: `(event, ctx)`.
- `functions["checkout.discounts"]`: `(input, settings)`. Pure, no `ctx`.
- `routes.admin.<name>`, `routes.public.<name>`, `routes.webhooks.<name>`: `(request, ctx) => { status?, headers?, body? }`.
- `cron.<name>`: `(ctx, { name, scheduledAt })`.
- `providers.<id>`: `definePaymentProvider`, `defineCourierProvider`, `defineSmsProvider`, `defineEmailProvider`, `defineFraudProvider`, `defineTaxProvider`, `defineTranslationProvider`, `defineAiProvider`, `defineMessagingProvider`, `definePushProvider`, `defineSearchProvider`, `defineAddressProvider`, `defineFxProvider` or `defineIdentityProvider`.
- `lifecycle.install`, `activate`, `deactivate`, `uninstall`: `(ctx)`. `uninstall` also gets `{ keepData }`. No declaration needed.
- `migrations["1"]`, `["2"]`: `(ctx)`. One for each `manifest.migrations[].version` (see "Data updates").

**Events.** `EVENT_TOPICS` in `packages/shared/src/events.ts` lists the 16 topics. The catalogue changes only by addition. An event carries ids, states and quantities, never contact data or money. Read the resource with `ctx.api`.

- Delivery is at least once. `event.id` is stable across attempts: use it as your idempotency key.
- A handler that throws or times out is retried after 1 min, 5 min, 30 min, 1 h, 3 h, 6 h and 12 h. After 8 attempts the delivery is exhausted and the merchant can retry it from the app's page.
- An app gets only events after its activation, including those its own writes cause. Write only when something changes, so the handler converges.

**Cron.** A schedule has five fields and runs in the store's time zone (`Asia/Dhaka`). The API checks schedules every 15 minutes on Workers Paid and every 24 minutes on Free. A slot runs once and never overlaps the job's previous run. After downtime only the latest missed slot runs (within 24 hours). Use `scheduledAt`, not the clock, for time windows.

## `ctx`

- `plugin`, `store`, `settings`: app id and version; store `name`, `url` (null until the merchant sets Settings > Store details > Web addresses), `currency`, `decimalPlaces`, `timezone`, `locale`; the installation's settings with secrets decrypted.
- `api.call(operationId, input)`: calls a `/api/v1` dashboard operation by id (`dashboard.orders.get`) with the dashboard's validation, RBAC and audit. Returns `{ ok, status, data, error }`. A mutating call needs `idempotencyKey` (8-200 characters). 60 calls a minute.
- `http.fetch(url, init)`: https only, to `allowedHosts`. Each redirect hop (at most 5) is checked again. Request and response are at most 1 MiB. `timeoutMs` is 1-30,000 (default 10,000). 60 requests a minute. `Set-Cookie` is dropped.
- `customFields` (`get`, `set`): values of the app's declared fields on one resource. The approved grant must cover the owner type.
- `messaging`: `email`, `sms` and `pushCustomer` through the store's providers (need `customers.view`), and `notifyStaff` (Firebase devices and Web Push browsers). `pushCustomer({ customerId, title, body?, url?, tag? })` reaches the browsers the buyer subscribed on the account page (or the store's push app); `url` is a store path. With `marketing: true` and a `customerId`, only a subscribed customer gets an email or SMS, with the unsubscribe footer. 60 messages a minute.
- `timeline.add({ orderId, kind, message, fields?, idempotencyKey? })`: a line on the order timeline with your app's name (needs `orders.edit` and a declared kind). `message` is plain text (500 characters), `fields` at most 10. The same `idempotencyKey` adds it once.
- `log`: `debug`, `info`, `warn`, `error`. The platform keeps the newest 500 lines per app and masks secrets, e-mail addresses and phone numbers.
- `storage`, `kv`: see Storage.

A refusal throws an error with a stable `code` (`storage.conflict`, `http.not_allowed`, `rate_limited`). Read it as `(error as { code?: string }).code`.

## Storage

`ctx.storage.<collection>` holds JSON records of a declared collection. A record is at most 64 KiB and its id is 1-128 printable characters. A query uses declared indexes only: equality on the leading fields of one index, ordering by its next field. `limit` is at most 100 (default 50).

Every write advances the record's **revision** (`plugin_records.revision`). Conditional write:

```ts
const current = await ctx.storage.balances.getVersion(customerId); // { data, revision } | null
await ctx.storage.balances.put(customerId, next, { expectedRevision: current?.revision ?? null });
// A write landed since (or the record exists when null was expected): `storage.conflict`, nothing changed.
```

- `update(id, patch, { expectedRevision? })` merges top-level fields. Without a pinned revision it re-reads and merges again, so no update is lost.
- `increment(id, field, delta, { min?, max? })` adds to a whole-number field. A result outside the bounds fails with `storage.out_of_range` and changes nothing.
- `ctx.storage.batch([...])` writes up to 25 `put`, `delete` and `check` operations across collections, all or nothing. Each may carry `expectedRevision`. A batch writes each record once.
- A unique index violation fails with `storage.unique_violation`.

`ctx.kv` is a key/value store with TTLs (value 64 KiB, key 256 characters, TTL at most one year, `list(prefix)` at most 1,000 keys). `getVersion` and `compareAndSet(key, expectedRevision | null, value)` give the same compare-and-set (`kv.conflict`). `batch` is a reserved collection name.

## Checkout functions

A function is pure: `(input, settings) => output`, with no I/O. The host stops it after the smaller of `limits.wallMs` and 1.5 s, validates the output and merges it (schemas: `@scalius/shared/plugins/functions`). Points, in checkout order: `cart.transform`, `cart.line_prices`, `cart.validate`, `checkout.discounts`, `checkout.shipping_rates`, `checkout.payment_methods`, then `order.risk` after the commit. They run for the online store and buyer agents; staff orders run all but `cart.transform` and `cart.line_prices` (staff set lines and prices). `cart.customer.tags` lists the signed-in customer's tags. `cart.market` is `{ id, country }`: the market the order is placed in and the country that chose it (null before an address is known). `cart.attributes` holds the buyer's checkout attributes by `<app id>.<key>`; it is empty until apps can declare them.

- **`cart.transform`** answers `{ operations: [{ expand: { lineId, title?, components: [{ variantId, quantity }] } } | { merge: { lineIds, title } }] }`. A bundle's components become real order lines (stock, tax and refunds per SKU); the buyer sees one line at their summed price. Lines with buyer inputs, gift cards and carts above 99 lines are never changed.
- **`cart.line_prices`** answers `{ prices: [{ lineId, unitPriceMinor }] }` for B2B, tiered or member prices (with `snapshot`). It prices a line only when no price list does: sale > segment > market list > your price > FX > base. The first app by priority wins a line.

- **Failure policy.** A function that throws, times out or answers invalidly is left out (`onError: "skip"`). Only `cart.validate` and `checkout.payment_methods` may use `onError: "block"`. Checkout then stops with the store's buyer-safe text (Settings > Checkout, "Apps at checkout").
- **Snapshot and commit** (`checkout.discounts`). Declare `snapshot: { collection }`. The signed-in buyer's record in that collection (record id = customer id) arrives as `input.snapshot` (`{ revision, data } | null`).
  - The answer may carry `commit: { record }`, the next version of that record. The platform writes it in the order's own commit batch, at the revision you saw, and only when one of your discounts applied.
  - If the record changed meanwhile, the order fails with `APP_OFFER_CHANGED` and the buyer reviews it.
  - Size the discount against `cart.lines[].lineTotalMinor`. The test app `apps/api/src/plugins/testing/apps/loyalty` is a worked example.
- **Holds** (`order.risk`). The point runs after the order commits. Answer `{ level, reasons, hold: true }` to put the order on hold (one `order_holds` row per order and app). Staff release the hold before the order ships or moves on. Staff can still cancel it. The platform never cancels on its own.

## Routes and storefront surfaces

| Surface | URL | Access | Body limit |
| --- | --- | --- | --- |
| `admin` | `/api/v1/plugins/<id>/admin/<name>` | Dashboard session. `apps.view` reads; `apps.use` also changes. | 1 MiB |
| `public` | `/api/v1/plugins/<id>/public/<name>` | None. 60 requests a minute per client and app. | 256 KiB |
| `webhooks` | `/api/v1/plugins/<id>/webhooks/<name>` | None. `GET` or `POST`. 60 requests a minute per client and route. `rawBody` holds the exact body for signature checks. | 1 MiB |

- Only active apps answer, and only declared routes and methods. Cookies never reach a handler. Admin and public handlers see only `accept`, `accept-language`, `content-type`, `if-none-match`, `user-agent` and `x-requested-with`. Webhook handlers see every header except credentials and network headers.
- Responses are JSON. An app cannot set cookies, CSP, CORS, `content-type` or redirect headers. A public or webhook response is `no-store` unless it sets exactly `cache-control: public, max-age=N` with N at most 300.
- Admin pages, cards and widgets answer with `ui.page(...)` or `ui.view(...)`, and buttons and forms with `ui.result(...)`. `adminContext(request)` reads the request, including the dashboard language.
- A theme section or product block route gets `request.render` and answers `{ body: { html, head? } }`. The platform sanitizes and caches the HTML. A render reads only the app's settings and the collections its section lists in `reads`, and stops after 1.5 s. A page shows at most 8 route sections (component sections, drawn at the edge, may fill the page: 24) and a product page at most 10 app blocks.
- A checkout or account block (`storefront.blocks: [{ type, name, target, route, reads }]`) renders like a section at its Shopify target (`purchase.checkout.contact.render-after`, `customer-account.order-status.block.render`, …). No forms on checkout targets and no head tags. A page shows at most 12 app blocks.
- With `storefront.proxy`, `/apps/<id>/*` on the storefront reaches the public routes. `request.customer` holds the signed-in customer's id, never a cookie. Answer `{ page }` or `{ redirect }` for a page navigation.

## Storefront components

An app can redesign the storefront without a fork: component sections, the header, footer and product card, ready-made templates, client islands and a stylesheet, compiled once by `pnpm plugin pack` and run at the edge as a pure function of the page's data. A paid store uploads and activates the app; a free store bundles it with `pnpm plugin add`. Component sections can place the store's own order form (`<Checkout product={...} />`) for single-page order landings. [docs/STOREFRONT-COMPONENTS.md](../../docs/STOREFRONT-COMPONENTS.md) is the guide; `plugins/noor` is a complete theme and `apps/api/src/plugins/testing/apps/studio` a small example.

## Providers

An app can fill a **port**, the typed interface the platform's own adapters implement (`@scalius/shared/plugins/providers`). A provider's store id is `<plugin id>:<provider id>`. Declare providers in the manifest by port and implement each with the matching `define*Provider`.

Each port has required operations, and optional ones that you list in `operations` (`PROVIDER_OPERATIONS` in `@scalius/shared/plugins/providers`). Required: `payment` needs `createSession` and `verifyWebhook`, `courier` needs `createShipment` and `trackShipment`, `sms`, `email`, `messaging` and `push` need `send`, `fraud` needs `check`, `tax` needs `calculate`, `translation` needs `translate`, `ai` needs `generate`, `search` needs `search`, `address` needs `suggest` and `resolve`, `fx` needs `rates`, and `identity` needs `authorize` and `exchange`. The platform calls every operation you declare, except courier `quote`, `cancelShipment` and `reconcileCod`, sms and email `deliveryStatus`, and all `tax` operations (tax is contract only). The merchant picks a provider in Settings > Payments, Shipping and delivery, Notifications (SMS and email) or Integrations (fraud).

The host validates every input and output on both sides. A provider runs only when it is ready: the app is active, approved for the port and runnable here, with complete settings and readable secrets. The dashboard shows readiness and, if you declare `testConnection`, a connection test. A setting named `environment` with the values `sandbox` or `live` marks the provider as test or live.

An app with several providers names each provider's own settings: `{ id, name, settings: ["gateway_token", "gateway_sender"] }`. Those keys need not be `required` for the whole app. The provider is ready only when each one is set, readable and not an obvious placeholder ("test", "your api key"), and a save refuses such a placeholder. Only the provider's own unreadable secrets block it, so one gateway's broken key never stops another (`plugins/bangladesh`).

A provider operation's `ctx.http` calls to its provider do not count against the app's outbound limit: the platform paces the operations it calls.

Fail with `ProviderError(category, message, { uncertain?, code? })`:

- `declined`: the provider refused and nothing happened. The platform shows it and does not retry.
- `retryable`: try again later. Add `uncertain: true` if the call may have reached the provider. The platform retries or reconciles, and never repeats an uncertain call blindly.
- `misconfigured`: credentials or settings are wrong. The provider is not ready and the platform fails closed.

A throw that is not a `ProviderError`, a timeout or an invalid answer counts as `retryable` and `uncertain`. A message is at most 300 characters and must be safe for a merchant: never a credential, a raw provider body or buyer contact data. `ctx.messaging` is refused inside a provider operation: reach your provider with `ctx.http`.

### Build a payment provider

Declare `{ id, name, checkoutName?, flow: "hosted", chargeCurrencies, operations }` under `providers.payment`, plus optional `amountLimits: { currency, minMinor, maxMinor }` and `amountCodecs: { BDT: { wireExponent: 2 } }`. `hosted` (redirect to the provider) is the only app flow. `chargeCurrencies` is a list such as `["BDT"]`, or `"any"`. Optional `countries` (default `"any"`) lists the shipping countries the method serves; checkout never offers it for a delivery to another country.

A hosted provider must declare `verifyReturn` and `queryPayment`. A provider that declares `refund` must declare `refundStatus`, and may add `listRefunds` to import refunds made in the provider's dashboard. For each session the platform builds the return URLs `/api/v1/payment/<provider id>/success|fail|cancel` and the webhook URL `/api/v1/webhooks/<provider id>`. `input.urls` holds them.

1. **`createSession(input, ctx)`** returns `{ providerRef, redirectUrl }` (https only).
   - `input.attemptKey` is your idempotency key. A retry of the same attempt must return the same provider session, so store it.
   - `input.correlationId` (at most 30 characters) is the merchant reference. The provider must echo it.
   - `input.wireAmount` (`{ minor, decimal }`) is the amount in your declared wire form. The platform refuses a charge your codec cannot carry exactly.
2. **`verifyReturn` and `verifyWebhook(request, ctx)`** authenticate before anything changes: check a signature, or ask the provider server to server for the reference the request names. A query string is never authority. Answer `{ status: "event", event }`, `"ignored"`, `"invalid"` (forged: nothing changes) or `"retry"` (the provider could not be asked now).
   - A confirmed event carries the provider-authenticated `amountMinor` and `currency`.
   - A webhook and a return for the same capture must give the same `eventType` and `eventId`, so the platform applies it once.
   - Failed and cancelled events carry `correlationId`, so the platform releases the right attempt.
3. **`queryPayment`** answers "did it go through?" for a buyer or a staff reconcile: `{ providerStatus, event? }`.
4. **`refund`** runs at most once per `input.idempotencyKey`. Store what you sent. If the answer is lost, raise `retryable` with `uncertain`: the platform then asks `refundStatus` instead of refunding twice.

### Build a courier

Declare `{ id, name, countries?, trackingUrl?, locations?, icon?, settings?, operations }` under `providers.courier`. The Bangladesh pack's Pathao and Steadfast (`plugins/bangladesh/src/couriers.ts`) are complete examples.

- `trackingUrl` is an https template that contains `{trackingId}`, such as `https://track.acme.example/{trackingId}`. The platform saves the page with each shipment.
- `locations: { key, required, numeric }`: your courier books by its own location ids, kept on the store's places under `externalIds.<key>` (your app may load them with the place import). The platform refuses a booking whose city, zone or area lacks a `required` id before it writes anything, and passes the ids as `recipient.locationIds`.
- `icon` is your courier's own mark in the package (SVG or PNG, the app icon's checks). The dashboard shows it beside the courier; without it, the app's icon.

1. **`createShipment(input, ctx)`.** The platform inserts its own shipment row first and passes its id as `input.idempotencyKey`. A retry after a lost answer reuses it, so book at most once per key.
   - `codAmountMinor` is the cash to collect (0 for prepaid), in minor units of `currency`.
   - Return `externalId`, `trackingId`, a normalized `status`, your `rawStatus`, the quoted `chargeMinor`, an optional label (https URL, or a base64 PDF the platform stores privately) and flat `details` for staff.
   - If the call may have reached the courier but you got no answer, raise `retryable` with `uncertain`. With `findShipment` (by order number) the platform then finds the booking instead of booking twice.
2. **`trackShipment`** maps your courier's status onto `COURIER_SHIPMENT_STATUSES` with an ISO timestamp. The platform moves the order from it.
3. **`verifyWebhook`** authenticates a tracking push to `POST /api/v1/webhooks/couriers/<plugin id>:<provider id>`, the URL the merchant copies into the courier's settings. You get every header (with `authorization`) and the exact body. Answer:
   - `{ status: "update", externalId, tracking, eventId?, orderId? }`: a new state. With `orderId` (the order number the courier echoes) the platform refuses a booking of another order and binds a booking `findShipment` confirmed without its id.
   - `{ status: "note", externalId, eventId, details, orderId? }`: facts (a tracking message) without a state change.
   - `"ignored"` (authentic, about no shipment: an integration check) or `"invalid"` (401; with `rejectStatus` 4xx for an authentic but malformed push).
   - Any accepted answer may carry `reply: { status (2xx), headers?, body? }`, what your courier expects back (Pathao checks a 202 and a secret header). The platform keeps it JSON, uncached and without cookies.
   - Raise `misconfigured` when your secret is not set: the platform answers 503 and the courier sends again later.

   The platform applies each push once (by `eventId` when you send one). It accepts a push only when exactly one active delivery provider uses your courier.

### SMS, email and fraud

- **SMS and email.** Implement `send`. Never send twice for one idempotency key (`clientReference` for SMS, `idempotencyKey` for email). Answer `{ success, providerRef?, rawStatus?, retryable? }`. Set `retryable: false` for errors a retry cannot fix.
- **Fraud.** Implement `check({ phone, orderId? })`. The merchant reads the answer on the order page as advice. It never blocks automatically. An app that must stop fulfilment answers `order.risk` with `hold: true`.

### Service ports

- **Messaging.** Declare `channels` (`whatsapp`, `messenger`, `instagram`, `telegram`, `viber`). `send({ channel, to, text | template, clientReference? })` answers like SMS. A WhatsApp app replaces the built-in Meta sender when the merchant chooses it.
- **Push.** `send({ audience, recipients, notification, clientReference? })`: `recipients` are Scalius staff or customer ids; map them to your own subscribers. Web Push is built in; your app replaces it for buyers when chosen.
- **Search.** `search({ query, locale, marketId, limit })` answers `{ productIds, correctedQuery? }`, best first. The platform reads, prices and filters the products itself and uses built-in search when you fail or take more than 1.5 s. Keep your index current from `product.*` events.
- **Address.** `suggest({ query, country, locale, sessionToken })` answers up to 8 suggestions; `resolve({ id, … })` answers the canonical address fields. Declare `countries`. The form still validates the address.
- **FX.** `rates({ base, quotes })` answers exact decimal rates (`"0.0084"`). The scheduled tick asks; buyers never wait on you; a failure keeps the last rate.
- **Identity.** `authorize({ state, nonce, codeChallenge, redirectUri, locale })` answers the provider's https sign-in URL; `exchange({ code, codeVerifier, nonce, redirectUri })` checks the ID token and answers `{ subject, email?, emailVerified, phone?, phoneVerified, name? }`. Set `emailVerified` only when the provider verified it: only verified facts link to an existing account.

## List columns

`admin.listColumns: [{ id, resource, title, type, filterable?, source }]` adds columns to the orders, products or customers list. `type` is `text`, `number`, `money` (store integer minor units; the list shows the amount), `date` or `boolean`. `source` is `{ kind: "storage", collection, field }` (the record whose id is the row's id) or `{ kind: "customField", key }` (your field on that resource). `filterable` needs a declared index that starts with the field. Merchants pick the columns; a list shows at most 5.

## Data updates

An app declares versioned updates of its own data (`manifest.migrations`, up to 200, versions increasing) and one handler for each (`migrations: { "1": async (ctx) => { … } }`). They use `ctx.storage` and `ctx.kv`, so they work the same on D1, TursoDB and PostgreSQL.

- The platform runs each pending update once, in order, before the app's next run after an install or an update. It records each one (`plugin_migrations`) and stores the newest version on the installation (`migratedVersion`). Checkout functions do not wait for them.
- A failed update stops the run. A dashboard update then puts back the previous version. A bundled app (updated by a deploy) becomes `failed` until it is fixed.
- A rollback does not reverse data. Make each update idempotent (it can run again after a crash), and keep the previous version able to read the result: add first, remove in a later version.
- Never renumber or remove a declared update.
- Uninstall with "keep data" keeps the record, so a reinstall does not run the updates again. "Delete data" removes it.

## Install, update and trust

- **Workers Free (bundled).** An operator adds the app to the fork and deploys: `pnpm plugin add <path>`, or `pnpm plugin add <vendor.name> --registry <index URL>` for a signed registry release. The Apps page shows that command.
- **Workers Paid (sandbox).** The Apps page installs from a registry with one click, or from an uploaded package (a ZIP that `pnpm plugin pack` writes). The platform downloads the release, checks its SHA-256, its compatibility, its Ed25519 signature and its images, and stores it in R2. Nothing runs until a Super Admin approves its access.
- **Signatures.** A release is signed over its id, version, bundle SHA-256 and the SHA-256 of its canonical manifest (`@scalius/shared/plugins/registry`). The store trusts the official key (pinned in code; empty until the official registry exists) and the keys a Super Admin added (Apps → Registries and trusted developers). An upload signed by an unknown developer, or not signed, installs only after a Super Admin chooses "trust this developer" or "install unsigned app".
- **Updates.** The Apps page shows newer registry versions. An update that asks for more access waits for a Super Admin. An active app loads the new code and runs its data updates at once; when either fails, the previous version comes back and the page says why.
- **Private apps.** Keep an app in `plugins/` of your fork (both loaders: `pnpm plugin add plugins/<dir>`, then deploy), or sign it with your own key and upload it on Paid. Add your public key as a trusted developer once, and your uploads need no extra step. A private app never needs the official registry.

## Quotas

The plan profile (`planLimits().plugins`) sets each app's ceilings. The manifest's `limits` apply within them.

| Limit | Free | Paid |
| --- | --- | --- |
| CPU per run (sandbox) | 50 ms | 200 ms |
| Wall time per run | 10 s | 30 s |
| Platform calls per run | 50 | 1,000 |
| Stored data (records and key/value) | 50 MiB | 1 GiB |
| Event, route and cron runs per minute | 600 | 6,000 |

- A run over a limit fails, and the app's log records a breach. Five breaches within an hour (at most one counted each minute) stop the app; the staff get a notice. A Super Admin starts it again by approving it.
- Storage is measured once a day. Above the limit, writes that add data fail with `quota.storage`; deletes still work.
- Checkout functions, provider operations and storefront output are paced by the platform, so the runs-per-minute limit does not count them.
- The emergency switch on the Apps page (and the `dashboard.apps.stop` and `dashboard.apps.stop_third_party` operations) stops one app, or every app not published by Scalius, at once. It runs no app code.

## The stable plugin API

This package, the manifest (`packages/shared/src/plugins`), the event catalogue and the bridge contract are the plugin API. It is the one part of Scalius that keeps backward compatibility.

- `apiVersion` names the version an app was built for (`PLUGIN_API_VERSION`, date-versioned). `SUPPORTED_PLUGIN_API_VERSIONS` lists the versions this platform runs. Install, activation and update refuse a manifest built for a version that is not listed, or whose `minPlatformVersion` is newer than this release, with a plain reason.
- Within one `apiVersion`, changes are additive only: new optional manifest fields, new `ctx` methods, new events, new function points and provider operations. Existing fields, types, error codes and behaviour do not change.
- A breaking change makes a new `apiVersion`. The platform then supports the old and the new version side by side for at least 12 months. The changelog marks each deprecation with the version that removes it.
- A deprecated field or method keeps working until the platform drops its `apiVersion`.
