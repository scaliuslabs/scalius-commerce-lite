# Audit 17 -- Notifications & Analytics

## 1. Overview

This audit covers the Notifications (email + FCM push) and Analytics (script management, dashboard metrics, Meta Conversions API) domains. These span across all three apps and multiple packages:

| Layer | Files |
|-------|-------|
| Core services | `packages/core/src/modules/notifications/notifications.service.ts`, `packages/core/src/modules/analytics/*.ts` |
| Integrations | `packages/core/src/integrations/email/`, `packages/core/src/integrations/firebase/admin.ts`, `packages/core/src/integrations/meta/conversions-api.ts`, `packages/core/src/integrations/analytics.ts` |
| API routes | `apps/api/src/routes/admin/analytics.ts`, `apps/api/src/routes/analytics.ts`, `apps/api/src/routes/admin/dashboard.ts`, `apps/api/src/routes/meta-conversions.ts`, `apps/api/src/routes/admin/settings/meta-conversions-admin.ts` |
| Queue consumer | `apps/api/src/queue-consumer.ts` |
| Admin UI | `apps/admin/src/components/admin/AnalyticsForm.tsx`, `AnalyticsList.tsx`, `DashboardChart.tsx`, `DashboardStats.tsx`, `NotificationDropdown.tsx`, `meta-conversions/` |
| Storefront | `apps/storefront/src/lib/analytics.ts`, `apps/storefront/src/lib/api/tracking.ts`, `apps/storefront/src/lib/tracking/meta-capi.ts` |

---

## 2. Notification System

### 2.1 Email Notifications

**Architecture:** Queue-driven. Order status changes enqueue `order.notification` messages to `ORDER_NOTIFICATIONS_QUEUE`. The queue consumer in `queue-consumer.ts` calls `sendOrderNotificationEmail()` which uses the email provider abstraction (`packages/core/src/integrations/email/`).

**Email provider abstraction** is clean:
- `EmailProvider` interface with `sendEmail(options)` method
- Registry pattern with `registerEmailProvider()` / `getEmailProvider()` / `setActiveEmailProvider()`
- Only Resend is implemented and auto-registered
- Graceful fallback: if no provider is registered, logs a warning and returns silently

**Email templates** (inline HTML in `notifications.service.ts`):
- `order_created`, `order_confirmed`, `order_shipped`, `order_delivered`
- Plain text fallback for each via regex stripping HTML tags
- Tracking data passed via optional `data?.trackingId` for shipped emails

**OTP delivery** (inline in `queue-consumer.ts`):
- Email OTP: sends styled HTML with monospace code block
- WhatsApp OTP: calls Graph API v19.0 with template messages
- SMS OTP: placeholder with console log -- providers pending

### 2.2 FCM Push Notifications

**Architecture:** `sendOrderNotification()` in `notifications.service.ts` sends multicast FCM push to all active admin device tokens. Called from queue consumer as a supplementary action after email delivery.

**FCM implementation** (`packages/core/src/integrations/firebase/admin.ts`):
- Pure REST implementation (no firebase-admin SDK) -- good for Cloudflare Workers
- Custom JWT creation with RS256 signing via Web Crypto API
- Access token caching via Cloudflare KV (`SHARED_AUTH_CACHE`) with 55-minute TTL
- Retry with exponential backoff (3 attempts) for 429 and 5xx responses
- Singleton pattern with dynamic override when DB-stored credentials are provided

**Token lifecycle:**
- Invalid tokens (`registration-token-not-registered`, `invalid-registration-token`) are automatically deactivated in `adminFcmTokens` table
- Active tokens fetched fresh on each notification send

### 2.3 Admin NotificationDropdown

Client-side notification UI stored in localStorage (`scalius_admin_notifications`). Listens for `admin-notification` CustomEvents dispatched by Firebase client SDK. Features:
- All/Unread tabs with badge counts
- Mark individual or all as read
- Max 50 notifications retained
- Relative time formatting
- Type-based icons and colors (new_order, payment_received, shipment_update, order_status, system)

