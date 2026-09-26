# Scalius Commerce — Architecture & Module Communication Guide

> How everything works, how domains talk to each other, and where the boundaries are.

The measured stable-release performance baseline, retained optimizations, and
rewrite thresholds are recorded in [PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md).
How a storefront page renders from one API batch, the per-page API and D1
budgets, API placement, and `pnpm perf:storefront` are in
[STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md).
Public cache validity, dependency triggers, and the one-second edge freshness
contract are in [CACHE-FRESHNESS.md](./platform/CACHE-FRESHNESS.md).


## System Overview

```
Browser (Admin)                  Browser (Customer)
    │ dashboard host                   ↓
    │                 ┌────────────────────────────────┐
    │                 │  Storefront Worker (SSR) :4322 │
    │                 └───────────────┬────────────────┘
    │                                 │ Service Binding
    ↓                                 ↓
┌─────────────────────────────────────────────────────┐
│  API Worker (Hono) :8787                             │
│  ├─ Dashboard SPA (ASSETS) + Better Auth /api/auth   │
│  ├─ Routes (thin HTTP layer, lazy route families)    │
│  ├─ Middleware (auth, RBAC, cache, CSP)              │
│  ├─ Queue Consumer (payment, notification, OTP+DLQs) │
│  └─ Cron every 15 min (scheduled maintenance)        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  @scalius/core (domain services)                     │
│  27 domains under src/modules, plus auth,            │
│  integrations, search, errors, utils                 │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  @scalius/database (Drizzle + relational providers)   │
│  Canonical schema, migrations, and atomic invariants  │
└─────────────────────────────────────────────────────┘
```

The API Worker loads route graphs lazily per family
(`apps/api/src/runtime/fetch-runtime-app.ts`: probe, public, admin, system,
docs; `runtime/admin-app.ts` and `runtime/public-app.ts` split those further).
The Worker entry's static graph stays small: it reads platform origins through
the `platform` domain only.

## Layer Rules

Dependencies flow **downward only**. The checks named below are the authority;
this document does not certify a clean tree by itself.

| Layer | May import | Never imports |
|-------|-----------|---------------|
| Dashboard browser code (`apps/admin-v2/src`) | `@scalius/shared`, `@scalius/api-client`, `@scalius/core/modules/<domain>/browser` | A domain `index`, any deeper core path, relational provider clients |
| API routes (`apps/api/src/routes/`) | `@scalius/core/modules/<domain>` and `/browser`, `@scalius/database`, `@scalius/shared` | Deeper core paths; nothing imports routes |
| Core domains (`packages/core/src/modules/<domain>/`) | Their own files, other domains' public files, `@scalius/database`, `@scalius/shared` | Routes, apps, other domains' internal files |
| Schema (`@scalius/database/schema/`) | `drizzle-orm` only | Services or routes |
| Shared (`@scalius/shared/`) | Nothing | Pure utilities |
| Storefront (`apps/storefront`) | `@scalius/shared`, `@scalius/api-client` | `@scalius/core`, `@scalius/database` |

The admin production build also scans every emitted browser asset for
relational provider markers, so server code that reaches the dashboard
indirectly still fails the build.

Worker bindings, database/auth/provider clients, credentials, in-flight I/O,
and tenant data are request-scoped. The API Worker creates them from the
current request context and never retains them in module variables. Deep media
projection is the sole implicit request context: the API wraps each request in
Cloudflare's `AsyncLocalStorage` with only the normalized public media base
URL. `scripts/check-source-policies.mjs` (run by the API build and by the test
suite) rejects mutable server module variables, the known historical
client/cache globals, and the structural import/sink policies listed there.

---

## Core Domains

Each directory under `packages/core/src/modules/` is one domain with at most
two public entries:

- `index.ts` — the domain's server API (everything other code may call);
- `browser.ts` — only when the domain has pure types and policies other code
  needs without its server graph. It is closed: every file it reaches, types
  included, is itself exported by a browser entry, and it imports nothing but
  `zod`, `@scalius/shared/*` and other browser files.

