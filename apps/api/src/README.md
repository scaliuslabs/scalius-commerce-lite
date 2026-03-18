# API Worker (`apps/api/`)

Standalone Hono API worker deployed as a Cloudflare Worker. Owns all HTTP routes, queue consumption, cron triggers, and the OpenAPI spec. Admin and storefront apps communicate with this worker via Cloudflare Service Bindings (`env.API` / `env.BACKEND_API`).

## Entry Point

`src/worker.ts` exports an `ApiWorker` class extending `WorkerEntrypoint<Env>` with three handlers:

| Handler | Purpose |
|---------|---------|
| `fetch(request)` | HTTP -- delegates to the Hono app (`src/app.ts`) |
| `queue(batch)` | Queues -- payment events, order ingest, OTP, notifications |
| `scheduled(controller)` | Cron -- releases expired stock reservations every 15 minutes |

## Route Organization

`src/app.ts` creates an `OpenAPIHono` app with base path `/api/v1` and mounts all routes. The file is organized into four sections:

### Storefront Routes (public, no auth)

26 route groups mounted directly on the app. No authentication required -- these serve the customer-facing storefront.

| Mount Point | Route File | Purpose |
|---|---|---|
| `/auth` | `routes/auth.ts` | Better Auth endpoints |
| `/attributes` | `routes/attributes.ts` | Filterable product attributes |
| `/collections` | `routes/collections.ts` | Homepage collections |
| `/hero` | `routes/hero.ts` | Hero section data |
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
| `/seo` | `routes/seo.ts` | SEO settings |
| `/products` | `routes/products.ts` | Product catalog |
| `/categories` | `routes/categories.ts` | Category listings |
| `/orders` | `routes/orders.ts` | Order creation (auth-protected) |
| `/cache` | `routes/cache.ts` | Cache control (admin-protected) |
| `/__ptproxy` | `routes/partytown-proxy.ts` | Partytown analytics proxy |

### Webhook Routes (signature verification IS the auth)

5 webhook receivers -- registered BEFORE auth middleware to bypass it.

| Mount Point | Route File | Verification Method |
|---|---|---|
| `/webhooks/stripe` | `routes/webhooks/stripe.ts` | `constructEventAsync` (Stripe SDK) |
| `/webhooks/sslcommerz` | `routes/webhooks/sslcommerz.ts` | Server-to-server IPN validation API call |
| `/webhooks/polar` | `routes/webhooks/polar.ts` | `standardwebhooks` signature verification |
| `/webhooks/pathao` | `routes/webhooks/pathao.ts` | `X-PATHAO-Signature` header check |
| `/webhooks/steadfast` | `routes/webhooks/steadfast.ts` | `Authorization: Bearer` token check |

### Admin Routes (admin auth + RBAC)

28 route groups under `/admin/*`, protected by `adminAuthMiddleware`.

| Mount Point | Route File | Purpose |
|---|---|---|
| `/admin/categories` | `routes/admin/categories.ts` | Category CRUD |
| `/admin/collections` | `routes/admin/collections.ts` | Collection CRUD + reorder |
| `/admin/customers` | `routes/admin/customers.ts` | Customer management |
| `/admin/pages` | `routes/admin/pages.ts` | CMS page CRUD |
| `/admin/widgets` | `routes/admin/widgets.ts` | Widget CRUD + AI generation |
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
| `/admin/settings` | `routes/admin/settings.ts` | Site settings, payment gateways |
| `/admin/orders` | `routes/admin/orders.ts` | Order management |
| `/admin/products` | `routes/admin/products.ts` | Product CRUD |
| `/admin/auth` | `routes/admin/auth-management.ts` | User/session management |
| `/admin/ai-context` | `routes/admin/ai-context.ts` | AI widget context |
| `/admin/ai-prompts` | `routes/admin/ai-prompts.ts` | AI prompt management |
| `/admin/openrouter` | `routes/admin/openrouter.ts` | OpenRouter LLM proxy |
| `/admin/attributes` | `routes/admin/attributes.ts` | Attribute CRUD |
| `/admin` | `routes/admin/system-utils.ts` | System utilities |
| `/admin/settings/delivery-locations` | `routes/admin/settings/delivery-locations.ts` | Location hierarchy CRUD |
| `/admin/settings/checkout-languages` | (reuses) `routes/checkout-languages.ts` | Admin checkout language CRUD |
| `/admin/settings/abandoned-checkouts` | (reuses) `routes/abandoned-checkouts.ts` | Admin abandoned checkout view |

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
| `/setup` | Initial deployment auth setup (bypasses normal auth) |
| `/docs` | Swagger UI |
| `/openapi.json` | Auto-generated OpenAPI 3.0 spec |
| `/health` | Health check with cache stats |