### 2.4 Queue Integration

The queue consumer (`apps/api/src/queue-consumer.ts`) is a well-structured thin dispatcher:
- Order ingest handled as a batch via `db.batch()`
- Payment/notification/OTP messages processed individually via `Promise.allSettled()`
- Success -> ack, failure -> retry with 30-second delay
- FCM push failure is non-fatal (try/catch around `sendOrderNotification`)

---

## 3. Analytics Script Management

### 3.1 Core Service

`analytics.service.ts` provides CRUD for analytics script configurations (Google Analytics, Facebook Pixel, custom scripts). Scripts are stored in the `analytics` table with:
- `type`: google_analytics | facebook_pixel | custom
- `location`: head | body_start | body_end
- `usePartytown`: boolean for web worker offloading
- `config`: raw HTML/JS script content
- `isActive`: toggle without deletion

### 3.2 Partytown Integration

Two copies of the same `processAnalyticsScript()` / `shouldUsePartytown()` logic exist:
1. `packages/core/src/integrations/analytics.ts` -- used by the API route (`apps/api/src/routes/analytics.ts`)
2. `apps/storefront/src/lib/analytics.ts` -- used client-side on the storefront

The API route applies Partytown transformation server-side before returning configs to the storefront. The storefront copy is never imported by the API (storefront does not import core).

### 3.3 API Routes

**Admin CRUD** (`apps/api/src/routes/admin/analytics.ts`): Full OpenAPIHono routes for list, create, get, update, delete, toggle. Uses `ok()` / `created()` / `NotFoundError` consistently.

**Public configurations** (`apps/api/src/routes/analytics.ts`): Single GET endpoint returning active scripts with Partytown processing applied. Uses cache middleware (TTL = 0 -- effectively disabled).

### 3.4 Admin UI

- `AnalyticsList.tsx`: Table with toggle, edit, delete actions. Client-side pagination. Uses `AdminListPagination` shared component.
- `AnalyticsForm.tsx`: React Hook Form + Zod validation. Config examples auto-fill based on type selection. Direct fetch to admin API routes.

---

## 4. Dashboard Metrics

### 4.1 Service Layer

`dashboard.service.ts` provides three query functions:

**`getDashboardStats(db)`**: Runs 5 parallel queries:
- Total active products (non-deleted, isActive)
- Total customers (non-deleted)
- Current month orders/revenue/status breakdown (excluding cancelled/returned)
- Last month orders/revenue
- All-time total revenue
- Calculates month-over-month growth percentages

**`getRecentOrders(db, limit)`**: Last N orders with formatted timestamps.

**`getDailyActivityData(db, days)`**: Per-day order counts + revenue + new customer counts for the last N days. Fills zero-rows for days with no data. Two separate queries (orders + customers) merged via date-keyed Maps.

### 4.2 API Route

`apps/api/src/routes/admin/dashboard.ts`: Single GET endpoint runs all three queries in parallel (`Promise.all`). Returns combined `{ stats, recentOrders, dailyActivityData }`.

### 4.3 Admin UI

- `DashboardStats.tsx`: 4 stat cards (monthly orders, monthly revenue, total customers, active products) with trend indicators and animated entrance via framer-motion. Lazy-loads `DashboardChart`.
- `DashboardChart.tsx`: Recharts AreaChart with dual Y-axes (revenue + orders/customers). Client-side time range filtering (7d/30d/90d) from pre-fetched 90-day data. Custom tooltip with currency formatting.

---

## 5. Meta Conversions API (CAPI)

### 5.1 Server-Side Event Pipeline

Full flow: Storefront browser -> `/meta/events` API -> Meta Graph API

**Storefront client** (`apps/storefront/src/lib/tracking/meta-capi.ts`):
- `sendServerEvent()` constructs payload with auto-collected user data (fbp/fbc cookies, sessionStorage PII, user agent)
- Fire-and-forget via `sendMetaCapiEvent()` in `tracking.ts` using `keepalive: true`
- Single retry with 5-second timeout

