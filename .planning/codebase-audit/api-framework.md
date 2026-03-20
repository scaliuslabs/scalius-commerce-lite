# API Framework Infrastructure Audit

**Date:** 2026-03-20
**Scope:** Worker entry, Hono app composition, middleware chain, error handling, queue consumer, OpenAPI config, response envelope, storefront routes, wrangler bindings.
**Files Analyzed:** 40+ files across `apps/api/src/`

---

## Summary

The API framework is well-structured with a clear separation between the thin HTTP layer (`apps/api/src/routes/`) and domain logic (`packages/core/src/modules/`). The OpenAPIHono-based route definitions provide automatic OpenAPI spec generation. Error handling is centralized with a consistent `AppError` hierarchy. The queue consumer is robust with per-message ack/retry. However, there are several real issues: duplicated error handling middleware, inconsistent timestamp formatting across storefront routes, storefront routes that bypass the service layer to query the DB directly, and several `z.any()` usages that degrade the OpenAPI spec quality.

**Overall Grade: B+** -- Solid architecture with well-defined patterns, but accumulated inconsistencies across the ~30 storefront route files need cleanup.

---

## Critical Issues

### 1. Duplicate Error Handling -- Middleware AND onError Do the Same Thing

**Files:** `apps/api/src/app.ts` (lines 84-111 and 157-202)

The `app.onError()` handler (lines 84-111) and the `app.use("*")` try/catch middleware (lines 157-202) both catch errors, format them identically as `{ success: false, error: { code, message, details } }`, and return JSON responses. This means:

- Every error is processed by BOTH handlers (the middleware catches it, returns a response, but if it re-throws, `onError` catches it again).
- The middleware version has a `process.env.NODE_ENV === "development"` branch that includes stack traces; the `onError` version does not. This creates inconsistent error responses depending on which handler wins.
- The middleware version handles raw `Error` instances separately from `unknown` errors; the `onError` version collapses them.

**Fix:** Remove the try/catch middleware entirely. Hono's `onError` is the correct place for global error handling. Move the dev-mode stack trace logic into `onError`.

### 2. Token Blacklist Fails Open -- Known Security Risk

**File:** `apps/api/src/utils/jwt.ts` (line 191)

```typescript
} catch (error: unknown) {
    console.error("Error checking token blacklist:", error);
    return false; // Fail open to avoid blocking valid requests
}
```

When KV is unavailable, `isTokenBlacklisted()` returns `false`, meaning revoked tokens are accepted. This is documented in `CLAUDE.md` under "Known Backlog" but remains a production security risk. Any KV outage window allows revoked tokens to authorize requests.

**Fix:** Consider a fail-closed default for admin routes at minimum. Or maintain a short-lived in-memory blacklist as a fallback.

### 3. `process.env.NODE_ENV` Used in Cloudflare Worker Context

**Files:** `apps/api/src/app.ts` (line 184), `apps/api/src/utils/jwt.ts` (lines 43, 168)

Workers do not have `process.env` by default (the `nodejs_compat` flag provides a polyfill, but `NODE_ENV` is not set by wrangler). The `process.env.NODE_ENV === "development"` check in the error middleware will never be true in production (correct) but also never in local dev unless explicitly set in `.dev.vars`. The code in `app.ts` line 243 (`if (process.env.NODE_ENV === "development")`) controls whether the media server route is registered -- this may silently fail.

**Impact:** Low immediate risk (fails safely), but the pattern is misleading. Use `c.env` bindings or wrangler `vars` for environment detection.

---

## Code Quality Issues

### 4. Excessive `z.any()` in OpenAPI Response Schemas

**Files:** Multiple storefront route files

Many routes use `z.any()` for response fields that have known shapes:

