# Notifications Domain Audit

## Summary

The notification domain handles three distinct channels: transactional order email to customers, FCM push notifications to admin dashboard browsers, and OTP delivery (email, WhatsApp, SMS stub). All channels are queue-driven via Cloudflare Queues with DLQ support. The architecture is sound -- webhooks and status changes enqueue messages, the queue consumer dispatches to the correct handler, and failures are retried automatically.

However, the domain has a significant dead-code problem: `sendOrderNotificationEmail()` declares four email types (`order_created`, `order_confirmed`, `order_shipped`, `order_delivered`) and the queue message type supports all four, but the only code path that enqueues `order.notification` messages is the `updateOrderStatus()` flow, which only triggers for `shipped` and `delivered`. The `order_created` and `order_confirmed` templates exist but are never sent. Additionally, there is a dual email provider system (legacy + universal) creating confusion about which code path is actually active, and zero test coverage for the entire notification domain.

**Files audited:**

| Layer | Files |
|-------|-------|
| Schema | `packages/database/src/schema/system.ts` (`adminFcmTokens`, `settings`) |
| Core service | `packages/core/src/modules/notifications/notifications.service.ts`, `index.ts` |
| Email integration (legacy) | `packages/core/src/integrations/email/provider.ts`, `resend.ts`, `index.ts` |
| Email integration (universal) | `packages/core/src/providers/email/types.ts`, `resend-adapter.ts`, `index.ts` |
| Firebase FCM (server) | `packages/core/src/integrations/firebase/admin.ts` |
| Firebase FCM (client) | `packages/core/src/integrations/firebase/client.ts` |
| OTP transport | `packages/core/src/modules/customers/otp-transport.ts` |
| Queue consumer | `apps/api/src/queue-consumer.ts` |
| API routes | `apps/api/src/routes/admin/orders-status.ts`, `apps/api/src/routes/admin/system-utils.ts` |
| Admin UI | `apps/admin/src/components/admin/NotificationDropdown.tsx` |
| Admin Firebase | `apps/admin/src/layouts/components/FirebaseInit.astro`, `apps/admin/src/pages/firebase-messaging-sw.js.ts` |
| Wrangler config | `apps/api/wrangler.jsonc` (queue definitions, DLQ config) |

---

## Critical Issues

### C1: `order_created` and `order_confirmed` email templates are dead code

**Files:**
- `packages/core/src/modules/notifications/notifications.service.ts` (lines 131, 144-145, 153-155)
- `packages/core/src/modules/orders/orders.fulfillment.ts` (lines 142-145)
- `packages/core/src/modules/orders/orders.types.ts` (line 122)
- `apps/api/src/routes/admin/orders-status.ts` (lines 81-89)

**Problem:** The email service declares `OrderEmailType = "order_created" | "order_confirmed" | "order_shipped" | "order_delivered"` and has templates for all four. The queue message type in `queue-consumer.ts` also supports all four. However, the **only** code that enqueues `order.notification` messages is the `updateOrderStatus()` result, and that function only populates the notification payload for `shipped` and `delivered` (via the `NOTIFICATION_STATUSES` record at line 142 of `orders.fulfillment.ts`). The `StatusUpdateResult` type in `orders.types.ts` confirms this: `notificationType: "order_shipped" | "order_delivered"`.

No code path ever enqueues `order_created` or `order_confirmed` notification messages. These email templates exist but are never reached.

**Impact:** Customers never receive "order received" or "order confirmed" emails, which are the most important lifecycle emails for customer confidence. The templates are present and correct, but unreachable.

**Fix approach:** Add `order_created` to the order ingest queue handler (`handleOrderIngestBatch()` in `packages/core/src/modules/orders/orders.queue.ts`) and add `order_confirmed` to the `NOTIFICATION_STATUSES` map in `orders.fulfillment.ts`:
```typescript
const NOTIFICATION_STATUSES: Record<string, OrderEmailType> = {
    confirmed: "order_confirmed",
    shipped: "order_shipped",
    delivered: "order_delivered",
};
```
Also update the `StatusUpdateResult.notificationType` union to include the new types.

### C2: Legacy email provider calls `getDb()` without env parameter

**Files:**
- `packages/core/src/integrations/email/resend.ts` (line 26)
- `packages/database/src/client.ts` (line 21)