**API route** (`apps/api/src/routes/meta-conversions.ts`):
- Validates payload with Zod (event name enum, user data, custom data)
- Generates unique event ID via cuid2
- Enriches user data with IP (`x-forwarded-for`) and user agent headers
- Dispatches via `waitUntil()` for non-blocking response

**Core integration** (`packages/core/src/integrations/meta/conversions-api.ts`):
- Fetches CAPI settings from singleton row in `metaConversionsSettings`
- Hashes PII (email, phone, name, location) via SHA-256 per Meta requirements
- Sends to Graph API v19.0
- Logs all events (success + failure + skipped) to `metaConversionsLogs` table
- Lazy cleanup of old logs on every event (configurable retention)

### 5.2 Storefront Analytics Functions

`apps/storefront/src/lib/analytics.ts` is a comprehensive dual-tracking library:

**Facebook Pixel (client-side + CAPI):**
- PageView, ViewContent, AddToCart, InitiateCheckout, AddPaymentInfo, Purchase, Lead, CompleteRegistration, Search
- Each function fires both `window.fbq()` client-side AND `sendServerEvent()` server-side
- Purchase event explicitly accepts `userData` for PII enrichment (most important for attribution)

**Google Analytics 4 (client-side only):**
- Full e-commerce tracking: view_item_list, select_item, view_item, add_to_cart, remove_from_cart, view_cart, begin_checkout, add_shipping_info, add_payment_info, purchase, refund
- Plus recommended events: search, generate_lead, sign_up, login, page_view
- Uses dataLayer push pattern (clears ecommerce object before each push per Google recommendation)

### 5.3 Admin Settings

- `MetaConversionsContainer.tsx`: Tabbed UI (Settings + Logs)
- `MetaConversionsSettingsForm.tsx`: Pixel ID, access token (masked), test event code, enable toggle, retention days
- `MetaConversionsLogs.tsx`: Paginated log viewer with expandable rows, clear all, manual cleanup, refresh
- Custom hooks (`useMetaConversionsSettings`, `useMetaConversionsLogs`) handle state and API calls
- Access token masking on both display and save (preserves existing token if masked value submitted)

---

## 6. Issues Found

### 6.1 Critical

**P1: `logRetentionDays` saved to DB but never read by the cleanup service.** The admin UI lets users set `logRetentionDays` (1-365 days) and it is persisted to the `metaConversionsSettings` table. However, `conversions-api.ts` hardcodes `LOG_RETENTION_HOURS = 12` and passes it to `logCapiEvent()` / `performLogCleanup()`. The DB-stored `logRetentionDays` is completely ignored at the service layer. Logs are always cleaned up after 12 hours regardless of what the admin sets in the UI. The admin setting is misleading.

**P1: FCM invalid token cleanup uses incorrect Drizzle SQL interpolation.** Line 120 of `notifications.service.ts`:
```ts
.where(sql`${adminFcmTokens.token} IN ${invalidTokens}`)
```
Drizzle's `sql` template tag will bind `invalidTokens` (a string array) as a single parameter, not expand it into an `IN (?, ?, ?)` clause. This will likely fail silently or produce incorrect SQL. Should use `inArray(adminFcmTokens.token, invalidTokens)` from drizzle-orm instead.

**P1: `process.env.NODE_ENV` used in Cloudflare Worker context.** Line 88 of `notifications.service.ts` checks `process.env.NODE_ENV !== "production"` for debug logging. Cloudflare Workers do not have `process.env` -- this will either throw or always be truthy, leaking debug logs in production.

### 6.2 Significant

