# Scalius Commerce — Architecture & Module Communication Guide

> How everything works, how modules talk to each other, and where the boundaries are.

The measured stable-release performance baseline, retained optimizations, and
rewrite thresholds are recorded in [PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md).


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
│  ├─ Routes (thin HTTP layer)                         │
│  ├─ Checkout DOs (sharded ingress + bounded commit)  │
│  ├─ Middleware (auth, RBAC, cache, CSP)              │
│  ├─ Queue Consumer (payment, notification, OTP+DLQs) │
│  └─ Cron every 15 min (scheduled maintenance)        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  @scalius/core (Domain Services)                     │
│  Commerce modules + auth + integrations + search     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  @scalius/database (Drizzle + relational providers)   │
│  Canonical schema, migrations, and atomic invariants  │
└─────────────────────────────────────────────────────┘
```

## Layer Rules

Dependencies are expected to flow **downward only**. Boundary tests and current
package checks are the authority for whether that remains true; this document
does not certify a clean tree by itself.

| Layer | May Import | Never Imports |
|-------|-----------|---------------|
| Admin browser routes/components | `@scalius/shared`, `@scalius/api-client`, browser-safe `@scalius/core` leaf modules | Relational provider clients or broad server-bearing core module barrels |
| Routes (apps/api/src/routes/) | @scalius/core, @scalius/database | Nothing imports routes |
| Services (@scalius/core/modules/) | @scalius/database, @scalius/shared | Never imports routes |
| Schema (@scalius/database/schema/) | drizzle-orm only | Never imports services or routes |
| Shared (@scalius/shared/) | Nothing | Pure utility, no dependencies |

The admin production build scans every emitted browser asset for relational
provider implementation markers. This is a transitive boundary check: it fails
even when database code reached the browser indirectly through a re-export
barrel. UI code that needs a pure policy or type imports its leaf module.

Worker bindings, database/auth/provider clients, credentials, in-flight I/O,
and tenant data are request-scoped. The API Worker creates them from
the current request context and never retains them in module variables. Deep
media projection is the sole implicit request context: the API wraps each request in Cloudflare's
`AsyncLocalStorage` with only the normalized public media base URL, allowing
concurrent merchant requests to remain isolated without threading presentation
configuration through every domain-service signature. The API production build
runs `scripts/check-source-policies.mjs` (also run by `pnpm test`), which rejects mutable server
module variables, the known historical client/cache globals, and the other
structural import/sink policies listed in that file.

## Runtime Configuration Boundary

Wrangler configs declare resource bindings only; they carry no `vars`. Each
Worker installs exactly one master secret, `SCALIUS_SECRET` (plus
`CREDENTIAL_ENCRYPTION_KEY` on the API). Every per-purpose secret is
HKDF-derived from the master at Worker entry in
`packages/shared/src/runtime-secrets.ts`.

Public origins are merchant settings, not deployment configuration. The API
resolves them per invocation in `apps/api/src/runtime/runtime-env.ts`, which
returns a request-scoped env carrying the derived secrets and the resolved
`PLATFORM_CONFIG`; consumers keep reading fields such as `env.STOREFRONT_URL`
without knowing where the value came from. The storefront Worker holds no
origins of its own: it reads them from `GET /api/v1/storefront/layout` through
its service binding and falls back to its own request origin for its own URL.
The dashboard SPA needs no origins: it calls the same-origin API Worker that
serves it. Local
development substitutes fixed localhost ports in code.

Automated and managed deployments extend this boundary without widening it.
Seven opt-in contracts — a gated first-admin setup token, external identity
handoff, `GET /api/v1/meta`, a runtime dashboard path prefix, signed front-proxy
headers, a Wrangler-free migration plan, and a headless demo-store export — are
all off by default, add no `vars` and no installed secret, derive their keys
from the same master secret, and store their flags in the same Platform settings
document. See [AUTOMATED-DEPLOYMENTS.md](AUTOMATED-DEPLOYMENTS.md).

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
Automated deployment systems should consume versioned manifests and
idempotently reconcile isolated bindings, domains, secrets, resource identities,
and release digests. Monitoring belongs outside this per-merchant runtime so it
can remain authoritative during a provider or deployment outage.

---

## The Order Lifecycle (Central Nervous System)

Everything in the platform revolves around orders. Here's the complete lifecycle:

### Entry Points

```
STOREFRONT CHECKOUT                 ADMIN DASHBOARD
├─ POST /orders                     ├─ POST /admin/orders
│  └─ Synchronous atomic commit     │  └─ Synchronous manual-order workflow
│     1. One read batch: idempotency│     with its own idempotency authority
│        row + checkout authority + │
│        customer and SKU rows      │
│     2. Price, quote fingerprint,  │
│        policy (memory only)       │
│     3. One guarded write batch:   │
│        order, items, SKU hold     │
│        (ledger v2 + stockVersion),│
│        attempt, receipt, outboxes │
│     4. Post-commit side effects   │
```

Every storefront and agent checkout, for every payment method and inventory
pool, commits through `commitStorefrontOrderPayload`: a D1 `batch()` (a real
transaction on TursoDB/PostgreSQL) of guarded statements. Order items exist
when the response is sent; there is no Durable Object, deferred projection,
or reservation lane. Stock holds live only on `product_variants`
(`reserved_stock`, `stock_version`) with one ledger-v2 movement per change.

### Status Transitions & Side Effects

```
INCOMPLETE ──→ PENDING ──→ CONFIRMED ──→ SHIPPED ──→ DELIVERED ──→ COMPLETED
     │           │              │            │            │
     │           │              │            │            └──→ RETURNED ──→ REFUNDED
     │           │              │            └──→ RETURNED
     └───────────┴──────────────┴──→ CANCELLED (terminal)