| Domain | Owns | Entries |
|--------|------|---------|
| `orders` | The order record: dashboard list/detail, manual orders and COD amendments, detail edits, archive, the status lifecycle kernel (`status/`), returns, invoices, receipts, lookup, payment recovery | index, browser |
| `checkout` | Storefront cart validation, the checkout authority and policy, delivery preflight and pricing, idempotent attempts, the single commit and post-commit side effects, quote fingerprint, abandoned checkouts | index, browser |
| `fulfilment` | The actions that hand units over, all written to the fulfilment ledger (`ledger.ts`, the only writer of `order_fulfillments`; `fulfilled_quantity` is its trigger projection): own-rider parcels, courier bookings and their reconciliation, pickup (ready / picked up with cash at the counter), service done, void, delivery outcomes (delivered, COD collected/failed/returned), and the fulfiller registry plus the automatic-fulfilment seam (Wave B fulfillers) | index |
| `products` | The merchant-edited product aggregate (products, SKUs, options, media, validation, aggregate revision) and the product rules others read through (public eligibility, buyer pricing, money) | index |
| `catalog` | Buyer-facing catalogue reads: listings, facets, product page, search, feeds, sitemaps, recommendations, storefront sections, feed diagnostics | index |
| `categories`, `collections`, `attributes` | Their records, publication rules and admin writes; `categories` also owns the tree (placement pre-check, moves, trash rules and tree reads over the trigger-maintained closure) | index, browser |
| `brands` | Brand records, their revision-guarded writes and buyer reads (brand page, list, sitemap); `catalog` joins a product's published brand through it | index, browser |
| `inventory` | Reservations, deductions, releases, restores, ledger v2, low-stock alerts, stock adjustment | index |
| `payments` | Gateway port and adapters, sessions, payment application, refunds and reconciliation, COD records | index, browser |
| `delivery` | Courier providers, shipments, tracking, delivery zones and locations | index, browser |
| `promotions` | The discount engine, checkout snapshots, redemptions | index, browser |
| `tax` | Tax classes, rates, the quote calculator | index, browser |
| `customers` | Customer records, account auth and OTP, identity, order claims | index, browser |
| `notifications` | Order notification outbox, delivery receipts, templates, provider health | index, browser |
| `conversations` | Buyer↔store threads (empty until Wave A) | index, browser |
| `reviews` | Verified-purchase reviews of delivered lines, moderation, replies, the rating projection, review requests (stubs until Wave B B1) | index, browser |
| `digital` | Private-R2 files, licence-key pools that are the variant's stock, entitlements, cookie-bound download tickets (stubs until B3) | index, browser |
| `gift-cards` | Codes, the append-only balance ledger, issue, redemption as a tender, release and refund credit (stubs until B4); a leaf domain that imports no other domain | index, browser |
| `warranty` | Revisioned warranty policies, per-fulfilment-line warranty records, claims backed by threads (stubs until B5) | index, browser |
| `settings` | Typed settings documents, their store, and the settings services | index, browser |
| `platform` | Public origins, CORS and identity handoff for the Worker entry | index |
| `media`, `pages`, `navigation`, `hero-sliders`, `storefront`, `analytics`, `fraud-checker` | Their records and reads | index (browser where listed in `package.json`) |
| `agent-access`, `agent-storefront` | Agent connections and the agent storefront workflows | index |

### How the boundaries are enforced

1. **Exports map.** `packages/core/package.json` exports exactly
   `./modules/<domain>` and, where it exists, `./modules/<domain>/browser`.
   `apps/api` and `apps/admin-v2` resolve `@scalius/core` through that map (no
   `tsconfig` path alias), so `@scalius/core/modules/<domain>/<file>` fails to
   compile and to resolve in tests. `@scalius/core/testing` carries test-only
   fixtures (the fake payment gateway) for other packages' tests.
2. **Source policies** (`scripts/check-source-policies.mjs`, samples in its
   test): no deep `@scalius/core/modules` path anywhere; dashboard code imports
   only browser entries; and `scripts/core-boundaries.mjs` checks the exports
   map against the domain directories, that every cross-domain import inside
   core resolves to a file the other domain's entries export, and that browser
   entries are closed.
3. **Graph ratchet** (`scripts/core-domain-graph.test.mjs`): the directed
   domain edges (type imports included) must equal
   `scripts/core-domain-graph.allow.json`. A new edge needs a reviewed
   allowlist diff; a removed edge must be deleted from the allowlist, so the
   graph only shrinks. `node scripts/core-boundaries.mjs --write-allowlist`
   regenerates it.