**Problem:** The legacy `ResendEmailProvider.sendEmail()` method calls `getEmailSettings()`, which dynamically imports `getDb` from `@scalius/database/client` and calls `getDb()` with no arguments. In `client.ts`, `getDb()` without the `env` parameter works **only** if a prior call (from middleware) has already initialized the singleton `_db`. This is fragile -- if the email provider is ever invoked before the DB singleton is initialized (e.g., during queue processing where the queue consumer explicitly passes `env` to `getDb(env)`), the call will either throw or return the already-initialized instance. The implicit dependency on initialization order is a latent bug.

**Impact:** Works today because the queue consumer calls `getDb(env)` early in `handleQueueBatch()`. But if the code is ever restructured to send emails outside the queue consumer context (e.g., directly from a service), it could fail with "D1 database binding not available."

**Fix approach:** The legacy email provider is marked `@deprecated`. Migrate the notification service to use the universal provider system (`packages/core/src/providers/email/`) which receives validated settings at construction time, eliminating the implicit DB dependency.

### C3: `sendOrderNotificationEmail()` does not receive `env` and cannot use the universal provider

**File:** `packages/core/src/modules/notifications/notifications.service.ts` (lines 137-175)

**Problem:** `sendOrderNotificationEmail()` calls `sendEmail()` from the legacy email integration (`packages/core/src/integrations/email/index.ts`), which resolves the provider from an in-memory registry. The universal provider system (`packages/core/src/providers/email/`) is registered but never actually used by the notification service -- the legacy `ResendEmailProvider` (which reads settings from DB on every send) is the one that handles all email delivery. The two provider systems coexist without clear boundaries.

**Impact:** The universal provider's benefits (validated settings at construction, `sendTemplated()` support, health checks, `messageId` returns) are unused. The notification service is locked to the legacy path.

**Fix approach:** Refactor `sendOrderNotificationEmail()` to accept `db` and `env` parameters (or a pre-configured email provider), and use the universal provider system. This also enables proper error reporting (message IDs for delivery tracking).

---

## Code Quality Issues

### Q1: WhatsApp OTP credentials passed through queue payload

**File:** `apps/api/src/queue-consumer.ts` (lines 197-229)

**Problem:** The `auth.send_otp` queue message includes `waToken` and `waPhoneId` directly in the message body. These are the WhatsApp Business API access token and phone number ID -- sensitive credentials stored in the `siteSettings` table. When enqueued, they are serialized into the Cloudflare Queue message. This means credentials are persisted in the queue's internal storage and potentially visible in queue monitoring tools.

**Better pattern:** The queue consumer should read credentials from the DB (or from `env`) at processing time, not receive them in the message payload. The OTP transport in `packages/core/src/modules/customers/otp-transport.ts` builds the payload with credentials from `settings`, which is the enqueue side. The consumer should instead receive only the `identifier`, `code`, and routing info, then resolve credentials itself.

### Q2: FCM tokens sent sequentially, not in parallel

**File:** `packages/core/src/integrations/firebase/admin.ts` (line 343)

**Problem:** `sendEachForMulticast()` iterates tokens with a `for...of` loop and `await`s each `sendFCMMessage()` call sequentially. With many admin devices registered, this creates O(n) latency where n is the number of tokens. Each token requires a separate HTTP call to the FCM API (the FCM v1 API does not support true multicast).

**Impact:** With 10 admin tokens, notification delivery takes 10x a single FCM call (each call has ~100-300ms latency plus potential retries). Cloudflare Queue consumers have a 30-second timeout by default; many tokens could approach this limit.

**Fix:** Use `Promise.allSettled()` to send all tokens concurrently, then collect results:
```typescript
const results = await Promise.allSettled(
  payload.tokens.map(token => sendFCMMessage(accessToken, this.projectId, { token, ...payload }))
);
```

### Q3: Inline HTML templates with no templating abstraction

**Files:**
- `packages/core/src/modules/notifications/notifications.service.ts` (lines 153-174)
- `packages/core/src/integrations/email/index.ts` (lines 46-144)
- `apps/api/src/queue-consumer.ts` (lines 183-195)

**Problem:** Eight different email templates are hardcoded as inline HTML template literals across three files:
1. Four order lifecycle emails in `notifications.service.ts`
2. Three auth emails (verification, password reset, admin invite) in `email/index.ts`
3. One OTP email in `queue-consumer.ts`

