# 25 - SDK Readiness Audit

## Executive Summary

The `@scalius/api-client` package is currently a **hollow stub** -- all 24 generated type exports resolve to `any`, the SDK methods file is empty, and the client is a no-op object. Despite this, both the admin and storefront already import from it, and the storefront has 6 explicit `TODO` comments awaiting real SDK types. The actual API surface has grown to ~328 `createRoute()` endpoints across 62 route files, while the previous OpenAPI spec only covered 60 paths. The admin and storefront have each built independent, incompatible API consumption layers: the admin uses a proxy+envelope unwrapping pattern with 668 lines of hand-written response types, while the storefront uses a JWT-authenticated `fetchWithRetry` client with 524 lines of its own domain types. Unifying these into a single SDK is a high-leverage move, but the current architecture creates specific challenges around the response envelope contract and the two fundamentally different transport mechanisms (service binding vs HTTP+JWT).

---

## 1. Current SDK State

### Package Structure

```
packages/api-client/
  package.json              # @scalius/api-client, @hey-api/openapi-ts v0.66
  openapi-ts.config.ts      # @hey-api plugins: typescript, sdk, client-fetch
  scripts/generate-spec.ts  # Fetches spec from live API or direct import
  src/
    index.ts                # Barrel re-export
    generated/
      types.gen.ts          # 24 `any` placeholder exports
      sdk.gen.ts            # Empty (comment only)
      client.gen.ts         # Stub: `{} as Client`
      index.ts              # Barrel
```

### What Exists Today

| File | Real Content |
|------|-------------|
| `types.gen.ts` | 24 lines of `export type X = any;` stubs |
| `sdk.gen.ts` | 2 lines (comments only) |
| `client.gen.ts` | No-op client, no-op `createClient()` |

### Export Map

```json
{
  ".":        "./src/index.ts",
  "./types":  "./src/generated/types.gen.ts",
  "./sdk":    "./src/generated/sdk.gen.ts",
  "./client": "./src/generated/client.gen.ts"
}
```

### Generation Pipeline

The `scripts/generate-spec.ts` script has two strategies:
1. Direct import of the Hono app and calling `app.request("/api/v1/openapi.json")`
2. Fallback: HTTP fetch from `localhost:8787`

Then `@hey-api/openapi-ts` generates types + SDK + client from the spec. The pipeline is functional but has never been run against the current 328-endpoint API.

### Coverage Gap

| Metric | Old Spec | Live API |
|--------|----------|----------|
| Route files | ~20 | 62 |
| `createRoute()` calls | ~60 | 328 |
| Route groups (app.route()) | ~15 | 50+ |
| Admin-only routes | ~10 | 30 |

The SDK type stubs cover 24 response types. The live API likely generates 200+ unique response schemas.

---

## 2. Admin API Pattern

The admin has a **dual-path architecture** with SSR loaders and client-side React components using different mechanisms.

### SSR Path (Astro Page Loaders)

**Files:** 10 loader files in `apps/admin/src/loaders/admin/`

```
api-server.ts  ->  service binding (prod) / HTTP (dev)
                   unwraps { success, data: T } -> T
                   forwards auth cookies
```

- `apiGet<T>()`, `apiPost<T>()`, `apiPut<T>()`, `apiDelete()` -- 64 call sites across 20 files
- All paths are relative to `/api/v1/admin` (hardcoded prefix)
- Generic type parameter `T` is always manually specified: `apiGet<{ products: ProductListItem[] }>("/products")`
- Types come from `@/types/api-responses.ts` -- 668 lines of hand-maintained interfaces

### Client-Side Path (React Components)

**Pattern 1: api-browser.ts wrappers** -- 5 call sites in 1 file (WidgetForm only)
```
api-browser.ts  ->  fetch("/api/v1/admin/...")
                    handles both envelope shapes (proxy vs Vite bypass)
                    returns T
```

**Pattern 2: Raw fetch** (dominant) -- 267 fetch calls across 97 component files
```
fetch(`/api/v1/admin/...`)  ->  manual .json() parsing
                                unwrapEnvelope() from api-helpers.ts
                                extractApiError() from api-helpers.ts
```

The `api-helpers.ts` utilities (`unwrapEnvelope`, `extractApiError`) are imported across 68 files.

