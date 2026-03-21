# Notifications Domain Re-Audit

**Re-audit Date:** 2026-03-21
**Previous Audit Date:** 2026-03-20
**Overall Score:** 6/10 (previous: 5/10)

---

## Previous Findings Status

### Critical Issues

#### C1: `order_created` and `order_confirmed` email templates are dead code
**Status: FIXED**

The `NOTIFICATION_STATUSES` map in `packages/core/src/modules/orders/orders.fulfillment.ts` (lines 142-149) now includes all six statuses:

```typescript
const NOTIFICATION_STATUSES: Record<string, string> = {
    pending: "order_created",
    confirmed: "order_confirmed",
    processing: "order_processing",
    shipped: "order_shipped",
    delivered: "order_delivered",
    cancelled: "order_cancelled",
};
```

The `StatusUpdateResult.notificationType` in `packages/core/src/modules/orders/orders.types.ts` (line 122) was widened to `string`, and `updateOrderStatus()` now populates the notification payload for all mapped statuses.

**Remaining gap:** The `order_created` path is still not reachable for new storefront orders because the order ingest queue handler (`packages/core/src/modules/orders/orders.queue.ts`) does not enqueue an `order.notification` message after successfully creating an order. The `pending` -> `order_created` mapping only fires when an admin manually sets status to `pending`, which is an unusual flow. New orders ingested via the queue never trigger an `order_created` email. See NEW issue N1.

Additionally, `order_processing` and `order_cancelled` are mapped in `NOTIFICATION_STATUSES` but have no matching templates in `sendOrderNotificationEmail()`. The function at `packages/core/src/modules/notifications/notifications.service.ts` (lines 173-187) only defines templates for `order_created`, `order_confirmed`, `order_shipped`, and `order_delivered`. The `order_processing` and `order_cancelled` types will hit the fallback `subjects[type] || 'Order Update'` path, producing a generic email. See NEW issue N2.

#### C2: Legacy email provider calls `getDb()` without env parameter
**Status: STILL OPEN**

`packages/core/src/integrations/email/resend.ts` (line 26) still calls `getDb()` with no arguments. The legacy provider continues to be the active code path for all notification emails. The `@deprecated` comment has been present since the previous audit. No migration to the universal provider has occurred.

#### C3: `sendOrderNotificationEmail()` does not receive `env` and cannot use the universal provider
**Status: PARTIALLY FIXED**

The function signature now accepts an optional `db?: Database` parameter (`packages/core/src/modules/notifications/notifications.service.ts` line 146). The function uses `db` to check notification channel preferences via `getNotificationChannels(db)` (lines 149-171). This is a meaningful improvement -- channel-based routing is now functional.

However, the queue consumer at `apps/api/src/queue-consumer.ts` (lines 343-349) does NOT pass `db` when calling `sendOrderNotificationEmail()`. The `db` parameter is omitted entirely. This means the channel preference check is never executed in the production queue flow -- every notification defaults to sending email regardless of channel settings. See NEW issue N3.

---

### Code Quality Issues

#### Q1: WhatsApp OTP credentials passed through queue payload
**Status: STILL OPEN**

`packages/core/src/modules/customers/otp-transport.ts` (lines 124-125) still passes `waToken` and `waPhoneId` directly in the `OtpQueuePayload`. The queue consumer at `apps/api/src/queue-consumer.ts` (lines 198-199) reads these from the message body. Credentials are still serialized into queue message storage.

#### Q2: FCM tokens sent sequentially, not in parallel
**Status: STILL OPEN**

`packages/core/src/integrations/firebase/admin.ts` (line 343) still uses a sequential `for...of` loop over tokens. Each token is sent one at a time with up to 3 retries per call.

#### Q3: Inline HTML templates with no templating abstraction
**Status: STILL OPEN**

Email templates remain inline HTML literals across three files:
- `packages/core/src/modules/notifications/notifications.service.ts` (lines 192-201)
- `packages/core/src/integrations/email/index.ts` (lines 51-143)
- `apps/api/src/queue-consumer.ts` (lines 184-195)

All duplicate the same `font-family: Arial` outer div pattern.

#### Q4: `notifications.service.ts` mixes two unrelated concerns
**Status: STILL OPEN**

The file still contains both `sendOrderNotification()` (FCM push) and `sendOrderNotificationEmail()` (transactional email) in a single 204-line file.

---

### Pattern Violations