Each template duplicates the same outer structure (`<div style="font-family: Arial...">`) with minor variations. Adding a new template requires copying this structure. There is no shared layout, no branding customization, and no way for store owners to modify email content.

**Fix:** Extract a minimal template utility that provides a shared layout wrapper and accepts title/body/action blocks. Keep it simple -- a function, not a template engine:
```typescript
function renderEmailTemplate(opts: { title: string; body: string; action?: { label: string; url: string } }): string
```

### Q4: `notifications.service.ts` mixes two unrelated concerns

**File:** `packages/core/src/modules/notifications/notifications.service.ts`

**Problem:** One file contains both `sendOrderNotification()` (FCM push to admin devices) and `sendOrderNotificationEmail()` (transactional email to customers). These have completely different dependency profiles: FCM push needs `db`, `env`, Firebase credentials, and the `adminFcmTokens` table; email needs only the email provider. Combining them makes it harder to test either in isolation.

**Fix:** Split into `fcm-push.service.ts` and `email-notifications.service.ts`, re-export both from `index.ts`.

---

## Pattern Violations

### P1: Notification enqueue has no `data` pass-through

**File:** `apps/api/src/routes/admin/orders-status.ts` (lines 83-89)

**Problem:** When enqueuing `order.notification`, the route does not pass through the `data` field from the `StatusUpdateResult`. The notification service's `sendOrderNotificationEmail()` accepts an optional `data?: Record<string, unknown>` parameter that can include `trackingId` for shipped emails. But the enqueue code omits `data`:
```typescript
await c.env.ORDER_NOTIFICATIONS_QUEUE.send({
    type: "order.notification",
    orderId: result.notification.orderId,
    customerEmail: result.notification.customerEmail,
    customerName: result.notification.customerName,
    notificationType: result.notification.notificationType,
    // data is NOT passed -- trackingId never reaches the email template
});
```

**Impact:** "Your order is on its way" emails never include the tracking ID, even though the template supports it (`data.trackingId` renders in the shipped template).

**Fix:** Add `data` to both the `StatusUpdateResult.notification` type and the enqueue call. The `updateOrderStatus()` function should populate `data: { trackingId }` when the new status is `shipped`.

### P2: Queue type definitions are not shared between enqueue and consume

**Files:**
- `apps/api/src/queue-consumer.ts` (line 104-110 -- `PaymentQueueMessage` union member for `order.notification`)
- `packages/core/src/modules/orders/orders.types.ts` (line 122 -- `StatusUpdateResult.notification`)
- `apps/api/src/routes/admin/orders-status.ts` (line 83-89 -- the actual enqueue call)

**Problem:** The `order.notification` message shape is defined in three places:
1. As a member of the `PaymentQueueMessage` union in `queue-consumer.ts`
2. As the `notification` property of `StatusUpdateResult` in `orders.types.ts`
3. Implicitly in the route's `send()` call

These are not linked by a shared type. The `PaymentQueueMessage` union accepts `notificationType: "order_created" | "order_confirmed" | "order_shipped" | "order_delivered"`, but `StatusUpdateResult` only allows `"order_shipped" | "order_delivered"`. A refactor that changes one will silently diverge from the others.

**Fix:** Extract a shared `OrderNotificationQueueMessage` type in a shared location (e.g., `packages/core/src/modules/notifications/types.ts`) and import it in both the consumer and the producer.

### P3: `order.notification` is a member of `PaymentQueueMessage` union

**File:** `apps/api/src/queue-consumer.ts` (lines 32-110)

**Problem:** The `order.notification` message type is defined as a member of the `PaymentQueueMessage` discriminated union alongside `payment.stripe.confirmed`, `payment.sslcommerz.failed`, etc. This is a naming/semantic mismatch -- order notifications are not payment events.

**Impact:** Confusing for future developers. The type name suggests all members are payment-related.

**Fix:** Rename to `QueueMessage` or split into `PaymentQueueMessage` and `NotificationQueueMessage`, combining them only in the `processQueueMessage()` function signature.

---

## Maintainability Concerns

### M1: Dual email provider systems

**Files:**
- Legacy: `packages/core/src/integrations/email/provider.ts` (registry), `resend.ts` (implementation), `index.ts` (convenience functions)
- Universal: `packages/core/src/providers/email/types.ts` (interface), `resend-adapter.ts` (implementation), `index.ts` (barrel)

