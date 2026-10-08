# Architecture

How Scalius Commerce is built: the two Workers, the core domain graph with its import rules, and the order lifecycle. It is for contributors and coding agents. Code and the checks named here are the authority; this page does not certify a clean tree.

Related docs:

- Themes, templates and listings: [storefront-theme.md](../packages/shared/src/storefront-theme.md).
- Render budgets and `pnpm perf:storefront`: [STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md). Baseline: [PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md).
- Public cache validity (DVC): [cache-deps README](../packages/core/src/cache-deps/README.md).
- Plan profile: [FREE-PLAN.md](./FREE-PLAN.md). Provider cutover: [DATABASE-PORTABILITY.md](./DATABASE-PORTABILITY.md).

## System overview

```text
 Browser (dashboard)               Browser (buyer)
        │                                 │
        │                    ┌────────────▼────────────┐
        │                    │ Storefront Worker       │
        │                    │ (Astro SSR)             │
        │                    └────────────┬────────────┘
        │                                 │ service binding BACKEND_API
┌───────▼─────────────────────────────────▼─────────────┐
│ API Worker (Hono)                                      │
│  - dashboard SPA (ASSETS) and Better Auth              │
│  - HTTP routes, loaded lazily per route family         │
│  - queue consumer: JOBS_QUEUE and jobs-dlq             │
│  - cron every 15 minutes: maintenance sweeps           │
└────────────────────────────┬───────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────┐
│ @scalius/core: 40 domains (acyclic graph)              │
│ plus settings-store, cache-deps, errors, auth,         │
│ integrations, search, utils                            │
└────────────────────────────┬───────────────────────────┘
                             │
┌────────────────────────────▼───────────────────────────┐
│ @scalius/database: Drizzle schema, D1 / TursoDB / PG   │
└────────────────────────────────────────────────────────┘
```

