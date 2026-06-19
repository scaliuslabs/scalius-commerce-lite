# API Worker (`apps/api/`)

Standalone Hono API worker deployed as a Cloudflare Worker. Owns all HTTP routes, queue consumption, cron triggers, and the OpenAPI spec. Admin and storefront apps communicate with this worker via Cloudflare Service Bindings (`env.API` / `env.BACKEND_API`).

## Entry Point

`src/worker.ts` exports an `ApiWorker` class extending `WorkerEntrypoint<Env>` with three handlers:

| Handler | Purpose |
|---------|---------|
| `fetch(request)` | HTTP -- delegates to the Hono app (`src/app.ts`) |
| `queue(batch)` | Queues -- payment events, order ingest, OTP, notifications |
| `scheduled(controller)` | Cron -- releases orphaned reservation movements every 15 minutes; existing orders are not expired here |

## Route Organization

`src/app.ts` creates an `OpenAPIHono` app with base path `/api/v1` and mounts all routes. The file is organized into four sections:

### Storefront And Related Routes

26 route groups mounted directly on the app. Most serve the customer-facing storefront without admin auth; `/orders` applies order/customer auth middleware, and `/cache` is admin-protected.

| Mount Point | Route File | Purpose |
|---|---|---|
| `/auth` | `routes/auth.ts` | Service JWT, Firebase config, token stats, and token revocation endpoints; Better Auth is hosted by the admin worker |
| `/attributes` | `routes/attributes.ts` | Filterable product attributes, including cached search facet filters |
| `/collections` | `routes/collections.ts` | Homepage collections |
| `/hero` | `routes/hero.ts` | Hero section data; slider lists cache only explicit `type=desktop/mobile` variants |
| `/search` | `routes/search.ts` | FTS5 product search |
| `/header` | `routes/header.ts` | Header config |
| `/navigation` | `routes/navigation.ts` | Navigation menus |
| `/footer` | `routes/footer.ts` | Footer config |
| `/pages` | `routes/pages.ts` | CMS pages |
| `/discounts` | `routes/discounts.ts` | Discount validation |
| `/widgets` | `routes/widgets.ts` | Active homepage widgets |
| `/analytics` | `routes/analytics.ts` | Analytics script configs |
| `/meta` | `routes/meta-conversions.ts` | Meta Pixel CAPI |
| `/storefront` | `routes/storefront.ts` | Homepage data bundle |
| `/checkout` | `routes/checkout.ts` | Checkout config |
| `/customer-auth` | `routes/customer-auth.ts` | Customer OTP auth |
| `/checkout-languages` | `routes/checkout-languages.ts` | Checkout i18n |
| `/abandoned-checkouts` | `routes/abandoned-checkouts.ts` | Abandoned checkout tracking |
| `/locations` | `routes/locations.ts` | City/zone/area hierarchy |
| `/shipping-methods` | `routes/shipping-methods.ts` | Shipping options |
| `/seo` | `routes/seo.ts` | SEO settings for meta tags |
| `/products` | `routes/products.ts` | Product catalog |
| `/categories` | `routes/categories.ts` | Category listings |
| `/orders` | `routes/orders.ts` | Order creation (auth-protected via `authMiddleware`) |
| `/cache` | `routes/cache.ts` | Cache control (admin-protected via `adminAuthMiddleware`) |
| `/__ptproxy` | `routes/partytown-proxy.ts` | Partytown analytics proxy |

Note: `/media` (`routes/media-server.ts`) is only registered in development mode for local file serving.

### Webhook Routes (signature verification IS the auth)

5 webhook receivers -- registered BEFORE auth middleware to bypass it.

| Mount Point | Route File | Verification Method |
|---|---|---|
| `/webhooks/stripe` | `routes/webhooks/stripe.ts` | `constructEventAsync` (Stripe SDK) |
| `/webhooks/sslcommerz` | `routes/webhooks/sslcommerz.ts` | Server-to-server IPN validation API call |
| `/webhooks/polar` | `routes/webhooks/polar.ts` | `standardwebhooks` signature verification |
| `/webhooks/pathao` | `routes/webhooks/pathao.ts` | `verifyDeliveryWebhook()` -- X-PATHAO-Signature header (timing-safe comparison) |
| `/webhooks/steadfast` | `routes/webhooks/steadfast.ts` | `verifyDeliveryWebhook()` -- Authorization Bearer token (timing-safe comparison) |

