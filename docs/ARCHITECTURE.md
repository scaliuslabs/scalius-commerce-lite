# Scalius Commerce — Architecture & Module Communication Guide

> How everything works, how modules talk to each other, and where the boundaries are.


## System Overview

```
Browser (Customer/Admin)
    ↓
┌─────────────────────────────────────────────────────┐
│  Admin Worker (TanStack)    Storefront Worker (SSR)  │
│  :4323                      :4322                    │
└────────────┬────────────────────────┬───────────────┘
             │ Service Binding        │ Service Binding
             ↓                        ↓
┌─────────────────────────────────────────────────────┐
│  API Worker (Hono) :8787                             │
│  ├─ Routes (thin HTTP layer)                         │
│  ├─ Middleware (auth, RBAC, cache, CSP)              │
│  ├─ Queue Consumer (payment, notification, ingest)   │
│  └─ Cron (reservation expiry)                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  @scalius/core (Domain Services)                     │
│  Commerce modules + auth + integrations + search     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│  @scalius/database (Drizzle + D1)                    │
│  Versioned schema, migrations, and D1 invariants      │
└─────────────────────────────────────────────────────┘
```

## Layer Rules

Dependencies are expected to flow **downward only**. Boundary tests and current
package checks are the authority for whether that remains true; this document
does not certify a clean tree by itself.

| Layer | May Import | Never Imports |
|-------|-----------|---------------|
| Routes (apps/api/src/routes/) | @scalius/core, @scalius/database | Nothing imports routes |
| Services (@scalius/core/modules/) | @scalius/database, @scalius/shared | Never imports routes |
| Schema (@scalius/database/schema/) | drizzle-orm only | Never imports services or routes |
| Shared (@scalius/shared/) | Nothing | Pure utility, no dependencies |

---

## The Order Lifecycle (Central Nervous System)

Everything in the platform revolves around orders. Here's the complete lifecycle:

### Entry Points

```
STOREFRONT CHECKOUT                ADMIN DASHBOARD
├─ POST /orders/create             ├─ POST /admin/orders
│  └─ Async via ORDER_INGEST_QUEUE │  └─ Synchronous (reserve + deduct immediately)
│     └─ 4-phase batch processing  │
│        1. Build statements       │
│        2. Reserve inventory      │
│        3. Atomic DB write        │
│        4. Init COD tracking      │
```

### Status Transitions & Side Effects

```
INCOMPLETE ──→ PENDING ──→ CONFIRMED ──→ SHIPPED ──→ DELIVERED ──→ COMPLETED
                 │              │            │            │
                 │              │            │            └──→ RETURNED ──→ REFUNDED
                 │              │            └──→ RETURNED
                 │              └──→ CANCELLED
                 └──→ CANCELLED ──→ PENDING (admin reactivation)
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
4. Queue notification — ORDER_NOTIFICATIONS_QUEUE.send()
    ↓
5. Queue consumer dispatches to channels (independently):
    ├─ EMAIL: sendEmail() via Cloudflare Email Service by default, Resend fallback
    ├─ SMS: getActiveSmsProvider(db) → provider.sendSms() (4 providers: smsnetbd, bdbulksms, mimsms, gennet)
    ├─ WHATSAPP: (placeholder — logged only)
    └─ PUSH: sendOrderNotification() (FCM to admin devices when enabled)
```

### Notification Coverage (9 types)

All 9 order statuses that trigger notifications: `order_created`, `order_confirmed`, `order_processing`, `order_shipped`, `order_delivered`, `order_completed`, `order_cancelled`, `order_returned`, `order_refunded`. Each channel (email, SMS, WhatsApp, push) is dispatched independently -- failure in one does not affect others.

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

This is **tight coupling by design**. Payment confirmation must atomically update inventory and order status. The `db.batch()` pattern ensures all three are consistent or none are.

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
    (cancelled)    (shipped/     (admin
     pre-ship)      paid)      reactivates)
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

**Transition Protection:** Order status inventory transitions write a deterministic, movement-generation-based `inventory_movements.id` claim and the variant counter CAS update in one D1 `safeBatch()`. Exact duplicate `transition:*` claims are treated as idempotent retries, mismatched duplicate claims fail closed for manual reconciliation, and the final `orders.inventoryAction` update is CAS-guarded against the action observed before the stock transition. Every stock mutation still uses `stockVersion` with 3 retries and exponential backoff.

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
                                    └─ Enqueue PAYMENT_EVENTS_QUEUE
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
| 3. DB dedup | Unique partial indexes | `UNIQUE(orderId, stripePaymentIntentId)`, `UNIQUE(orderId, sslcommerzValId)`, `UNIQUE(orderId, polarCheckoutId)` |
| 4. Status guard | processPaymentConfirmed() | Skip if `paymentStatus === PAID` |

### Amount Conventions

| Gateway | DB Storage | Queue Message | API Call | Conversion |
|---------|-----------|---------------|----------|------------|
| Stripe | Major units | Smallest units (cents) | Smallest | x/÷ 10^decimals |
| SSLCommerz | Major units | Major units | Major | None |
| Polar | Major units | Smallest units (cents) | Smallest | x/÷ 10^decimals |
| COD | Major units | N/A | N/A | None |

---

## Notification System

### Channel Dispatch

```
ORDER_NOTIFICATIONS_QUEUE message arrives
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
        └─ ORDER_NOTIFICATIONS_QUEUE.send({ type: "order.notification", ... })
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

### Two-Tier System

| Table | Purpose | Example Keys |
|-------|---------|-------------|
| `siteSettings` | Singleton row, typed fields | guestCheckoutEnabled, checkoutMode, headerConfig, storefrontUrl |
| `settings` | Key-value with category | `email.resend_api_key`, `whatsapp.access_token`, `firebase.service_account`, `sms.active_provider`, `business_info.company_name` |

### Settings Categories

| Category | Purpose | Encrypted |
|----------|---------|-----------|
| `email` | Email provider (Cloudflare Email selection/binding status, optional Resend API key, sender) | Resend key only |
| `whatsapp` | Meta WhatsApp Cloud API access token; phone-number ID/auth template remain in `siteSettings` | Yes |
| `sms` | SMS provider credentials (4 providers: smsnetbd, bdbulksms, mimsms, gennet) | Yes (AES-GCM) |
| `stripe` | Stripe credentials | Yes |
| `sslcommerz` | SSLCommerz credentials | Yes |
| `polar` | Polar credentials | Yes |
| `firebase` | Firebase service account and public browser config | Service account only (AES-GCM `enc:`) |
| `business_info` | Company name, TIN, logo, address | No |
| `invoice_counter` | Next invoice number | No |
| `notifications` | Per-status channel preferences | No |

---

## Release posture

Numeric architecture scores and blanket “production-ready” claims are not used.
They hide the difference between a sensible module boundary and a verified
commerce lifecycle. Stable-release confidence comes from focused invariant
tests, sequential package gates, deployed Cloudflare
smokes, and current operational evidence. The
orders/payments/inventory triangle remains intentionally coupled at its atomic
D1 commit boundary; every other dependency should be justified by current code
and boundary tests.

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
4. **All payment processing uses `db.batch()`** — atomic across order + payment + inventory
5. **Webhook handlers claim before side effects** — duplicates return success; queue-send failures mark the event failed and return retryable errors
6. **Response envelope is always `{ success: true, data: T }`** — storefront proxies unwrap before returning to browser
7. **Secrets come from `env.*` (runtime), never `import.meta.env` (build-time)**
8. **Storefront imports `@scalius/shared` and `@scalius/api-client` only** — never `@scalius/core` or `@scalius/database`