### Admin Type System

`apps/admin/src/types/api-responses.ts` (668 lines) defines all API response shapes manually:
- Product, Category, Collection, Order, Customer, Widget, Page, Discount domains
- Composite types: ProductDetail, OrderDetail, OrderFormData, CustomerHistoryData
- Pagination, stats, form options types
- Imported in 28 files across loaders and components

The admin does NOT use any SDK types from `@scalius/api-client`. The `sdk.ts` re-export exists but is unused in practice.

### Admin Proxy

`apps/admin/src/pages/api/v1/[...path].ts` -- catches ALL `/api/v1/*` requests:
- Production: forwards via `env.API` service binding
- Dev: forwards via HTTP to `localhost:8787`
- **Unwraps** `{ success, data: T }` to `{ success, ...T }` for backward compatibility
- **Flattens** structured errors `{ error: { code, message } }` to `{ error: "message" }`

This proxy creates an envelope mismatch: components that run in dev (Vite bypass) see raw envelopes, while production code sees unwrapped responses. The `api-browser.ts` and `api-helpers.ts` exist specifically to normalize this.

---

## 3. Storefront API Pattern

### Client Architecture

**Core client:** `apps/storefront/src/lib/api/client.ts` (202 lines)
- JWT token management (refresh, expiry, retry on 401)
- `fetchWithRetry()` with configurable retries, timeouts, auth
- Service binding via `BACKEND_API` Fetcher in production SSR (non-dev)
- HTTP fallback in dev and client-side
- `createApiUrl()` resolves base URL from runtime env, window global, or fallback

### Module Structure

20 API module files in `apps/storefront/src/lib/api/`:

| Module | Functions | Auth Required |
|--------|-----------|---------------|
| `products.ts` | 5 functions | No (public) |
| `categories.ts` | 2 functions | No |
| `collections.ts` | 2 functions | No |
| `orders.ts` | 2 functions | Yes |
| `checkout.ts` | 2 functions | No |
| `discounts.ts` | 2 functions | Mixed |
| `header.ts` | 1 function | No |
| `footer.ts` | 1 function | No |
| `navigation.ts` | 1 function | No |
| `pages.ts` | 2 functions | No |
| `search.ts` | 1 function | No |
| `widgets.ts` | 2 functions | No |
| `settings.ts` | 4 functions | No |
| `shipping.ts` | 1 function | No |
| `attributes.ts` | 1 function | No |
| `tracking.ts` | 1 function | No |
| `storefront.ts` | 2 functions | No |
| `abandoned-checkouts.ts` | 1 function | No |
| `customer-auth.ts` | 6 functions | Session-based |
| `context.ts` | AsyncLocalStorage for BACKEND_API | - |

### Consistent Pattern Per Module

Every module follows the same pattern:
```typescript
import { createApiUrl, fetchWithRetry } from "./client";
import type { X } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

export async function getX(): Promise<X | null> {
  return withEdgeCache("cache_key", async () => {
    const url = createApiUrl("/endpoint");
    const response = await fetchWithRetry(url, {}, 3, 8000, false);
    const json: { success: boolean; data: { x: X } } = await response.json();
    return json.data.x;
  }, { ttlSeconds: CACHE_TTL.LONG });
}
```

Every function manually types the response envelope inline: `{ success: boolean; data: { key: T } }`. The inner data shape varies per endpoint (sometimes `{ products: T[] }`, sometimes `{ product: T }`, sometimes just `T`).

### Storefront Type System

`apps/storefront/src/lib/api/types.ts` (524 lines) with:
- SDK re-exports: 1 named type (`OrderPostRequest`) + 22 response type re-exports (all `any`)
- 6 `TODO` comments marking types to replace with SDK types when available
- Local domain types: Product, Category, Collection, Order, Widget, Page, etc.
- Storefront-specific types: CollectionWithProducts, CreateOrderPayload, CheckoutLanguageData, etc.

### Storefront Proxy Endpoints

10 proxy routes in `apps/storefront/src/pages/api/`:
- `checkout/create-order.ts` -- unwraps `.data` before returning to browser
- `checkout/stripe-intent.ts`, `polar-session.ts`, `sslcommerz-session.ts` -- payment session proxies
- `customer-auth/[...path].ts` -- same-origin proxy for Set-Cookie headers
- `auth/logout.ts`, `purge-cache.ts`, `products/[slug].ts`, `facebook-feed.xml.ts`