#### P1: Notification enqueue has no `data` pass-through (trackingId never reaches email)
**Status: PARTIALLY FIXED -- STILL BROKEN**

The fix attempt is visible in `apps/api/src/routes/admin/orders-status.ts` (line 89):
```typescript
trackingId: data.status === "shipped" ? result.notification.trackingId : undefined,
```

And the `StatusUpdateResult.notification` type in `packages/core/src/modules/orders/orders.types.ts` (line 123) now includes `trackingId?: string`.

The `updateOrderStatus()` function in `packages/core/src/modules/orders/orders.fulfillment.ts` (lines 206-208) correctly populates `trackingId` when status is `shipped`.

**However, the trackingId is sent as a top-level field on the queue message, NOT inside the `data` field.** The `PaymentQueueMessage` type for `order.notification` (`apps/api/src/queue-consumer.ts` lines 103-110) defines `data?: Record<string, unknown>` but has no `trackingId` field. The enqueue call puts `trackingId` directly on the message object (which TypeScript allows because the extra field is not checked at the queue `send()` call level). The consumer then passes `payload.data` to `sendOrderNotificationEmail()` -- but `payload.data` is `undefined` because trackingId was placed on a different field.

The email function reads `data?.trackingId` at `packages/core/src/modules/notifications/notifications.service.ts` (line 181). Since `data` is never populated, `safeTrackingId` is always empty. Shipped emails still never include the tracking ID.

**Fix:** Change the enqueue call to: `data: { trackingId: result.notification.trackingId }` instead of `trackingId: result.notification.trackingId`.

#### P2: Queue type definitions are not shared between enqueue and consume
**Status: STILL OPEN**

The `order.notification` message shape is still defined in three places:
1. `PaymentQueueMessage` union in `apps/api/src/queue-consumer.ts` (lines 103-110)
2. `StatusUpdateResult.notification` in `packages/core/src/modules/orders/orders.types.ts` (lines 118-124)
3. Implicitly in the enqueue call in `apps/api/src/routes/admin/orders-status.ts` (lines 83-90)

No shared type exists. The P1 trackingId bug above is a direct consequence of this -- the enqueue site diverged from the consumer's expected shape.

#### P3: `order.notification` is a member of `PaymentQueueMessage` union
**Status: STILL OPEN**

The union at `apps/api/src/queue-consumer.ts` (line 32) is still named `PaymentQueueMessage` and includes the `order.notification` variant alongside payment events.

---

### Maintainability Concerns

#### M1: Dual email provider systems
**Status: STILL OPEN**

Both systems remain:
- Legacy: `packages/core/src/integrations/email/provider.ts`, `resend.ts`, `index.ts`
- Universal: `packages/core/src/providers/email/types.ts`, `resend-adapter.ts`, `index.ts`

The legacy system is still the active code path. The universal `ResendEmailProvider` in `packages/core/src/providers/email/resend-adapter.ts` is registered with the universal registry but never invoked by any notification code.

#### M2: Firebase client toast notification bypasses admin UI component system
**Status: STILL OPEN**

`packages/core/src/integrations/firebase/client.ts` (lines 39-85) still uses raw DOM manipulation with `document.createElement()`.

#### M3: Service worker fetches Firebase config with relative URL
**Status: STILL OPEN (not verified -- file not re-read, low priority)**

---

### Performance & Scalability

#### S1: FCM access token cache depends on KV availability
**Status: STILL OPEN**

`packages/core/src/integrations/firebase/admin.ts` (lines 293-301). The `console.warn` for cache bypass was actually commented out (line 299), meaning silent cache miss with no logging at all.

#### S2: Sequential FCM sends with per-message retry
**Status: STILL OPEN**

Same sequential pattern at `packages/core/src/integrations/firebase/admin.ts` (lines 343-381).

#### S3: Email provider reads settings from DB on every `sendEmail()` call
**Status: STILL OPEN**

`packages/core/src/integrations/email/resend.ts` (lines 16-49) still runs two DB queries per email.

#### S4: NotificationDropdown re-filters notifications on every render
**Status: STILL OPEN**

`apps/admin/src/components/admin/NotificationDropdown.tsx` (lines 239-247) still computes `unreadCount` and `unreadNotifications` as two independent filter passes.

---

### Robustness Gaps

#### R1: DLQ messages are never monitored or replayed
**Status: STILL OPEN**