**Problem:** Two complete email provider systems exist in parallel:

1. **Legacy** (`integrations/email/`): `EmailProvider` interface with `sendEmail(options): Promise<void>`. Registry pattern. Resend implementation reads settings from DB on every send. This is the one actually used by all notification code.

2. **Universal** (`providers/email/`): `EmailProvider` interface (extends `ProviderLifecycle`) with `sendEmail(options): Promise<SendEmailResult>`, plus optional `sendTemplated()`. Receives validated settings at construction. Registered with a universal provider registry. **Never called by any notification code.**

The legacy `resend.ts` is explicitly marked `@deprecated` with a comment pointing to the universal adapter, but no migration has occurred. Both are auto-registered on import.

**Impact:** Adding a new email provider (e.g., SendGrid) requires implementing it in the universal system, but the notification service will not use it because it calls the legacy `sendEmail()`. Any new provider must also be added to the legacy registry to work.

### M2: Firebase client toast notification bypasses admin UI component system

**File:** `packages/core/src/integrations/firebase/client.ts` (lines 39-85)

**Problem:** `showCustomFCMToast()` creates DOM elements directly with `document.createElement()`, using CSS classes like `custom-fcm-toast`, `custom-fcm-toast-title`, etc. These styles must exist in the admin's global CSS, but the component is defined in the `core` package (not the admin app). It also duplicates the notification rendering logic that exists in `NotificationDropdown.tsx`.

**Impact:** Two separate notification presentation systems: the toast (raw DOM in core package) and the dropdown (React component in admin). Style changes must be synchronized manually.

### M3: Service worker fetches Firebase config from `/api/v1/auth/firebase-config` at import time

**File:** `apps/admin/src/pages/firebase-messaging-sw.js.ts` (lines 7-15)

**Problem:** The service worker is generated by an Astro SSR page that fetches Firebase config from the API. But line 8 uses `fetch("/api/v1/auth/firebase-config")` with a relative URL. In the Astro SSR context (running inside a Cloudflare Worker), this relative URL will be resolved against the worker's own origin, which means it goes through the admin worker's service binding to the API worker. If the API worker is not yet bound (e.g., during initial deployment), this fetch silently fails and generates a no-op service worker.

---

## Performance & Scalability

### S1: FCM access token cache depends on KV availability

**File:** `packages/core/src/integrations/firebase/admin.ts` (lines 293-316)

**Problem:** `ensureValidAccessToken()` caches the Google OAuth access token in `SHARED_AUTH_CACHE` (KV) with a 3300-second TTL (55 minutes, since Google tokens expire at 3600 seconds). If KV is not bound, every `sendOrderNotification()` call generates a new JWT, signs it with RSA, and exchanges it for a Google access token -- three HTTP round trips (JWT sign, OAuth token exchange, FCM send) instead of one.

**Current mitigation:** The comment notes "Bypassing cache" but does not warn or track how often this happens.

**Improvement:** Log a metric or console.warn on cache miss so operators can detect when KV is unbound.

### S2: Sequential FCM sends with per-message retry (up to 3 retries each)

**File:** `packages/core/src/integrations/firebase/admin.ts` (lines 176-218, 343-381)

**Problem:** `sendFCMMessage()` has built-in retry logic (3 attempts with exponential backoff for 429/5xx). `sendEachForMulticast()` calls this sequentially for each token. Worst case: 10 tokens x 3 retries x ~2s backoff = 60 seconds. The queue consumer has a 30-second timeout per message by default.

**Impact:** With many registered admin devices and transient FCM issues, the notification handler could exceed the queue timeout, causing the entire message to be retried (which sends duplicate notifications to devices that already received them).

**Fix:** Cap total execution time with `AbortSignal.timeout()`, send tokens concurrently, and skip remaining tokens if time budget is exhausted.

### S3: Email provider reads settings from DB on every `sendEmail()` call

**File:** `packages/core/src/integrations/email/resend.ts` (lines 16-49)

**Problem:** `getEmailSettings()` runs two DB queries (API key + sender address) on every email send. For queue batches with `max_batch_size: 20` (the order-notifications queue config), this means 40 DB queries for settings before any emails are sent.

**Fix:** Cache email settings for the duration of the batch, or migrate to the universal provider system which receives settings at construction time.

### S4: NotificationDropdown re-filters notifications on every render