```

**What happens at each transition:**

| Transition | Inventory | Notification | Payment |
|-----------|-----------|-------------|---------|
| → PENDING | Stock reserved | "order_created" email/SMS/push | — |
| → CONFIRMED | No change (stays reserved) | "order_confirmed" | — |
| → PROCESSING | No change | "order_processing" | — |
| → SHIPPED | Reserved → Deducted (stock permanently removed) | "order_shipped" + tracking | — |
| → DELIVERED | No change | "order_delivered" | COD must already have collected payment evidence |
| → COMPLETED | No change | "order_completed" | — |
| → CANCELLED (pre-ship) | Reservation released | "order_cancelled" | — |
| → CANCELLED (post-ship) | Deducted stock restored | "order_cancelled" | — |
| → RETURNED | Deducted stock restored | "order_returned" | Refund initiated |
| → REFUNDED | Stock restored (full refund only) | "order_refunded" | Gateway refund API call |

### The Cascade Chain

When an order status changes, this cascade fires:

```
Admin/Webhook triggers status change
    ↓
1. validateTransition() — state machine checks valid transition
    ↓
2. CAS update — orders.version incremented (optimistic lock, prevents race between admin + webhook)
    ↓
3. applyInventoryForStatusChange() — central orchestrator
    ├─ Reads current inventoryAction (none/reserved/deducted/restored)
    ├─ Determines required operation based on new status
    ├─ Executes: reserve / deduct / release / restore
    └─ Returns new inventoryAction for batch
    ↓
4. Queue notification — JOBS_QUEUE.send()
    ↓
5. Queue consumer dispatches to channels (independently):
    ├─ EMAIL: sendEmail() via Cloudflare Email Service by default, Resend fallback
    ├─ SMS: getActiveSmsProvider(db) → provider.sendSms() (4 providers: smsnetbd, bdbulksms, mimsms, gennet)
    ├─ WHATSAPP: Meta Cloud API template send
    └─ PUSH: sendOrderNotification() (FCM to admin devices when enabled)
```

### Notification Coverage

`ORDER_NOTIFICATION_TYPES` (`packages/core/src/modules/notifications/notification-types.ts`) is the source of truth: order created/confirmed/processing/shipped/delivered/completed/cancelled/returned, refund processing/failed/refunded/partially refunded, balance paid, and support request submitted/updated. Each channel (email, SMS, WhatsApp, push) is dispatched independently -- failure in one does not affect others.

---

## Module Dependency Graph

### Hub Modules (most connections)

```
ORDERS ──→ INVENTORY (reserve/deduct/release/restore)
       ──→ PAYMENTS (COD tracking, payment status)
       ──→ DELIVERY (shipment creation)
       ──→ DISCOUNTS (eligibility, usage tracking)

