# API Framework Infrastructure Re-Audit

**Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Worker entry, Hono app composition, middleware chain, error handling, queue consumer, OpenAPI config, response envelope, storefront routes, wrangler bindings.

---

## Previous Finding Status

### Critical Issues

#### 1. Duplicate Error Handling -- Middleware AND onError
**Status: FIXED**

The try/catch middleware (previously lines 157-202 in `apps/api/src/app.ts`) has been completely removed. The file now has a comment at line 156-158 confirming the removal:

```typescript
// Error handling is handled by app.onError() above.
// All uncaught errors propagate to the global onError handler which
// returns properly formatted JSON error responses.
```

Only `app.onError()` (lines 84-111) remains as the single global error handler. Clean fix.

#### 2. Token Blacklist Fails Open -- Known Security Risk
**Status: FIXED**

`apps/api/src/utils/jwt.ts` line 184 now returns `true` (fail closed) when KV is unavailable:

```typescript
} catch (error: unknown) {
    console.error("Error checking token blacklist:", error);
    return true; // Fail closed — reject token when KV is unavailable
}
```

This means revoked tokens are rejected even during KV outages. The trade-off is that a KV outage could temporarily lock out valid users, but this is the correct security posture.

#### 3. `process.env.NODE_ENV` Used in Cloudflare Worker Context
**Status: PARTIALLY FIXED**