DLQ config remains in `apps/api/wrangler.jsonc` (lines 73-84). No consumer is bound to any DLQ. Three DLQs now exist: `order-notifications-dlq`, `payment-events-dlq`, `auth-otp-dlq`, `order-ingest-dlq`. None have consumers.

#### R2: Email delivery failures are silently swallowed
**Status: STILL OPEN**

The queue consumer at `apps/api/src/queue-consumer.ts` (line 156) logs a generic error message with `msg.id` but not the payload details (order ID, email, notification type). After DLQ, context is lost.

#### R3: FCM push failure silently caught in queue consumer
**Status: STILL OPEN**

`apps/api/src/queue-consumer.ts` (lines 359-361) catches FCM errors with console.error but no failure rate tracking.

#### R4: No idempotency on notification sends
**Status: STILL OPEN**

No deduplication key exists. Queue retries can produce duplicate customer emails.

#### R5: WhatsApp OTP has no delivery status verification
**Status: STILL OPEN**

No webhook for WhatsApp delivery receipts.

#### R6: `sendOrderNotificationEmail()` does not validate email address
**Status: STILL OPEN**

The function at `packages/core/src/modules/notifications/notifications.service.ts` (line 141) accepts `email: string` with no validation.

---

## New Issues Found

### N1: `order_created` email is still unreachable for storefront orders (Critical)

**Files:**
- `packages/core/src/modules/orders/orders.queue.ts` (lines 371-384 -- post-write phase, no notification enqueue)
- `packages/core/src/modules/orders/orders.fulfillment.ts` (line 143 -- maps `pending` to `order_created`)

**Problem:** The `NOTIFICATION_STATUSES` map now maps `pending` -> `order_created`. But new orders created via the storefront checkout flow go through the order ingest queue (`handleOrderIngestBatch()`), which creates orders directly in `pending` status. Since the order is not transitioning *to* `pending` via `updateOrderStatus()`, the `NOTIFICATION_STATUSES` mapping never fires. The `handleOrderIngestBatch()` function has no code to enqueue an `order.notification` message.

For `order_created` to actually send, the admin would need to manually call `updateOrderStatus(db, orderId, "pending")` on an order already in a different status -- which is not a normal flow.

**Impact:** Customers never receive "We've received your order" emails. This is the single most important transactional email for customer confidence.

**Fix:** After the successful `db.batch()` and message ack in `handleOrderIngestBatch()` (around line 384), enqueue an `order.notification` message with `notificationType: "order_created"` to `ORDER_NOTIFICATIONS_QUEUE`:
```typescript
if (env.ORDER_NOTIFICATIONS_QUEUE && payload.orderData.customerEmail) {
    await env.ORDER_NOTIFICATIONS_QUEUE.send({
        type: "order.notification",
        orderId: payload.orderData.id as string,
        customerEmail: payload.orderData.customerEmail as string,
        customerName: payload.orderData.customerName as string,
        notificationType: "order_created",
    });
}
```

### N2: `order_processing` and `order_cancelled` have no email templates (Medium)

**Files:**
- `packages/core/src/modules/orders/orders.fulfillment.ts` (lines 145, 148 -- maps `processing` and `cancelled`)
- `packages/core/src/modules/notifications/notifications.service.ts` (lines 173-187 -- template records)

**Problem:** The `NOTIFICATION_STATUSES` map includes `processing: "order_processing"` and `cancelled: "order_cancelled"`, but `sendOrderNotificationEmail()` only has templates for four types: `order_created`, `order_confirmed`, `order_shipped`, `order_delivered`. The `subjects` and `messages` records do not contain `order_processing` or `order_cancelled` keys. When these statuses trigger, the email subject falls back to `Order #${orderId} Update` and the body to a generic `Your order has been updated` message.

**Impact:** Customers receive a vague, generic email instead of a meaningful status update when their order is being processed or has been cancelled. The cancellation email is especially important because the customer needs to know they won't receive their order.

