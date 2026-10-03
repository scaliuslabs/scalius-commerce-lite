# @scalius/plugin-sdk

The SDK for Scalius apps (plugins). Plugin authors use it to declare what an app may do (the manifest) and to write the handlers the platform calls. The package is private to this monorepo: apps import it as a workspace package.

Reference apps: `plugins/hello` (events, routes, cron, storage, admin pages), `plugins/bulk-discount` (checkout functions), `plugins/loyalty` (atomic storage and order commits), `plugins/bkash` and `plugins/nagad` (payment providers). The versioned contract (manifest, functions, providers, UI documents) is `packages/shared/src/plugins`. The host (loaders, bridge, routes, delivery, cron) is `apps/api/src/plugins`. Installed apps' state is `packages/core/src/modules/plugins`.

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

Test it with the harness. It runs the platform's runtime over an in-memory bridge.

```ts
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import tally from "./index";

const harness = createPluginTestHarness(tally);
const order = { type: "order", id: "ord_1" };
await harness.event("order.paid", order, {}, { id: "evt_1" });
await harness.event("order.paid", order, {}, { id: "evt_1" }); // a redelivery changes nothing
harness.records.get("tally")?.get("paid"); // { count: 1 }
```

## Build and install

```sh
pnpm plugin create acme.tally          # scaffold plugins/tally
pnpm install
pnpm plugin add plugins/tally          # pack, check, record in scalius.plugins.json
pnpm run deploy                        # compile the app into the API Worker
```