**P2: Duplicate analytics tracking code between core and storefront.** `packages/core/src/integrations/analytics.ts` and `apps/storefront/src/lib/analytics.ts` contain nearly identical copies of `processAnalyticsScript()`, `shouldUsePartytown()`, and all FB Pixel + GA4 tracking functions. The storefront version adds CAPI server-side calls; the core version is client-only. This creates a maintenance burden -- changes to tracking logic must be applied in two places.

**P2: Dashboard `getDailyActivityData` passes a Date object to `gte()` for an integer timestamp column.** The `orders.createdAt` and `customers.createdAt` are `integer("created_at", { mode: "timestamp" })`. Drizzle's timestamp mode converts between Date objects and unix seconds automatically for `eq()`, but the `gte()` comparison on line 155-156 uses a Date object directly. This may work with Drizzle's timestamp mode conversion, but the inconsistency with the raw SQL `${orders.createdAt} >= ${firstDayOfMonthTs}` pattern in `getDashboardStats` (which uses explicit unix seconds) is fragile and could break if Drizzle's conversion behavior changes.

**P2: Meta CAPI access token passed as URL query parameter.** In `conversions-api.ts` line 166, the access token is appended to the URL as a query parameter. While this is Meta's documented pattern, it means the token appears in HTTP access logs, Cloudflare edge logs, and any request tracing. The Meta API also supports `Authorization: Bearer <token>` header -- using that would be more secure.

**P2: Analytics service uses `Record<string, unknown>` for typed data.** `createAnalyticsScript()` and `updateAnalyticsScript()` accept `data: Record<string, unknown>` and cast every field with `as string`, `as boolean`. The Zod-validated data from the API route is already typed -- the service should accept the validated type instead of discarding type safety.

**P2: `performLogCleanup` is called but not awaited in `logCapiEvent`.** Line 48 of `meta.service.ts` calls `performLogCleanup(db, retentionHours)` without `await`. This means cleanup runs as an unresolved promise. In Cloudflare Workers, this could be garbage collected before completion. Should either be awaited or dispatched via `waitUntil()`.

### 6.3 Minor

**P3: Notification email templates are inline HTML strings.** The 4 order email templates and 4 system emails (verification, password reset, admin invite, OTP) are all inline HTML in TypeScript. As the template count grows, these should be extracted to a template engine or at minimum a separate template file.

**P3: Dashboard stats query excludes cancelled/returned from current month totals but includes them in the status breakdown.** The `currentMonthArr` WHERE clause filters out cancelled/returned orders for count and revenue, but the CASE expressions count `cancelled` and `returned` statuses. Since the WHERE clause excludes them, `currentMonthStats.cancelled` will always be 0. This is confusing -- either include all statuses in the base query and filter revenue separately, or remove the cancelled status counter.

**P3: Analytics public endpoint has cache TTL of 0.** `apps/api/src/routes/analytics.ts` applies `cacheMiddleware({ ttl: 0 })` which effectively means no caching. Analytics configurations rarely change -- a 5-10 minute TTL would reduce DB queries on every storefront page load.

**P3: `handleManualCleanup` in `useMetaConversionsLogs.ts` double-parses the response.** Lines 108-114 call `response.json()` on an error path, then call `response.json()` again on success. The response body is a stream that can only be consumed once. If the response is not ok, the error path reads the body, then the success path (which should not run but could in edge cases) would fail.

**P3: `fcmInstance` singleton in `firebase/admin.ts` persists across requests in Cloudflare Workers.** Since Cloudflare Worker isolates can serve multiple requests, the singleton `fcmInstance` will reuse credentials from the first request. If Firebase credentials are updated in the DB, the singleton will not pick up the change until the isolate is recycled. The `serviceAccountJson` parameter path creates a new instance, but the env-based path uses the stale singleton.

**P3: DashboardChart hardcodes Bengali Taka symbol in tooltip default.** The `CustomTooltipContent` component defaults `symbol` to `"\u09F3"` (Bengali Taka). This is just a default prop value and the actual symbol is always passed from the parent, but it could confuse future developers.

---

## 7. Architecture Assessment

### Strengths