**File:** `apps/admin/src/components/admin/NotificationDropdown.tsx` (lines 239-247)

**Problem:** `unreadCount` and `unreadNotifications` are computed with `useMemo` but both filter the entire array independently. With `MAX_NOTIFICATIONS = 50`, this is negligible, but the pattern could be improved:

```typescript
// Current: two filter passes
const unreadCount = useMemo(() => notifications.filter(n => !n.read).length, [notifications]);
const unreadNotifications = useMemo(() => notifications.filter(n => !n.read), [notifications]);

// Better: one pass
const unreadNotifications = useMemo(() => notifications.filter(n => !n.read), [notifications]);
const unreadCount = unreadNotifications.length;
```

---

## Robustness Gaps

### R1: DLQ messages are never monitored or replayed

**File:** `apps/api/wrangler.jsonc` (lines 73-84)

**Observation:** The `order-notifications` queue has a DLQ (`order-notifications-dlq`) configured with `max_retries: 3`. However, there is no consumer bound to the DLQ, no admin UI to view DLQ messages, and no replay mechanism. Failed notifications (after 3 retries + 30s delay each) silently land in the DLQ and are never processed.

**Impact:** If the email provider is down for a few minutes, customer notification emails are permanently lost. The admin never knows.

**Fix approach:** Bind a consumer to the DLQ that logs failures to the `settings` or a dedicated `notification_failures` table. Add an admin UI to view and replay failed notifications. Alternatively, add an alerting mechanism (e.g., a counter in KV that the admin dashboard checks).

### R2: Email delivery failures are silently swallowed

**Files:**
- `packages/core/src/integrations/email/resend.ts` (lines 87-92) -- throws on Resend API error
- `packages/core/src/integrations/email/index.ts` (line 36) -- `sendEmail()` propagates the throw
- `apps/api/src/queue-consumer.ts` (line 343) -- the throw triggers retry via `Promise.allSettled`

**Partial mitigation:** The queue consumer's `Promise.allSettled` catches the thrown error and calls `msg.retry({ delaySeconds: 30 })`. After 3 retries, the message goes to DLQ.

**Gap:** There is no logging of *which* email failed, *why* it failed, or *which order* it was for. The console.error in `queue-consumer.ts` line 156 logs the message ID but not the payload details. After the message hits DLQ, the context is lost.

**Fix:** Add structured logging with order ID, email address, and error reason before calling `msg.retry()`.

### R3: FCM push failure silently caught in queue consumer

**File:** `apps/api/src/queue-consumer.ts` (lines 352-360)

**Observation:** FCM push failure is caught with a try/catch and logged as non-fatal. This is intentional and correct -- FCM push should not block email delivery. However, there is no tracking of FCM failure rates. If Firebase credentials expire, every push silently fails indefinitely.

**Improvement:** Track consecutive failures in KV. After N consecutive failures, log a warning that suggests checking Firebase configuration.

### R4: No idempotency on notification sends

**File:** `apps/api/src/queue-consumer.ts` (lines 341-362)

**Problem:** If a queue message is retried (e.g., after a transient failure between email send and `msg.ack()`), the email is sent again. There is no idempotency key or deduplication. The customer receives duplicate emails.

**Impact:** Low frequency (requires a failure at the exact moment between successful send and ack), but when it happens, customers get duplicate "Your order has shipped" emails.

**Fix:** Use `orderId + notificationType` as an idempotency key. Check a KV entry or DB flag before sending. Alternatively, accept the risk (duplicate notifications are annoying but not harmful) and document the trade-off.

### R5: WhatsApp OTP has no delivery status verification

**File:** `apps/api/src/queue-consumer.ts` (lines 197-229)

**Problem:** The WhatsApp API call checks `waRes.ok` for the HTTP response, but WhatsApp message delivery is asynchronous. A 200 response means the message was accepted by the Meta API, not that it was delivered to the user. There is no webhook for WhatsApp delivery receipts, so failed OTP deliveries are invisible.

### R6: `sendOrderNotificationEmail()` does not validate email address

**File:** `packages/core/src/modules/notifications/notifications.service.ts` (line 138)

**Problem:** The function accepts `email: string` and passes it directly to `sendEmail({ to: email })`. There is no validation that the email is non-empty or well-formed. The Resend API will reject invalid emails, but this burns an API call and triggers a queue retry for an issue that could be caught immediately.

---

## LLM-Friendliness

