# Audit 20: API Worker Architecture

**Scope:** `apps/api/` -- Worker entry, Hono app setup, middleware, route organization, error handling, response patterns, queue consumer, OpenAPI spec, auth integration.

**Files reviewed:** `worker.ts`, `app.ts`, `queue-consumer.ts`, 4 middleware files, 6 utility files, 15+ route files (storefront, admin, webhooks, payments), `wrangler.jsonc`, `package.json`, `tsconfig.json`, `@scalius/core/errors/index.ts`, `@scalius/database/client.ts`.

---

## 1. Worker Entry (`worker.ts`)

**Status: Clean.**

```
ApiWorker extends WorkerEntrypoint<Env>
  fetch()      -> app.fetch(request, env, ctx)
  queue()      -> handleQueueBatch(batch, env)
  scheduled()  -> releaseExpiredReservations(db, 30)  [every 15 min]
```

The entry point is minimal and correct. Three concerns are clearly separated: HTTP, queues, and cron. The `AppType` is re-exported for RPC type inference. No issues.

---

## 2. App Organization (`app.ts`)

**Status: Functional but growing unwieldy. 375 lines, 75 route imports.**

### Structure

```
1. Imports (75 route + middleware imports, lines 1-74)
2. App creation with basePath("/api/v1") (line 78)
3. Global onError handler (lines 84-111)
4. Middleware chain (lines 118-202):
   - DB/KV/R2 initialization
   - CORS preflight logging
   - CORS middleware
   - X-Proxy-Base-URL header
   - Error handling try/catch
5. Root endpoint + health check (lines 206-273)
6. Storefront routes (lines 220-242)
7. Webhook routes (lines 282-286)
8. Auth middleware registration (lines 289-291)
9. Protected storefront routes (lines 293-296)
10. Admin routes with adminAuthMiddleware (lines 303-332)
11. Setup routes (line 335)
12. Payment routes (lines 338-340)
13. Swagger/OpenAPI (lines 343-371)
```

### Strengths

- Clear separation between storefront, admin, and webhook route groups.
- `basePath("/api/v1")` on the app keeps individual route files simple.
- Webhook routes are registered before auth middleware, so signature verification is the only auth (correct).
- The `adminAuthMiddleware` uses `app.use("/admin/*", ...)` to blanket all admin routes.
- OpenAPI doc and Swagger UI are served from the same app.

### Issues

**[MEDIUM] Duplicate error handling.** The global `app.onError()` handler (lines 84-111) and the middleware-based `try/catch` handler (lines 157-202) are nearly identical. Hono's `onError` already catches anything thrown from route handlers. The middleware-based handler is redundant -- it adds a second layer of the same logic. The middleware version adds a `stack` field in development mode and handles `instanceof Error` separately, which the `onError` does not. These should be merged into a single handler.

**[LOW] 75 route imports.** The file is a registry of every route in the system. This works but creates a large merge-conflict surface. If the route count doubles, this file becomes unwieldy. A potential improvement: group imports by domain into barrel files (e.g., `routes/admin/index.ts` that exports all admin sub-routes). Not urgent.

**[LOW] Missing newline between media route and health check.** Line 245: `}// Add health check endpoint` -- the closing brace of the dev-only media block runs directly into the health check comment. Cosmetic.

---

## 3. Route Patterns

**Status: Highly consistent. Good template for LLMs.**

Every route file follows the same pattern:

```typescript
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ok, created, noContent } from "../utils/api-response";
import { NotFoundError, ValidationError } from "../utils/api-error";

const app = new OpenAPIHono();

const myRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Domain"],
  summary: "Description",
  request: { query: z.object({...}) },
  responses: { 200: { description: "..." } }
});

app.openapi(myRoute, async (c) => {
  const db = c.get("db");
  // ... delegate to @scalius/core service
  return ok(c, result);
});

export { app as myRoutes };
```

### Strengths