4. **Dashboard boundary test**
   (`apps/admin-v2/src/lib/browser-core-boundaries.test.ts`) and the admin
   build's bundle scan.

Inside core, a domain imports another domain's *public file* directly
(`../payments/refund-service`) rather than through its `index.ts`. The domains
still form one dependency cycle group, and routing internal imports through
the barrels turns that into module-level cycles where values read while a
module loads (zod schemas, document definitions, registries) are not yet
defined. The public-file rule keeps the same boundary without that hazard.

### The dependency graph

The allowlist has 93 directed edges. Fifteen domains form one cycle group
(catalog, categories, collections, customers, delivery, inventory, media,
notifications, orders, pages, payments, products, promotions, settings, tax);
the reciprocal pairs are the debt to pay down first:

| Pair | Why it exists today |
|------|--------------------|
| orders ↔ payments | Payment application moves order status; order reads show payment facts. The atomic commit coupling below is intentional. |
| inventory ↔ products | Stock writes read product pricing and SKU rules; product writes record stock movements. |
| customers ↔ orders | Order commits update customer stats; customer views read order money and support requests. |
| delivery ↔ orders | Courier tracking moves order status; order code reads delivery location names. |
| payments ↔ settings | Gateway settings documents; checkout flow reads the gateway registry. |
| notifications ↔ settings | Channel preferences live in settings; settings validate notification types. |
| media ↔ settings | Media usage reads presentation documents; settings resolve media. |

Moving the buyer reads out of `products` into `catalog` removed
`products → categories` and `products → promotions`, so `categories ↔ products`
and `products ↔ promotions` are gone; `catalog` depends on `products`, never
the reverse.

#### The intentional triangle

```
       ORDERS
      /       \
     /    DB    \
    /   batch()  \
PAYMENTS ──── INVENTORY
```

Payment confirmation must atomically update inventory and order status. The
provider-backed `safeBatch()` boundary keeps all three consistent or none.

### Per-domain registries and seams

Shared composition files are split so features in different domains never
edit the same file:

- Route permissions: `packages/core/src/auth/rbac/route-permissions/<domain>.ts`,
  merged by `index.ts`. A path pattern belongs to exactly one file, and no two
  files can match the same path at the same specificity (tested), so the merge
  order never decides a lookup.
- Agent operation registry: `apps/api/src/openapi/operation-registry/<surface>-<domain>.ts`,
  merged by `index.ts` (row shape in `entry.ts`). An operation id belongs to
  exactly one file (tested).
- Order routes: `apps/api/src/routes/storefront-orders/`,
  `routes/customer-auth/` and `routes/admin/orders/`, one router per flow. Each
  `index.ts` mounts them in registration order, which is also the published
  OpenAPI path order.
- Conversation seams: the `conversations` domain entries, and empty routers
  mounted once (`routes/customer-auth/conversations.ts`,
  `routes/storefront-orders/conversation.ts`, `routes/admin/conversations.ts`).
- Order-line extras: `apps/api/src/routes/shared/order-line-extras.ts` composes
  each item's review, downloads, licence keys, gift cards and warranty from the
  four Wave B domains at the API layer (never inside `orders`, which would make
  cycles) for the receipt, the account order and the admin order.
- Automatic fulfilment: `apps/api/src/utils/auto-fulfil-queue.ts` sends
  `order.auto_fulfil` after every commit that settles payment; it never throws,
  and the 15-minute sweep is the backstop.

## Runtime Configuration Boundary

Wrangler configs declare resource bindings only; they carry no `vars`. Each
Worker installs exactly one master secret, `SCALIUS_SECRET` (plus
`CREDENTIAL_ENCRYPTION_KEY` on the API). Every per-purpose secret is
HKDF-derived from the master at Worker entry in
`packages/shared/src/runtime-secrets.ts`.

Public origins are merchant settings, not deployment configuration. The API
resolves them per invocation in `apps/api/src/runtime/runtime-env.ts` through
the `platform` domain, which returns a request-scoped env carrying the derived
secrets and the resolved `PLATFORM_CONFIG`; consumers keep reading fields such
as `env.STOREFRONT_URL` without knowing where the value came from. The
storefront Worker holds no origins of its own: it reads them from
`GET /api/v1/storefront/layout` through its service binding and falls back to
its own request origin for its own URL. The dashboard SPA needs no origins: it
calls the same-origin API Worker that serves it. Local development substitutes
fixed localhost ports in code.