## Middleware Pipeline

Registered in order in `app.ts`. Every request goes through these:

1. **Per-request init** (`app.use("*")`) -- Calls `getDb(env)`, `initKv(env.CACHE)`, `initStorage(env.BUCKET)`.
2. **CORS logging** (`app.use("*")`) -- Logs preflight requests for debugging.
3. **CORS** (`app.use("*")`) -- Dynamic origin validation via `getCorsOriginContext()` from `@scalius/shared`.
4. **Proxy base URL** (`app.use("*")`) -- Sets `X-Proxy-Base-URL` header from `PUBLIC_API_BASE_URL`.
5. **Error handler** (`app.use("*")`) -- Catches `ApiError` subclasses and generic errors, returns standardized JSON.

Then, route-specific middleware:

| Middleware | Applied To | Purpose |
|---|---|---|
| `adminAuthMiddleware` | `/admin/*`, `/cache/*` | Better Auth session OR JWT Bearer OR Scanner Token. Then RBAC permission check. |
| `authMiddleware` | `/orders/*` | JWT Bearer token verification with auto-refresh. |
| `cacheMiddleware` | Individual routes | KV-backed response caching with configurable TTL. |

### Admin Auth Flow

`adminAuthMiddleware` tries three auth methods in order:

1. **Better Auth session cookie** -- from the admin dashboard SSR frontend
2. **JWT Bearer token** -- from decoupled mobile/external apps
3. **X-Scanner-Token header** -- from the warehouse scanner app (restricted to `/inventory/` endpoints only)

After authentication, it performs RBAC: checks `isSuperAdmin`, then resolves route-specific permissions via `getRoutePermission()` and validates against the user's effective permission set.

## Response Helpers

`src/utils/api-response.ts`:

| Helper | Returns | Status |
|--------|---------|--------|
| `ok(c, data)` | `{ success: true, data: T }` | 200 |
| `created(c, data)` | `{ success: true, data: T }` | 201 |
| `noContent(c)` | Empty body | 204 |

All success responses follow the `{ success: true, data: T }` envelope. The admin proxy unwraps this to `{ success: true, ...T }` for backward compatibility. The storefront reads `json.data` directly.

`src/utils/api-error.ts` re-exports error classes from `@scalius/core/errors`:

| Class | Status | Code |
|-------|--------|------|
| `ValidationError` | 400 | `VALIDATION_ERROR` |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `RateLimitError` | 429 | `RATE_LIMIT` |
| `ServiceUnavailableError` | 503 | `SERVICE_UNAVAILABLE` |

Thrown errors are caught by the global error handler and returned as `{ success: false, error: { code, message, details? } }`.

## Cache TTLs

`src/utils/cache-ttls.ts` centralizes all cache durations:

| Constant | Seconds | Used For |
|----------|---------|----------|
| `STANDARD` | 3600 | Products, categories, pages, widgets, collections |
| `SHORT` | 300 | Search results, order lookups, shipping methods |
| `MEDIUM` | 600 | Delivery locations |
| `ATTRIBUTES` | 1800 | Attribute data |
| `CHECKOUT_CONFIG` | 60 | Gateway config |
| `NONE` | 0 | Analytics config, SEO |