- The API Worker serves the dashboard SPA (`apps/admin-v2/dist`) through its `ASSETS` binding. `apps/admin-v2` has no Wrangler config. On the dashboard host the API Worker serves the SPA shell, Better Auth (`<base>/api/auth/*`) and the API (`<base>/api/v1/*`): `apps/api/src/dashboard/surface.ts`.
- The storefront Worker reads everything through `BACKEND_API` and has no KV binding.
- Local ports: API 8787, storefront 4322, dashboard dev server 4323 (`scripts/dev-ports.mjs`).
- `apps/api/src/runtime/fetch-runtime-app.ts` sorts a request path into one family (`probe`, `public`, `admin`, `system`, `docs`, `plugins`) and loads only that family's app. `runtime/admin-app.ts` and `runtime/public-app.ts` split their families into lazy groups.
- `apps/api/src/app.ts` is the full contract app that produces the OpenAPI contract. `runtime/route-family-parity.test.ts` checks that each of its routes belongs to exactly one runtime app.
- `JOBS_QUEUE` message types: `payment.event`, `auth.send_otp`, `notification`, `order.notification` (legacy), `order.auto_fulfil`, `media.render_variants`, `catalog.recommendations.refresh`, `catalog.projections.rebuild`, `events.dispatch`, `webhooks.deliver`, `plugins.deliver`. `jobs-dlq` archives exhausted messages.
- The API Worker also exports the realtime hub, one Durable Object per store (see [Realtime hub](#realtime-hub)).
- The cron runs `runScheduledMaintenance` (`apps/api/src/scheduled-maintenance.ts`). On Workers Free the sweeps rotate through four slices, so each runs hourly. On Paid every sweep runs on every tick. Sweeps marked `every` (notification outbox flush, event outbox maintenance, plugin maintenance) run on every tick on both plans.

## Layer rules

Dependencies flow downward only.

| Layer | May import | Never imports |
|-------|-----------|---------------|
| Dashboard (`apps/admin-v2/src`) | `@scalius/shared`, `@scalius/api-client`, `@scalius/core/modules/<domain>/browser`, `@scalius/core/auth/rbac/*` | A domain `index`, any other core path, database provider clients |
| API routes (`apps/api/src/routes/`) | `@scalius/core` through its exports map, `@scalius/database`, `@scalius/shared` | A path outside the exports map. Nothing imports routes. |
| Core domains (`packages/core/src/modules/<domain>/`) | Own files, other domains' entries, core's shared areas, `@scalius/database`, `@scalius/shared` | Routes, apps, a file inside another domain, a domain that imports them back |
| Schema (`@scalius/database/schema`) | `drizzle-orm` | Services or routes |
| Shared (`@scalius/shared`) | No workspace package | |
| Storefront (`apps/storefront`) | `@scalius/shared`, `@scalius/api-client` | `@scalius/core`, `@scalius/database` |

The admin build (`scripts/check-admin-client-boundaries.mjs`) scans every emitted JavaScript file for database-provider markers and circular static chunk imports.

Worker bindings, database clients, credentials, in-flight I/O and tenant data are request-scoped. The API Worker creates them per request and never keeps them in module variables. Implicit request context uses `AsyncLocalStorage` only: the public media base URL (`withPublicMediaUrl`), the public render context, the dependency scope and the read observer.

## Core domains

Each directory under `packages/core/src/modules/` is one domain with at most two public entries:

- `index.ts` is the server API.
- `browser.ts` exists only when the domain has pure types and policies that other code needs without its server graph. It is closed: every file it reaches is exported by a browser entry, and it imports only `zod`, `@scalius/shared/*` and other browser files. 23 of the 40 domains have one.

Other code reaches a domain only through these entries: `../<domain>` or `../<domain>/browser` inside core, `@scalius/core/modules/<domain>` (and `/browser`) outside it. Core also has shared areas that are not domains: `settings-store`, `cache-deps`, `errors`, `auth`, `integrations`, `search`, `utils` and `testing` (test-only fixtures).

| Domain | Owns |
|--------|------|
| `agent-access` | Agent grants, credentials, authorization |
| `agent-storefront` | Buyer-agent storefront workflows |
| `analytics` | Analytics scripts, provider health, dashboard reports |
| `attributes` | Attribute definitions, groups, values, category attribute sets |
| `brands` | Brand records and buyer reads |
| `catalog` | Buyer reads: listings, facets, product page, collections, site search, feeds, sitemaps, recommendations |
| `categories` | Category records, tree, publication rules |
| `checkout` | Cart validation, checkout authority, pricing, idempotent attempts, the single commit and its post-commit work, abandoned checkouts |
| `collections` | Collection records and publication rules |
| `conversations` | Buyer-store threads and attachments |
| `custom-fields` | Custom field definitions and values |
| `customer-marketing` | Marketing consent per channel, double opt-in, unsubscribe links |
| `customers` | Customer records, account auth and OTP, identity, tags, segments |
| `delivery` | Couriers, shipments, tracking, delivery zones and locations |
| `digital` | Private files, licence-key pools (the SKU's stock), entitlements, download tickets |
| `events` | Event outbox dispatch, webhook subscriptions and deliveries (catalog: `@scalius/shared/events`) |
| `fraud-checker` | The manual courier-history lookup by phone. It advises and never blocks. |
| `fulfilment` | Actions that hand units over (the fulfilment ledger) and automatic fulfilment |
| `gift-cards` | Codes, the append-only balance ledger, issue, redemption, refund credit |
| `inventory` | Reservations, deductions, ledger v2, locations, low-stock alerts, suppliers, purchase orders, transfers |
| `markets` | Markets, their countries and URL presences, the presence matrix, the backup market's price increment and the store pricing currency, an order's market |
| `media` | The Files library: uploads, usage index, permanent delete |
| `media-references` | Stored-file key and URL projection, deleting-reference guard |
| `navigation` | Menus, publications, placements |
| `notifications` | Channel rules and templates, order notification outbox, delivery receipts, provider health |
| `order-kernel` | What every order writer shares: state machine, shipment claim lease, payment-session and refund-attempt locks, app facts |
| `orders` | The order record: lists, manual orders, edits, status lifecycle, app holds, returns, invoices, receipts, payment recovery, account orders |
| `pages` | CMS pages, articles, store policy pages |
| `payments` | Gateway port and adapters, sessions, payment application, refunds, COD records |
| `platform` | The `platform` settings document: origins, CORS, identity handoff |
| `plugins` | Installed apps' state and lifecycle |
| `product-admin` | The dashboard product editor under one aggregate revision |
| `products` | The product model and its rules: eligibility, buyer pricing, option model, low-stock policy, catalog projections |
| `promotions` | Discount engine, checkout snapshots, redemptions |
| `reviews` | Verified-purchase reviews, moderation, rating projection, review requests |
| `settings` | Shared settings documents and services |
| `store-transfer` | Product, customer and inventory import and export |
| `storefront` | Homepage and layout reads for the storefront |
| `tax` | Tax classes, rates, the quote calculator |
| `warranty` | Warranty policies, per-line warranties, claims backed by threads |

### How the boundaries are enforced

1. **Exports map.** `packages/core/package.json` exports `./modules/<domain>`, `./modules/<domain>/browser` where it exists, and the shared areas. `apps/api` and `apps/admin-v2` resolve `@scalius/core` through this map with no `tsconfig` alias, so `@scalius/core/modules/<domain>/<file>` fails to compile and to resolve in tests.
2. **Source policies** (`scripts/check-source-policies.mjs`; run by the API build and the test suite). They forbid deep `@scalius/core/modules` paths, dashboard imports of non-browser entries, mutable module variables, and `drizzle-orm/d1` or `D1Database` in core.
3. **Core boundaries** (`scripts/core-boundaries.mjs`, run by the source policies):
   - the exports map matches the domain directories;
   - every import of a domain from another domain or a shared area resolves to that domain's `index.ts` or `browser.ts`;
   - no import cycle spans two units (a domain, or a shared-area file or directory such as `auth/rbac`);
   - browser entries are closed.
4. **Graph ratchet** (`scripts/core-domain-graph.test.mjs`). The directed domain edges (type imports included) must equal `scripts/core-domain-graph.allow.json`, and its `cycles` list is empty. A new edge needs a reviewed allowlist diff and must not close a cycle. A removed edge must leave the allowlist. `node scripts/core-boundaries.mjs --write-allowlist` regenerates it.
5. **Dashboard boundary test** (`apps/admin-v2/src/lib/browser-core-boundaries.test.ts`) and the admin build scan.

The graph has no cycle, and no file cycle crosses a unit. So importing a domain through its `index.ts` is safe: an entry never re-enters a module that is still loading, and zod schemas, document definitions and registries exist when another domain reads them.

### The dependency graph

The allowlist holds 166 directed edges. A domain sits one layer above the highest domain it imports. There are 12 layers:

```text
L11  agent-storefront
L10  checkout · storefront · warranty
L9   analytics · conversations · fulfilment
L8   orders · store-transfer
L7   customer-marketing · payments · reviews
L6   navigation · notifications
L5   catalog · delivery · digital · product-admin
L4   brands · categories · inventory · pages · price-lists · promotions · sales-channels
L3   custom-fields · onboarding · products · tax
L2   customers · markets · media · platform
L1   plugins · settings
L0   agent-access · attributes · collections · events · fraud-checker
     gift-cards · media-references · order-kernel · translations
```

Rules that keep it acyclic:

- **Leaf domains import no domain:** `agent-access`, `attributes`, `collections`, `events`, `fraud-checker`, `gift-cards`, `media-references`, `order-kernel`, `translations`. Put a fact in a leaf when several domains act on it and none should own the others.
- **`settings` imports only `media-references`.** The document store is infrastructure (`@scalius/core/settings-store`). A domain declares the documents it owns.
- **`markets` imports only `settings` and `translations`** (a presence names a store language). A domain that prices reads the store currency and the price increment from `markets` (`readStoreCurrency()`, `storePriceIncrementSql()`); the code-only money helpers stay in `settings`.
- **`plugins` imports only `events`.**
- **Orchestrators sit on top.** `checkout`, `fulfilment`, `storefront`, `agent-storefront` and `store-transfer` compose lower domains, and nothing below them imports them. Work that needs two peers goes into the orchestrator or the API route that calls both.
- **The model sits below its editor.** `products` is below `inventory`. `product-admin` is above `inventory` and `tax`.
- **`orders` sits above `payments`, `delivery` and `notifications`.** These share `order-kernel` instead of importing `orders`.

### Per-domain registries and seams

Shared composition files are split so that features in different domains never edit the same file.

- Route permissions: `packages/core/src/auth/rbac/route-permissions/<area>.ts`, merged by `index.ts`. A path pattern belongs to exactly one file, and `route-permissions.test.ts` checks that no two files tie on a path.
- Agent operation registry: `apps/api/src/openapi/operation-registry/<surface>-<area>.ts`, merged by `index.ts` (row shape in `entry.ts`). An operation id belongs to exactly one file (`agent-operation-contract.test.ts`).
- Order routes: `routes/storefront-orders/`, `routes/customer-auth/` and `routes/admin/orders/` under `apps/api/src`, one router per flow. Each `index.ts` mounts them in registration order, which is also the published OpenAPI path order. Append new routers; never reorder.
- Order-line extras: `apps/api/src/routes/shared/order-line-extras.ts` composes each item's review, download, licence-key, gift-card and warranty facts at the API layer. `warranty` sits above `orders`, so `orders` cannot import it.
- Automatic fulfilment: `apps/api/src/utils/auto-fulfil-queue.ts` sends `order.auto_fulfil` after a write that settles payment (checkout commit, payment confirmation, cash collection). It never throws. The scheduled `auto_fulfil_sweep` is the backstop.

## Provider ports

`@scalius/shared/plugins/providers` defines one port per provider kind: `payment`, `courier`, `sms`, `email`, `fraud` and `tax`. Built-in adapters (Stripe, the email senders) and app providers (the Bangladesh pack's SSLCommerz, couriers, SMS gateways and fraud checkers, bKash, Nagad) implement the same port. A retired built-in id (`sslcommerz`, `pathao`, …) on rows saved before its move resolves to the app provider that replaced it, and fails closed ("Activate Bangladesh pack in Apps to use it.") until that app is active. Core resolves a provider by id and never asks which kind it got. A built-in id never contains a colon. An app provider id is `<plugin id>:<provider id>`.

- The API builds each request's app providers from `plugin_registrations` rows of kind `provider` (`apps/api/src/plugins/providers/`). Payment and courier providers join their registries (`payments/gateways/registry.ts`, `delivery/couriers/registry.ts`). SMS, email and fraud providers reach core through the `AppProviders` lookup (`packages/core/src/integrations/provider-port.ts`).
- Core asks for an app provider only when the saved choice names one, so a store on built-in providers reads no plugin table. Without a lookup an app choice fails closed.
- Ports change only additively within a plugin API version.

## Runtime configuration boundary

Wrangler configs declare resource bindings only and carry no `vars`, except `LOCAL_MAILPIT_URL` in `apps/api/wrangler.local.jsonc`. `pnpm check:env` enforces this. It limits bindings to KV `CACHE`, R2 `BUCKET`, rate limiters `RL_STRICT` and `RL_STANDARD`, queue producer `JOBS_QUEUE` and the Durable Object `REALTIME_HUB` (class `RealtimeHub`, SQLite-backed, created by a `new_sqlite_classes` migration). It requires `CF_VERSION_METADATA`, keeps the entrypoints uncached and checks each Worker's `Env` declaration.

- Installed secrets: `SCALIUS_SECRET` on both Workers and `CREDENTIAL_ENCRYPTION_KEY` on the API Worker. Every per-purpose secret is HKDF-derived from `SCALIUS_SECRET` at Worker entry (`packages/shared/src/runtime-secrets.ts`).
- Public origins are the `platform` settings document, not deployment configuration. Merchants edit the origins under Settings > Store details > Web addresses. They edit the customer cookie domain, extra CORS origins and single sign-on under Settings > Advanced > Sign-in and access. `GET /api/v1/platform` serves the four origins and the setup-token and identity-handoff flags with `Cache-Control: no-store`.
- The API Worker resolves the document once per invocation in `runtime/runtime-env.ts`, through the `platform` domain only, so the entry's static graph stays small. It returns a request-scoped env with the derived secrets and `PLATFORM_CONFIG`. Consumers read fields such as `env.STOREFRONT_URL`.
- The storefront Worker reads the origins from the platform fields of the layout payload that every page fetches (`applyPlatformOrigins`, `apps/storefront/src/lib/api/runtime.ts`). Its own URL falls back to the request origin. The dashboard SPA calls the same-origin API Worker and needs no origins.
- `--plan paid` (default Free) generates a Wrangler config with the Paid CPU limit, queue batch sizes and the build constant `__SCALIUS_PLAN__`. Plan-sized values live in `packages/shared/src/plan-limits.ts` and are read through `planLimits()`. Code never branches on the plan name. See [FREE-PLAN.md](./FREE-PLAN.md).
- Seven opt-in contracts support automated deployments. All are off by default and add no `vars` and no installed secret. See [AUTOMATED-DEPLOYMENTS.md](./AUTOMATED-DEPLOYMENTS.md).

### Build outputs and secrets

No build inlines a local value. Secrets reach a Worker only through its `env` at request time. `.dev.vars` and `.env*` serve `wrangler dev` and `astro dev`, never a bundle.

- Storefront: Astro inlines every non-`PUBLIC_` variable it can see wherever server code reads `import.meta.env.NAME`. A bare `import.meta.env`, even in a comment, inlines every variable the module's text names. `@astrojs/cloudflare` copies `.dev.vars` into `process.env`, and the Cloudflare Vite plugin writes it into `dist/server/`. `apps/storefront/integrations/build-env-isolation.mjs` keeps only the built-in keys (`DEV`, `SSR`, `PROD`, `MODE`, `BASE_URL`, `SITE`, `ASSETS_PREFIX`), turns off Vite env files and drops env files from the bundle.
- Dashboard: `envDir: false`. API: `wrangler deploy` inlines no env. Source policy: storefront and dashboard code never read `process.env`.
- `pnpm check:dist-secrets` scans every `dist/` file for env files, extra `import.meta.env` keys and secret names bound to string literals. It reports names only. `pnpm check:build-canaries` builds a copy of each app with canary secrets and fails if one reaches `dist/`. `pnpm run deploy*` runs both after the build and before any upload.

## Realtime hub

Decision (2026-10, research R8): the dashboard is live through one SQLite-backed Durable Object per store, `RealtimeHub` (`apps/api/src/realtime/hub.ts`), exported by the API Worker. It is the only Durable Object. WebSockets on Workers need a Durable Object, and nothing portable does this job, so the owner rule "a new Cloudflare primitive only where nothing portable can do the job" allows it. SQLite Durable Objects run on Workers Free. Do not add another Durable Object or Workflows without a new decision.

- The relational database stays the authority. The hub keeps no business state and uses no storage. Each socket's attachment holds its staff id, name, topics, proof expiry and open editors.
- `<dashboard>/api/realtime` (`realtime/connect.ts`) checks the Origin, the signed session cookie, onboarding and 2FA gates and RBAC once per connection. The hub receives the proven identity and the topics the permissions allow (`realtimeTopicsFor`, `@scalius/shared/realtime`), never the cookie.
- Sockets are hibernatable and tagged by topic and user; `ping` is an auto-response. An idle dashboard costs no duration and no database read.
- Producers send ids, kinds, states and revisions only: the event outbox flush (the rows it claims or settles, no extra read) and the write observer for tables without events (inbox, reviews, courier shipments, payments). One RPC per flush or write, never per row.
- Presence and save notices go from editor to hub to the other editors; the three-way field merge (`apps/admin-v2/src/lib/three-way-merge.ts`) settles a save that meets a newer revision.
- Details, costs and merge rules: `docs/platform/REALTIME.md`.

## Database provider boundary

D1 is the zero-configuration default. TursoDB and PostgreSQL (Neon, or generic through `pg` or Hyperdrive) are the external options. Routes and domain services see one `@scalius/database` surface. Provider selection, transport, capability fallbacks, atomic writes and conflict retry stay inside the database and core boundaries. Never add provider branches in domain code. Reference: [packages/database/README.md](../packages/database/README.md).

This repository is the per-merchant commerce runtime. Provisioning, deployments, migration orchestration and rollback retention belong to deployment operations, not to Worker request paths. A provider switch needs a write freeze, a revision-fenced source snapshot, a verified target import and matching logical fingerprints: [DATABASE-PORTABILITY.md](./DATABASE-PORTABILITY.md).

`pnpm run deploy` deploys the API Worker (with the dashboard SPA) and the storefront Worker from fixed Wrangler configs.

## Public caching

Public API and storefront caches use dependency validation (DVC). SQL triggers advance dependency keys in the same transaction as each write. The registry is `packages/shared/src/cache-deps.ts`. Public readers declare what they read with `deps.*` (`@scalius/core/cache-deps`).

- A cached entry carries a proof of its dependencies. A read serves it only while the proof holds.
- Every cache key carries the Worker version (`CF_VERSION_METADATA`). Without a version nothing is cached.
- The API Worker reads through its own cache reader (`createPublicPartReader`), not a Workers Cache entrypoint, so every hit is validated.
- There are no route generation bumps, KV coherence mirror, purges or warm lists.

## Order lifecycle

### Entry points

```text
STOREFRONT CHECKOUT (checkout)       DASHBOARD (orders)
POST /orders                         POST /admin/orders
 1. One read batch: idempotency      One manual-order workflow with its
    row, checkout authority,         own idempotency authority
    customer and SKU rows            (orders/admin/create-attempts.ts)
 2. Price, quote fingerprint,
    policy (in memory)
 3. One guarded write batch:
    authority guard, attempt, SKU
    holds (ledger v2 + stockVersion),
    order, items, receipt, outboxes
 4. Post-commit side effects
```

Every storefront and agent checkout commits through `commitStorefrontOrderPayload` (`checkout/commit.ts`) as one `safeBatch()` of guarded statements. Order items exist when the response is sent. The commit asserts the `checkoutAuthorityRevision` it priced against. If catalog, delivery, tax or checkout policy changed, the commit rolls back and the buyer reviews again. A committed order still replays from its idempotency row.

Stock holds live only on `product_variants` (`reserved_stock`, `stock_version`), with one ledger-v2 movement per change. A new order starts with `inventory_action = reserved` when any line is tracked.

Post-commit work runs through `waitUntil()` and never fails a committed checkout. It relays outbox rows to the queue, dispatches Meta events, enqueues automatic fulfilment for a paid order, runs app risk checks and records marketing consent.

### Statuses and where they come from

The state machine is `packages/shared/src/order-state.ts`, wrapped by `validateTransition()` in `order-kernel/state-machine.ts`. An order has three dimensions: order status, payment status and fulfilment status.

| From | Next order status |
|------|-------------------|
| `incomplete` | `pending`, `cancelled` |
| `pending` | `processing`, `confirmed`, `cancelled` |
| `processing` | `confirmed`, `cancelled` |
| `confirmed` | `shipped`, `delivered`, `cancelled` |
| `shipped` | `confirmed`, `delivered`, `returned`, `cancelled` |
| `delivered` | `completed`, `returned`, `refunded` |
| `completed` | `returned`, `refunded` |
| `returned` | `refunded` |
| `cancelled`, `refunded` | none |

`shipped` to `confirmed` rebuilds a courier handoff. `confirmed` to `delivered` serves an order with nothing to ship.

The machine lists every legal move. Who may make a move is narrower:

- **The generic status editor** (`updateOrderStatus`; dashboard and agents; `orders/status/policy.ts`) makes only moves without side effects: `incomplete` to `pending`, `pending` or `processing` to `confirmed`, `delivered` to `completed`, and cancellation.
- **Shipped, delivered and returned are fulfilment facts.** They come only from `fulfilment` actions (Mark as sent, Book courier, cash collected, Mark delivered, Mark returned) or a return. Each records what moved and moves the stock through `applyOrderStatusChange` (`orders/status/lifecycle.ts`).
- **Refunded** comes from the refund workflow in `payments`.
- **Delivered and completed need settled money.** A COD order needs its cash collection recorded.
- **Cancel** is refused while any unit is handed over. The generic cancel works only for an order with no payment taken or in flight, or one paid only by gift cards (cancelling returns the balance). A paid order must be refunded first.
- **An open app hold** (`order_holds`) limits the generic editor to cancel.
- **Order locks** block every status change while a shipment claim, a refund attempt or a hosted-payment session setup is active (`order-kernel`).

Order lines have a fulfilment type (`ship`, `pickup`, `digital`, `gift_card`, `service`). The fulfilment ledger (`order_fulfillments`, `order_fulfillment_lines`) adds no order status. `order_items.fulfilled_quantity` is a trigger projection of the ledger: never write it.

| Move to | Inventory (`inventory/inventory-transitions.ts`) | Notification type |
|---------|-----------|-------------|
| `pending` | None. The checkout commit reserved the stock. | `order_created` |
| `processing`, `confirmed` | None. Stock stays reserved. | `order_processing`, `order_confirmed` |
| `shipped` | Reserved stock is deducted. | `order_shipped` |
| `delivered` | Reserved stock is deducted if not yet deducted. | `order_delivered` |
| `completed` | None. | `order_completed` |
| `cancelled`, `refunded` | Reserved stock is released. Deducted stock is restored. | `order_cancelled`, `order_refunded` |
| `returned` | Deducted stock is restored, unless an open return owns it. The return receipt restocks good units and writes off damaged ones. | `order_returned` |

`orders.inventory_action` records the result: `none`, `reserved`, `deducted` or `restored`. A move to `incomplete`, `pending`, `processing` or `confirmed` re-reserves an order whose action is `restored`. This repairs data only.

### The cascade

```text
Fulfilment action / generic editor / delivery webhook
    ↓
1. validateTransition() (canTransitionTo() for a webhook)
    ↓
2. CAS update of orders.version and status
   (an admin change, a webhook and a payment cannot all win)
    ↓
3. applyInventoryForStatusChangeWithImpact(): reserve, deduct, release
   or restore, with deterministic movement claims and a stockVersion CAS
   in one safeBatch()
    ↓
4. The API route records a notification_outbox row and sends it to JOBS_QUEUE
    ↓
5. The queue consumer dispatches each enabled channel
```

If step 3 fails, the lifecycle kernel rolls the status back. The delivery webhook marks the shipment for reconciliation instead.

Inventory protection: a status transition writes a deterministic `inventory_movements.id` claim and the SKU counter CAS update in one `safeBatch()`. A repeated `transition:*` claim is an idempotent retry. A conflicting claim fails closed and needs manual reconciliation. The `orders.inventory_action` update is CAS-guarded against the value read before the stock transition. Every stock mutation uses `stockVersion` with bounded conflict retry.

### Notifications and courier webhooks

- **Notifications.** A fact commits a `notification_outbox` row and sends `{ type: "notification", outboxId }` to `JOBS_QUEUE`. The message carries no contact or body. The consumer claims the row, reads the channel rules, fences each recipient with a `notification_delivery_receipts` row and calls the provider. A failure marks the row failed with backoff, and the scheduled `notification_outbox_flush` retries it. Order types are `ORDER_NOTIFICATION_TYPES` (`notifications/notification-types.ts`). Details: [notifications README](../packages/core/src/modules/notifications/README.md).
- **Courier webhooks.** Every courier is an app's: `POST /api/v1/webhooks/couriers/{provider}` (and the old `/webhooks/pathao`, `/webhooks/steadfast`, forwarded to the Bangladesh pack's couriers) has the app verify the callback; the route then claims a `webhook_events` row, save the shipment status, update the fulfilment ledger and move the order through `updateOrderStatusFromShipment()` (`delivery/tracking.ts`). A refused transition is skipped, and an admin change wins a race. The shipment-to-order table is in the [delivery README](../packages/core/src/modules/delivery/README.md).

## Money

Money is stored and computed as integer minor units of the order or store currency (`*_minor` columns, `packages/shared/src/money.ts`). Gateways receive integer minor units plus an ISO 4217 code across the payment port. The HTTP contract carries decimal major units, converted once at the edge.

## Payment pipeline

```text
provider webhook / hosted return / buyer reconcile
        ↓
claimAndEnqueuePaymentEvent (apps/api/src/routes/payment/payment-events.ts)
 1. The gateway adapter verifies the callback (or queries the provider
    on a buyer reconcile).
 2. One webhook_events row is claimed before any side effect.
 3. One payment.event message goes to JOBS_QUEUE.
        ↓
Queue consumer (apps/api/src/queue-consumer.ts)
 processPaymentConfirmed() / processPaymentFailed()
  - refuses a deleted, fully paid, refunded, cancelled or returned order
  - validates the order and payment transitions
  - one safeBatch(): order CAS (status, paid amounts, payment status,
    version), order_payments row, payment plan, Meta purchase outbox claim
```

Stock was reserved at checkout, so payment confirmation writes no inventory statements.

| Guard | Where | Mechanism |
|-------|-------|-----------|
| Webhook claim | `webhook_events` | Claim before side effect. Failed claims retry. Stale `processing` claims are reclaimed after a 5-minute lease. |
| Payment record | `order_payments` | Unique index on `(payment_method, provider_ref)` where `provider_ref` is not null |
| Status guard | `getUnpayableOrderReason()` | Refuses an order that cannot take a payment |
| Version CAS | `orders.version` | The batch fails if the order changed |

Gateway port rules: [payments README](../packages/core/src/modules/payments/README.md).

## Settings documents

A settings document is one `settings` row: `category` is the document key, `key` is `'document'`, `value` is JSON and `revision` is the CAS counter. A domain declares each document with `defineSettingsDocument()` (`packages/core/src/settings-store/index.ts`), the only code that reads or writes document rows. Secret fields hold `enc:` ciphertext under `CREDENTIAL_ENCRYPTION_KEY` and are decrypted strictly. The `platform` and `security` documents also have a KV mirror. "Declared in" paths are under `packages/core/src/modules/`.

| Document key | Declared in | Holds | Secret fields |
|--------------|-------------|-------|---------------|
| `platform` | `platform/document.ts` | Public origins, cookie domain, CORS origins, identity handoff | -- |
| `notifications`, `notification_templates` | `notifications/documents.ts` | Channel rules, staff email recipients, WhatsApp order template, message copy | -- |
| `delivery_pickup` | `delivery/zones.ts` | Revision counter for the local pickup rates (store-wide, no zone) | -- |
| `inventory` | `products/low-stock-policy.ts` | Default low-stock threshold | -- |
| `staff-shortcuts:<userId>` | `settings/staff-shortcuts.ts` | One staff member's keyboard shortcuts | -- |
| `checkout`, `customer_auth`, `customer_countries`, `customer_requests`, `marketing_consent` | `settings/documents.ts` | Checkout flow, sign-in policy, phone countries, buyer requests, marketing consent | -- |
| `currency`, `business`, `seo`, `media`, `security`, `policies`, `emi`, `reviews`, `gift_cards` | `settings/documents.ts` | Currency, business identity, discovery policy, media hosts, CSP sources, policy pages, EMI plans, review and gift-card defaults | -- |
| `email`, `whatsapp`, `sms`, `firebase` | `settings/documents.ts` | Messaging providers | Resend key, WhatsApp token, SMS keys, service account |
| `stripe`, `payment_methods` (and the retired `sslcommerz`, cleared by the Bangladesh pack's activation) | `settings/documents.ts` | Stripe and the checkout method allowlist | Stripe secret and webhook secret (old SSLCommerz store password) |
| `meta_conversions` | `settings/documents.ts` | Meta Conversions API | Access token |
| `plugin_registry` | `plugins/registry-trust.ts` | App registries and trusted developer keys (Super Admin only) | -- |

Fraud-checker provider rows (`category = 'fraud-checker'`) and `notification_provider_health` markers share the table but are not documents. The storefront theme is not a settings document: it lives in `theme_settings` and `theme_settings_drafts`.

## List pagination

Lists that can grow large use keyset (cursor) paging: the admin orders, products and customers lists and the public product listing. A cursor names the last row shown. Totals are exact up to a plan cap and read "N+" above it. Numbered `page` requests work only for shallow offsets (`planLimits().lists`). Code: `packages/shared/src/pagination.ts` (cursors) and `packages/core/src/utils/keyset.ts` (SQL). `apps/api/src/routes/admin/list-cursor-contract.test.ts` pins the contract.

## How to extend

### Add a feature to an existing domain

1. Put the code in the owning domain. Export what other code may call from `index.ts`. Export pure types and policies from `browser.ts` and keep it closed.
2. Add routes in the owning route file, permissions in `route-permissions/<area>.ts` and agent operations in `operation-registry/<surface>-<area>.ts`.
3. If one domain imports another for the first time, run `node scripts/core-boundaries.mjs --write-allowlist` and justify the edge in review. Prefer moving the code.

### Add a domain

1. Create `packages/core/src/modules/<domain>/index.ts`, and `browser.ts` if other code needs pure types or policies.
2. Add `./modules/<domain>` (and `/browser`) to the `packages/core/package.json` exports. `scripts/core-boundaries.mjs` fails until the map and the directories agree.
3. Add its route permission file and registry files.
4. Mount its routers in `apps/api/src/app.ts` and in the matching `apps/api/src/runtime/<family>-app.ts`.
5. Record its domain edges in the allowlist.

### Add a built-in payment gateway

Paths are under `packages/core/src/modules/payments/` unless stated.

1. Write `gateways/<id>.ts` implementing `PaymentGateway` (`gateways/port.ts`).
2. Add the adapter to `BUILT_IN_GATEWAYS` in `gateways/registry.ts` and its id to `BUILT_IN_PAYMENT_GATEWAY_IDS` in `gateways/identity.ts`. `gateways/gateway-kernel.test.ts` keeps both lists equal.
3. Declare its credential document in `packages/core/src/modules/settings/documents.ts` and its reader in `gateway-settings.ts`.

A third party builds a payment provider as an app: [plugin-sdk README](../packages/plugin-sdk/README.md), "Build a payment provider".

### Add a courier

Core has no courier of its own. A courier is an app's courier provider ([plugin-sdk README](../packages/plugin-sdk/README.md), "Build a courier"); a regional one belongs in that country's pack (the Bangladesh pack holds Pathao and Steadfast). Anything the courier needs from the platform goes into the courier port (`packages/shared/src/plugins/providers/courier.ts`), never into a core adapter.

### Add a built-in SMS provider

1. Write `packages/core/src/integrations/sms/providers/<id>.ts`.
2. Add its id to `BUILT_IN_SMS_PROVIDER_IDS` (`integrations/sms/port.ts`) and its adapter to `BUILT_IN_SMS_ADAPTERS` (`integrations/sms/sms-settings.ts`).
3. Add its credential fields to `smsDocument` in `packages/core/src/modules/settings/documents.ts`, with secret fields.

The notification channels (`email`, `sms`, `whatsapp`, `push`) are fixed in the `notifications` domain.

## Key invariants

1. Stock is deducted on shipment, not on payment.
2. Every status transition passes the state machine. Shipped, delivered and returned come only from fulfilment actions.
3. Every stock mutation uses a `stockVersion` CAS and writes its ledger-v2 edge in the same batch.
4. Payment confirmation is one `safeBatch()` across the order, the payment record and the payment plan.
5. Webhook handlers claim before side effects. A duplicate returns success. A failed queue send marks the event failed and returns a retryable error.
6. API responses use the envelope `{ success: true, data: T }`. Consumers read `data` (the storefront uses `apps/storefront/src/lib/api/unwrap.ts`).
7. Secrets come from `env.*` at request time, never from `import.meta.env` at build time.
8. Core domains are reached only through their entries. The domain graph is acyclic and only shrinks.