Automated and managed deployments extend this boundary without widening it.
Seven opt-in contracts — a gated first-admin setup token, external identity
handoff, `GET /api/v1/meta`, a runtime dashboard path prefix, signed front-proxy
headers, a Wrangler-free migration plan, and a headless demo-store export — are
all off by default, add no `vars` and no installed secret, derive their keys
from the same master secret, and store their flags in the same Platform settings
document. See [AUTOMATED-DEPLOYMENTS.md](AUTOMATED-DEPLOYMENTS.md).

### Build outputs and secrets

No build inlines a local value. Secrets reach a Worker only through its `env`
at request time; `.dev.vars` and `.env*` exist for `wrangler dev`/`astro dev`
bindings and never for a bundle.

- Storefront: Astro inlines every non-`PUBLIC_` variable it can see (Vite env
  files plus all of `process.env`) as string literals wherever server code
  reads `import.meta.env.NAME`, and wherever a module mentions a bare
  `import.meta.env` (even in a comment) it inlines every variable the module's
  text names. `@astrojs/cloudflare` copies `.dev.vars` into `process.env`
  before the build, and the Cloudflare Vite plugin writes `.dev.vars` into
  `dist/server/`. `apps/storefront/integrations/build-env-isolation.mjs`
  rewrites every module so only the built-in keys (`DEV`, `SSR`, `PROD`,
  `MODE`, `BASE_URL`, `SITE`, `ASSETS_PREFIX`) survive, turns off Vite env
  files, and drops env files from the bundle.
- Dashboard: `envDir: false`; it reads no env.
- API: `wrangler deploy` bundles with esbuild and inlines no env.
- Source policy (`scripts/check-source-policies.mjs`): storefront and dashboard
  code use only the built-in `import.meta.env` keys and never `process.env`.
- `pnpm check:dist-secrets` (`scripts/check-dist-secrets.mjs`) scans every
  `dist/` file for env files, `import.meta.env` objects with extra keys, and
  known secret names or names from the app's local env files bound to string
  literals, reporting names only. `pnpm check:build-canaries`
  (`scripts/check-build-canaries.mjs`) builds a throwaway copy of each app with
  canary `.dev.vars`/`.env*` files, canary shell secrets and, for the
  storefront, a probe route that reads them, and fails if any canary reaches
  `dist/`. `pnpm run deploy*` runs both after the build, before any upload.

## Database Provider Boundary

D1 remains the zero-configuration starter database. TursoDB is the portable
external SQLite option whose hosted concurrency must be qualified against the
exact service generation, and PostgreSQL/Neon is the proven high-throughput
tier; selecting any provider is not by itself an orders-per-second guarantee.
Routes and domain services receive the same `@scalius/database` surface;
provider selection, transport adaptation, capability fallbacks, atomic writes,
and conflict retry stay inside the database/core boundaries. Do not add
provider branches throughout domain code.

This repository is the per-merchant commerce runtime. Provisioning, desired
state, deployments, domains, migration orchestration, monitoring, rollback
retention, and resource retirement belong to deployment operations, not Worker
request paths. A provider switch is valid only after a write freeze, a
revision-fenced canonical source snapshot, canonical normalization, verified
target import, and exact logical schema/data fingerprints. See
[Database portability and cutover](DATABASE-PORTABILITY.md).

The current root deploy command is a single-merchant operational deployment: it
deploys the API Worker (which also serves the dashboard SPA) and the storefront
Worker from fixed Wrangler configuration.

---

## The Order Lifecycle

### Entry Points

```
STOREFRONT CHECKOUT (checkout)       ADMIN DASHBOARD (orders)
├─ POST /orders                      ├─ POST /admin/orders
│  └─ Synchronous atomic commit      │  └─ Synchronous manual-order workflow
│     1. One read batch: idempotency │     with its own idempotency authority
│        row + checkout authority +  │     (orders/admin/create-attempts.ts)
│        customer and SKU rows       │
│     2. Price, quote fingerprint,   │
│        policy (memory only)        │
│     3. One guarded write batch:    │
│        order, items, SKU hold      │
│        (ledger v2 + stockVersion), │
│        attempt, receipt, outboxes  │
│     4. Post-commit side effects    │
```