1. **Queue-driven notification delivery** is resilient. Webhooks return immediately, Cloudflare retries failed messages, and FCM failures do not block email delivery.

2. **Meta CAPI implementation is thorough.** Full pipeline from storefront browser to Meta's Graph API with proper PII hashing (SHA-256), event deduplication (unique event IDs), and diagnostic logging for skipped/failed events.

3. **Firebase REST implementation** avoids the firebase-admin SDK entirely, which is critical for Cloudflare Workers (no Node.js runtime). JWT creation, token caching via KV, and retry logic are all well-implemented.

4. **Dual-tracking pattern** (client-side Pixel + server-side CAPI) maximizes attribution accuracy while keeping the storefront responsive (fire-and-forget with `keepalive`).

5. **Dashboard queries use `Promise.all`** for parallel execution, and the daily activity fill-in-zeros pattern ensures the chart always renders complete date ranges.

6. **Admin Meta CAPI UI** is complete: settings management with masked tokens, paginated log viewer with expandable details, manual cleanup, and retention configuration.

### Weaknesses

1. **Code duplication** between core integrations analytics and storefront analytics creates maintenance risk. The storefront added CAPI calls to every FB tracking function but the core copy has none -- they have diverged.

2. **Retention configuration is disconnected.** The admin UI configures days, the service hardcodes hours, and they operate on different time scales (30 days vs 12 hours). This is a user-facing bug.

3. **No notification preferences.** There is no way for admins to opt out of specific notification types (e.g., only get push for new orders, not shipment updates). All active FCM tokens receive all notifications.

4. **Email templates are not customizable.** Store owners cannot modify email content or branding through the admin UI. All templates are hardcoded strings.

5. **Analytics cache is disabled** (TTL=0), meaning every storefront page load triggers a DB query for analytics configurations.

---

## 8. LLM-Friendliness Assessment

**Good patterns:**
- Clear file naming: `notifications.service.ts`, `meta.service.ts`, `dashboard.service.ts`
- Module barrel exports via `index.ts` files
- Queue message types are discriminated unions with explicit `type` field
- JSDoc comments on all public functions in the meta/firebase integrations
- Comprehensive inline comments in `analytics.ts` explaining GA4 and FB Pixel patterns

**Areas for improvement:**
- The core `analytics.ts` integration file mixes server-side concerns (Partytown processing) with client-side browser code (dataLayer, window.fbq). An LLM could mistake the browser-only tracking functions as usable in the Worker context.
- The notification service combines two unrelated concerns (FCM push + email) in one file with only comments separating them. Separate files would make intent clearer.
- The `Record<string, unknown>` parameters in `analytics.service.ts` obscure what fields are expected, making it harder for an LLM to generate correct service calls.

---

## 9. File Reference