## Queue Consumer

`src/queue-consumer.ts` dispatches messages by type. Three queue strategies:

### Order Ingest Queue

Queue name: `order-ingest-queue`. Uses batch processing -- a single `db.batch()` across all messages in the batch. Handles `order.ingest` messages.

### Payment/Notification/OTP Queue

Messages processed independently with `Promise.allSettled`. Successful messages are acked; failed messages retry with 30-second delay.

| Message Type | Handler | Action |
|---|---|---|
| `payment.stripe.confirmed` | `processPaymentConfirmed()` | Convert cents->major unit via `getDecimalPlaces()`, record payment |
| `payment.stripe.failed` | `processPaymentFailed()` | Mark order failed |
| `payment.stripe.canceled` | `releaseOrderInventory()` | Release reserved stock |
| `payment.stripe.refunded` | (audit only) | Log refund event |
| `payment.sslcommerz.confirmed` | `processPaymentConfirmed()` | Amount already in major unit, record payment |
| `payment.sslcommerz.failed` | `processPaymentFailed()` | Mark order failed |
| `payment.polar.confirmed` | `processPaymentConfirmed()` | Convert cents->major unit via `getDecimalPlaces()` |
| `payment.polar.failed` | `processPaymentFailed()` | Mark order failed |
| `payment.polar.refunded` | `processPolarWebhookRefund()` | Update payment status, release inventory on full refund |
| `order.notification` | Email + FCM push | Send order status email and admin push notification |
| `auth.send_otp` | Email/WhatsApp/SMS | Send OTP code via configured channel |

## How to Add a New Endpoint

1. **Create the route file** in `src/routes/` (public) or `src/routes/admin/` (admin-protected):

```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ok } from "../utils/api-response";
import { NotFoundError } from "../utils/api-error";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";

const app = new OpenAPIHono<{ Bindings: Env }>();

const getThingRoute = createRoute({
  method: "get",
  path: "/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ /* ... */ }) } } },
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
app.use("/*", cacheMiddleware({ ttl: CACHE_TTLS.STANDARD, keyPrefix: "api:things:" }));
```

4. **Delegate to core** -- route handlers should be thin: validate input, call a `@scalius/core` service function, return via `ok()`/`created()`/`noContent()`. Business logic belongs in `packages/core/src/modules/`.

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.ts` | Worker entry point (fetch + queue + scheduled) |
| `src/app.ts` | Hono app, route mounting, middleware, OpenAPI spec |
| `src/queue-consumer.ts` | Queue message dispatcher |
| `src/middleware/admin-auth.ts` | Admin auth (session + JWT + scanner token) + RBAC |
| `src/middleware/auth.ts` | JWT auth for protected public routes |
| `src/middleware/webhook-auth.ts` | Delivery webhook signature verification |
| `src/middleware/cache.ts` | KV-backed response cache middleware |
| `src/utils/api-response.ts` | `ok()`, `created()`, `noContent()` helpers |
| `src/utils/api-error.ts` | Error class re-exports from `@scalius/core` |
| `src/utils/cache-ttls.ts` | Centralized TTL constants |
| `src/utils/kv-cache.ts` | KV cache get/set/invalidation utilities |
| `src/utils/cache-invalidation.ts` | Entity-specific cache invalidation |
| `src/utils/jwt.ts` | JWT sign/verify/refresh utilities |

## Known Gaps

- Widget history API endpoints (`GET/POST/DELETE /admin/widgets/{id}/history/*`) are referenced by the admin UI but do not exist yet.
- `capturePaymentIntent()` and `cancelPaymentIntent()` exist in `@scalius/core` but have no API routes.
- The `media` route (`/media`) is only registered in development mode for local file serving.
- The OpenAPI spec auto-generation only documents routes that use `createRoute()` -- any routes using plain Hono `.get()`/`.post()` are not in the spec.