- Routes are thin HTTP wrappers. Business logic lives in `@scalius/core` services.
- Validation schemas are defined inline or imported from `@scalius/core`.
- Error mapping is consistent: service throws `Error`, route catches and re-throws as `NotFoundError`/`ValidationError`/etc.
- `ok()`, `created()`, `noContent()` enforce the `{ success: true, data: T }` envelope.

### Route File Sizes

| File | Lines | Assessment |
|------|-------|------------|
| `admin/orders.ts` | 861 | At limit. 20+ endpoints for orders, shipments, fulfillment, COD, refunds. Could split shipment/fulfillment into a sub-file. |
| `admin/rbac.ts` | 678 | At limit. Role/permission CRUD. Acceptable for a single domain. |
| `admin/auth-management.ts` | 587 | Moderate. Auth setup + management. |
| `admin/products.ts` | 555 | Good. Products + variants with bulk operations. |
| `categories.ts` (storefront) | 450 | Good. |
| `admin/widgets.ts` | 412 | Good. |
| All others | <400 | Clean. |

Only `admin/orders.ts` is truly large. It handles orders, COD tracking, fulfillment shipments, payment info, refunds, and returns -- all under one file. The shipment-related endpoints (lines 474-703) could be extracted to `admin/order-shipments.ts`.

---

## 4. Error Handling

**Status: Well-designed error class hierarchy. One format inconsistency.**

### Error Classes (in `@scalius/core/errors/index.ts`)

```
AppError (status, code, message, details)
  -> ValidationError     (400, VALIDATION_ERROR)
  -> NotFoundError       (404, NOT_FOUND)
  -> UnauthorizedError   (401, UNAUTHORIZED)
  -> ForbiddenError      (403, FORBIDDEN)
  -> ConflictError       (409, CONFLICT)
  -> RateLimitError      (429, RATE_LIMIT)
  -> ServiceUnavailableError (503, SERVICE_UNAVAILABLE)
```

The `apps/api/src/utils/api-error.ts` re-exports these with `AppError as ApiError` for backward compatibility with the global error handler. This is clean.

### Global Error Response Format

The `onError` handler produces:
```json
{ "success": false, "error": { "code": "...", "message": "...", "details": ... } }
```

### Issue: Middleware error format mismatch

**[MEDIUM]** The `authMiddleware` and `adminAuthMiddleware` return error responses with a different shape:

```json
{ "success": false, "error": "Authentication required", "message": "..." }
```

This is flat (`error` is a string) vs. the global handler's nested format (`error` is an object with `code`/`message`). Consumers parsing `response.error.code` will get `undefined` for auth errors. These middleware should throw `UnauthorizedError` / `ForbiddenError` instead of manually constructing JSON responses, letting the global error handler format them consistently.

Specific locations:
- `middleware/auth.ts` lines 45-51, 74-80, 90-96
- `middleware/admin-auth.ts` lines 91-98, 108-111, 127-135, 156-168, 176

The `adminAuthMiddleware` also has two responses that omit `success: false` entirely (lines 127-135, 176).

---

## 5. Response Pattern

**Status: Consistent across route handlers. Envelope contract is well-enforced.**

### Response Helpers

```typescript
ok(c, data)       -> { success: true, data: T }  (200)
created(c, data)  -> { success: true, data: T }  (201)
noContent(c)      -> null body                     (204)
```

### 202 Accepted Pattern

The `orders.ts` storefront route correctly builds the 202 manually:
```typescript
c.json({ success: true, data: { checkoutToken, orderId, ... } }, 202)
```

This follows the CLAUDE.md convention that `ok()` only supports 200/201.

### Pagination Pattern

Routes return pagination as part of the data payload:
```typescript
ok(c, { orders: [...], pagination: { page, limit, total, totalPages } })
```

This is consistent across admin list endpoints.

---

## 6. Queue Consumer (`queue-consumer.ts`)