**Fix:** Add templates to the `subjects` and `messages` records:
```typescript
subjects["order_processing"] = `Order #${orderId} Processing`;
subjects["order_cancelled"] = `Order #${orderId} Cancelled`;
messages["order_processing"] = `Your order <strong>#${orderId}</strong> is being processed, ${safeName}! We'll update you when it ships.`;
messages["order_cancelled"] = `Your order <strong>#${orderId}</strong> has been cancelled, ${safeName}. If you have questions, please contact our support team.`;
```

Also update the `OrderEmailType` on line 131 to include the new types, and update the `PaymentQueueMessage` union at `apps/api/src/queue-consumer.ts` (line 108) to include `"order_processing" | "order_cancelled"`.

### N3: Queue consumer does not pass `db` to `sendOrderNotificationEmail()` -- channel preferences are ignored (Critical)

**Files:**
- `apps/api/src/queue-consumer.ts` (lines 343-349)
- `packages/core/src/modules/notifications/notifications.service.ts` (lines 140-171)

**Problem:** The `sendOrderNotificationEmail()` function accepts an optional `db?: Database` parameter (line 146) and uses it to check notification channel preferences (lines 149-171). When `db` is provided, the function reads the `notifications.order_channels` setting to determine whether email is enabled for the given status type.

The queue consumer calls `sendOrderNotificationEmail()` without the `db` parameter:
```typescript
await sendOrderNotificationEmail(
  payload.customerEmail,
  payload.customerName,
  payload.orderId,
  payload.notificationType,
  payload.data,
  // db is NOT passed
);
```

Since `db` is `undefined`, the `if (db)` check at line 149 is false, and the channel preference check is skipped entirely. Emails are always sent regardless of the admin's channel configuration set via the NotificationChannelsBuilder UI.

The admin UI at `apps/admin/src/components/admin/settings/NotificationChannelsBuilder.tsx` allows configuring channels per status, and the settings are correctly stored via `apps/api/src/routes/admin/settings/notification-channels.ts`. But the stored settings have zero runtime effect because the consumer never reads them.

**Impact:** Admins configure notification channels in settings, but the configuration is completely ignored. All order status changes always send email.

**Fix:** Pass `db` to `sendOrderNotificationEmail()` in the queue consumer:
```typescript
await sendOrderNotificationEmail(
  payload.customerEmail,
  payload.customerName,
  payload.orderId,
  payload.notificationType,
  payload.data,
  db,  // <-- add this
);
```

### N4: `NotificationChannelsBuilder` UI offers statuses that have no backend templates (Low)

**Files:**
- `apps/admin/src/components/admin/settings/NotificationChannelsBuilder.tsx` (lines 15-22)
- `packages/core/src/modules/notifications/notifications.service.ts` (lines 173-187)

**Problem:** The UI presents six statuses: `order_created`, `order_confirmed`, `order_processing`, `order_shipped`, `order_delivered`, `order_cancelled`. The backend only has templates for four of these. The `order_processing` and `order_cancelled` templates produce generic fallback emails (see N2). Admins may enable channels for these statuses expecting polished emails, but will get bare-bones output.

**Impact:** UX confusion -- admins configure channels for statuses that don't have proper templates.

### N5: Enqueue sends `trackingId` as top-level field instead of inside `data` (Bug -- still broken)

**Files:**
- `apps/api/src/routes/admin/orders-status.ts` (line 89)
- `apps/api/src/queue-consumer.ts` (lines 103-110, 348)
- `packages/core/src/modules/notifications/notifications.service.ts` (line 181)

**Problem:** This is the concrete manifestation of the P1 issue that was reported as "partially fixed" but remains broken. The enqueue call sends:
```typescript
{
    type: "order.notification",
    orderId: ...,
    customerEmail: ...,
    customerName: ...,
    notificationType: ...,
    trackingId: data.status === "shipped" ? result.notification.trackingId : undefined,
}
```

The `PaymentQueueMessage` type has `data?: Record<string, unknown>` -- no `trackingId` field. The consumer reads `payload.data` (which is `undefined`) and passes it to the email function. The email function reads `data?.trackingId` to render the tracking ID in shipped emails. Since `payload.data` is never set, tracking IDs never appear in emails.

**Fix:** Change line 89 of `orders-status.ts` from:
```typescript
trackingId: data.status === "shipped" ? result.notification.trackingId : undefined,
```
to:
```typescript
data: data.status === "shipped" && result.notification.trackingId
    ? { trackingId: result.notification.trackingId }
    : undefined,
