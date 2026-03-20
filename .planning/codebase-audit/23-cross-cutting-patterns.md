# Audit 23: Cross-Cutting Patterns

## Overview

Audit of patterns that span multiple domains and packages: response envelope, error handling, type flow, validation, caching, imports, secret management, service bindings, and module-level state.

**Scope:** All apps (admin, API, storefront) and all packages (core, database, shared, api-client).

---

## 1. Response Envelope

### Contract

```
Success: { success: true, data: T }
Error:   { success: false, error: { code, message, details? } }
```

### API Layer (apps/api)

**Grade: A-**

- `ok(c, data)` and `created(c, data)` centralized in `apps/api/src/utils/api-response.ts` -- used 271 times across 59 route files. Highly consistent.
- `noContent(c)` used for DELETEs -- returns 204 with null body. Correct.
- `c.json()` direct calls exist only in webhooks (28 occurrences across 6 files) and the 202 Accepted paths. Webhooks are an acceptable exception (they follow external provider conventions, not the internal envelope).
- The 202 pattern manually constructs `{ success: true, data: {...} }` (2 occurrences in `orders.ts`). Matches the CLAUDE.md contract for 202 responses.
- The root `/api/v1/` endpoint and `/health` return non-envelope shapes -- acceptable for infrastructure endpoints.

**One concern:** The `ok()` function accepts an optional `status` param that allows `201`, making it overlap with `created()`. This dual path is harmless but creates ambiguity -- one route could use `ok(c, data, 201)` while another uses `created(c, data)` for the same purpose.

### Admin Proxy (apps/admin/src/pages/api/v1/[...path].ts)

**Grade: A**

- Correctly unwraps `{ success: true, data: T }` to `{ success: true, ...T }` when T is an object.
- Passes through arrays unchanged (cannot spread an array into an object).
- Flattens error objects: `{ success: false, error: { code, message } }` becomes `{ success: false, error: "message", errorCode: "code" }`.
- Strips `content-length` after re-serialization -- important because body size changes.

### Admin Server-Side (apps/admin/src/lib/api-server.ts)

**Grade: A**

- `handleResponse<T>()` correctly unwraps `body.data` as T.
- Fallback handles non-standard shapes by stripping `success` field and returning the rest.
- Error extraction handles both string errors and object errors with message field.
- `setRequestHeaders()` stores per-request headers for auth cookie forwarding. Note: this is a module-level mutable variable (`let _requestHeaders`) -- potential cross-request leakage risk on Cloudflare Workers (see Section 9).

### Admin Browser-Side (apps/admin/src/lib/api-browser.ts)

**Grade: A**

- `parseResponse<T>()` handles both envelope shapes: raw API `{ success, data: T }` (dev mode via Vite proxy bypass) and proxy-unwrapped `{ success, ...T }` (production).
- Detection heuristic is clever: if `body.data !== undefined` and the only other key is `success`, treat it as raw envelope.
- This dual-shape handling is the result of the documented Vite proxy bypass issue (CLAUDE.md "Vite proxy envelope bypass").

### Storefront Client (apps/storefront/src/lib/api/client.ts)

**Grade: B+**

- `fetchWithRetry()` returns raw `Response` -- consumers must parse the envelope themselves.
- No centralized envelope unwrapping equivalent to admin's `parseResponse`.
- Individual storefront API helper files (e.g., `@/lib/api/orders.ts`) presumably handle unwrapping, but it's scattered rather than centralized.

### Storefront Proxy Endpoints (apps/storefront/src/pages/api/checkout/*.ts)

**Grade: B**

- `stripe-intent.ts`, `polar-session.ts`, `sslcommerz-session.ts` all unwrap with `json.data || json` -- correct but duplicated across 3 files.
- `create-order.ts` re-wraps the response in its own `{ success: true, data: { id } }` shape rather than forwarding the API response.
- Error responses inconsistently use `{ error: "msg" }` (stripe/polar/sslcommerz) vs `{ success: false, error: "msg" }` (create-order). The checkout page must handle both.
- `purge-cache.ts` uses `{ success: true, message, details }` -- non-standard shape but appropriate for an operational endpoint.

**Recommendation:** Extract a shared `unwrapApiResponse()` helper for storefront proxy endpoints, mirroring the admin pattern.

---

## 2. Error Handling Chain

### Error Classes (packages/core/src/errors/index.ts)

**Grade: A**