| File | Field |
|------|-------|
| `apps/api/src/routes/storefront.ts` | `seo: z.any()`, `hero: z.any()`, `widgets: z.array(z.any())`, `collections: z.array(z.any())` |
| `apps/api/src/routes/checkout.ts` | `successEnvelope(z.any())` for entire config |
| `apps/api/src/routes/collections.ts` | `collection: z.any()`, `categories: z.array(z.any())`, `products: z.array(z.any())` |
| `apps/api/src/routes/search.ts` | `products: z.array(z.any())`, `pages: z.array(z.any())`, `categories: z.array(z.any())` |
| `apps/api/src/routes/orders.ts` | `order: z.any()` for order detail, `orders: z.array(z.any())` for customer orders |
| `apps/api/src/routes/customer-auth.ts` | `customer: z.object({}).passthrough()`, `orders: z.array(z.any())` |
| `apps/api/src/routes/products.ts` | `variants: z.array(z.any())`, `product: z.any()`, `relatedProducts: z.array(z.any())` |

**Impact:** The generated OpenAPI spec (and therefore the SDK types in `@scalius/api-client`) lack type information for these fields. Consumers get `any` types. The `apps/api/src/schemas/entities.ts` file already defines proper schemas for many of these entities but they are not used in the storefront routes.

**Fix:** Replace `z.any()` with the entity schemas from `apps/api/src/schemas/entities.ts` or create new schemas for storefront-specific response shapes.

### 5. Storefront Routes Bypass Service Layer -- Direct DB Queries

Several storefront routes contain raw Drizzle queries instead of calling `@scalius/core` service functions:

| Route File | What It Does Directly |
|------------|----------------------|
| `apps/api/src/routes/header.ts` | Queries `siteSettings`, parses JSON, builds response |
| `apps/api/src/routes/footer.ts` | Queries `siteSettings`, parses JSON, builds response |
| `apps/api/src/routes/navigation.ts` | Queries `siteSettings`, `categories`, `pages`, builds navigation tree |
| `apps/api/src/routes/collections.ts` | Queries `collections` table directly (but calls `resolveCollectionProducts` for products) |
| `apps/api/src/routes/widgets.ts` | Queries `widgets` table directly |
| `apps/api/src/routes/hero.ts` | Queries `heroSliders` table directly |
| `apps/api/src/routes/locations.ts` | Queries `deliveryLocations` table directly |
| `apps/api/src/routes/shipping-methods.ts` | Queries `shippingMethods` table directly |
| `apps/api/src/routes/seo.ts` | Queries `siteSettings` table directly |
| `apps/api/src/routes/orders.ts` | Large inline query with joins for GET /:id |
| `apps/api/src/routes/storefront.ts` | CSP route queries `settings` table directly |

This violates the "thin HTTP layer" convention stated in `CLAUDE.md`. These routes mix data access and presentation logic in the HTTP layer.

**Fix:** Extract DB queries to corresponding `*.storefront.ts` service files in `packages/core/src/modules/`. The `storefront.ts` route already uses `getHomepageData()` and `getLayoutData()` from `@scalius/core` -- that is the correct pattern.

### 6. Inconsistent Timestamp Formatting

**Files:** Multiple storefront routes

Each route file implements its own timestamp conversion logic:

- `apps/api/src/routes/collections.ts`: `formatTimestamp()` -- handles null, validates, multiplies by 1000
- `apps/api/src/routes/widgets.ts`: `convertTimestampToISO()` -- handles Date, number, string, validates
- `apps/api/src/routes/hero.ts`: Inline `slider.createdAt instanceof Date ? slider.createdAt.toISOString() : null`
- `apps/api/src/routes/shipping-methods.ts`: `method.createdAt instanceof Date ? method.createdAt.toISOString() : null`
- `apps/api/src/routes/orders.ts`: `unixToDate()` then `.toISOString()`

**Impact:** Different routes handle the same timestamp edge cases differently. A unix timestamp that is a string in one route gets different treatment than in another.

**Fix:** Create a shared `formatTimestamp()` utility in `apps/api/src/utils/` or `@scalius/shared` and use it everywhere.

### 7. Checkout Config Error Swallowed and Returns Hardcoded Fallback

**File:** `apps/api/src/routes/checkout.ts` (lines 50-60)