Every storefront and agent checkout, for every payment method and inventory
pool, commits through `commitStorefrontOrderPayload` (`checkout/commit.ts`): a
D1 `batch()` (a real transaction on TursoDB/PostgreSQL) of guarded statements.
Order items exist when the response is sent; there is no Durable Object,
deferred projection, or reservation lane. Stock holds live only on
`product_variants` (`reserved_stock`, `stock_version`) with one ledger-v2
movement per change.

### Statuses and where they come from

```
INCOMPLETE ──→ PENDING ──→ (PROCESSING) ──→ CONFIRMED ──→ SHIPPED ──→ DELIVERED ──→ COMPLETED
     │            │              │              │            │            │
     │            │              │              │            │            └──→ RETURNED ──→ REFUNDED
     │            │              │              │            └──→ RETURNED
     └────────────┴──────────────┴──────────────┴──→ CANCELLED (terminal)
```

The state machine (`packages/shared/src/order-state.ts`, checked by
`validateTransition()` in `orders/status/state-machine.ts`) lists every legal
move. Who may make it is narrower:

- **The generic status editor** (`updateOrderStatus`, dashboard and agents
  alike; `orders/status/policy.ts`) makes only side-effect-free moves:
  incomplete → pending, pending/processing → confirmed, → cancelled, and
  delivered → completed.
- **Shipped, delivered and returned are fulfilment facts.** They come only
  from real actions in `fulfilment`: Mark as sent / Book courier (shipped),
  cash collected or Mark delivered once everything is sent (delivered), Mark
  returned or a return (returned). Each records what moved and moves the stock
  with it through the lifecycle kernel `applyOrderStatusChange`
  (`orders/status/lifecycle.ts`).
- **Refunded** comes from the refund workflow (`payments`).
- **Delivered needs settled money**: a COD order must already have its cash
  recorded.
- **Cancel** is refused while any unit is with the courier, and generic
  cancellation is limited to unpaid orders with no payment in flight; paid
  orders are cancelled by the refund workflow.

Wave A adds per-line fulfilment types (ship, pickup, digital, gift card,
service) and a fulfilment ledger in the `fulfilment` domain without new order
statuses (`audit/rewrite-2026-09-23/WAVE-A-DESIGN.md` §2).

| Move | Inventory (`inventory/inventory-transitions.ts`) | Notification |
|------|-----------|-------------|
| → pending | Stock reserved | `order_created` |
| → processing / confirmed | Stays reserved | `order_processing` / `order_confirmed` |
| → shipped | Reserved → deducted | `order_shipped` |
| → delivered | Deducts reserved stock if not yet deducted | `order_delivered` |
| → completed | No change | `order_completed` |
| → cancelled | Reserved stock released; deducted stock restored | `order_cancelled` |
| → returned | Deducted stock restored, unless an open return owns it (its receipt restocks good units and writes off damaged ones) | `order_returned` |
| → refunded | Reserved stock released; deducted stock restored | `order_refunded` |

### The cascade

```
Fulfilment action / webhook / generic editor
    ↓
1. validateTransition() — state machine
    ↓
2. CAS update — orders.version (admin changes and webhooks cannot both win)
    ↓
3. applyInventoryForStatusChange() — reserve / deduct / release / restore
   with deterministic movement claims and stockVersion CAS
    ↓
4. Notification recorded in notification_outbox, relayed to JOBS_QUEUE
    ↓
5. Queue consumer dispatches each enabled channel independently
   (email, SMS, WhatsApp, admin push)
```

`ORDER_NOTIFICATION_TYPES` (`notifications/notification-types.ts`) is the
source of truth for order notifications: order created/confirmed/processing/
shipped/delivered/completed/cancelled/returned, refund processing/failed/
refunded/partially refunded, balance paid, and support request
submitted/updated.

---

## Inventory State Machine

```
                   ┌──────────┐
                   │   NONE   │
                   └────┬─────┘
                        │ (order created)
                        ↓
                   ┌──────────┐
            ┌──────│ RESERVED │──────┐
            │      └────┬─────┘      │
            │           │            │
    (cancelled)    (shipped/    (projection
     pre-ship)      delivered)    repair)
            │           │            │
            ↓           ↓            ↑
    ┌──────────┐  ┌──────────┐       │
    │ RESTORED │  │ DEDUCTED │       │
    └──────────┘  └────┬─────┘       │
            ↑          │             │
            │    (cancelled/         │
            │     returned           │
            │     post-ship)         │
            └──────────┘─────────────┘
```