---

## 4. Type Sharing Analysis

### Current State: Zero Shared Types

| Source | Admin | Storefront |
|--------|-------|------------|
| `@scalius/api-client/types` | Imported in `sdk.ts` (unused) | 23 re-exports (all resolve to `any`) |
| `@/types/api-responses.ts` | 668 lines, 28 importers | N/A |
| `./lib/api/types.ts` | N/A | 524 lines, every API module imports |
| `@scalius/core/modules/*` | 1 import (orders loader) | Not allowed |
| `@scalius/database/schema` | Not used for types | Not allowed |

### Type Duplication

Types defined in both admin and storefront with overlapping but non-identical shapes:

| Type | Admin Fields | Storefront Fields | Differences |
|------|-------------|-------------------|-------------|
| `Product` | 16 fields | 20 fields | Storefront adds `discountedPrice`, `hasVariants`, `imageUrl`, `features` |
| `Category` | 9 fields | 8 fields | Admin has `updatedAt`/`deletedAt`, storefront has `createdAt` only |
| `Order` | 25 fields | 16 fields | Admin has `fulfillmentStatus`, `inventoryPool`, `version`; storefront has `shipments`, `deliveryProviders` |
| `OrderItem` | 9 fields | 9 fields | Nearly identical, storefront missing `productImage` sometimes |
| `Widget` | 12 fields | 11 fields | Admin uses `WidgetPlacementRule` enum, storefront uses `string` |
| `Page` | 14 fields | 15 fields | Storefront adds optional `widgets` array |
| `ShippingMethod` | 8 fields | 8 fields | Identical except Date types |
| `Discount` | 25 fields | 10 fields | Admin has full CRUD shape, storefront has validation-only subset |

### Date Type Inconsistency

A pervasive issue across both consumers:
- Admin types use `Date` for timestamps
- Storefront types use `string` for timestamps
- Some admin types use `Date | string | number` union
- API actually returns Unix timestamps (numbers) from D1/SQLite
- Both consumers do manual `new Date()` conversions in their loaders/modules

---

## 5. Gap Analysis for Unified SDK

### What's Missing

1. **No OpenAPI spec on disk.** The `openapi.json` file doesn't exist. Must start API and run generation.

2. **No real types.** All 24 exports are `any`. The admin's 668-line type file and storefront's 524-line type file are the actual sources of truth.

3. **No SDK methods.** The `sdk.gen.ts` is empty. Both consumers hand-write all fetch calls.

4. **No domain types in the spec.** The Hono OpenAPI routes define request/response schemas via Zod, but `@hey-api/openapi-ts` generates operation-level types (`GetProductsResponse`), not standalone domain types (`Product`). Both consumers need the latter.

5. **No envelope unwrapping.** The API returns `{ success, data: T }` but a generated SDK would return the raw response. Both consumers currently handle unwrapping manually.

6. **No transport abstraction.** The admin uses service binding (via admin proxy or `api-server.ts`), while the storefront uses JWT + service binding (via `fetchWithRetry`). A unified SDK needs to support both transport mechanisms.

7. **No caching integration.** The storefront wraps every call in `withEdgeCache()`. A unified SDK can't impose caching, but needs to make it composable.

8. **No error type standardization.** The admin has `extractApiError()` handling two error shapes; the storefront has `AuthApiEnvelope` with similar logic. Neither is in the SDK.

9. **Admin proxy envelope mismatch.** The admin proxy rewrites responses, creating a unique envelope shape that no generated SDK would produce. This proxy either needs to be removed or the SDK needs to account for it.

10. **Route coverage.** 328 `createRoute()` calls, but some routes use plain Hono `.get()`/`.post()` which won't appear in the OpenAPI spec. The actual discoverable surface depends on OpenAPI annotation coverage.

---

## 6. API Surface Estimate

### By Consumer