```typescript
} catch (error: unknown) {
    console.error("[checkout] Error fetching checkout config:", error instanceof Error ? error.message : error);
    return ok(c, {
      gateways: [{ id: "cod", name: "Cash on Delivery", currencies: ["bdt"] }],
      guestCheckoutEnabled: true,
      ...
    });
}
```

If the database is unreachable or the service throws, the storefront silently receives a hardcoded "COD only" gateway config with Bangladesh-specific currency. This will cause incorrect checkout behavior for non-BDT stores.

**Fix:** Let the error propagate to the global error handler, or at minimum read the fallback currency from a less-error-prone source.

---

## Middleware Chain Analysis

**File:** `apps/api/src/app.ts`

The middleware chain executes in this order for every request:

```
1. Per-request init       (lines 118-126)  -- DB, KV, R2 initialization
2. CORS preflight logger  (lines 128-135)  -- Logs OPTIONS requests
3. CORS handler           (lines 137-146)  -- Dynamic origin from getCorsOriginContext()
4. X-Proxy-Base-URL       (lines 148-154)  -- Sets header for frontend proxy discovery
5. Error handler (TRY)    (lines 157-202)  -- DUPLICATE with onError
6. Route handler          (varies)         -- Matched route executes
```

**Issues:**

- **Middleware #2 is noise**: The CORS preflight logger adds zero value. It logs the origin of every OPTIONS request but takes no action. This is pure log pollution in production.
- **Middleware #4 sets a response header on every request**: `X-Proxy-Base-URL` is set for all requests, even webhooks and internal calls. This header is only useful for the admin/storefront frontends.
- **Middleware #5 is redundant**: See Critical Issue #1.
- **The CORS middleware creates a new `cors()` instance on every request**: The `corsMiddleware` variable is recreated inside the handler because `getCorsOriginContext()` is async. This is correct behavior (origin must be dynamic) but worth noting for understanding.

**Auth middleware ordering:**

```
Public storefront routes:  No auth
/webhooks/*:               No auth (signature verification in handler)
/orders/*:                 authMiddleware (JWT)
/cache/*:                  adminAuthMiddleware (Better Auth session OR JWT)
/admin/*:                  adminAuthMiddleware (Better Auth session OR JWT OR scanner token)
```

The auth boundary is well-defined: webhooks are registered BEFORE the auth middleware block, public routes have no auth, and admin routes use a wildcard middleware.

**Scanner token security:** The scanner token in `apps/api/src/middleware/admin-auth.ts` is properly restricted to `/inventory/` endpoints only (line 100-106). The synthetic user gets `role: "scanner"` which prevents RBAC escalation.

---

## Error Handling Architecture

### Error Class Hierarchy

**File:** `packages/core/src/errors/index.ts`

```
AppError (base)
  +-- ValidationError  (400, "VALIDATION_ERROR")
  +-- NotFoundError    (404, "NOT_FOUND")
  +-- UnauthorizedError(401, "UNAUTHORIZED")
  +-- ForbiddenError   (403, "FORBIDDEN")
  +-- ConflictError    (409, "CONFLICT")
  +-- RateLimitError   (429, "RATE_LIMIT")
  +-- ServiceUnavailableError (503, "SERVICE_UNAVAILABLE")
```

**Re-export:** `apps/api/src/utils/api-error.ts` re-exports all errors from `@scalius/core/errors` with `AppError as ApiError` alias for backward compatibility.

**Response envelope:**

```json
// Success: { "success": true, "data": T }
// Error:   { "success": false, "error": { "code": "...", "message": "...", "details": ... } }
```

**Quality assessment:** The error hierarchy is clean and well-designed. All errors carry a status code, machine-readable code, and human message. The `details` field on `ValidationError` passes through Zod validation issues.

### Error Handling Gap: Manual Error String Parsing in Order Route

**File:** `apps/api/src/routes/orders.ts` (lines 335-347)