Clean hierarchy:
```
AppError (status, code, message, details?)
  +-- ValidationError (400, VALIDATION_ERROR)
  +-- NotFoundError (404, NOT_FOUND)
  +-- UnauthorizedError (401, UNAUTHORIZED)
  +-- ForbiddenError (403, FORBIDDEN)
  +-- ConflictError (409, CONFLICT)
  +-- RateLimitError (429, RATE_LIMIT)
  +-- ServiceUnavailableError (503, SERVICE_UNAVAILABLE)
```

Re-exported from `apps/api/src/utils/api-error.ts` as `ApiError` (alias for `AppError`) for backward compatibility. 274 usages across 45 route files.

### API Global Error Handler (apps/api/src/app.ts)

**Grade: B+**

- **Dual handler issue:** Both `app.onError()` (lines 84-111) and middleware error handler (lines 157-202) catch the same errors. The middleware `try/catch` runs first; `onError` is the fallback for errors that escape the middleware chain. Having both is defensive but creates duplicate code.
- Both handlers produce the same envelope: `{ success: false, error: { code, message, details? } }`.
- The middleware handler exposes `error.message` and `error.stack` (in dev) for generic Errors -- acceptable since production hides stack traces.
- The `onError` handler always exposes `err.message` even in production -- potential info leakage.

### Shared Error Utilities (packages/shared/src/error-utils.ts)

**Grade: C+**

- `safeErrorResponse()` and `zodErrorResponse()` exist but are **barely used** -- only `apps/admin/src/pages/health.ts` imports them.
- `honoSafeError()` returns `{ success: false, error: "message" }` -- a flat string, not the structured `{ code, message }` object the API uses. Inconsistent with the API error envelope.
- These utilities predate the standardized error classes and are effectively dead code.

**Recommendation:** Deprecate or remove `safeErrorResponse`, `zodErrorResponse`, and `honoSafeError` from shared. The API uses `AppError` subclasses and the global handler exclusively.

### Rate Limiter (packages/shared/src/rate-limit.ts)

**Grade: C**

- Throws generic `Error` on rate limit, not `RateLimitError`. The global error handler catches it as a 500 `INTERNAL_ERROR` instead of 429.
- Uses `setInterval` for cleanup -- problematic on Cloudflare Workers where there's no persistent event loop between requests.
- In-memory `Map` resets on isolate restart -- acknowledged in CLAUDE.md Known Backlog.

---

## 3. Type Flow: Schema to UI

### Chain

```
DB Schema (packages/database/src/schema/*.ts)
  --> Zod Validation (packages/core/src/modules/*/validation.ts)
  --> Service Layer (packages/core/src/modules/*/*.admin.ts | *.storefront.ts)
  --> API Route (apps/api/src/routes/*) -- uses createRoute() with Zod schemas
  --> OpenAPI Spec (auto-generated from Zod via @hono/zod-openapi)
  --> SDK Types (packages/api-client/src/generated/types.gen.ts)
  --> UI Component (apps/admin/src/components/ | apps/storefront/src/)
```

**Grade: B-**

Strengths:
- 12 Zod validation files in `packages/core/src/modules/*/validation.ts` -- consistent location.
- API routes use `createRoute()` with Zod schemas (399 usages across 68 files) -- validation is automatic.
- Domain services split by audience: `*.admin.ts` (admin CRUD), `*.storefront.ts` (read-only), `*.service.ts` (shared logic).

Weaknesses:
- **SDK is stale:** The `openapi.json` has 60 paths vs 221+ live paths. Types in `api-client` are outdated. Both admin and storefront import from `@scalius/api-client/types`, but these types may not match current API shapes.
- **Admin components define their own form types:** e.g., `apps/admin/src/components/admin/{domain}-form/types.ts` duplicates field definitions rather than deriving from SDK or Zod schemas.
- **No shared response type inference:** API routes don't export inferred response types that consumers could import. The type chain breaks at the API boundary -- consumers cast with `as T`.

---

## 4. Validation Patterns

### Where Validation Happens

| Layer | Mechanism | Count |
|-------|-----------|-------|
| API routes | Zod via `createRoute()` | 68 route files |
| Core services | Inline checks, `throw ValidationError` | Ad hoc |
| Admin forms | React Hook Form + Zod | Per component |
| Storefront proxies | Manual checks | Minimal |

**Grade: B**

- API-layer validation is thorough -- Zod schemas are registered in `createRoute()` for both request body and query params.
- Service-layer validation is supplementary -- services throw `ValidationError` for business rule violations (e.g., "Cannot cancel a delivered order").
- Admin form validation uses separate Zod schemas that may drift from the API schemas. There's no mechanism to share validation between API and admin form.
- Storefront proxy endpoints do almost no validation -- they forward payloads to the API and rely on API-side validation.