Delivery webhook verification (`src/middleware/webhook-auth.ts`) uses a three-strategy approach:
1. Provider-specific signature/token verification (Pathao: X-PATHAO-Signature, Steadfast: Bearer token, default: HMAC-SHA256)
2. IP allowlist fallback via `config.allowedWebhookIps`
3. If no security is configured, the webhook is **rejected** (not allowed through)

### Admin Routes (admin auth + RBAC)

All routes under `/admin/*` are protected by `adminAuthMiddleware`. The settings sub-routes are organized into modular files mounted through `routes/admin/settings.ts`.

| Mount Point | Route File | Purpose |
|---|---|---|
| `/admin/categories` | `routes/admin/categories.ts` | Category CRUD |
| `/admin/collections` | `routes/admin/collections.ts` | Collection CRUD + reorder |
| `/admin/customers` | `routes/admin/customers.ts` | Customer management |
| `/admin/pages` | `routes/admin/pages.ts` | CMS page CRUD |
| `/admin/widgets` | `routes/admin/widgets.ts` | Widget CRUD + history + AI generation |
| `/admin/discounts` | `routes/admin/discounts.ts` | Discount CRUD |
| `/admin/media` | `routes/admin/media.ts` | R2 media upload/manage |
| `/admin/inventory` | `routes/admin/inventory.ts` | Stock management + scanner |
| `/admin/navigation` | `routes/admin/navigation.ts` | Header/footer nav config |
| `/admin/search` | `routes/admin/search.ts` | Admin search |
| `/admin/shipments` | `routes/admin/shipments.ts` | Shipment management |
| `/admin/analytics` | `routes/admin/analytics.ts` | Analytics script CRUD |
| `/admin/dashboard` | `routes/admin/dashboard.ts` | Dashboard aggregates |
| `/admin/fraud-checker` | `routes/admin/fraud-checker.ts` | Fraud risk assessment |
| `/admin/rbac` | `routes/admin/rbac.ts` | Role/permission management |
| `/admin/settings` | `routes/admin/settings.ts` | Settings router (see below) |
| `/admin/orders` | `routes/admin/orders.ts` | Order management (+ `orders-status.ts`, `orders-refund.ts`) |
| `/admin/products` | `routes/admin/products.ts` | Product CRUD |
| `/admin/auth` | `routes/admin/auth-management.ts` | User/session management |
| `/admin/ai-context` | `routes/admin/ai-context.ts` | AI widget context |
| `/admin/ai-prompts` | `routes/admin/ai-prompts.ts` | Dashboard-configured AI prompts |
| `/admin/ai` | `routes/admin/ai.ts` | Widget AI generation via AI SDK providers |
| `/admin/widget-generation-runs` | `routes/admin/widget-generation-runs.ts` | Durable Object widget generation run lifecycle and status APIs |
| `/admin/attributes` | `routes/admin/attributes.ts` | Attribute CRUD |
| `/admin` | `routes/admin/system-utils.ts` | System utilities |
| `/admin/settings/delivery-locations` | `routes/admin/settings/delivery-locations.ts` | Location hierarchy CRUD |
| `/admin/settings/checkout-languages` | (reuses) `routes/checkout-languages.ts` | Admin checkout language CRUD |
| `/admin/settings/abandoned-checkouts` | (reuses) `routes/abandoned-checkouts.ts` | Admin abandoned checkout view |

**Admin Settings Sub-routes** (mounted inside `routes/admin/settings.ts`):

| Sub-mount | File | Purpose |
|---|---|---|
| `/` (root) | `settings/site.ts` | Site-wide settings (siteSettings table) |
| `/` (root) | `settings/ai.ts` | Widget AI provider, model, secret, and prompt settings |
| `/` (root) | `settings/payments.ts` | Payment gateway config (Stripe, SSLCommerz, Polar) |
| `/` (root) | `settings/system.ts` | System settings (currency, theme, phone) |
| `/shipping-methods` | `settings/shipping.ts` | Shipping method CRUD |
| `/delivery-providers` | `settings/delivery-providers.ts` | Delivery provider CRUD |
| `/hero-sliders` | `settings/hero-sliders.ts` | Hero slider CRUD |
| `/meta-conversions` | `settings/meta-conversions-admin.ts` | Meta Conversions API config |
| `/notification-channels` | `settings/notification-channels.ts` | Notification channel config per order status |
| `/` (root) | `settings/sms.ts` | SMS provider settings shown under admin notification settings (4 providers: smsnetbd, bdbulksms, mimsms, gennet) |
| `/` (root) | `settings/business.ts` | Business info (company name, TIN, logo, address, invoice prefix) |