**Status: Well-structured. Good separation of concerns.**

### Architecture

```
handleQueueBatch()
  |-- order-ingest-queue -> handleOrderIngestBatch() [batch strategy]
  |-- all other queues -> processQueueMessage() per message [individual ack/retry]
        |-- auth.send_otp -> inline email/WhatsApp
        |-- payment.stripe.confirmed/failed/canceled/refunded
        |-- payment.sslcommerz.confirmed/failed
        |-- payment.polar.confirmed/failed/refunded
        |-- order.notification -> email + FCM
```

### Strengths

- Order ingest uses batch processing (`db.batch()` across all messages). Other messages are processed independently with `Promise.allSettled`.
- Failed messages get `msg.retry({ delaySeconds: 30 })` with Cloudflare's built-in retry.
- All 4 queues have DLQ configured in `wrangler.jsonc`.
- Currency conversion uses `getDecimalPlaces()` for ISO 4217 compliance.
- FCM push failure is caught and logged as non-fatal (won't fail the message).

### Issues

**[LOW] Inline OTP email template.** The `auth.send_otp` case (lines 180-231) contains an HTML email template inline. The TODO at line 19 acknowledges this should be extracted when SMS providers are added. Not urgent but the inline HTML makes the file noisier.

**[LOW] Missing type narrowing for order ingest.** Line 138 uses `batch.queue === "order-ingest-queue"` OR `batch.messages.some(m => m.body.type === "order.ingest")`. The queue name check should be sufficient since Cloudflare routes each queue to one consumer. The `some()` fallback is defensive but adds an unnecessary scan.

---

## 7. Auth Integration

**Status: Two auth systems coexist correctly.**

### Auth Middleware (`middleware/auth.ts`)

- JWT-based. Extracts `Bearer` token from `Authorization` header.
- Token blacklist checked via KV.
- Auto-refresh: if token is within 5 minutes of expiry, a new one is issued via `X-New-Token` header.
- Skips auth for `/health`, `/docs`, `/openapi.json`, `/auth/token`.

### Admin Auth Middleware (`middleware/admin-auth.ts`)

Three-tier auth cascade:
1. **Better Auth session cookie** (from admin dashboard SSR)
2. **JWT Bearer token** (for decoupled/mobile clients)
3. **Scanner token** (KV-based, restricted to `/inventory/` endpoints)

After auth, RBAC kicks in:
- Super admin bypasses all permission checks.
- Regular admin users have permissions checked against `getRoutePermission()`.

### Webhook Auth (`middleware/webhook-auth.ts`)

Not middleware per se -- it's a utility function `verifyDeliveryWebhook()` used by Pathao/Steadfast webhook routes. Three strategies: HMAC-SHA256 signature, IP allowlist, or passthrough with security warning. Well-implemented with constant-time comparison.

---

## 8. Identified Issues (by severity)

### CRITICAL

**[C1] Singleton `db` import in 6 route files.**

Several storefront route files import `{ db }` (the lazy proxy singleton) instead of using `c.get("db")`:

| File | Import |
|------|--------|
| `routes/auth.ts` | `import { db } from "@scalius/database/client"` |
| `routes/header.ts` | `import { db } from "@scalius/database/client"` |
| `routes/categories.ts` | `import { db } from "@scalius/database/client"` |
| `routes/footer.ts` | `import { db } from "@scalius/database/client"` |
| `routes/navigation.ts` | `import { db } from "@scalius/database/client"` |
| `routes/admin/settings/payments.ts` | `import { db } from "@scalius/database/client"` |
| `routes/admin/settings/hero-sliders.ts` | `import { db } from "@scalius/database/client"` |

The `db` proxy works because `getDb(env)` is called in the init middleware before any route handler runs, so the singleton is populated. However, this creates a hidden coupling: if the init middleware is ever removed or reordered, all these routes silently break. The correct pattern (used by ~90% of routes) is `const db = c.get("db")`. These 7 files should be migrated.

**[C2] Inline `require()` in admin orders route.**

Line 268 of `admin/orders.ts`:
```typescript
const tracking = await c.get("db").select().from(require("@scalius/database/schema").codTracking)...
```
Using `require()` at runtime in an ESM context is fragile. It works because wrangler/esbuild handles it, but it breaks tree-shaking and static analysis. This should be a top-level import.

### HIGH

**[H1] Error response format inconsistency between middleware and global handler.**

Auth middleware returns `{ success: false, error: "string", message: "string" }`.
Global handler returns `{ success: false, error: { code: "string", message: "string" } }`.

Consumers cannot reliably parse error responses. See Section 4 for details.

**[H2] Auth middleware `process.env.API_TOKEN` fallback.**

In `routes/auth.ts` line 57-59:
```typescript
const API_TOKEN = c.env.API_TOKEN || process.env.API_TOKEN || "default-api-token-change-in-production";
```
The fallback chain uses `process.env` which is not available in Cloudflare Workers production (only in local dev via Node compat). This creates a false sense of security -- the default token string is baked into the bundle. The `c.env.API_TOKEN` path is correct for production (reads from `wrangler secret`). The `process.env` and default fallbacks should be removed or limited to development mode only.

### MEDIUM

**[M1] Duplicate error handling in app.ts.**

Both `app.onError()` (lines 84-111) and the middleware try/catch (lines 157-202) catch the same errors. See Section 2.

**[M2] Missing OpenAPI response schemas.**

Every `createRoute()` response definition is `{ description: "..." }` with no `content` or `schema`. Example:
```typescript
responses: { 200: { description: "Product list with pagination" } }
```
This means the OpenAPI spec documents the request schemas (via Zod) but NOT the response schemas. The generated spec will show response descriptions but no type information. This defeats the purpose of OpenAPI for SDK generation and documentation. Response schemas should use `z.object()` definitions.

**[M3] Admin orders file at 861 lines.**

See Section 3. The shipment management endpoints (6 endpoints, ~230 lines) and the COD/refund/return endpoints (~100 lines) could be extracted to keep the file under 500 lines.

**[M4] CORS preflight logging in production.**

The CORS logging middleware (lines 128-135) logs every OPTIONS preflight request. This is noisy in production and provides no actionable information. Should be gated behind development mode.

### LOW

**[L1] Stale file-level comments.** `app.ts` line 1: `// src/server/index.ts`. `products.ts` line 1: `// src/server/routes/products.ts`. These reference an old file structure.

**[L2] `ok()` accepts status parameter but only 200/201.** The signature `ok(c, data, status: 200 | 201 = 200)` overlaps with `created()`. The status parameter on `ok()` should be removed since `created()` handles 201.

**[L3] No RateLimitError `Retry-After` header.** The `RateLimitError` class has a `retryAfterSeconds` property but neither the global error handler nor the search route sets a `Retry-After` header. Per HTTP spec, 429 responses should include this header.

---

## 9. OpenAPI Spec Quality

**Status: Partially implemented.**

### What works
- All routes use `createRoute()` with method, path, tags, and summary.
- Request validation schemas (query, params, body) are fully typed via Zod.
- Tags are consistent (e.g., "Admin - Products", "Products", "Orders").
- Swagger UI is served at `/api/v1/docs`.
- Bearer auth security scheme is registered.

### What's missing
- **Response schemas**: No route defines response content schemas. The spec only has descriptions.
- **Error response schemas**: 4xx/5xx responses have no structured schema definition.
- **Security annotations**: Routes don't declare which security scheme they require (the `security` field is missing from `createRoute()` calls).
- **Example values**: No `.openapi({ example: ... })` annotations on response fields.

The spec is useful for discovering endpoints but cannot drive SDK generation accurately (which is why `pnpm generate:sdk` produces an outdated/incomplete client).

---

## 10. LLM-Friendliness

**Rating: 8/10 -- Excellent template, minor gaps.**

### What makes this easy for LLMs

1. **Uniform pattern**: Every route file follows the exact same structure. An LLM can copy any existing route and modify it.
2. **Thin HTTP layer**: Routes only do validation + delegation. No business logic to reason about.
3. **Clear imports**: `ok`, `created`, `noContent` from `api-response`; error classes from `api-error`.
4. **Zod schemas co-located or imported**: Request validation is always visible in the route definition.
5. **Tags for organization**: The tag naming convention (`"Admin - {Domain}"` vs `"{Domain}"`) makes it clear which group a route belongs to.

### What could be improved

1. **No route file template/generator**: A `pnpm generate:route` script would help.
2. **Response schemas missing**: An LLM cannot infer the response shape from the route definition alone -- it has to read the service function.
3. **The 75-import `app.ts`**: An LLM adding a route must also modify `app.ts` to register it. This is error-prone (import + `app.route()` + correct placement relative to middleware).

---

## 11. Wrangler Config (`wrangler.jsonc`)

**Status: Well-configured.**

- D1 database binding with migration directory pointing to shared package.
- 3 KV namespaces: CACHE, SESSION, SHARED_AUTH_CACHE.
- R2 bucket for media.
- 4 queue producers, 4 queue consumers with DLQ configured.
- Cron trigger every 15 minutes for inventory expiry.
- `nodejs_compat` compatibility flag enabled.
- CPU limit set to 300s (generous for a Worker).
- Production vars defined inline (URLs, domains).

No issues.

---

## 12. Middleware Chain Analysis

The middleware executes in this order for every request:

```
1. DB/KV/R2 init         -> sets c.set("db"), initKv(), initStorage()
2. CORS preflight logger  -> logs OPTIONS requests
3. CORS middleware         -> sets CORS headers
4. X-Proxy-Base-URL       -> sets header for SDK base URL discovery
5. Error handler          -> try/catch wrapper (redundant with onError)
6. Route-level middleware  -> cacheMiddleware(), authMiddleware, etc.
7. Route handler          -> the actual endpoint
```

Steps 1-5 run for ALL requests including webhooks. This means:
- Webhook requests go through CORS (unnecessary but harmless).
- The error handler middleware wraps webhook handlers (correct -- provides consistent error format).
- DB is initialized even for static routes like `/health` (minor overhead, D1 binding is cheap).

---

## 13. Summary

| Area | Grade | Notes |
|------|-------|-------|
| Worker entry | A | Clean, minimal, correct |
| App organization | B+ | Works well, 75 imports getting large |
| Route patterns | A | Highly consistent, good delegation |
| Error handling | B- | Good classes, format inconsistency in middleware |
| Response envelope | A | `ok()`/`created()`/`noContent()` well-enforced |
| Queue consumer | A- | Clean dispatcher, DLQ configured, inline OTP template |
| Auth integration | A- | Dual-auth works, middleware error format needs fix |
| Route file sizes | B+ | Only `admin/orders.ts` is large |
| OpenAPI spec | C | Request schemas good, response schemas absent |
| LLM-friendliness | A- | Copy-paste pattern works, registration in app.ts is manual |

### Top 5 Recommendations (priority order)

1. **Fix auth middleware error format** to match global handler shape (`error` as object, not string). Or better: throw `UnauthorizedError`/`ForbiddenError` and let the global handler format it.
2. **Migrate 7 files from singleton `db` import to `c.get("db")`** for consistency and resilience.
3. **Remove duplicate error handling** -- delete the middleware-based try/catch and keep only `app.onError()`, adding the dev-mode `stack` field to it.
4. **Add OpenAPI response schemas** to at least the most-used endpoints, enabling accurate SDK generation.
5. **Fix the inline `require()` in `admin/orders.ts`** line 268 -- convert to top-level import.