**No duplication concern:** Validation in API routes (structural) and services (business rules) serve different purposes and should both exist.

---

## 5. Import Conventions

**Grade: A-**

- `@scalius/core/modules/...` subpath imports used consistently (not bare `@scalius/core`).
- `@scalius/database/client` and `@scalius/database/schema` subpath imports correct everywhere.
- `@scalius/shared/...` subpath imports used correctly.
- Storefront correctly does NOT import `@scalius/core` or `@scalius/database` -- 0 violations found.
- Admin imports `@scalius/core` and `@scalius/database` as expected.
- `@/` alias used consistently within each app for local imports.

One minor issue: `apps/admin/src/lib/sdk.ts` re-exports from `@scalius/api-client` but is barely used -- `api-server.ts` and `api-browser.ts` are the actual workhorses.

---

## 6. Secret Management

**Grade: A-**

`import.meta.env` usages found in 6 `.ts` files:

| File | Usage | Risk |
|------|-------|------|
| `admin/pages/firebase-messaging-sw.js.ts` | `PUBLIC_FIREBASE_*` (7 usages) | None -- all `PUBLIC_` prefixed, intentionally client-visible |
| `storefront/lib/api/client.ts` | `import.meta.env.SSR`, `import.meta.env.DEV` | None -- boolean flags, no secrets |
| `storefront/lib/runtime-env.ts` | `import.meta.env.STOREFRONT_URL` | Low -- fallback only, not a secret |
| `storefront/lib/media-url.ts` | `import.meta.env.SSR` | None -- boolean flag |
| `storefront/lib/image-optimizer.ts` | `import.meta.env.DEV` | None -- boolean flag |
| `storefront/lib/middleware-helper/csp-handler.ts` | `import.meta.env.PUBLIC_API_BASE_URL` | Low -- public URL, not a secret |

**No secret leakage found.** All sensitive values (`API_TOKEN`, `JWT_SECRET`, `PURGE_TOKEN`, `BETTER_AUTH_SECRET`) come from Cloudflare runtime `env.*` per the documented convention.

The storefront's `runtime-env.ts` properly stores `API_TOKEN` in a module-level variable set by middleware rather than baking it into the build.

---

## 7. Service Binding Usage

**Grade: A**

### Admin (env.API)

- `apps/admin/src/pages/api/v1/[...path].ts` -- proxy endpoint, production path
- `apps/admin/src/lib/api-server.ts` -- SSR page data loading, production path
- Both have identical fallback pattern: check `env.API`, else use `PUBLIC_API_BASE_URL` or `localhost:8787`

### Storefront (env.BACKEND_API)

- `apps/storefront/src/pages/api/auth/logout.ts` -- production path
- `apps/storefront/src/pages/api/customer-auth/[...path].ts` -- production path
- `apps/storefront/src/lib/api/client.ts` via `apiContext.getStore()?.BACKEND_API` -- SSR data loading
- Same fallback pattern as admin

### Consistency

Both apps use the same 3-tier resolution:
1. Service binding (production) -- zero-latency internal routing
2. `PUBLIC_API_BASE_URL` env var (staging / custom)
3. `localhost:8787` (local dev)

The Cloudflare env detection pattern is duplicated across files (`try { const e = cfEnv as unknown as Env; return (e?.API || ...) ? e : undefined } catch { return undefined }`). Could be extracted into a shared helper, but the duplication is small and localized.

---

## 8. `any` Type Debt

**Grade: C+**

### Actual Count: ~54 occurrences across 35 files in admin app

The CLAUDE.md estimate of "~250 `any` usages" appears inflated. Actual `any` keyword matches include prose (comments like "any additional notes") and HTML attributes (`step="any"`). True type-unsafe `any` usages:

| Category | Count | Examples |
|----------|-------|---------|
| eslint-disable justified | 10 | CF Worker env proxy, Astro locals, react-day-picker v8 |
| Library typing workarounds | 6 | `zodResolver() as any`, `Badge variant as any`, phone input |
| Genuine type holes | 5 | `FraudCheckIndicator` state, `CollectionRow` props, debounce |
| Shared/infrastructure | 3 | `smartCache` Map, `inflight` Map, `edge-cache` waitUntil |