PAYMENTS ──→ INVENTORY (buildInventoryStatements for atomic batch)
         ──→ ORDERS (state machine validation)
         ──→ SETTINGS (currency config, gateway credentials)

INVENTORY ──→ SETTINGS (currency config)

DELIVERY ──→ INVENTORY (webhook status → inventory transitions)
```

### Leaf Modules (consumed only, no cross-module imports)

Products, Categories, Collections, Attributes, Pages, Navigation, Media, Analytics, Customers, Discounts, Notifications, Fraud Checker

### The Intentional Triangle

```
       ORDERS
      /       \
     /    DB    \
    /   batch()  \
PAYMENTS ──── INVENTORY
```

This is **tight coupling by design**. Payment confirmation must atomically update inventory and order status. The provider-backed `safeBatch()` boundary ensures all three are consistent or none are.

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
     pre-ship)      paid)         repair)
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

**Transition Protection:** Order status inventory transitions write a deterministic, movement-generation-based `inventory_movements.id` claim and the variant counter CAS update in one provider-backed `safeBatch()`. Exact duplicate `transition:*` claims are treated as idempotent retries, mismatched duplicate claims fail closed for manual reconciliation, and the final `orders.inventoryAction` update is CAS-guarded against the action observed before the stock transition. Every stock mutation still uses `stockVersion` with bounded conflict retry.

---

## Payment Processing Pipeline

```
Browser → Storefront Proxy → API Worker → Gateway
                                              │
                                         (async webhook)
                                              │
                                              ↓
                                    Webhook Handler (API)
                                    ├─ Verify signature
                                    ├─ Claim durable webhook_events row
                                    └─ Enqueue JOBS_QUEUE
                                              │
                                              ↓
                                    Queue Consumer
                                    └─ processPaymentConfirmed()
                                       ├─ Dedup: SELECT orderPayments
                                       ├─ Validate state machine
                                       ├─ Atomic batch:
                                       │  ├─ INSERT orderPayments
                                       │  ├─ UPDATE orders
                                       │  └─ inventory statements
                                       └─ Update payment plans
```

### 4 Idempotency Layers

| Layer | Where | Mechanism |
|-------|-------|-----------|
| 1. Webhook claim | `webhook_events` table | Claim-before-side-effect with retryable failed claims and lease-reclaimable stale processing claims |
| 2. Queue dedup | Cloudflare native | Per-message ID tracking |
| 3. DB dedup | Unique partial indexes | `UNIQUE(orderId, stripePaymentIntentId)`, `UNIQUE(orderId, sslcommerzValId)` |
| 4. Status guard | processPaymentConfirmed() | Skip if `paymentStatus === PAID` |

### Amount Conventions

| Gateway | DB Storage | Queue Message | API Call | Conversion |
|---------|-----------|---------------|----------|------------|
| Stripe | Major units | Smallest units (cents) | Smallest | x/÷ 10^decimals |
| SSLCommerz | Major units | Major units | Major | None |
| COD | Major units | N/A | N/A | None |

---

## Notification System

### Channel Dispatch

```
JOBS_QUEUE message arrives
    ↓
Claim order_notification_outbox by outboxId
    ↓
sendOrderNotificationEmail(email, name, orderId, type, data, db, { outboxId })
    ↓
Read channel config from DB (settings.order_channels)
    ├─ enabledChannels = channels[type] || ["email"]
    ↓
For each enabled customer target:
    ├─ Claim order_notification_delivery_receipts row
    ├─ EMAIL: sendEmail() via Cloudflare Email Service by default, Resend fallback
    ├─ SMS: getActiveSmsProvider(db) → provider.sendSms()
    └─ WHATSAPP: Meta Cloud API template send via configured order template
    ↓
sendOrderNotification(..., { outboxId }) for admin FCM push when enabled
    ↓
Mark parent outbox sent only when enabled receipts are accepted/skipped
```

### Known Notification Gaps

| Trigger | Current | Should Be |
|---------|---------|-----------|
| Shipment-only statuses (`out_for_delivery`, `on_hold`, `delivery_failed`) | Internal status only | Add explicit templates/settings before customer-facing shipment-progress notifications |
| Admin push provider | Firebase FCM only | Add first-party Web Push or Cloudflare-native/default push alternative |
| WhatsApp provider idempotency | Local D1 receipt fence only | Add upstream provider idempotency if Meta exposes a first-class key |

---

## Delivery Webhook → Order Status → Inventory Cascade

```
Pathao/Steadfast Webhook
    ↓