The most problematic usage (the duplicate error handler middleware with dev-mode stack traces) is gone because the entire middleware was removed (see issue #1).

Three usages remain in `apps/api/src`:
- `apps/api/src/app.ts` line 167: Welcome endpoint shows `environment: process.env.NODE_ENV || "development"` -- cosmetic, no functional impact.
- `apps/api/src/app.ts` line 199: `if (process.env.NODE_ENV === "development")` gates the media server route -- still silently fails if NODE_ENV is not set. Low risk since the media server is dev-only convenience.
- `apps/api/src/utils/jwt.ts` line 161: `if (typeof process !== "undefined" && process.env.NODE_ENV === "production")` controls logging of token revocations -- has a safer guard (`typeof process !== "undefined"`) and fails silently.

**Impact: Low.** The remaining usages all fail safely. The dangerous one (error response format differing by environment) is gone.

---

### Code Quality Issues

#### 4. Excessive `z.any()` in OpenAPI Response Schemas
**Status: FIXED**

Massive improvement. Previous audit found `z.any()` in 8+ storefront route files for core entity fields (`products`, `orders`, `collections`, etc.). Current state:

Only 2 files still use `z.any()`:
- `apps/api/src/routes/media-server.ts` line 21: `z.any()` for binary media content -- appropriate, this is a binary stream response.
- `apps/api/src/routes/partytown-proxy.ts` line 71: `z.any()` for proxied third-party content -- appropriate, response shape is external and unknown.

All storefront routes now use typed inline schemas (e.g., `z.object({ id: z.string(), name: z.string(), ... })`). Many use `.passthrough()` rather than strict schemas from `entities.ts`, but that is a separate issue (see "Still Open" below).

#### 5. Storefront Routes Bypass Service Layer -- Direct DB Queries
**Status: STILL OPEN**

The following storefront routes still import directly from `@scalius/database/schema` and run raw Drizzle queries instead of delegating to `@scalius/core` services:

| Route File | Direct DB Import |
|---|---|
| `apps/api/src/routes/header.ts` | `siteSettings` |
| `apps/api/src/routes/footer.ts` | `siteSettings` |
| `apps/api/src/routes/navigation.ts` | `categories`, `pages`, `siteSettings` |
| `apps/api/src/routes/seo.ts` | `siteSettings` |
| `apps/api/src/routes/hero.ts` | `heroSliders` |
| `apps/api/src/routes/widgets.ts` | `widgets` |
| `apps/api/src/routes/locations.ts` | `deliveryLocations` |
| `apps/api/src/routes/shipping-methods.ts` | `shippingMethods` |
| `apps/api/src/routes/collections.ts` | `collections` (but calls `resolveCollectionProducts` for products) |
| `apps/api/src/routes/analytics.ts` | `analytics` |
| `apps/api/src/routes/abandoned-checkouts.ts` | `abandonedCheckouts` |
| `apps/api/src/routes/checkout-languages.ts` | `checkoutLanguages` |
| `apps/api/src/routes/auth.ts` | `settings` |
| `apps/api/src/routes/attributes.ts` | `products`, `productVariants`, `productAttributeValues`, `productAttributes` |
| `apps/api/src/routes/categories.ts` | `categories`, `products`, `productImages`, `productVariants` |

Some routes use a mix: `products.ts` and `storefront.ts` correctly delegate to `@scalius/core` service functions. `pages.ts` uses `getPublicPages()` / `getPublicPageBySlug()` from core. `search.ts` uses the core `search()` function. `customer-auth.ts` uses core auth services.

**Assessment:** 15 storefront route files still contain direct DB queries. This is unchanged from the previous audit.

#### 6. Inconsistent Timestamp Formatting
**Status: STILL OPEN**

The same 4-5 different timestamp conversion implementations exist across storefront routes:

- `apps/api/src/routes/collections.ts` line 25: `formatTimestamp()` local function
- `apps/api/src/routes/widgets.ts` line 33: `convertTimestampToISO()` local function
- `apps/api/src/routes/hero.ts` line 121: inline `instanceof Date` check
- `apps/api/src/routes/shipping-methods.ts` line 76: inline `instanceof Date` check
- `apps/api/src/routes/orders.ts` line 25: `unixToDate()` local function
- `apps/api/src/routes/categories.ts` line 55: `unixToDate()` local function (duplicated)

No shared utility has been created.

#### 7. Checkout Config Error Swallowed and Returns Hardcoded Fallback
**Status: STILL OPEN**

`apps/api/src/routes/checkout.ts` lines 50-60 still catch all errors and return a hardcoded COD-only gateway config with `currencies: ["bdt"]`. If the database or service layer fails, any non-BDT store gets wrong currency config silently.

---

### Middleware Chain Issues

#### CORS Preflight Logger
**Status: STILL OPEN**

`apps/api/src/app.ts` lines 128-135 still log every OPTIONS request origin with no action taken. Pure log noise in production.

#### X-Proxy-Base-URL Header
**Status: STILL OPEN (Acceptable)**

Set on every request (line 148-154). Still hits webhooks and internal calls unnecessarily but functionally harmless.

---

### Error Handling Gap: Manual Error String Parsing in Order Route
**Status: PARTIALLY FIXED**

The root cause is fixed: `packages/core/src/modules/orders/orders.storefront.ts` no longer throws `throw new Error("VALIDATION_ERROR:...")` or `throw new Error("INSUFFICIENT_STOCK:...")`. It now throws proper `ValidationError` from `@scalius/core/errors`.

However, the dead catch code in `apps/api/src/routes/orders.ts` lines 335-341 still exists:

```typescript
if (error instanceof Error && error.message.startsWith("VALIDATION_ERROR:")) {
  throw new ValidationError(error.message.replace("VALIDATION_ERROR:", ""));
}
if (error instanceof Error && error.message.startsWith("INSUFFICIENT_STOCK:")) {
  throw new ValidationError(error.message.replace("INSUFFICIENT_STOCK:", ""));
}
```

This is dead code -- these branches can never execute since core now throws `ValidationError` directly (which is an `AppError`, not a plain `Error` with a string prefix). The `ValidationError` propagates straight to `app.onError()` without hitting this catch block at all.

**Fix:** Remove the two dead `if` blocks from the catch. Keep the `z.ZodError` handler and the re-throw.

---

### Queue Consumer Issues

#### A. Inline HTML Template
**Status: STILL OPEN**

`apps/api/src/queue-consumer.ts` lines 184-194 still have the email OTP HTML template hardcoded inline.

#### B. WhatsApp Credentials in Queue Messages
**Status: STILL OPEN**

`apps/api/src/queue-consumer.ts` still reads `payload.waToken` and `payload.waPhoneId` from the queue message body (lines 198-204). The enqueue site in `packages/core/src/modules/customers/otp-transport.ts` lines 124-125 still passes `waToken` and `waPhoneId` through the queue payload. Credentials are stored in Cloudflare Queue infrastructure.

#### C. Default Case Behavior
**Status: STILL OPEN (Acceptable)**

The `default` case (line 365-367) logs a warning. Since it does not throw, `Promise.allSettled` treats it as fulfilled, and the ack/retry loop at lines 149-159 acks the message. This is correct behavior -- unknown message types are consumed and not retried endlessly. The code is just not obvious about this intent.

---

### Pattern Consistency

#### Cache TTL Magic Numbers
**Status: PARTIALLY FIXED**

`CACHE_TTLS` constants exist at `apps/api/src/utils/cache-ttls.ts` and are used by some routes. But 8 route files still use magic number `3600`:

- `apps/api/src/routes/attributes.ts` line 24
- `apps/api/src/routes/categories.ts` line 24
- `apps/api/src/routes/products.ts` line 20
- `apps/api/src/routes/widgets.ts` lines 16, 26
- `apps/api/src/routes/pages.ts` line 18
- `apps/api/src/routes/collections.ts` line 17
- `apps/api/src/routes/navigation.ts` line 16
- `apps/api/src/routes/hero.ts` line 20

Routes that correctly use `CACHE_TTLS`: `header.ts`, `footer.ts`, `storefront.ts`, `search.ts`, `orders.ts`.

#### OpenAPIHono Bindings Type Parameter
**Status: PARTIALLY FIXED**

Previous audit flagged 5 files missing `<{ Bindings: Env }>`. Current state: 4 storefront route files still omit it:
- `apps/api/src/routes/header.ts` line 10
- `apps/api/src/routes/categories.ts` line 18
- `apps/api/src/routes/navigation.ts` line 10
- `apps/api/src/routes/footer.ts` line 10
- `apps/api/src/routes/products.ts` line 15

Many admin route files also omit it (17+ admin files use `new OpenAPIHono()` without bindings). This works because the parent app's bindings propagate, but it means `c.env` lacks type safety inside those route handlers.

#### OpenAPI Security Annotations
**Status: STILL OPEN**

No routes use `security: [{ bearerAuth: [] }]` in their `createRoute()` definitions. The security scheme is registered at `apps/api/src/app.ts` line 323 but never referenced.

---

## New Issues Found

### N1. Excessive `.passthrough()` Degrades OpenAPI Spec

While `z.any()` has been eliminated from storefront routes, it has been replaced with `.passthrough()` on nearly all inline response schemas. Grep finds 80+ `.passthrough()` calls across route files.

`.passthrough()` tells Zod to allow additional properties beyond those defined. For OpenAPI spec generation, this means the spec says "these fields exist, but there could be any other fields too." This is better than `z.any()` (at least the known fields are documented) but still weakens the spec.

The `apps/api/src/schemas/entities.ts` file defines strict schemas without `.passthrough()` for 20+ entities, but most routes define their own inline schemas with `.passthrough()` instead of importing from entities.ts.

**Impact:** SDK types include index signatures for passthrough objects, making autocomplete less useful. Not a runtime bug but degrades developer experience for API consumers.

**Fix approach:** Replace inline `.passthrough()` schemas with strict imports from `entities.ts` where entity shapes match.

### N2. Dead Error String-Parsing Code in Orders Route

As described in the previous finding re-assessment above, `apps/api/src/routes/orders.ts` lines 335-341 contain two dead `if` blocks that parse string-prefixed error messages. The core service no longer throws these error types.

**Impact:** No runtime impact (dead code), but misleading for future developers.

**Fix approach:** Remove the two dead `if` blocks.

### N3. Checkout Config Response Schema Uses `z.record(z.string(), z.unknown())`

`apps/api/src/routes/checkout.ts` line 25 defines the response schema as:

```typescript
schema: successEnvelope(z.record(z.string(), z.unknown()))
```

This provides no type information to SDK consumers about the checkout config shape. The `getCheckoutConfig()` service returns a well-defined object with `gateways`, `guestCheckoutEnabled`, `authVerificationMethod`, `checkoutMode`, `partialPaymentEnabled`, `partialPaymentAmount` -- all of which could be typed.

**Impact:** Storefront checkout page gets `Record<string, unknown>` from the SDK. Must cast or assert types.

---

## Summary of Current State

### What Was Fixed (5 items)
1. Duplicate error handler middleware removed -- single `onError` handler
2. Token blacklist now fails closed -- security improvement
3. `z.any()` eliminated from all entity response schemas (only 2 legitimate uses remain)
4. Core order service now throws typed `ValidationError` instead of string-prefixed errors
5. `process.env.NODE_ENV` in error response formatting eliminated (via middleware removal)

### What Is Partially Fixed (3 items)
1. `process.env.NODE_ENV` -- 3 harmless usages remain
2. Cache TTL magic numbers -- 5 routes use `CACHE_TTLS`, 8 still use `3600`
3. Dead error string parsing code in orders route -- root cause fixed, dead code remains

### What Is Still Open (8 items)
1. 15 storefront routes bypass service layer with direct DB queries
2. 5 different timestamp formatting implementations across routes
3. Checkout config hardcoded BDT fallback on error
4. CORS preflight logger middleware (log noise)
5. WhatsApp credentials passed through queue messages
6. Inline OTP email HTML template in queue consumer
7. No `security` annotations on protected OpenAPI routes
8. `.passthrough()` proliferation (80+ instances) weakens OpenAPI spec

### New Issues (3 items)
1. `.passthrough()` has replaced `z.any()` but still degrades SDK types
2. Dead error string-parsing code in orders route
3. Checkout config response schema provides no type info

---

## Rating

**Previous: B+ (7.5/10)**
**Current: A- (8.5/10)**

**Justification:** The three most impactful fixes landed -- the duplicate error handler (a correctness issue), the token blacklist fail-open (a security issue), and the `z.any()` proliferation (a spec quality issue). The codebase is measurably safer and better typed. The remaining issues are all consistency/architecture concerns (service layer extraction, timestamp dedup, `.passthrough()` cleanup) that do not cause bugs or security vulnerabilities. The BDT checkout fallback remains the most concerning open issue since it could produce wrong behavior for non-BDT stores during database outages, but it requires a DB failure to trigger.

---

*Re-audit: 2026-03-21*