`pnpm plugin` keeps `scalius.plugins.json` (the `sandbox` flag, and each app's `id`, `version`, `source` and `sha256`) and the generated `apps/api/src/plugins/bundled.gen.ts` and `sandbox-runtime.gen.ts` in step. Do not edit them by hand. Other commands:

- `pnpm plugin build [plugin id ...]` packs the listed apps (all by default) again.
- `pnpm plugin list` shows each bundled app and whether it is current. `pnpm plugin remove <plugin id>` stops bundling one.
- `pnpm plugin sandbox <on|off>` records whether deploys bind the Worker Loader.
- `pnpm plugin wrangler-config [--local] [--plan paid]` prints the API Wrangler config path to use. Free without the sandbox gives the committed config. Otherwise it writes `wrangler.deploy.gen.json` (`wrangler.local.deploy.gen.json` with `--local`) beside it.

After the deploy, the app shows on the Apps page as not active. A Super Admin reviews what it asks for and activates it.

## Two loaders

One module runs in both loaders, and the same runtime code builds `ctx` in both. A passing harness test holds in either.

- **Bundled** runs in the API Worker on any plan. `scalius.plugins.json` lists the apps. Every value crossing the bridge is structured-cloned, as in RPC.
- **Sandbox** needs Workers Paid. Each app version runs in its own Dynamic Worker (binding `LOADER`), cached by id, version and SHA-256. It has no network (`globalOutbound: null`), the CPU limit `limits.cpuMs` and 200 bridge calls per invocation.
- An installation with `source` `bundled` uses the bundled loader. `registry` and `upload` use the sandbox. No shipped command creates those: only the API tests do.
- A Free deploy has no `LOADER` binding, so a sandbox installation cannot run. Its calls fail as `unavailable` (provider calls as `misconfigured`). Its status stays.
- `pnpm plugin sandbox on` and `pnpm run deploy --plugin-sandbox` bind the loader and imply `--plan paid`. An explicit Free plan with the sandbox on fails.

## The manifest

`parsePluginManifest` (`@scalius/plugin-sdk/manifest`) validates it. Unknown keys fail.

| Field | Meaning | Limit |
| --- | --- | --- |
| `id`, `name`, `version`, `apiVersion`, `description`, `author` | Identity. `version` is semver. `apiVersion` is `PLUGIN_API_VERSION` (`2026-10`). Uploaded apps cannot use `scalius.*` ids. | |
| `permissions` | RBAC names. Every `ctx.api` call is checked against them. `team`, `agent_access`, `webhooks` and `apps` are never grantable. | 80 |
| `allowedHosts` | Hosts `ctx.http` may reach: exact, or `*.example.com`. `host:port` names one non-default port. No IP literals, no localhost. Empty means no network. | 20 |
| `events` | Topics, `<resource>.*` or `*`. | 40 |
| `functions` | `{ point, priority, onError, snapshot }`. | 5 |
| `providers` | Provider ports, grouped by port. | 10 |
| `routes` | `admin` and `public` entries `{ name, methods }`; `webhooks` names. | 40, 20, 10 |
| `cron` | `{ name, schedule }`. | 10 |
| `storage` | Collections with `indexes` and `unique`. | 20 collections; 4 indexes, 2 unique, 4 fields each |
| `customFields` | Fields in the app's namespace on a product, variant, customer, order, category, collection, brand or page. | 50 |
| `settings` | The merchant's form. Types: `text`, `textarea`, `number`, `boolean`, `select`, `multiselect`, `secret`, `url` (https), `email`, `color`. | 40 |
| `admin` | `pages`, `cards`, `actions`, `widgets`; each names an admin route. | 10, 20, 20, 5 |
| `storefront` | `sections`, `productBlocks`, `head`, `scripts` (https; their hosts join the storefront CSP), `proxy`. | 20, 10, 5 |
| `limits` | `cpuMs` 5-200 (default 50), `wallMs` 100-30,000 (default 10,000). `translations.bn` holds Bangla text. | |

Activation shows a Super Admin everything the manifest asks for. An update that asks for more access stays inactive until a Super Admin approves it.

Settings of type `secret` are encrypted with a key derived from `CREDENTIAL_ENCRYPTION_KEY` and masked everywhere. They appear decrypted only in `ctx.settings` at run time. The host masks them in your log lines and error messages. A secret that cannot be opened reads as `null`.

## Handlers

Definition keys match the manifest. The host rejects an undeclared handler and a declared item without one, when the app is packed and when it loads.

| Definition key | Handler |
| --- | --- |
| `events["order.paid"]`, `["order.*"]`, `["*"]` | `(event, ctx)` |
| `functions["checkout.discounts"]` | `(input, settings)`: pure, no `ctx` |
| `routes.admin.<name>`, `routes.public.<name>`, `routes.webhooks.<name>` | `(request, ctx) => { status?, headers?, body? }` |
| `cron.<name>` | `(ctx, { name, scheduledAt })` |
| `providers.<id>` | `definePaymentProvider`, `defineCourierProvider`, `defineSmsProvider`, `defineEmailProvider`, `defineFraudProvider` or `defineTaxProvider` |
| `lifecycle.install`, `activate`, `deactivate`, `uninstall` | `(ctx)`; `uninstall` also gets `{ keepData }`. Needs no declaration. |

**Events.** `EVENT_TOPICS` in `packages/shared/src/events.ts` lists the 16 topics. The catalogue is a public API and changes only by addition. An event carries ids, states and quantities, never contact data or money. Read the resource with `ctx.api`.

- Delivery is at least once. `event.id` is stable across attempts: use it as your idempotency key.
- A handler that throws or times out is retried after 1 min, 5 min, 30 min, 1 h, 3 h, 6 h and 12 h. After 8 attempts the delivery is exhausted. The merchant can retry it from the app's page.
- At most 4 deliveries of one app run at once.
- An app gets only events after its activation, including events its own writes cause. Write only when something changes, so the handler converges.

**Cron.** A schedule has five fields and runs in the store's time zone (`Asia/Dhaka`). The API checks schedules on its scheduled tick, every 15 minutes. A slot runs once and never overlaps the job's previous run. After downtime only the latest missed slot runs (within 24 hours). Use `scheduledAt`, not the clock, for time windows.

## `ctx`

| Member | What it does |
| --- | --- |
| `plugin`, `store`, `settings` | App id and version. Store `name`, `url` (null until the merchant sets the store address in Settings → Store details → Web addresses), `currency`, `decimalPlaces`, `timezone`, `locale`. The installation's settings, secrets decrypted. |
| `api.call(operationId, input)` | Calls a `/api/v1` dashboard operation by id (`dashboard.orders.get`) with the dashboard's validation, RBAC and audit. Returns `{ ok, status, data, error }`. A mutating call needs `idempotencyKey` (8-200 characters). 60 calls a minute. |
| `storage`, `kv` | See Storage. |
| `http.fetch(url, init)` | https only, to `allowedHosts`. Each redirect hop (at most 5) is checked again. Request and response are at most 1 MiB. `timeoutMs` is 1-30,000 (default 10,000). 60 requests a minute. `Set-Cookie` is dropped. |
| `customFields` (`get`, `set`) | Values of the app's declared fields on one resource. The approved grant must cover the owner type. |
| `messaging` | `email` and `sms` through the store's providers (need `customers.view`), and `notifyStaff`. With `marketing: true` and a `customerId`, only a subscribed customer gets the message, with the unsubscribe footer. 60 messages a minute. |
| `log` | `debug`, `info`, `warn`, `error`. The platform keeps the newest 500 lines per app and masks secrets, e-mail addresses and phone numbers. |

A refusal throws an error with a stable `code` (`storage.conflict`, `http.not_allowed`, `rate_limited`). Read it as `(error as { code?: string }).code`.

## Storage

`ctx.storage.<collection>` holds JSON records of a declared collection. A record is at most 64 KiB and its id is 1-128 printable characters. A query uses declared indexes only: equality on the leading fields of one index, ordering by its next field. `limit` is at most 100 (default 50).

Every write advances the record's **revision** (`plugin_records.revision`). A write can be conditional:

```ts
const current = await ctx.storage.balances.getVersion(customerId); // { data, revision } | null
await ctx.storage.balances.put(customerId, next, { expectedRevision: current?.revision ?? null });
// A write landed since (or the record exists when null was expected): `storage.conflict`, nothing changed.
```

- `update(id, patch, { expectedRevision? })` merges top-level fields. Without a pinned revision it re-reads and merges again, so no update is lost.
- `increment(id, field, delta, { min?, max? })` adds to a whole-number field. A result outside the bounds fails with `storage.out_of_range` and changes nothing. A balance never goes below its floor, however many debits race.
- `ctx.storage.batch([...])` writes up to 25 `put`, `delete` and `check` operations across collections, all or nothing, in one database batch. Each may carry `expectedRevision`. A batch writes each record once.
- A unique index violation fails with `storage.unique_violation`.

`ctx.kv` is a key/value store with TTLs (value 64 KiB, key 256 characters, TTL at most one year, `list(prefix)` at most 1,000 keys). `getVersion` and `compareAndSet(key, expectedRevision | null, value)` give the same compare-and-set (`kv.conflict`). `batch` is a reserved collection name.

## Checkout functions

A function is pure: `(input, settings) => output`, with no I/O. The host stops it after the smaller of `limits.wallMs` and 1.5 s, validates the output and merges it (schemas: `@scalius/shared/plugins/functions`). Points: `cart.validate`, `checkout.discounts`, `checkout.shipping_rates`, `checkout.payment_methods`, `order.risk`. They run for the online store, staff orders and buyer agents (`cart.channel`). `cart.customer.tags` is always empty.

- **Failure policy.** A function that throws, times out or answers invalidly is left out (`onError: "skip"`). Only `cart.validate` and `checkout.payment_methods` may use `onError: "block"`. Checkout then stops with the store's buyer-safe text (Settings → Checkout, "Apps at checkout").
- **Snapshot and commit** (`checkout.discounts`). Declare `snapshot: { collection }`. The signed-in buyer's record in that collection (record id = customer id) arrives as `input.snapshot` (`{ revision, data } | null`).
  - The answer may carry `commit: { record }`, the next version of that record. The platform writes it in the order's own commit batch, at the revision you saw, and only when one of your discounts applied.
  - If the record changed meanwhile, the order fails with `APP_OFFER_CHANGED` and the buyer reviews it.
  - Size the discount against `cart.lines[].lineTotalMinor`. `plugins/loyalty` is the worked example.
- **Holds** (`order.risk`). The point runs after the order commits, so the buyer never waits. Answer `{ level, reasons, hold: true }` to put the order on hold (one `order_holds` row per order and app). A held order is not shipped or moved on until staff release the hold. Staff can still cancel it. The platform never cancels on its own.

## Routes and storefront surfaces

| Surface | URL | Access | Body limit |
| --- | --- | --- | --- |
| `admin` | `/api/v1/plugins/<id>/admin/<name>` | Dashboard session. `apps.view` reads; `apps.use` also changes. | 1 MiB |
| `public` | `/api/v1/plugins/<id>/public/<name>` | None. 60 requests a minute per client and app. | 256 KiB |
| `webhooks` | `/api/v1/plugins/<id>/webhooks/<name>` | None. `GET` or `POST`. 60 requests a minute per client and route. `rawBody` holds the exact body for signature checks. | 1 MiB |

- Only active apps answer, and only declared routes and methods. Cookies never reach a handler. Admin and public handlers see only `accept`, `accept-language`, `content-type`, `if-none-match`, `user-agent` and `x-requested-with`. Webhook handlers see every header except credentials and network headers.
- Responses are JSON. An app cannot set cookies, CSP, CORS, `content-type` or redirect headers. A public or webhook response is `no-store` unless it sets exactly `cache-control: public, max-age=N` with N at most 300.
- Admin pages, cards and widgets answer with `ui.page(...)` or `ui.view(...)`. Buttons and forms answer with `ui.result(...)`. `adminContext(request)` reads the request, including the dashboard language.
- A theme section or product block route gets `request.render` and answers `{ body: { html, head? } }`. The platform sanitizes the HTML and caches it. While rendering, the app may read only its settings and the collections its section lists in `reads`. A render stops after 1.5 s. A homepage shows at most 8 app sections and a product page at most 10 app blocks.
- With `storefront.proxy`, `/apps/<id>/*` on the storefront reaches the public routes. `request.customer` holds the signed-in customer's id, never a cookie. Answer `{ page }` or `{ redirect }` for a page navigation.

## Providers

An app can fill a **port**: the typed interface the platform's own adapters implement (`@scalius/shared/plugins/providers`). Core code calls one interface per port and never asks whether it got a built-in adapter or an app. A provider's id in the store is `<plugin id>:<provider id>`. Declare providers in the manifest by port. Implement each with the matching `define*Provider`.

| Port | Required | Optional (list in `operations`) | The platform calls | Merchant picks it in |
| --- | --- | --- | --- | --- |
| `payment` | `createSession`, `verifyWebhook` | `verifyReturn`, `queryPayment`, `refund`, `refundStatus`, `listRefunds`, `testConnection` | All | Settings → Payments |
| `courier` | `createShipment`, `trackShipment` | `findShipment`, `verifyWebhook`, `testConnection`, `quote`, `cancelShipment`, `reconcileCod` | All except `quote`, `cancelShipment`, `reconcileCod` | Settings → Shipping and delivery |
| `sms`, `email` | `send` | `deliveryStatus`, `testConnection` | `send`, `testConnection` | Settings → Notifications |
| `fraud` | `check` | `testConnection` | All | Settings → Integrations |
| `tax` | `calculate` | `commit`, `void`, `testConnection` | None: contract only | None |

The host validates every input and output on both sides. The merchant sees your providers beside the built-ins. Each shows its readiness and, when you declare `testConnection`, a connection test. Ready means the app is active, approved for the port and runnable here, with complete settings and readable secrets. A provider never runs unless it is ready. A setting named `environment` with the values `sandbox` or `live` marks the provider as test or live in the dashboard.

Fail with `ProviderError(category, message, { uncertain?, code? })`:

| Category | Meaning | Platform reaction |
| --- | --- | --- |
| `declined` | The provider refused. Nothing happened. | Shown, not retried. |
| `retryable` | Try again later. Add `uncertain: true` if the call may have reached the provider. | Retried or reconciled. An uncertain call is kept and resolved, never repeated blindly. |
| `misconfigured` | Credentials or settings are wrong. | The provider is not ready. The platform fails closed. |

A throw that is not a `ProviderError`, a timeout or an invalid answer counts as `retryable` and `uncertain`. A message is at most 300 characters and must be safe for a merchant: never a credential, a raw provider body or buyer contact data. `ctx.messaging` is refused inside a provider operation: reach your provider with `ctx.http`.

### Build a payment provider

```ts
providers: {
  payment: [{
    id: "wallet",
    name: "Acme Wallet",
    checkoutName: "Acme Wallet",           // what buyers see (default: name)
    flow: "hosted",                         // the only app flow: redirect to the provider
    chargeCurrencies: ["BDT"],              // or "any"
    amountLimits: { currency: "BDT", minMinor: 1_000, maxMinor: 50_000_00 }, // optional
    amountCodecs: { BDT: { wireExponent: 2 } },                               // optional
    operations: ["verifyReturn", "queryPayment", "refund", "refundStatus", "testConnection"],
  }],
},
```

A hosted provider must declare `verifyReturn` and `queryPayment`. A provider that declares `refund` must declare `refundStatus`. It may add `listRefunds` to import refunds made in the provider's dashboard. For each session the platform builds the return URLs `/api/v1/payment/<provider id>/success|fail|cancel` and the webhook URL `/api/v1/webhooks/<provider id>`.

1. **`createSession(input, ctx)`.** The platform has already claimed the attempt locally.
   - `input.attemptKey` is your idempotency key. A retry of the same attempt must return the same provider session. Store it.
   - `input.correlationId` (at most 30 characters) is the merchant reference. The provider must echo it.
   - `input.wireAmount` is the amount in your declared wire form (`{ minor, decimal }`). The platform refuses a charge your codec cannot carry exactly.
   - Send the buyer back to `input.urls.success`, `fail` or `cancel`. Webhooks go to `input.urls.webhook`.
   - Return `{ providerRef, redirectUrl }` (https only).
2. **`verifyReturn` and `verifyWebhook(request, ctx)`.** Authenticate before anything changes: check a signature, or ask the provider server to server for the reference the request names. A query string is never authority. Answer `{ status: "event", event }`, `"ignored"`, `"invalid"` (forged: nothing changes) or `"retry"` (the provider could not be asked now).
   - A confirmed event carries the provider-authenticated `amountMinor` and `currency`.
   - A webhook and a return for the same capture must give the same `eventType` and `eventId`. The platform then applies it once.
   - Failed and cancelled events carry `correlationId`, so the platform releases the right attempt.
3. **`queryPayment`** answers "did it go through?" for a buyer or a staff reconcile: `{ providerStatus, event? }`.
4. **`refund`** runs at most once per `input.idempotencyKey`. Store what you sent. If the answer is lost, raise `retryable` with `uncertain`. The platform then asks `refundStatus` instead of refunding twice.

Test with `harness.provider("wallet", "createSession", input)`. It validates both sides like the host. See `plugins/bkash` and `plugins/nagad`.

### Build a courier

```ts
providers: {
  courier: [{
    id: "parcel",
    name: "Acme Parcel",
    trackingUrl: "https://track.acme.example/{trackingId}",                  // optional
    operations: ["findShipment", "verifyWebhook", "testConnection"],
  }],
},
```

1. **`createShipment(input, ctx)`.** The platform inserts its own shipment row first and passes its id as `input.idempotencyKey`. A retry after a lost answer reuses it, so book at most once per key.
   - `input.orderId` is the order number your courier records.
   - `codAmountMinor` is the cash to collect (0 for prepaid), in minor units of `currency`. `decimalPlaces` serves couriers that take major units.
   - Return `externalId`, `trackingId`, a normalized `status`, your `rawStatus`, the quoted `chargeMinor`, an optional label (https URL, or a base64 PDF the platform stores privately) and optional flat `details` for staff.
   - If the call may have reached the courier but you got no answer, raise `retryable` with `uncertain`. With `findShipment` (by order number) the platform then finds the booking instead of booking twice.
2. **`trackShipment`** maps your courier's status onto `COURIER_SHIPMENT_STATUSES` (`picked_up`, `in_transit`, `delivered`, `returned`, and more) with an ISO timestamp. The platform moves the order from it.
3. **`verifyWebhook`** authenticates a tracking push sent to `POST /api/v1/webhooks/couriers/<plugin id>:<provider id>`. The merchant copies that URL from the courier's settings. Answer `{ status: "update", externalId, tracking, eventId? }`, `"ignored"` or `"invalid"`. The platform applies each push once (by `eventId` when you send one). It accepts a push only when exactly one active delivery provider uses your courier.

The platform stores only the normalized status, your short raw status and your flat `details`.

### SMS, email and fraud

- **SMS and email.** Implement `send`. Never send twice for one idempotency key (`clientReference` for SMS, `idempotencyKey` for email). Answer `{ success, providerRef?, rawStatus?, retryable? }`. Set `retryable: false` for errors a retry cannot fix.
- **Fraud.** Implement `check({ phone, orderId? })`. The merchant reads the answer on the order page as advice. It never blocks automatically. An app that must stop fulfilment answers `order.risk` with `hold: true`.

## Test harness

`createPluginTestHarness(module, { settings, store, api, fetch })` enforces the manifest the way the platform does: declared collections, indexed queries, unique indexes, revisions, allowed hosts. `ctx.api` and `ctx.http` answer from the callbacks you pass. Its methods are `event`, `fn`, `route`, `render`, `cron`, `lifecycle` and `provider`. Its state is `records`, `kv`, `customFields`, `logs` and `sent` (recorded messages).