### Strengths

1. **Clear module barrel exports**: `packages/core/src/modules/notifications/index.ts` re-exports both functions, making imports clean.

2. **Discriminated union for queue messages**: The `type` field in queue messages enables exhaustive pattern matching in the switch statement.

3. **Comprehensive README**: `packages/core/src/modules/notifications/README.md` documents every function, every queue message type, connection status, and the full end-to-end flow. An LLM can read this file alone and understand the domain.

4. **Firebase README**: `packages/core/src/integrations/firebase/README.md` is exceptionally thorough -- covers server-side, client-side, service worker, admin UI integration, database schema, and API endpoints.

5. **OTP transport abstraction**: `packages/core/src/modules/customers/otp-transport.ts` uses a clean strategy pattern with typed interfaces and concrete implementations.

### Weaknesses

1. **Two provider systems with no clear "which to use" signal**: An LLM reading the codebase will find `EmailProvider` defined in two places with different signatures. The `@deprecated` comment on the legacy file is helpful, but the fact that all runtime code uses the legacy path creates confusion.

2. **`PaymentQueueMessage` naming**: An LLM generating code to handle order notifications will look for a `NotificationQueueMessage` type and not find one -- it must know to look inside `PaymentQueueMessage`.

3. **Dead email types**: An LLM asked to "send an order_created notification" will find the template in `notifications.service.ts` and the type in `queue-consumer.ts` and assume it works. It does not -- there is no code path that produces this message type.

4. **Implicit dependency chain**: `sendEmail()` -> `getEmailProvider()` -> in-memory registry -> `ResendEmailProvider` -> `getDb()` -> module singleton. An LLM cannot trace this without reading five files.

5. **`notifications.service.ts` comment says "Extracted from src/lib/notification-utils.ts and src/queue-consumer.ts"**: This references files that no longer exist (pre-refactor paths). It is misleading context for an LLM.

---

## Recommended Changes

### Priority 1 (Critical -- functionality gaps)

1. **Wire `order_created` and `order_confirmed` notifications**: Add `confirmed: "order_confirmed"` to `NOTIFICATION_STATUSES` in `orders.fulfillment.ts`. For `order_created`, enqueue the notification from the order ingest queue handler. Update `StatusUpdateResult.notificationType` to include the new types.

2. **Pass `data` (trackingId) through to notification emails**: Add `data` field to the `StatusUpdateResult.notification` type and the enqueue call in `orders-status.ts`. Populate `trackingId` from the shipment when status transitions to `shipped`.

3. **Extract shared `OrderNotificationQueueMessage` type**: Define it once in `packages/core/src/modules/notifications/types.ts` and import in both the queue consumer and the orders-status route.

### Priority 2 (Robustness)

4. **Add structured failure logging**: Before calling `msg.retry()` in the queue consumer, log `{ orderId, notificationType, customerEmail, error }` to enable debugging when messages hit DLQ.

5. **Add email validation**: Validate `email` parameter in `sendOrderNotificationEmail()` before calling `sendEmail()`. Skip and log rather than triggering a retry.

6. **Parallelize FCM token sends**: Replace the sequential `for...of` loop in `sendEachForMulticast()` with `Promise.allSettled()`. Add a timeout guard to prevent exceeding queue consumer limits.

### Priority 3 (Maintainability)

7. **Consolidate email provider systems**: Either migrate notification code to the universal provider system, or remove the universal provider and keep the legacy one. Having both with only the legacy active is tech debt.

8. **Split `notifications.service.ts`**: Separate FCM push and email notification into two files. They have zero shared logic.

9. **Extract email template utility**: Create a shared `renderEmailLayout()` function that all 8 email templates use for the outer wrapper. Keep the body content inline but centralize the boilerplate.

10. **Rename `PaymentQueueMessage` to `QueueMessage`**: Or split the union into `PaymentQueueMessage | NotificationQueueMessage | OrderIngestQueueMessage` and combine them at the consumer level.

### Priority 4 (Scalability)

11. **Cache email settings per batch**: In the queue consumer, read email settings once before processing the batch and pass them to `sendOrderNotificationEmail()`.

12. **Add DLQ monitoring**: Bind a consumer to `order-notifications-dlq` that writes failures to a database table. Add an admin UI indicator for failed notifications.

13. **Remove stale comments**: Update the header comment in `notifications.service.ts` that references non-existent files.