| Consumer | Route Prefix | Estimated Endpoints |
|----------|-------------|-------------------|
| Admin | `/api/v1/admin/*` | ~180 (30 route groups x ~6 operations) |
| Storefront (public) | `/api/v1/*` (non-admin) | ~70 (20 route groups x ~3.5 operations) |
| Storefront (auth) | `/api/v1/orders/*`, `/api/v1/customer-auth/*` | ~15 |
| Webhooks | `/api/v1/webhooks/*` | ~12 (not SDK-relevant) |
| Payment | `/api/v1/payment/*` | ~10 |
| Internal | `/api/v1/cache/*`, `/api/v1/setup/*` | ~8 |
| **Total** | | **~295 SDK-relevant** |

### Storefront Actual API Calls

Counting unique endpoints called by storefront modules:
- Products: 4 endpoints (`/products`, `/products/:slug`, `/products/:id/variants`, `/categories/:slug/products`)
- Categories: 2 (`/categories`, `/categories/:slug`)
- Collections: 2 (`/collections`, `/collections/:id`)
- Orders: 3 (`/orders`, `/orders/:id`, `/orders/status/:token`)
- Layout/Site: 6 (`/header`, `/footer`, `/navigation`, `/seo`, `/storefront/homepage`, `/storefront/layout`)
- Content: 3 (`/pages`, `/pages/slug/:slug`, `/widgets/active/homepage`, `/widgets/:id`)
- Checkout: 3 (`/checkout/config`, `/checkout-languages/active`, `/shipping-methods`)
- Other: 6 (`/search`, `/discounts/validate`, `/discounts/usage`, `/analytics/configurations`, `/hero/sliders`, `/locations/*`)
- Customer auth: 5 (`/customer-auth/send-otp`, `/verify-otp`, `/me`, `/profile`, `/orders`)
- **Total: ~34 unique storefront endpoints**

---

## 7. Consumer Needs from a Unified SDK

### Admin Needs

1. **SSR-first:** Most data loading happens in Astro page loaders (server-side), not client components
2. **Service binding transport:** Must support `env.API.fetch()` in production
3. **Cookie forwarding:** SSR requests must forward the browser's auth cookies
4. **Both read and write:** Admin uses GET, POST, PUT, DELETE across all domains
5. **Manual response typing:** Wants `apiGet<{ products: ProductListItem[] }>("/products")` style
6. **Envelope handling:** Currently done by the proxy and `api-server.ts`
7. **Client-side fallback:** React components make raw `fetch()` calls through the admin proxy

### Storefront Needs

1. **JWT auth:** Automatic token acquisition, refresh, and retry
2. **Service binding transport:** Uses `BACKEND_API` Fetcher in production SSR
3. **Edge caching:** Every read call wraps in `withEdgeCache()` with configurable TTL
4. **Mostly read-only:** Only order creation and discount usage recording are writes
5. **Response envelope unwrapping:** Every function manually parses `{ success, data: T }`
6. **Domain-level functions:** Wants `getProductBySlug(slug)`, not `sdk.getProductsBySlug({ slug })`

### Shared Needs

1. **Typed responses:** Both need proper TypeScript types for API responses
2. **Error handling:** Both need consistent error parsing
3. **Transport agnostic:** Must work with service bindings and HTTP
4. **Envelope aware:** Must handle `{ success, data: T }` wrapper
5. **Tree-shakeable:** Storefront should not bundle admin SDK methods

---

## 8. Breaking Changes Required

### Must Change

1. **Admin proxy elimination or bypass.** The proxy that rewrites `{ success, data: T }` to `{ success, ...T }` is incompatible with a typed SDK. Either:
   - Remove the proxy and update all 267 client-side fetch calls to use SDK methods
   - Or keep the proxy but have the SDK bypass it for SSR calls

2. **Admin response types migration.** The 668-line `api-responses.ts` file must be replaced by SDK-generated types. This touches 28 files.

3. **Storefront types migration.** The 524-line `types.ts` file's local types must be replaced by SDK types. This touches every API module (20 files).

4. **Date serialization standardization.** The API returns Unix timestamps, but admin types expect `Date`. The SDK will generate `number` types. All date conversion code must move to a consistent layer.

5. **Envelope unwrapping centralization.** Both consumers manually parse `{ success, data: T }`. The SDK must handle this uniformly or expose a middleware hook.

### Should Change