| File | Role |
|------|------|
| `packages/core/src/modules/notifications/notifications.service.ts` | FCM push + order email sending |
| `packages/core/src/modules/notifications/index.ts` | Barrel export |
| `packages/core/src/modules/analytics/analytics.service.ts` | Analytics script CRUD |
| `packages/core/src/modules/analytics/analytics.validation.ts` | Zod schemas for analytics scripts |
| `packages/core/src/modules/analytics/dashboard.service.ts` | Dashboard stats, recent orders, daily activity |
| `packages/core/src/modules/analytics/meta.service.ts` | CAPI settings fetch, event logging, log cleanup |
| `packages/core/src/modules/analytics/index.ts` | Barrel export |
| `packages/core/src/integrations/analytics.ts` | Partytown processing + FB/GA4 tracking (core copy) |
| `packages/core/src/integrations/meta/conversions-api.ts` | CAPI event dispatch, PII hashing, Graph API call |
| `packages/core/src/integrations/meta/crypto-utils.ts` | SHA-256, email/phone hashing |
| `packages/core/src/integrations/firebase/admin.ts` | FCM REST API, JWT auth, KV token caching |
| `packages/core/src/integrations/email/index.ts` | Email provider abstraction + convenience functions |
| `packages/core/src/integrations/email/provider.ts` | EmailProvider interface + registry |
| `apps/api/src/queue-consumer.ts` | Queue batch handler -- payment, notification, OTP dispatch |
| `apps/api/src/routes/admin/analytics.ts` | Admin analytics CRUD routes |
| `apps/api/src/routes/analytics.ts` | Public analytics config endpoint |
| `apps/api/src/routes/admin/dashboard.ts` | Dashboard summary route |
| `apps/api/src/routes/meta-conversions.ts` | Public Meta CAPI event ingestion |
| `apps/api/src/routes/admin/settings/meta-conversions-admin.ts` | Admin CAPI settings + log management |
| `apps/admin/src/components/admin/AnalyticsForm.tsx` | Analytics script form |
| `apps/admin/src/components/admin/AnalyticsList.tsx` | Analytics script list with actions |
| `apps/admin/src/components/admin/DashboardChart.tsx` | Recharts area chart for daily activity |
| `apps/admin/src/components/admin/DashboardStats.tsx` | Dashboard stat cards with trends |
| `apps/admin/src/components/admin/NotificationDropdown.tsx` | Admin notification bell UI |
| `apps/admin/src/components/admin/meta-conversions/MetaConversionsContainer.tsx` | Tabbed CAPI settings + logs |
| `apps/admin/src/components/admin/meta-conversions/MetaConversionsSettingsForm.tsx` | CAPI settings form |
| `apps/admin/src/components/admin/meta-conversions/MetaConversionsLogs.tsx` | CAPI log viewer |
| `apps/admin/src/components/admin/meta-conversions/LogDetails.tsx` | Expandable log detail view |
| `apps/admin/src/components/admin/meta-conversions/hooks/useMetaConversionsLogs.ts` | Log fetching/management hook |
| `apps/admin/src/components/admin/meta-conversions/hooks/useMetaConversionsSettings.ts` | Settings state hook |
| `apps/admin/src/loaders/admin/analytics.ts` | SSR data loaders for analytics pages |
| `apps/admin/src/loaders/admin/dashboard.ts` | SSR data loader for dashboard |
| `apps/storefront/src/lib/analytics.ts` | Dual FB/GA4 + CAPI tracking library |
| `apps/storefront/src/lib/api/tracking.ts` | CAPI event API client |
| `apps/storefront/src/lib/tracking/meta-capi.ts` | CAPI client-side dispatcher with user data collection |

---

## 10. Recommendations

### Immediate Fixes

1. **Fix FCM token cleanup SQL** -- replace `sql` template with `inArray(adminFcmTokens.token, invalidTokens)` in `notifications.service.ts`
2. **Remove `process.env.NODE_ENV` check** -- use Cloudflare-compatible env detection or remove the debug log gate entirely
3. **Wire `logRetentionDays` from DB to cleanup service** -- `conversions-api.ts` should read the setting from DB instead of using hardcoded 12 hours, or remove the admin UI setting to avoid confusion

### Short-Term Improvements

4. **Accept typed input in analytics service** -- change `Record<string, unknown>` to the Zod-inferred type from `createAnalyticsSchema` / `updateAnalyticsSchema`
5. **Enable analytics cache** -- set a reasonable TTL (300-600 seconds) on the `/analytics/configurations` endpoint
6. **Await or `waitUntil` the cleanup in `logCapiEvent`** -- ensure log cleanup actually completes in Worker context
7. **Fix dashboard cancelled count** -- either include cancelled/returned in the base query or remove the counter from the status breakdown

### Medium-Term

8. **Consolidate tracking code** -- extract shared analytics types and utilities to `@scalius/shared`, keep browser-specific code in storefront only
9. **Extract email templates** -- create a template module with HTML templates as separate files or a simple template engine
10. **Add notification preferences** -- per-admin opt-in/out for notification types in the admin FCM token table