**Transition protection:** order status inventory transitions write a
deterministic, movement-generation-based `inventory_movements.id` claim and the
variant counter CAS update in one provider-backed `safeBatch()`. Exact
duplicate `transition:*` claims are idempotent retries, mismatched duplicate
claims fail closed for manual reconciliation, and the final
`orders.inventoryAction` update is CAS-guarded against the action observed
before the stock transition. Every stock mutation uses `stockVersion` with
bounded conflict retry.

---

## Money

Money is stored and computed as integer minor units of the order or store
currency (`*_minor` columns, `packages/shared/src/money.ts`). Gateways receive
integer minor units plus an ISO 4217 code across the payment port; the HTTP
contract carries decimal major units, converted once at the edge.

## Payment Processing Pipeline

```
Browser → Storefront Proxy → API Worker → Gateway
                                              │
                                         (async webhook)
                                              │
                                              ↓
                                    Webhook Handler (API)
                                    ├─ Verify with the gateway adapter
                                    ├─ Claim durable webhook_events row
                                    └─ Enqueue JOBS_QUEUE (payment.event)
                                              │
                                              ↓
                                    Queue Consumer
                                    └─ processPaymentConfirmed()
                                       ├─ Dedup on (payment_method, provider_ref)
                                       ├─ Validate state machine
                                       └─ Atomic batch: payment row, order,
                                          inventory statements, payment plan
```

| Layer | Where | Mechanism |
|-------|-------|-----------|
| 1. Webhook claim | `webhook_events` | Claim-before-side-effect with retryable failed claims and lease-reclaimable stale processing claims |
| 2. Queue dedup | Cloudflare native | Per-message id tracking |
| 3. DB dedup | Unique index | `UNIQUE(payment_method, provider_ref)` on `order_payments` |
| 4. Status guard | `processPaymentConfirmed()` | Skip when the order is already paid |

See `packages/core/src/modules/payments/README.md` for the gateway port rules.

---

## Notification System

```
JOBS_QUEUE message arrives
    ↓
Claim notification_outbox by outboxId
    ↓
sendOrderNotificationEmail(..., { outboxId })
    ↓
Read channel preferences (notifications settings document)
    ↓
For each enabled customer target:
    ├─ Claim notification_delivery_receipts row
    ├─ EMAIL: Cloudflare Email Service by default, Resend fallback
    ├─ SMS: active SMS provider
    └─ WHATSAPP: Meta Cloud API template
    ↓
sendOrderNotification(..., { outboxId }) for admin FCM push when enabled
    ↓
Mark parent outbox sent only when enabled receipts are accepted/skipped
```

| Gap | Current | Should be |
|-----|---------|-----------|
| Shipment-only statuses (`out_for_delivery`, `on_hold`, `delivery_failed`) | Internal status only | Explicit templates/settings before customer-facing shipment-progress notifications |
| Admin push provider | Firebase FCM only | A first-party Web Push or Cloudflare-native alternative |
| WhatsApp provider idempotency | Local D1 receipt fence only | Upstream provider idempotency if Meta exposes a key |

---

## Delivery Webhook → Order Status → Inventory

```
Pathao/Steadfast Webhook
    ↓
Verify signature + KV idempotency
    ↓
Update deliveryShipments
    ↓
If status changed:
    ├─ mapProviderStatus() → normalized status
    ├─ updateOrderStatusFromShipment()   (delivery/tracking.ts)
    │   ├─ Validate transition (state machine)
    │   ├─ CAS update on orders.version (admin changes take priority)
    │   └─ applyInventoryForStatusChange()
    └─ enqueueOrderStatusChangeNotification()
```

| Provider event | Normalized | Order status |
|---------------|------------|-------------|
| order.picked / in-transit | shipped | SHIPPED |
| order.delivered | delivered | DELIVERED |
| order.returned | returned | RETURNED |
| order.delivery-failed | failed | → CONFIRMED (revert) |
| order.cancelled | cancelled | CANCELLED |

---

## Settings Architecture

Settings are typed documents: one `settings` row per document (`category` =
document key, `key = 'document'`, JSON `value`, CAS `revision`), defined in
`packages/core/src/modules/settings/documents.ts` and read/written only through
`defineSettingsDocument()` (`settings-store.ts`). Secret fields are `enc:`
ciphertext under `CREDENTIAL_ENCRYPTION_KEY`, decrypted strictly.