### Payment Routes (public, storefront-facing)

3 route groups for payment session/intent creation.

| Mount Point | Route File | Purpose |
|---|---|---|
| `/payment/stripe` | `routes/payment/stripe-routes.ts` | Create PaymentIntent |
| `/payment/sslcommerz` | `routes/payment/sslcommerz-routes.ts` | Create session + redirect handlers |
| `/payment/polar` | `routes/payment/polar-routes.ts` | Create checkout session + redirect handlers |

### Setup & Documentation

| Route | Purpose |
|-------|---------|
| `/setup` | Initial deployment auth setup at `/api/v1/setup` (bypasses normal auth) |
| `/docs` | Swagger UI |
| `/openapi.json` | Auto-generated OpenAPI 3.0 spec |
| `/health` | Health check with cache stats |
| `/` | Welcome message with version and environment |

## Middleware Pipeline

Registered in order in `app.ts`. Every request goes through these global middleware:

1. **Per-request init** (`app.use("*")`) -- Calls `getDb(env)`, `initKv(env.CACHE)`, `initStorage(env.BUCKET)`.
2. **CORS logging** (`app.use("*")`) -- Logs preflight requests for debugging.
3. **CORS** (`app.use("*")`) -- Dynamic origin validation via `getCorsOriginContext()` from `@scalius/shared`.
4. **Security headers** (`app.use("*")`) -- Adds `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and HSTS outside localhost.
5. **Proxy base URL** (`app.use("*")`) -- Sets `X-Proxy-Base-URL` header from `PUBLIC_API_BASE_URL`.

**Global error handler** (`app.onError`) -- Single handler that catches all uncaught errors. `ApiError` subclasses return their specific status/code; generic errors return 500. All errors return JSON `{ success: false, error: { code, message, details? } }`.

Then, route-specific middleware:

| Middleware | Applied To | Purpose |
|---|---|---|
| `adminAuthMiddleware` | `/admin/*`, `/cache/*` | Better Auth session cookie OR JWT Bearer token OR scanner session cookie. Then RBAC/2FA permission checks. |
| `authMiddleware` | `/orders/*` | JWT Bearer token verification with auto-refresh. |
| `cacheMiddleware` | Individual routes | KV-backed response caching with configurable TTL; cache-miss writes use `executionCtx.waitUntil()` when Workers provides it. |

### Admin Auth Flow (`src/middleware/admin-auth.ts`)

`adminAuthMiddleware` tries three auth methods in order:

1. **Better Auth session cookie** -- from the admin dashboard SSR frontend
2. **JWT Bearer token** -- from decoupled mobile/external apps (auto-refreshes near expiry, returns new token via `X-New-Token` header)
3. **Scanner session cookie** -- created after QR token exchange by the admin worker; restricted to exact scanner workflow endpoints, role is `scanner` not `admin`

After authentication, it rejects 2FA-enabled admin sessions that have not completed 2FA, except exact `GET /admin/auth/2fa/info`, `POST /admin/auth/2fa/verify`, `POST /admin/auth/2fa/complete-verification`, and `POST /admin/auth/2fa/method` requests. It then performs RBAC: resolves the user's effective permission set via `getUserPermissions()` (which handles super-admin internally), then checks route-specific permissions via `getRoutePermission()` supporting `permission`, `anyOf`, and `allOf` modes. Scanner sessions skip full RBAC but are limited to the scanner allowlist.

### Auth Middleware (`src/middleware/auth.ts`)

JWT Bearer token verification for protected public routes (e.g., `/orders/*`) and protected `/auth/*` token-management routes. `/auth/token` and `/auth/firebase-config` are public before this middleware; `/auth/me`, `/auth/revoke`, and `/auth/token-stats` require a valid JWT. Auto-refreshes tokens nearing expiry and returns generic error messages to prevent token enumeration.

### Webhook Auth (`src/middleware/webhook-auth.ts`)

Delivery webhook signature verification supporting provider-specific strategies:
- **Pathao**: `X-PATHAO-Signature` header with timing-safe comparison
- **Steadfast**: `Authorization: Bearer` token with timing-safe comparison
- **Generic**: HMAC-SHA256 via `X-Webhook-Signature` header (supports `sha256=` prefix format)
- **Fallback**: IP allowlist via `CF-Connecting-IP` / `X-Forwarded-For`
- **No security**: Rejects the request (fail-closed)

Credentials are loaded from the `deliveryProviders` table and decrypted via AES-GCM (`decryptCredentialsGraceful()`).

## Response Conventions

### Success Responses

`src/utils/api-response.ts`:

| Helper | Returns | Status |
|--------|---------|--------|
| `ok(c, data)` | `{ success: true, data: T }` | 200 |
| `created(c, data)` | `{ success: true, data: T }` | 201 |
| `noContent(c)` | Empty body | 204 |

All success responses follow the `{ success: true, data: T }` envelope. The `T` passed to `ok()` is the FINAL payload -- never include redundant `success` or `data` wrapping inside `T`. The storefront reads `json.data` directly.

For 202 Accepted: use `c.json({ success: true, data: {...} }, 202)` directly (not `ok()` which forces 200).

### Error Responses

`src/utils/api-error.ts` re-exports error classes from `@scalius/core/errors` (`ApiError` is an alias for `AppError`):

| Class | Status | Code |
|-------|--------|------|
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `RateLimitError` | 429 | `RATE_LIMIT` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |

Thrown errors are caught by `app.onError()` and returned as `{ success: false, error: { code, message, details? } }`.

### OpenAPI Schema Utilities

`src/schemas/responses.ts` provides shared helpers for `createRoute()` response definitions:

| Helper | Purpose |
|--------|---------|
| `successEnvelope(schema)` | Wraps schema in `{ success: true, data: T }` |
| `paginatedEnvelope(key, schema)` | Wraps in `{ success: true, data: { [key]: items[], pagination } }` |
| `errorResponseSchema` | Standard error shape |
| `errorResponses` | Pre-built 400/401/403/404/500 response definitions |
| `messageResponse` | `{ success: true, data: { message: string } }` |
| `idResponse` | `{ success: true, data: { id: string } }` |
| `noContentResponse` | 204 No Content definition |

`src/schemas/entities.ts` defines Zod schemas for domain entities used in API responses: products, orders, categories, customers, collections, discounts, pages, widgets, attributes, media, delivery, settings, and navigation.

## JWT Utilities (`src/utils/jwt.ts`)

- `generateToken(payload, expiresIn?, env?)` -- Sign a JWT (default 1h expiry)
- `verifyToken(token, env?)` -- Verify signature + check KV blacklist
- `revokeToken(token)` -- Add to KV blacklist with TTL matching token expiry (minimum 60s for KV)
- `isTokenBlacklisted(token)` -- Check KV blacklist (fails closed: rejects token when KV unavailable)
- `refreshTokenIfNeeded(token, thresholdMinutes?, env?)` -- Re-sign if within threshold of expiry (verifies first)
- `extractTokenFromHeader(header)` -- Parse `Bearer` token from Authorization header
- Token hashing uses SHA-256 hex digest for blacklist keys

## Cache TTLs

`src/utils/cache-ttls.ts` centralizes all cache durations:

| Constant | Seconds | Used For |
|----------|---------|----------|
| `STANDARD` | 3600 | Products, categories, pages, widgets, collections, SEO |
| `SHORT` | 300 | Search results, order lookups, shipping methods |
| `MEDIUM` | 600 | Delivery locations |
| `ATTRIBUTES` | 1800 | Attribute data |
| `CHECKOUT_CONFIG` | 60 | Gateway config |
| `NONE` | 0 | Analytics config |

### Product Availability Invalidation

Stock-changing paths must keep product availability fresh without broad catalog busts. Use helpers from `src/utils/cache-invalidation.ts`:

- `resolveProductAvailabilityCacheSubjects(db, { orderIds, productIds, variantIds })` before destructive writes that may remove `order_items`.
- `invalidateProductAvailabilityCacheSubjects(subjects, c, db)` after the write commits when subjects were preloaded before a destructive write; pass `db` so product shortcodes embedded in CMS pages can be found and purged too.
- `invalidateProductAvailabilityCaches(db, input, c)` for normal post-commit order/payment/delivery/cron paths.

The helper deletes exact API product detail keys, query-varied product detail keys, product-search keys, and `api:search:*`, then schedules storefront exact data keys (`product_slug_${slug}`, `product_variants_${productId}`) plus exact product HTML paths (`/products/${slug}`) with `bumpVersion: false`. When a changed product slug appears in a published CMS page shortcode, it also purges that page's exact API page-render pattern, `page_render_${slug}_` data generation, and CMS HTML path; if the affected page count exceeds `MAX_STOREFRONT_EXACT_HTML_PATHS`, the purge bumps the global HTML version instead of silently leaving excess pages stale. Exact storefront HTML paths are relative-only, canonicalized with the shared HTML cache-path rules before dedupe/capping, and capped at `MAX_STOREFRONT_EXACT_HTML_PATHS` (`20`) before the purge request is sent. Current call sites cover admin order create/edit/delete/restore/permanent-delete, bulk/manual shipment/status/COD/fulfillment/refund/return paths, order ingest/payment queue mutations, delivery webhook reconciliation, admin shipment refresh, admin inventory variant adjustments (`/{variantId}/adjust`, `/stock-adjust`, `/stock-set`), and the scheduled orphan-reservation sweep.

Admin inventory stock edits are availability-only changes. They should pass the affected `variantId` to `invalidateProductAvailabilityCaches()` after the core stock operation commits, and should not call `invalidateCatalogCaches("products", c)` unless product/catalog metadata changed too.

`ADMIN_PATH_TO_GROUPS` intentionally does not map `/api/v1/admin/inventory/*` to broad catalog groups; the stock mutation routes own their targeted invalidation directly.

Search facet caching uses `api:attributes:search-filters` and must stay in both the `search` and `attributes` invalidation groups: product/search changes alter matching category neighborhoods, while attribute writes alter available filter values.

### Hero and Widget Cache Rules

`cacheMiddleware({ varyByQuery: true })` sorts query params before building KV keys, and routes with schema defaults should pass `queryDefaults` so explicit defaults do not fragment public caches. Use path-aware defaults when one router has multiple routes with different query defaults, such as `/products` and `/products/search`.

`/api/v1/hero/sliders` is user-agent derived when no `type` query is supplied, so the list route must keep `varyByQuery: true` and cache only explicit `type=desktop` or `type=mobile` requests. Do not cache the untyped auto-detected list response.

Admin widget writes first invalidate API widget/pattern keys, then schedule storefront purges. Product, category, page, and collection scoped placements must include exact rendered `htmlPaths` in the purge payload so those pages move without a global storefront version bump. Widget writes must also resolve published CMS pages whose rich content contains matching `[widget id="..."]` / `[widget slug="..."]` shortcodes and add exact page-render prefixes plus CMS `htmlPaths`; shortcode scans that exceed the exact warm cap or fail after a committed write fall back to a global HTML version bump for freshness. Homepage/global widget changes are the expected global-version/warm-homepage lane.

## Queue Consumer

`src/queue-consumer.ts` dispatches messages by type. Two queue strategies:

### Order Ingest Queue

Queue name: `order-ingest`. Uses batch processing for throughput, but reservation, ambiguous-commit checks, fallback writes, checkout status, ack/retry, and rollback decisions remain isolated per order. A rejected or acked message must not be retried because another message in the same queue batch failed. Handles `order.ingest` messages. Delegated to `handleOrderIngestBatch()` in `@scalius/core/modules/orders/orders.queue`.

After the ingest handler returns, the API queue consumer invalidates targeted product availability caches from the attempted order IDs and variant IDs. This is intentionally post-processing: the ingest handler still owns ack/retry and inventory safety decisions.

### Payment/Notification/OTP Queue

Messages processed independently with `Promise.allSettled`. Successful messages are acked; failed messages retry with 30-second delay.

| Message Type | Handler | Action |
|---|---|---|
| `payment.stripe.confirmed` | `processPaymentConfirmed()` | Convert smallest-unit->major-unit via `getDecimalPlaces()` (ISO 4217), record payment |
| `payment.stripe.failed` | `processPaymentFailed()` | Mark order failed |
| `payment.stripe.canceled` | `releaseOrderInventory()` | Release reserved stock |
| `payment.stripe.refunded` | (audit only) | Log refund event (refunds are admin-initiated synchronously) |
| `payment.sslcommerz.confirmed` | `processPaymentConfirmed()` | Amount already in major unit, record payment |
| `payment.sslcommerz.failed` | `processPaymentFailed()` | Mark order failed |
| `payment.polar.confirmed` | `processPaymentConfirmed()` | Convert smallest-unit->major-unit via `getDecimalPlaces()` |
| `payment.polar.failed` | `processPaymentFailed()` | Mark order failed |
| `payment.polar.refunded` | `processPolarWebhookRefund()` | Update payment status, release inventory on full refund (can originate from Polar dashboard) |
| `order.notification` | `sendOrderNotificationEmail()` + `sendOrderNotification()` (FCM) | Send order status notifications across enabled channels (email, SMS via 4 providers, WhatsApp skip receipt, FCM push). Queue messages with `outboxId` create per-channel delivery receipts so retries skip accepted/skipped targets and keep the parent outbox retryable while any enabled target is retryable. |
| `auth.send_otp` | Email / WhatsApp / SMS | Claim `auth_otp_delivery_receipts`, skip terminal/expired OTP attempts, then send via email (`sendEmail()` with Cloudflare Email Service default and Resend fallback), WhatsApp (Meta Graph API template), or SMS (`getActiveSmsProvider()` with 4 providers). Resend receives `deliveryKey` as `Idempotency-Key`; GenNet receives a deterministic receipt-derived `csms_id`. |

## How to Add a New Endpoint

1. **Create the route file** in `src/routes/` (public) or `src/routes/admin/` (admin-protected):

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ok } from "../utils/api-response";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const getThingRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Things"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Success",
      content: { "application/json": { schema: successEnvelope(z.object({ /* ... */ })) } },
    },
    ...errorResponses,
  },
});