```

### N6: `updateOrderStatus` route does not accept `trackingId` from request body (Medium)

**Files:**
- `apps/api/src/routes/admin/orders-status.ts` (lines 57-72, 78)
- `packages/core/src/modules/orders/orders.fulfillment.ts` (line 151)

**Problem:** The `updateOrderStatus()` function accepts an optional `data?: { trackingId?: string }` parameter. But the route handler at line 78 calls:
```typescript
const result = await OrdersService.updateOrderStatus(db, orderId, data.status);
```

It never passes `data` with the trackingId. The request body schema (line 64) only validates `{ status: z.string() }` -- no `trackingId` field is accepted. Even if the enqueue data-field bug (N5) were fixed, `result.notification.trackingId` would always be undefined because the status update API never receives a tracking ID from the admin UI.

**Fix:** Extend the request body schema to include `trackingId`:
```typescript
z.object({ status: z.string(), trackingId: z.string().optional() })
```
And pass it to the service:
```typescript
const result = await OrdersService.updateOrderStatus(db, orderId, data.status, { trackingId: data.trackingId });
```

### N7: Stale comment in `notifications.service.ts` header (Low)

**File:** `packages/core/src/modules/notifications/notifications.service.ts` (line 3)

**Problem:** The comment reads "Extracted from src/lib/notification-utils.ts and src/queue-consumer.ts" referencing files that no longer exist (pre-refactor paths).

---

## Summary of Changes Since Previous Audit

**Improvements:**
1. `NOTIFICATION_STATUSES` expanded from 2 statuses (shipped, delivered) to 6 statuses (pending, confirmed, processing, shipped, delivered, cancelled)
2. `StatusUpdateResult.notificationType` widened from `"order_shipped" | "order_delivered"` to `string`, supporting all status types
3. `sendOrderNotificationEmail()` now accepts optional `db` parameter and checks notification channel preferences
4. Notification channel admin UI (`NotificationChannelsBuilder.tsx`) and API routes (`notification-channels.ts`) added
5. Channel preferences stored and retrieved via `getNotificationChannels()` / `updateNotificationChannels()` in settings service
6. `updateOrderStatus()` now populates `trackingId` in the notification payload when status is `shipped`

**What remains broken:**
1. `order_created` emails are unreachable for storefront orders (queue ingest never enqueues notification)
2. `order_processing` and `order_cancelled` have no proper email templates
3. Channel preferences are never consulted because queue consumer does not pass `db`
4. TrackingId never reaches shipped emails (wrong field placement in enqueue call + missing request body field)
5. All items from the previous quality, maintainability, performance, and robustness sections are untouched

---

## Updated Priority Recommendations

### Priority 1 (Critical -- functionality gaps)

1. **Wire `order_created` in order ingest queue** (N1): After successful `db.batch()` in `handleOrderIngestBatch()`, enqueue `order.notification` with `notificationType: "order_created"`.

2. **Pass `db` to `sendOrderNotificationEmail()` in queue consumer** (N3): Without this, the NotificationChannelsBuilder settings page is decorative only.

3. **Fix trackingId field placement** (N5): Move `trackingId` into the `data` field in the enqueue call at `orders-status.ts`.

4. **Accept `trackingId` in the status update API** (N6): Extend request body schema and pass to `updateOrderStatus()`.

### Priority 2 (Medium -- incomplete features)

5. **Add `order_processing` and `order_cancelled` email templates** (N2): These statuses are mapped but produce generic emails.

6. **Extract shared `OrderNotificationQueueMessage` type** (P2): Define once, import everywhere -- prevent future field mismatches.

### Priority 3 (Robustness)

7. **Add structured failure logging** (R2): Log `orderId`, `notificationType`, `customerEmail`, and error reason before `msg.retry()`.

8. **Parallelize FCM token sends** (Q2/S2): Replace sequential loop with `Promise.allSettled()`.

9. **Add email validation** (R6): Validate email before sending.

### Priority 4 (Maintainability)

10. **Migrate notification service to universal email provider** (M1/C2/S3): Eliminate dual provider system and DB queries per send.

11. **Rename `PaymentQueueMessage`** (P3): To `QueueMessage` or split into focused types.

12. **Fix stale comments** (N7): Remove references to deleted files.

---

## Score Justification: 6/10

**Improvements (+1 from 5/10):**
- Channel preferences infrastructure is built (UI, API, settings service, function signature)
- Status coverage expanded from 2 to 6
- TrackingId support partially wired

**Remaining critical issues (-4 points):**
- `order_created` email still unreachable for the primary use case (storefront checkout)
- Channel preferences completely non-functional (db not passed)
- TrackingId still broken (wrong field placement + missing API field)
- Two new email types have no templates
- All legacy issues (dual providers, sequential FCM, no DLQ monitoring, credentials in queue) remain untouched