6. **Storefront fetchWithRetry replacement.** The 202-line custom client should be replaced by the SDK's generated client configured with retry/timeout interceptors.

7. **Admin api-server.ts replacement.** The 172-line SSR fetch utility should be replaced by SDK methods configured for service binding transport.

8. **Admin api-browser.ts elimination.** The 133-line client-side utility should be replaced by SDK methods. Only used in 1 component today.

9. **Admin api-helpers.ts refactor.** The `unwrapEnvelope`/`extractApiError` utilities (used in 68 files) should be replaced by SDK-level error handling.

### Can Defer

10. Edge caching integration (storefront can keep wrapping SDK calls in `withEdgeCache`)
11. Customer auth flows (these use same-origin proxies for cookie handling, orthogonal to SDK)
12. Payment session proxies (storefront-specific, low volume)

---

## 9. LLM-Friendliness Assessment

### Current State: Poor

- **No discoverable API surface.** An LLM reading `@scalius/api-client` finds 24 `any` types and no methods. It cannot determine what endpoints exist or what shapes they return.
- **Types scattered across 3 locations.** Admin types in `api-responses.ts`, storefront types in `api/types.ts`, and SDK stubs in `types.gen.ts`. An LLM must read all three to understand the full picture.
- **Envelope complexity.** The admin proxy rewrites response shapes, creating two envelope formats. An LLM generating admin code must know which format applies (SSR vs client-side, dev vs prod).
- **Implicit API contracts.** Storefront modules hardcode response shapes inline (e.g., `{ success: boolean; data: { products: Product[] } }`). These contracts are not declared anywhere discoverable.

### After SDK Regeneration: Good

- **Single source of truth.** All types in `@scalius/api-client/types`, all methods in `@scalius/api-client/sdk`.
- **Operation names map to endpoints.** `getProducts()`, `getProductsBySlug()`, etc.
- **Request/response types co-located.** `GetProductsResponse`, `PostOrdersData` generated from Zod schemas.
- **Importable from any consumer.** Both admin and storefront reference the same types.

### Recommendations for LLM Ergonomics

1. Export domain types alongside operation types (requires custom plugin or post-processing)
2. Use descriptive operation IDs in Hono routes (these become SDK method names)
3. Add JSDoc to Zod schemas (flows through to generated types)
4. Keep the SDK package as the canonical import path in CLAUDE.md

---

## 10. SDK Unification Roadmap

### Phase 1: Foundation (Pre-requisite)

**Goal:** Generate real types from the live API spec.

1. Start the API worker (`pnpm dev --filter=@scalius/api`)
2. Run `pnpm generate:sdk` to fetch the live OpenAPI spec and generate types
3. Audit the generated output: count types, methods, verify coverage
4. Check which routes use plain Hono methods vs `createRoute()` (only the latter appear in the spec)
5. If coverage is low, add `createRoute()` wrappers to high-value plain routes
6. Commit the generated spec + types

**Deliverable:** `openapi.json` with 200+ paths, `types.gen.ts` with real types, `sdk.gen.ts` with methods.

**Risk:** If `@hey-api/openapi-ts` v0.66 doesn't handle the Hono-generated spec cleanly, may need config adjustments.

### Phase 2: Type Migration

**Goal:** Replace hand-maintained types with SDK types.

1. Compare generated types against `apps/admin/src/types/api-responses.ts` (668 lines)
2. Compare against `apps/storefront/src/lib/api/types.ts` (524 lines)
3. Identify gaps where generated types are missing fields that consumers need
4. For missing fields: either fix the API's Zod schemas or create extension types
5. Create a shared types layer in `@scalius/api-client` that exports domain types:
   ```typescript
   // packages/api-client/src/domain-types.ts
   // Extracted from generated types for convenience
   export type Product = GetProductsBySlugResponse["data"]["product"];
   export type Category = GetCategoriesResponse["data"]["categories"][number];
   ```
6. Migrate storefront `types.ts` to re-export from SDK (replacing `TODO` comments)
7. Migrate admin `api-responses.ts` to re-export from SDK

**Deliverable:** Both consumers import types from `@scalius/api-client`. Hand-maintained type files reduced to thin re-export layers.

### Phase 3: Client Abstraction

**Goal:** Create a transport-agnostic client that both consumers can configure.