```typescript
if (error instanceof Error && error.message.startsWith("VALIDATION_ERROR:")) {
  throw new ValidationError(error.message.replace("VALIDATION_ERROR:", ""));
}
if (error instanceof Error && error.message.startsWith("INSUFFICIENT_STOCK:")) {
  throw new ValidationError(error.message.replace("INSUFFICIENT_STOCK:", ""));
}
```

The `createStorefrontOrder()` service function throws plain `Error` objects with prefixed messages instead of typed `AppError` subclasses. The route handler then manually parses these string prefixes. This is fragile -- a typo in the prefix would cause the error to fall through to a generic 500.

**Fix:** Make `createStorefrontOrder()` throw `ValidationError` directly (it already has access to the class via `@scalius/core/errors`).

---

## Queue Consumer Analysis

**File:** `apps/api/src/queue-consumer.ts` (369 lines)

### Architecture

```
Worker.queue(batch)
  -> handleQueueBatch(batch, env)
    -> if order.ingest: handleOrderIngestBatch() [batch processing]
    -> else: Promise.allSettled(messages.map(processQueueMessage))
      -> per message: switch on payload.type
        -> payment.*.confirmed -> processPaymentConfirmed()
        -> payment.*.failed -> processPaymentFailed()
        -> payment.*.canceled -> releaseOrderInventory()
        -> order.notification -> sendOrderNotificationEmail() + sendOrderNotification()
        -> auth.send_otp -> sendEmail() or WhatsApp API
```

### Strengths

1. **Ack/retry pattern is correct:** Successful messages are `.ack()`'d, failed messages are `.retry({ delaySeconds: 30 })`. Cloudflare handles DLQ after max retries.
2. **Order ingest batch optimization:** The `order.ingest` messages use a single `db.batch()` call for all messages in the batch, which is a correct optimization for D1.
3. **FCM push is non-fatal:** The `sendOrderNotification()` call is wrapped in try/catch (line 353) so FCM failures do not prevent email delivery.
4. **Type safety:** The `PaymentQueueMessage` discriminated union type ensures exhaustive switch handling.

### Issues

**A. Inline HTML template in queue consumer (lines 184-194):**
The email OTP HTML template is hardcoded inline. This should be in a template file or at least a shared constant. When the email design changes, someone has to find it buried in the queue consumer.

**B. WhatsApp API credentials passed through queue message (lines 198-200, 201-224):**
The queue payload includes `waToken` and `waPhoneId`. While these are read from the DB at enqueue time, passing credentials through the queue message body means they are stored in Cloudflare's queue infrastructure. This is not encrypted at rest in the same way KV or D1 is.

**Fix for B:** Read WhatsApp credentials from the DB inside the queue consumer handler, not from the message payload.

**C. Missing default break in switch exhaustiveness:**
The `default` case (line 365) only logs a warning. For a queue consumer, unknown message types should also `.ack()` the message to prevent infinite retries (the current code falls through to the ack/retry loop which acks on fulfilled, but the warn does not throw, so it would be acked -- this is actually correct behavior, just not obvious).

### Wrangler Queue Config

**File:** `apps/api/wrangler.jsonc`

| Queue | Batch Size | Timeout | Retries | DLQ |
|-------|-----------|---------|---------|-----|
| payment-events | 10 | 5s | 3 | payment-events-dlq |
| order-notifications | 20 | 10s | 3 | order-notifications-dlq |
| auth-otp | 10 | 2s | 5 | auth-otp-dlq |
| order-ingest | 100 | 5s | 3 | order-ingest-dlq |

All queues have DLQs configured. The OTP queue has 5 retries (higher than others) which is appropriate for time-sensitive delivery.

---

## OpenAPI/Swagger Quality

### Spec Generation

**File:** `apps/api/src/app.ts` (lines 347-364)

The spec is generated dynamically via `app.getOpenAPIDocument()` at `/api/v1/openapi.json`. Swagger UI is served at `/api/v1/docs`.

### Schema Quality