Verify signature + KV idempotency
    ↓
Update deliveryShipments table
    ↓
If status changed:
    ├─ mapProviderStatus() → normalized status
    ├─ updateOrderStatusFromShipment()
    │   ├─ Validate transition (state machine)
    │   ├─ CAS update on orders.version (admin changes take priority)
    │   ├─ applyInventoryForStatusChange()
    │   └─ Update orders.status + inventoryAction
    └─ enqueueOrderStatusChangeNotification()
        └─ JOBS_QUEUE.send({ type: "order.notification", ... })
```

**Status Mapping (Provider → Order):**

| Provider Event | Normalized | Order Status |
|---------------|------------|-------------|
| order.picked / in-transit | shipped | SHIPPED |
| order.delivered | delivered | DELIVERED |
| order.returned | returned | RETURNED |
| order.delivery-failed | failed | → CONFIRMED (revert) |
| order.cancelled | cancelled | CANCELLED |

---

## Settings Architecture

Settings are typed documents: one `settings` row per document
(`category` = document key, `key = 'document'`, JSON `value`, CAS `revision`),
defined in `packages/core/src/modules/settings/documents.ts` and read/written
only through `defineSettingsDocument()` (`settings-store.ts`). Secret fields are
`enc:` ciphertext under `CREDENTIAL_ENCRYPTION_KEY`, decrypted strictly.

| Document | Purpose | Secret fields |
|----------|---------|---------------|
| `platform` | Public storefront/API/dashboard/media origins, customer cookie domain, extra CORS origins | -- |
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
commit boundary; every other dependency should be justified by current code and
boundary tests.

---

## How to Extend

### Add a Payment Gateway
1. `packages/core/src/modules/payments/{gateway}.ts` — implement `PaymentProvider`
2. `packages/core/src/modules/payments/factory.ts` — register in factory
3. `apps/api/src/routes/payment/{gateway}-routes.ts` — session creation endpoint
4. `apps/api/src/routes/webhooks/{gateway}.ts` — webhook handler + durable `webhook_events` claim
5. `apps/api/src/queue-consumer.ts` — add case for `payment.{gateway}.confirmed/failed`
6. `apps/storefront/src/lib/checkout/handlers/{gateway}.ts` — checkout handler
7. `apps/storefront/src/pages/api/checkout/{gateway}-session.ts` — proxy endpoint

### Add a Delivery Provider
1. `packages/core/src/modules/delivery/providers/{provider}.ts` — implement interface
2. `packages/core/src/modules/delivery/factory.ts` — register
3. `apps/api/src/routes/webhooks/{provider}.ts` — webhook handler

### Add a Notification Channel
1. Add channel dispatch in `notifications.service.ts` (alongside email/SMS blocks)
2. Add channel key to `NotificationChannelsBuilder.tsx` CHANNELS array
3. Queue consumer already handles generically

### Add a New Domain Module
1. Create `packages/core/src/modules/{domain}/` with service + validation + types + index
2. Create route at `apps/api/src/routes/admin/{domain}.ts`
3. Create admin component at `apps/admin-v2/src/components/admin/{domain}/`
4. Register the module only at the explicit route/composition and permission
   boundaries that consume it; avoid unrelated cross-domain edits

---

## Key Invariants (Never Break These)

1. **Inventory deduction happens on SHIPMENT, not on payment** — stock stays reserved until physically shipped
2. **All status transitions go through `validateTransition()`** — no direct DB updates bypassing state machine
3. **All stock mutations use `stockVersion` CAS** — prevents race conditions
4. **All payment processing uses `safeBatch()`** — atomic across order + payment + inventory on the selected provider
5. **Webhook handlers claim before side effects** — duplicates return success; queue-send failures mark the event failed and return retryable errors
6. **Response envelope is always `{ success: true, data: T }`** — storefront proxies unwrap before returning to browser
7. **Secrets come from `env.*` (runtime), never `import.meta.env` (build-time)**
8. **Storefront imports `@scalius/shared` and `@scalius/api-client` only** — never `@scalius/core` or `@scalius/database`