1. Add a `createScaliusClient(config)` factory to `@scalius/api-client`:
   ```typescript
   interface ClientConfig {
     transport: "http" | "service-binding";
     fetcher?: Fetcher;           // CF service binding
     baseUrl?: string;            // HTTP base URL
     auth?: {
       type: "cookie" | "jwt";
       getToken?: () => Promise<string>;
       forwardHeaders?: Headers;
     };
     unwrapEnvelope?: boolean;     // default true
     onError?: (error: ApiError) => void;
   }
   ```
2. The factory returns typed SDK methods preconfigured with the transport
3. Admin configures with `transport: "service-binding"` + cookie auth
4. Storefront configures with JWT auth + optional service binding

**Deliverable:** A single `createScaliusClient()` entry point that replaces `api-server.ts`, `api-browser.ts`, and `fetchWithRetry`.

### Phase 4: Consumer Migration

**Goal:** Replace hand-written fetch calls with SDK methods.

**Admin (larger effort):**
1. Replace 10 SSR loaders to use SDK methods instead of `apiGet<T>()`
2. Replace the 267 raw `fetch()` calls in React components (across 97 files) -- this is the bulk of the work
3. Remove `api-helpers.ts` (`unwrapEnvelope`, `extractApiError`) -- 68 import sites
4. Evaluate whether the admin proxy can be simplified or removed

**Storefront (smaller effort):**
1. Replace 20 API module files to use SDK methods instead of `createApiUrl` + `fetchWithRetry`
2. Keep `withEdgeCache` wrappers around SDK calls
3. Keep storefront proxy endpoints for checkout/auth (cookie-based, not SDK-relevant)

**Deliverable:** Both consumers use `@scalius/api-client` for all API calls. Custom fetch utilities removed.

### Phase 5: Automation

**Goal:** Keep the SDK in sync with API changes.

1. Add a CI step that regenerates the SDK on API route changes
2. Add a TypeScript type-check step that catches breaking changes
3. Consider adding the spec generation to `pnpm build` for the api-client package
4. Document the regeneration workflow in the SDK README

---

## Severity Assessment

| Issue | Severity | Impact |
|-------|----------|--------|
| All SDK types are `any` | **High** | Zero type safety for SDK consumers |
| 1,192 lines of duplicated types across admin + storefront | **High** | Types drift independently, no single source of truth |
| 267 raw fetch calls in admin components | **Medium** | High migration effort, but currently working |
| Envelope mismatch (admin proxy vs raw) | **Medium** | Causes bugs in dev mode, requires dual-shape handling |
| No OpenAPI spec on disk | **Medium** | Can't generate SDK without starting the API |
| Date type inconsistency (Date vs string vs number) | **Medium** | Causes runtime conversion bugs |
| Storefront inline response typing | **Low** | Repetitive but functional |
| Edge caching not in SDK | **Low** | Storefront can keep wrapping calls |

## Key Files

| File | Purpose |
|------|---------|
| `/packages/api-client/package.json` | SDK package definition |
| `/packages/api-client/openapi-ts.config.ts` | Generation config |
| `/packages/api-client/scripts/generate-spec.ts` | Spec fetching script |
| `/packages/api-client/src/generated/types.gen.ts` | 24 `any` stubs |
| `/packages/api-client/src/generated/sdk.gen.ts` | Empty SDK |
| `/packages/api-client/src/generated/client.gen.ts` | No-op client |
| `/apps/admin/src/lib/api-server.ts` | Admin SSR fetch (172 lines) |
| `/apps/admin/src/lib/api-browser.ts` | Admin client fetch (133 lines) |
| `/apps/admin/src/lib/api-helpers.ts` | Envelope unwrap utilities (48 lines) |
| `/apps/admin/src/pages/api/v1/[...path].ts` | Admin proxy (135 lines) |
| `/apps/admin/src/types/api-responses.ts` | Admin types (668 lines) |
| `/apps/storefront/src/lib/api/client.ts` | Storefront client (202 lines) |
| `/apps/storefront/src/lib/api/types.ts` | Storefront types (524 lines) |
| `/apps/storefront/src/lib/api/index.ts` | Storefront barrel (20 modules) |
| `/apps/api/src/app.ts` | Hono app with all route registrations |