**Good:**
- `apps/api/src/schemas/responses.ts` provides reusable `successEnvelope()`, `errorResponses`, `paginationSchema`
- `apps/api/src/schemas/entities.ts` defines 20+ entity schemas with proper types
- All routes use `createRoute()` with `tags` and `summary` fields

**Bad:**
- The entity schemas in `entities.ts` are well-defined but many storefront routes do not use them. They define inline schemas with `z.any()` instead (see Issue #4).
- Many `.passthrough()` calls weaken the schema validation.
- Some timestamp fields use `z.any()` because of Drizzle Date vs. unix number ambiguity (e.g., `productVariantSchema` lines 64-77 in entities.ts).

### Security Scheme

```typescript
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});
```

The security scheme is registered but individual routes do not reference it in their `createRoute()` definitions (no `security: [{ bearerAuth: [] }]`). This means the OpenAPI spec does not indicate which routes require authentication -- the auth is enforced by middleware, not by the spec.

**Fix:** Add `security` to protected route definitions for better API documentation.

---

## Pattern Consistency

### Consistent Patterns (Good)

1. **Response envelope:** All routes use `ok(c, data)` for 200 responses. No routes return raw `c.json()` except for 202 Accepted (which correctly uses `c.json({ success: true, data: {...} }, 202)`).
2. **Error throwing:** All routes throw `ApiError` subclasses rather than returning error responses directly. The global handler formats them.
3. **Route file structure:** Each file follows `const app = new OpenAPIHono(); ... export { app as xxxRoutes }`.
4. **Import pattern:** All route files import `ok` from `../utils/api-response` and error classes from `../utils/api-error`.
5. **Cache middleware:** Applied via `app.use("*", cacheMiddleware({...}))` or per-path.
6. **Naming:** Route files are kebab-case, export names are camelCase suffixed with `Routes`.

### Inconsistent Patterns (Fix)

| Pattern | Correct Usage | Deviation |
|---------|--------------|-----------|
| Cache TTL source | `CACHE_TTLS.STANDARD` constant | `products.ts`, `collections.ts`, `hero.ts`, `pages.ts`, `widgets.ts`, `navigation.ts` use magic number `3600` |
| Hono type parameter | `new OpenAPIHono<{ Bindings: Env }>()` | `products.ts`, `header.ts`, `footer.ts`, `navigation.ts`, `pages.ts` use `new OpenAPIHono()` without Bindings |
| Schema file usage | Import from `../schemas/entities.ts` | Only `widgets.ts`, `locations.ts`, `pages.ts` use entity schemas; most storefront routes define inline schemas |
| Service layer delegation | Call `@scalius/core` service functions | 11+ storefront routes query DB directly (see Issue #5) |
| Timestamp formatting | No shared utility exists | 5 different inline implementations (see Issue #6) |

### Admin vs Storefront Route Separation

The route files are split into:
- `apps/api/src/routes/*.ts` -- storefront-facing routes (30 files, ~5300 lines)
- `apps/api/src/routes/admin/*.ts` -- admin-facing routes (27 files, ~9400 lines)
- `apps/api/src/routes/payment/*.ts` -- payment gateway routes (3 files, ~640 lines)
- `apps/api/src/routes/webhooks/*.ts` -- webhook handlers (5 files, ~350 lines)

This separation is clean. Admin routes share the `adminAuthMiddleware` wildcard at `/admin/*`. Storefront routes are public or use per-route auth.

---

## Scalability & Performance

### Route Count and App Size

**File:** `apps/api/src/app.ts` (376 lines, 75 imports)

The single `app.ts` file imports and mounts 65+ route modules. This is a large import tree but since Cloudflare Workers bundle everything at deploy time, the import count does not affect cold start (there is no lazy loading needed).

**Route registration is O(n)** -- Hono builds a trie router, so route matching remains O(path_depth) regardless of route count.

### Middleware Overhead Per Request

Every request (including health checks) goes through 5 middleware layers:
1. DB init (`getDb()` -- lightweight factory, no connection pool)
2. KV init (`initKv()` -- single assignment)
3. CORS check (creates new `cors()` instance each time)
4. Header set (string concatenation)
5. Error handler (try/catch wrapper)

**Total overhead:** Negligible. The DB and KV init are assignment operations, not network calls. CORS is a function call. The only concern is the CORS middleware creating a new closure on every request, but this is unavoidable with dynamic origins.

### Cache Strategy

The KV cache middleware (`apps/api/src/middleware/cache.ts`) caches full HTTP responses (status + headers + body). This is effective but:

- Cache keys include the full path and query string. No normalization (e.g., `?a=1&b=2` vs `?b=2&a=1` produce different keys).
- The `varyByAuth` option hashes the entire Authorization header. This means different JWT tokens for the same user produce different cache keys. For JWTs that rotate (via `refreshTokenIfNeeded`), this causes cache misses after every refresh.

### D1 Connection Pattern

`getDb(c.env)` is called in the per-request middleware. D1 does not use connection pools -- each call creates a lightweight wrapper around the binding. This is correct for Workers.

---

## LLM-Friendliness

### Strengths for LLM Navigation

1. **Consistent file naming:** Route files match their mount paths (`/admin/products` -> `routes/admin/products.ts`)
2. **Top-of-file comments:** Many files have header comments explaining purpose (e.g., `customer-auth.ts` lines 1-14)
3. **Inline type definitions:** Route files define their request/response schemas inline, making it possible to understand the API contract without reading other files
4. **Queue consumer has architecture comment:** Lines 1-19 explain the dispatch pattern and handler locations
5. **CLAUDE.md is comprehensive:** The project instructions file covers all conventions, paths, and patterns

### Weaknesses for LLM Navigation

1. **75 imports in app.ts:** An LLM reading `app.ts` has to process 75 import statements before reaching the middleware chain. Consider a barrel import for route groups.
2. **Storefront routes scattered at root level:** There is no `routes/storefront/` directory. Storefront routes like `products.ts`, `categories.ts`, `pages.ts` sit next to admin routes at the root of `routes/`. Only admin routes have a clear `/admin/` directory. This makes it unclear which routes are storefront-facing without reading `app.ts`.
3. **No JSDoc on exported functions:** The `ok()`, `created()`, `noContent()` helpers have doc comments, but most route handler functions do not.
4. **Inline schemas vs entity schemas:** An LLM looking for the schema of a product response has to check both `schemas/entities.ts` AND the inline schema in the route file. There is no single source of truth.

---

## Recommended Changes

### Priority 1 -- Bugs and Security

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | Remove duplicate error handler middleware (keep `onError` only) | `apps/api/src/app.ts` | 30 min |
| 2 | Fix checkout config hardcoded BDT fallback | `apps/api/src/routes/checkout.ts` | 15 min |
| 3 | Stop passing WhatsApp credentials through queue messages | `apps/api/src/queue-consumer.ts`, enqueue sites | 1 hr |
| 4 | Make `createStorefrontOrder()` throw typed errors instead of string-prefixed messages | `packages/core/src/modules/orders/`, `apps/api/src/routes/orders.ts` | 1 hr |

### Priority 2 -- Consistency

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 5 | Replace magic TTL numbers with `CACHE_TTLS` constants | 6 route files | 30 min |
| 6 | Add `<{ Bindings: Env }>` type parameter to all `OpenAPIHono()` constructors | 5 route files | 15 min |
| 7 | Create shared `formatTimestamp()` utility, replace 5 inline implementations | New utility + 5 route files | 1 hr |
| 8 | Replace `z.any()` in storefront route schemas with proper entity schemas | 8+ route files | 3 hrs |

### Priority 3 -- Architecture

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 9 | Extract direct DB queries from storefront routes into `@scalius/core` service functions | 11 route files, new service files | 4 hrs |
| 10 | Remove CORS preflight logger middleware | `apps/api/src/app.ts` | 5 min |
| 11 | Move storefront routes into `routes/storefront/` directory | 20+ route files, `app.ts` | 2 hrs |
| 12 | Add `security` annotation to protected OpenAPI routes | All admin route files | 2 hrs |
| 13 | Extract OTP email template from queue consumer | `apps/api/src/queue-consumer.ts` | 30 min |

### Priority 4 -- Nice to Have

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 14 | Normalize query string parameters in cache key generation | `apps/api/src/middleware/cache.ts` | 30 min |
| 15 | Consolidate 75 imports in `app.ts` using barrel files for route groups | `app.ts`, new index files | 1 hr |
| 16 | Add request ID middleware for log correlation | `apps/api/src/app.ts` | 30 min |

---

## Appendix: Route Inventory

### Storefront Routes (Public, no auth unless noted)

| Mount Path | File | Auth | Cache TTL |
|-----------|------|------|-----------|
| `/auth` | `routes/auth.ts` | Mixed (some endpoints use authMiddleware) | None |
| `/attributes` | `routes/attributes.ts` | None | ATTRIBUTES (1800s) |
| `/collections` | `routes/collections.ts` | None | 3600s (magic) |
| `/hero` | `routes/hero.ts` | None | 3600s (magic) |
| `/search` | `routes/search.ts` | None | SHORT (300s) + rate limit |
| `/header` | `routes/header.ts` | None | STANDARD (3600s) |
| `/navigation` | `routes/navigation.ts` | None | 3600s (magic) |
| `/footer` | `routes/footer.ts` | None | STANDARD (3600s) |
| `/pages` | `routes/pages.ts` | None | 3600s (magic) |
| `/discounts` | `routes/discounts.ts` | None | None |
| `/widgets` | `routes/widgets.ts` | None | 3600s (magic) |
| `/analytics` | `routes/analytics.ts` | None | 0 (no cache) |
| `/meta` | `routes/meta-conversions.ts` | None | None |
| `/storefront` | `routes/storefront.ts` | None | STANDARD (3600s) |
| `/checkout` | `routes/checkout.ts` | None | 60s |
| `/customer-auth` | `routes/customer-auth.ts` | Cookie-based sessions | None |
| `/checkout-languages` | `routes/checkout-languages.ts` | None | N/A |
| `/abandoned-checkouts` | `routes/abandoned-checkouts.ts` | Mixed (cleanup requires auth) | None |
| `/locations` | `routes/locations.ts` | None | 600s |
| `/shipping-methods` | `routes/shipping-methods.ts` | None | 300s |
| `/seo` | `routes/seo.ts` | None | 0 (no cache) |
| `/products` | `routes/products.ts` | None | 3600s (magic) |
| `/categories` | `routes/categories.ts` | None | 3600s (magic) |
| `/orders` | `routes/orders.ts` | authMiddleware (JWT) | SHORT (300s) |
| `/cache` | `routes/cache.ts` | adminAuthMiddleware | N/A |
| `/payment/stripe` | `routes/payment/stripe-routes.ts` | None | None |
| `/payment/sslcommerz` | `routes/payment/sslcommerz-routes.ts` | None | None |
| `/payment/polar` | `routes/payment/polar-routes.ts` | None | None |
| `/webhooks/*` | `routes/webhooks/*.ts` | Signature verification | None |

### Admin Routes (all behind adminAuthMiddleware)

27 route files in `apps/api/src/routes/admin/` totaling ~9400 lines. All RBAC-gated via `getRoutePermission()`.

### Special Routes

| Path | Purpose | File |
|------|---------|------|
| `/` | Welcome message | `app.ts` (line 206) |
| `/health` | Health check with cache stats | `app.ts` (line 246) |
| `/__ptproxy` | Partytown analytics proxy | `routes/partytown-proxy.ts` |
| `/media` | Dev-only media server | `routes/media-server.ts` |
| `/docs` | Swagger UI | `app.ts` (line 344) |
| `/openapi.json` | OpenAPI spec | `app.ts` (line 347) |
| `/setup` | Initial deployment setup | `routes/admin/auth-management.ts` |