**Impact assessment:**
- Most `any` usages are at component boundaries (UI libraries with incomplete types) -- not in business logic.
- The `smartCache` and `inflight` Maps using `any` are acceptable for generic cache infrastructure.
- `FraudCheckIndicator` using `useState<any>` is the most impactful -- fraud data shape should be typed.
- `CollectionRow` extending `any` loses all prop safety.

---

## 9. Caching Patterns

### API-Side (apps/api)

**Grade: A**

- `CACHE_TTLS` constants centralized in `apps/api/src/utils/cache-ttls.ts` -- STANDARD (1h), SHORT (5m), MEDIUM (10m), ATTRIBUTES (30m), CHECKOUT_CONFIG (1m), NONE (0).
- Used in route-level cache middleware via `@hono/zod-openapi` cache config.
- KV cache for API-side state (`checkout_status:*`, webhook replay keys).

### Storefront-Side (apps/storefront)

**Grade: A-**

Two-layer architecture:
- **L1:** In-memory (`smartCache`) -- fast, dies on cold start. Map-based with TTL.
- **L2:** Cloudflare Cache API (`withEdgeCache`) -- survives cold starts. Versioned cache keys (`?v={kvVersion}&build={BUILD_ID}`).
- Request deduplication via `inflight` Map -- prevents duplicate API calls when multiple components request simultaneously.
- Purge endpoint (`/api/purge-cache`) bumps KV version, clears L1, warms critical caches via `waitUntil`.

**Concerns:**
- `CACHE_TTL` in `edge-cache.ts` (LONG: 24h, MEDIUM: 1h, SHORT: 5m) overlaps with but differs from API's `CACHE_TTLS`. Two independent TTL constant sets for different layers is correct conceptually but could confuse developers.
- L1 keys include KV version suffix (`key:v42`) for cross-isolate invalidation -- smart design.
- Module-level mutable state (`cacheContext`, `inflight`, `cacheStorage`) is set per-request by middleware. On Cloudflare Workers, this is safe for single-tenant but could cause cross-request contamination under concurrent requests on the same isolate.

### Selective Purge

**Grade: A**

The `POST /api/purge-cache` endpoint supports selective invalidation:
- `prefixes` param for targeted L1 eviction
- `bumpVersion` param to control L2 invalidation
- `groups` for logical categorization

---

## 10. Error Boundaries

### Admin App

**Grade: C+**

- One React `ErrorBoundary` class component at `apps/admin/src/components/admin/ErrorBoundary.tsx`.
- Used via `PageSection` wrapper (`apps/admin/src/components/admin/shared/PageSection.tsx`).
- No page-level 404.astro or 500.astro error pages.
- If an Astro page throws during SSR, the user sees a raw error -- no graceful fallback.

### Storefront App

**Grade: D**

- No React ErrorBoundary component found.
- No 404.astro or 500.astro error pages.
- If a storefront page throws, the user sees a raw error.

**Recommendation:** Add `500.astro` and `404.astro` pages to both apps. Add an ErrorBoundary wrapper to storefront React islands.

---

## 11. LLM-Friendliness / Navigability

**Grade: A-**

Strengths:
- CLAUDE.md is exceptionally thorough -- architecture, conventions, recipes, import paths, known issues.
- 47 README files across the codebase (from Session 4).
- Domain modules follow consistent naming: `{domain}.admin.ts`, `{domain}.storefront.ts`, `{domain}.service.ts`, `{domain}.validation.ts`.
- API routes mirror domain names: `routes/admin/products.ts` maps to `core/modules/products/products.admin.ts`.
- Clear package boundaries with documented dependency graph.

Weaknesses:
- Route files are large (some 500+ lines) -- could benefit from splitting into sub-files per operation.
- The relationship between `apps/api/src/utils/api-error.ts` (re-export) and `packages/core/src/errors/index.ts` (canonical) requires reading the re-export to understand.
- Storefront proxy endpoints in `apps/storefront/src/pages/api/` lack a README explaining the envelope unwrapping pattern.

---

## 12. Module-Level Mutable State

**Grade: B-**

15 module-level `let _*` variables found across the codebase:

| Module | Variable | Risk |
|--------|----------|------|
| `database/client.ts` | `_db` | Low -- D1 binding is stable across requests |
| `api/utils/kv-cache.ts` | `_kv` | Low -- KV binding is stable |
| `core/utils/kv-cache.ts` | `_kv` | Low -- same pattern |
| `core/payments/stripe.ts` | `_stripe`, `_stripeKey` | Low -- SDK client reuse is safe |
| `core/payments/polar.ts` | `_cachedClient`, `_cachedToken` | Low -- SDK client reuse |
| `core/integrations/storage.ts` | `_bucket`, `_publicUrl` | Low -- R2 binding stable |
| `admin/lib/api-server.ts` | `_requestHeaders` | **MEDIUM** -- request-scoped data in module-level var |
| `storefront/lib/api/runtime-env.ts` | 5 vars | **MEDIUM** -- request-scoped env in module-level vars |
| `storefront/lib/api/client.ts` | `jwtToken`, `tokenExpiry` | **HIGH** -- auth state shared across requests |
| `storefront/lib/edge-cache.ts` | `cacheContext` | **MEDIUM** -- request-scoped context |

**Key concern:** `_requestHeaders` in admin and `jwtToken`/`tokenExpiry` in storefront are request-scoped data stored in module-level variables. On Cloudflare Workers, a single isolate can handle sequential requests, meaning Request A's headers could leak into Request B's API calls if middleware fails to reset them.

The storefront's `runtime-env.ts` has the same risk but is mitigated by middleware always calling `setRuntimeEnv()` at request start. The admin's `_requestHeaders` is set by middleware via `setRequestHeaders()` -- same mitigation.

For `jwtToken`/`tokenExpiry` in the storefront client, this is actually intentional -- the JWT is a service-to-service token (not user-specific), so sharing it across requests is correct and desirable.

---

## Top 10 Systemic Issues

### 1. Stale SDK Types (Impact: HIGH, Effort: LOW)

The generated SDK at `packages/api-client` has 60 paths vs 221+ live API paths. Both admin and storefront import types from `@scalius/api-client/types`. Running `pnpm generate:sdk` would fix this, but it's been deferred "until API surface stabilizes." Every consumer that imports these types is working with potentially wrong type definitions.

**Fix:** Regenerate the SDK. The API surface has been stable for multiple sessions now.

### 2. No Astro Error Pages (Impact: HIGH, Effort: LOW)

Neither admin nor storefront has `404.astro` or `500.astro` pages. Users see raw errors on uncaught exceptions. The storefront has no React ErrorBoundary at all.

**Fix:** Add error pages to both apps. Add an ErrorBoundary to storefront React islands.

### 3. Storefront Proxy Envelope Inconsistency (Impact: MEDIUM, Effort: LOW)

The 4 storefront proxy endpoints (`create-order.ts`, `stripe-intent.ts`, `polar-session.ts`, `sslcommerz-session.ts`) each manually unwrap the API envelope with duplicated logic and inconsistent error shapes. Some return `{ error }`, others `{ success: false, error }`.

**Fix:** Extract a shared `unwrapApiResponse()` helper and standardize error shapes.

### 4. Dead Error Utilities in @scalius/shared (Impact: LOW, Effort: LOW)

`safeErrorResponse()`, `zodErrorResponse()`, and `honoSafeError()` in `packages/shared/src/error-utils.ts` are barely used (1 consumer). They predate the standardized `AppError` system and produce inconsistent error shapes.

**Fix:** Remove or deprecate. The API uses `AppError` subclasses exclusively.

### 5. Rate Limiter Throws Wrong Error Type (Impact: MEDIUM, Effort: LOW)

`packages/shared/src/rate-limit.ts` throws `new Error(message)` instead of `RateLimitError`. The API global error handler catches it as a 500 `INTERNAL_ERROR` rather than 429 `RATE_LIMIT`. Additionally, `setInterval` for cleanup is problematic on Cloudflare Workers.

**Fix:** Import and throw `RateLimitError` from `@scalius/core/errors`. Replace `setInterval` cleanup with per-request lazy eviction.

### 6. Duplicate Global Error Handlers (Impact: LOW, Effort: LOW)

`apps/api/src/app.ts` has both `app.onError()` (lines 84-111) and a middleware-based error handler (lines 157-202). Both produce the same error envelope. The `onError` handler always exposes `err.message` even in production.

**Fix:** Remove the middleware error handler and rely solely on `app.onError()`, or vice versa. Ensure production does not expose raw error messages.

### 7. Admin Form Types Drift from API Schemas (Impact: MEDIUM, Effort: MEDIUM)

Admin form components define their own TypeScript types and Zod schemas (`types.ts` files per form) independently of the API's validation schemas in `packages/core/src/modules/*/validation.ts`. Changes to validation rules must be made in two places.

**Fix:** Long-term, derive admin form schemas from the core validation schemas (or from the regenerated SDK types). Short-term, document the dual-schema locations in the How-To recipe.