| Document | Purpose | Secret fields |
|----------|---------|---------------|
| `platform` | Public storefront/API/dashboard/media origins, customer cookie domain, extra CORS origins (service in the `platform` domain) | -- |
| `checkout`, `customer_auth`, `customer_countries`, `customer_requests`, `currency` | Checkout flow, sign-in policy, phone countries, buyer requests, currency | -- |
| `header`, `footer`, `homepage`, `seo`, `media`, `security`, `business` | Storefront presentation, discovery, media delivery, CSP, business identity | -- |
| `notifications` | Per-event channel preferences and order WhatsApp template | -- |
| `email`, `whatsapp`, `sms`, `firebase` | Notification/OTP providers | Resend key, WhatsApp token, SMS credentials, service account |
| `stripe`, `sslcommerz`, `payment_methods` | Payment gateways and checkout method allowlist | Gateway secrets |
| `meta_conversions` | Meta CAPI | Access token |

Fraud-checker provider rows and `notification_provider_health` pause markers
share the table but are not documents.

---

## Release posture

Numeric architecture scores and blanket "production-ready" claims are not used.
Release confidence comes from invariant tests, sequential package gates,
deployed Cloudflare smokes, and current operational evidence. The
orders/payments/inventory triangle stays intentionally coupled at its atomic
commit boundary; every other dependency is recorded in the graph allowlist and
should shrink.

---

## How to Extend

### Add a feature to an existing domain
1. Put the code in the owning domain; export what other code may call from its
   `index.ts` (and pure types or policies from `browser.ts`, keeping it
   closed).
2. Add its routes in the owning route file or folder, its permissions in
   `route-permissions/<domain>.ts`, and its agent operations in
   `operation-registry/<surface>-<domain>.ts`.
3. If it makes one domain import another for the first time, run
   `node scripts/core-boundaries.mjs --write-allowlist` and justify the new
   edge in review. Prefer moving the code instead.

### Add a new domain
1. Create `packages/core/src/modules/<domain>/index.ts` (and `browser.ts` if
   it has pure types or policies others need).
2. Add `./modules/<domain>` (and `./modules/<domain>/browser`) to
   `packages/core/package.json` exports; `check-source-policies` fails until
   the map and the directories agree.
3. Add its route permission file and registry file(s), and mount its routers
   once in `apps/api/src/app.ts` and the matching runtime family app.
4. Record its domain edges in the allowlist.

### Add a payment gateway
1. Write `payments/gateways/<id>.ts` implementing `PaymentGateway` from
   `gateways/port.ts`.
2. Add one line to `PAYMENT_GATEWAYS` in `gateways/registry.ts`.
3. Define its credential document in `settings/documents.ts` and its reader in
   `payments/gateway-settings.ts`.

### Add a delivery provider
1. `packages/core/src/modules/delivery/providers/{provider}.ts` — implement the
   provider interface.
2. `packages/core/src/modules/delivery/factory.ts` — register it.
3. `apps/api/src/routes/webhooks/{provider}.ts` — webhook handler.

### Add a notification channel
1. Add channel dispatch in `notifications/notifications.service.ts`.
2. Add the channel key to the dashboard channel builder.
3. The queue consumer already handles channels generically.

---

## Key Invariants (Never Break These)

1. **Inventory deduction happens on shipment, not on payment** — stock stays reserved until physically sent.
2. **All status transitions go through `validateTransition()`**, and fulfilment statuses only through real actions.
3. **All stock mutations use `stockVersion` CAS** with ledger-v2 edges in the same batch.
4. **All payment processing uses `safeBatch()`** — atomic across order + payment + inventory on the selected provider.
5. **Webhook handlers claim before side effects** — duplicates return success; queue-send failures mark the event failed and return retryable errors.
6. **Response envelope is always `{ success: true, data: T }`** — storefront proxies unwrap before returning to the browser.
7. **Secrets come from `env.*` (runtime), never `import.meta.env` (build time).**
8. **Storefront imports `@scalius/shared` and `@scalius/api-client` only** — never `@scalius/core` or `@scalius/database`.
9. **Core domains are reached only through their entries**, and the domain graph only shrinks.