app.openapi(getThingRoute, async (c) => {
  const { id } = c.req.valid("param");
  const thing = await getThingById(c.get("db"), id);
  if (!thing) throw new NotFoundError("Thing not found");
  return ok(c, thing);
});

export const thingRoutes = app;
```

2. **Register in `app.ts`**:

```typescript
import { thingRoutes } from "./routes/things";

// Public route:
app.route("/things", thingRoutes);

// OR admin route (auto-protected by the /admin/* middleware):
app.route("/admin/things", adminThingRoutes);
```

3. **Add caching** (optional) -- use `cacheMiddleware` with `CACHE_TTLS`:

```typescript
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";

app.use("/*", cacheMiddleware({ ttl: CACHE_TTLS.STANDARD, keyPrefix: "api:things:" }));
```

On cache miss, handlers should return as soon as the response is ready; `cacheMiddleware` schedules the KV write through `executionCtx.waitUntil()` in Workers and only awaits it in local/test contexts with no execution context.

If a public endpoint varies by query or request headers, use `varyByQuery`, `queryDefaults`, and/or `cacheCondition` deliberately. User-agent-derived responses should usually bypass shared KV cache unless their cache key includes the derived variant.

4. **Delegate to core** -- route handlers should be thin: validate input, call a `@scalius/core` service function, return via `ok()`/`created()`/`noContent()`. Business logic belongs in `packages/core/src/modules/`.

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.ts` | Worker entry point (fetch + queue + scheduled) |
| `src/app.ts` | Hono app, route mounting, middleware, OpenAPI spec |
| `src/queue-consumer.ts` | Queue message dispatcher |
| `src/middleware/admin-auth.ts` | Admin auth (session + JWT + scanner session cookie) + 2FA gate + RBAC |
| `src/middleware/auth.ts` | JWT auth for protected public routes |
| `src/middleware/webhook-auth.ts` | Delivery webhook signature verification (HMAC/token/IP) |
| `src/middleware/cache.ts` | KV-backed response cache middleware |
| `src/utils/api-response.ts` | `ok()`, `created()`, `noContent()` helpers |
| `src/utils/api-error.ts` | Error class re-exports from `@scalius/core/errors` |
| `src/utils/cache-ttls.ts` | Centralized TTL constants |
| `src/utils/kv-cache.ts` | KV cache get/set/invalidation utilities |
| `src/utils/cache-invalidation.ts` | Entity-specific cache invalidation |
| `src/utils/jwt.ts` | JWT sign/verify/refresh/revoke/blacklist utilities |
| `src/utils/encryption-key.ts` | Encryption key extraction from env |
| `src/schemas/entities.ts` | Zod schemas for all domain entities |
| `src/schemas/responses.ts` | OpenAPI envelope/pagination/error helpers |