### 8. Module-Level Request State (Impact: MEDIUM, Effort: MEDIUM)

`_requestHeaders` (admin), `cacheContext` (storefront), and `runtime-env` vars (storefront) store per-request data in module-level variables. While middleware always resets these at request start, a bug in middleware ordering or early return could leak state across requests.

**Fix:** Migrate to `AsyncLocalStorage` (available in Cloudflare Workers) or Astro's `locals` for request-scoped state. The storefront's `apiContext` already uses `AsyncLocalStorage` for the service binding -- extend this pattern to runtime env vars.

### 9. Two Independent TTL Constant Sets (Impact: LOW, Effort: LOW)

API has `CACHE_TTLS` in `apps/api/src/utils/cache-ttls.ts`. Storefront has `CACHE_TTL` in `apps/storefront/src/lib/edge-cache.ts`. Different names, different values, no shared source of truth.

**Fix:** Move cache TTL constants to `@scalius/shared` so both layers reference the same values. Alternatively, keep separate but document the relationship.

### 10. `ok()` Function Accepts Optional 201 Status (Impact: LOW, Effort: LOW)

`ok(c, data, 201)` and `created(c, data)` are functionally identical. This creates a subtle API for contributors -- which one to use for 201 responses?

**Fix:** Remove the `status` parameter from `ok()` so it always returns 200. `created()` is the explicit 201 helper.

---

## File References

| File | Role |
|------|------|
| `apps/api/src/utils/api-response.ts` | Response envelope helpers (ok, created, noContent) |
| `apps/api/src/utils/api-error.ts` | Error class re-exports from core |
| `apps/api/src/app.ts` | Global error handler, middleware chain, route registration |
| `apps/api/src/utils/cache-ttls.ts` | API-side cache TTL constants |
| `apps/admin/src/pages/api/v1/[...path].ts` | Admin proxy -- envelope unwrapping |
| `apps/admin/src/lib/api-server.ts` | Admin SSR API client |
| `apps/admin/src/lib/api-browser.ts` | Admin browser API client |
| `apps/admin/src/components/admin/ErrorBoundary.tsx` | Admin React error boundary |
| `apps/storefront/src/lib/api/client.ts` | Storefront API client with JWT and retry |
| `apps/storefront/src/lib/api/runtime-env.ts` | Storefront runtime env store |
| `apps/storefront/src/lib/smart-cache.ts` | L1 in-memory cache |
| `apps/storefront/src/lib/edge-cache.ts` | L2 Cloudflare Cache API wrapper |
| `apps/storefront/src/pages/api/checkout/*.ts` | Storefront proxy endpoints |
| `packages/core/src/errors/index.ts` | Canonical error class hierarchy |
| `packages/shared/src/error-utils.ts` | Legacy error utilities (mostly dead) |
| `packages/shared/src/rate-limit.ts` | In-memory rate limiter |
| `packages/shared/src/currency.ts` | Currency formatting utilities |
| `packages/shared/src/price-utils.ts` | Price arithmetic (currency.js) |
| `packages/database/src/client.ts` | D1 database client singleton |

---

## Summary Scorecard

| Area | Grade | Notes |
|------|-------|-------|
| Response Envelope (API) | A- | 271 usages of ok()/created(), consistent |
| Response Envelope (Consumers) | B | Admin solid, storefront proxy inconsistent |
| Error Handling Chain | B+ | Clean hierarchy, dual handler, dead shared utils |
| Type Flow | B- | Good structure, stale SDK breaks the chain |
| Validation | B | API-level thorough, admin form schemas drift |
| Import Conventions | A- | Clean boundaries, storefront isolation verified |
| Secret Management | A- | No leakage found, proper runtime-only access |
| Service Bindings | A | Consistent patterns, proper fallback tiers |
| `any` Type Debt | C+ | ~54 real occurrences, mostly at library boundaries |
| Caching | A- | Well-designed L1/L2, minor TTL divergence |
| Error Boundaries | C- | Admin minimal, storefront none |
| Module-Level State | B- | 15 singletons, 3 medium-risk request-scoped vars |
| LLM-Friendliness | A- | Excellent CLAUDE.md, 47 READMEs, consistent naming |

**Overall Cross-Cutting Grade: B+**

The codebase has strong architectural foundations -- the response envelope, error hierarchy, import boundaries, and caching layers are well-designed. The main debt is in consumer-side consistency (storefront proxies, error pages) and the stale SDK types that break the type flow chain.
