# Storefront App Infrastructure Audit

**Analysis Date:** 2026-03-20
**Branch:** mono-repo
**Auditor:** Claude Opus 4.6 (1M context)

## Summary

The storefront (`apps/storefront/`) is a well-architected Astro 6 SSR application deployed as a Cloudflare Worker. It communicates with the API worker exclusively via Cloudflare Service Bindings in production and falls back to HTTP fetch in development. The codebase respects import boundaries (no `@scalius/core` or `@scalius/database` imports), implements a sophisticated two-layer caching system (L1 in-memory + L2 Cloudflare Cache API), and uses a generated SDK for type-safe API calls. The checkout system uses a clean gateway handler registry pattern supporting COD, Stripe, SSLCommerz, and Polar.

Key strengths: parallel data loading (`loadPageWithLayout`), request deduplication, KV-versioned cache invalidation, aggressive CSP headers, stale asset auto-reload, and proper `waitUntil` usage for background work.

Key weaknesses: 35 `as any` casts in SDK response unwrapping, module-level mutable state in `edge-cache.ts` (`cacheContext`), dual inflight maps (one in `smart-cache.ts`, one in `edge-cache.ts`), and a cart storage key mismatch between `cart.ts` and `checkout/index.ts`.

---

## Critical Issues

### 1. Module-Level Mutable State in `edge-cache.ts` -- Concurrent Request Race

**Files:** `apps/storefront/src/lib/edge-cache.ts` (lines 36-41, 52-63)

**Problem:** `cacheContext` is a module-level mutable object. In Cloudflare Workers, a single isolate can handle multiple concurrent requests. If request A sets `cacheContext` and then request B overwrites it before request A's `withEdgeCache` fetcher completes, request A will read request B's cache version and hostname, resulting in cross-request cache key contamination.

```typescript
// edge-cache.ts line 36-41 -- module-level mutable state, shared across concurrent requests
let cacheContext: CacheContext = {
  cache: null,
  kvVersion: "1",
  hostname: "localhost",
  waitUntil: null,
};
```

The middleware calls `setEdgeCacheContext()` at the start of each request. If two requests overlap in the same isolate, the second request's `setEdgeCacheContext()` call overwrites the first's context.

**Impact:** In multi-tenant deployments or under concurrent load, cache keys may include the wrong hostname or wrong KV version. This can cause:
- Serving tenant A's cached content to tenant B
- Stale data surviving a cache purge because the wrong version was used in L1 key

**Fix:** Migrate `cacheContext` into `AsyncLocalStorage` (already used by `apiContext` in `apps/storefront/src/lib/api/context.ts`). Pass the context through the same `apiContext.run()` call in middleware, or create a separate ALS instance for cache context.

### 2. Cart localStorage Key Mismatch

**Files:**
- `apps/storefront/src/store/cart.ts` (line 42): reads/writes `localStorage.getItem("cart")`
- `apps/storefront/src/lib/checkout/index.ts` (line 209): clears `localStorage.removeItem("scalius_cart")`

**Problem:** The cart store persists to `localStorage` under the key `"cart"`, but the checkout page's `clearCheckoutAndCart()` function removes the key `"scalius_cart"`. After a successful payment, the cart is NOT actually cleared because the wrong key is targeted.

```typescript
// store/cart.ts line 42-43
localStorage.getItem("cart")  // reads "cart"

// checkout/index.ts line 209
localStorage.removeItem("scalius_cart");  // removes "scalius_cart" -- WRONG KEY
```

**Impact:** After completing a purchase, the customer's cart still shows the purchased items. On the next visit, the stale cart contents appear.

**Fix:** Change `checkout/index.ts` line 209 to `localStorage.removeItem("cart")` to match the key used in `store/cart.ts`.

### 3. `setRuntimeEnv()` is a No-Op but Middleware Still Calls It

**Files:**
- `apps/storefront/src/lib/api/runtime-env.ts` (lines 19-27): `setRuntimeEnv` is documented as a no-op
- `apps/storefront/src/middleware.ts` (lines 278-284): calls `setRuntimeEnv()` with env vars

**Problem:** The middleware calls `setRuntimeEnv()` which does nothing. The comment says "apiContext.run() in middleware handles this now." However, the middleware calls `setRuntimeEnv()` BEFORE `apiContext.run()`. If any code between `setRuntimeEnv()` and `apiContext.run()` tries to read runtime env values (e.g., via `getRuntimeApiUrl()`), it will get `undefined`.

**Impact:** Currently harmless because nothing reads between those two calls. But the dead code is misleading and creates a maintenance hazard. Also, the globalThis CDN_DOMAIN assignment at middleware line 288-291 is a separate module-level mutable store that can race under concurrent requests (same issue as cacheContext).

**Fix:** Remove the `setRuntimeEnv()` call from middleware. Remove the `setRuntimeEnv()` function from `runtime-env.ts`. Move the globalThis CDN_DOMAIN assignment into the ALS context.

---

## Code Quality Issues

### 4. Pervasive `as any` Casts in SDK Response Unwrapping (35 occurrences)

**Files:** All 17 files in `apps/storefront/src/lib/api/`

Every API function that uses the SDK casts the response to `any` to unwrap the `{ success, data }` envelope:

```typescript
// Pattern seen in every API module:
const d = (data as any)?.data;           // products.ts, settings.ts, etc.
return (data as any)?.data?.category;    // categories.ts
const d = data as any;                   // storefront.ts
return d?.success ? d.data : null;       // settings.ts
```

**Root cause:** The generated SDK types (`@scalius/api-client/types`) wrap response types as `GetApiV1ProductsResponse` etc., but these are per-endpoint response wrappers, not the inner `{ success: true, data: T }` envelope. The storefront must manually unwrap.

**Impact:** Loss of type safety on all API response data. Any schema change on the API side silently passes through without type errors. This is the storefront's largest type safety gap.

**Fix:** Create typed unwrap helpers. For example:
```typescript
function unwrapSdkResponse<T>(data: unknown): T | null {
  const d = data as { success?: boolean; data?: T };
  return d?.success ? (d.data ?? null) : null;
}
```
Apply consistently across all API modules to centralize the one `as any` cast.

### 5. Duplicate Inflight Deduplication Maps

**Files:**
- `apps/storefront/src/lib/edge-cache.ts` (line 80): `const inflight = new Map<string, Promise<any>>()`
- `apps/storefront/src/lib/smart-cache.ts` (line 83): `const inflight = new Map<string, Promise<any>>()`

**Problem:** Two separate inflight deduplication maps exist. `withEdgeCache` (edge-cache.ts) uses one, `withSmartCache` (smart-cache.ts) uses another. If the same key is requested through different functions, deduplication fails.

In practice this is mitigated because most storefront code uses `withEdgeCache` exclusively. The `withSmartCache` function appears unused in the current codebase (the CSP handler uses `withEdgeCache` directly).

**Impact:** Low risk currently. But the dead `withSmartCache` function with its own inflight map is confusing and a maintenance trap.

**Fix:** Remove `withSmartCache` from `smart-cache.ts` if unused. Keep `smartCache` (the cache storage object) since `edge-cache.ts` imports it. Alternatively, document that `withSmartCache` is the L1-only version and `withEdgeCache` is the L1+L2 version.

### 6. `edge-cache.ts` Clears Inflight Map on Every Request

**File:** `apps/storefront/src/lib/edge-cache.ts` (line 61)

```typescript
export function setEdgeCacheContext(...): void {
  inflight.clear();  // Clears ALL in-flight promises on every new request
  cacheContext = { cache, kvVersion, hostname, waitUntil };
}
```

**Problem:** If request A has an in-flight fetch promise and request B arrives, request B's `setEdgeCacheContext` call clears the inflight map. Request A's promise is now dangling -- the `finally` block in `withEdgeCache` tries to `inflight.delete(key)` but the map was already cleared. This is benign for cleanup but means request A's deduplication benefit is lost for any subsequent requester.

More concerning: the comment says "Per CF docs: module-level mutable state can cause issues with isolate reuse." The fix of clearing inflight actually makes the problem worse by destroying valid in-flight promises from concurrent requests.

**Impact:** Under concurrent load, deduplication is unreliable. Not a correctness bug (fetches complete normally) but a performance issue.

**Fix:** This is a symptom of the module-level mutable state issue (Critical Issue #1). Moving inflight into ALS solves this naturally.

### 7. `checkout/index.ts` Module-Level State for Payment Processing

**File:** `apps/storefront/src/lib/checkout/index.ts` (lines 18-21)

```typescript
let selectedMethod: string | null = null;
let checkoutData: Record<string, unknown> | null = null;
let checkoutConfig: CheckoutConfig | null = null;
let gateways: Array<{ id: string; [key: string]: unknown }> = [];
let isProcessing = false;
```

**Impact:** Low risk because this is client-side only code (runs in browser, not SSR). Module-level state is fine for single-tab browser usage. However, if the checkout page is opened in two tabs, they share no state (each tab gets its own module instance). This is acceptable.

---

## Caching Architecture

### L1: In-Memory Cache (`smart-cache.ts`)

**File:** `apps/storefront/src/lib/smart-cache.ts`

- **Storage:** `Map<string, CacheEntry>` with LRU eviction at 1000 entries
- **TTL:** Per-entry, configurable (default 60s, overridden by callers)
- **Eviction:** LRU via delete-and-reinsert on access
- **Thread safety:** N/A (single-threaded Worker isolate)
- **Lifecycle:** Survives across warm-start requests; cleared on cold start or cache purge

**Strengths:**
- LRU eviction prevents unbounded memory growth
- Fast: zero-cost Map lookups, no serialization
- TTL-based expiry prevents stale data

**Weaknesses:**
- Cap of 1000 entries may be too low for stores with many products. Each product page caches `product_slug_X`, `product_variants_X`, plus category and collection data.
- No memory size tracking -- 1000 entries of large product responses consume more memory than 1000 entries of small settings responses.

### L2: Cloudflare Cache API (`edge-cache.ts`)

**File:** `apps/storefront/src/lib/edge-cache.ts`

- **Storage:** Cloudflare Cache API (persistent at edge PoP)
- **Cache keys:** `https://{hostname}/_api-cache/{key}?v={kvVersion}&build={BUILD_ID}`
- **TTL:** `Cache-Control: public, max-age={ttl}, stale-while-revalidate=120, stale-if-error=300`
- **Timeouts:** 500ms for `cache.match()`, preventing hangs
- **Background writes:** Uses `waitUntil` for non-blocking `cache.put()`
- **Invalidation:** KV version bump changes cache key, making old entries unreachable

**Strengths:**
- Survives cold starts (unlike L1)
- KV-versioned keys provide clean invalidation without needing cache.delete()
- Timeout protection prevents Cache API hangs from blocking responses
- `stale-while-revalidate` + `stale-if-error` provide resilience

**Weaknesses:**
- L2 entries are orphaned (not deleted) when KV version bumps. They eventually expire via TTL but consume edge cache space until then.
- No cache warming for individual product pages after purge (only homepage is warmed in `purge-cache.ts`)

### HTML Page Caching (Middleware)

**File:** `apps/storefront/src/middleware.ts`

- **Cacheable paths:** Regex-matched (`/`, `/products/X`, `/categories/X`, `/search`, `/sitemap*.xml`, static pages)
- **Non-cacheable:** `/api/*`, `/cart`, `/checkout`, `/buy/*`, `/order-success`, `/account`
- **Cache key:** URL with tracking params stripped, variant params stripped for product pages, `cache_v={kvVersion}-{BUILD_ID}` appended
- **Browser headers:** `no-cache, no-store, must-revalidate` (browser always revalidates)
- **Edge storage:** `public, max-age=31536000, immutable` (effectively permanent, invalidated by KV version)

**Strengths:**
- Clean separation: browser always revalidates, edge caches long-term
- Tracking params (`fbclid`, `gclid`, UTMs) stripped from cache keys
- Product variant params (`size`, `color`) stripped to prevent cache explosion
- BUILD_ID in cache key ensures new deployments serve fresh HTML

**Weaknesses:**
- Cart and checkout pages get `private, no-cache, no-store` but this is only applied if the regex matches. The regex `/^\/(cart|checkout)\/?$/` only matches `/cart` and `/checkout` exactly -- `/cart/` with trailing slash also matches, but `/cart/something` does not. This is fine since Astro routes don't have sub-paths for cart.

### Cache Invalidation Flow

1. Admin makes content change
2. Admin dashboard calls API to save
3. API calls storefront's `POST /api/purge-cache` with token and optional prefixes
4. Storefront bumps KV version (new cache keys for L2 + HTML)
5. Storefront clears L1 (smartCache.clear() or selective prefix clear)
6. Background: homepage is fetched to warm L2 cache

**TTL Constants** (`edge-cache.ts` line 248-252):
- `LONG: 86400` (24h) -- layout, categories, products, SEO, header, footer
- `MEDIUM: 3600` (1h) -- product listings, paginated data
- `SHORT: 300` (5m) -- CSP settings, checkout config

---

## API Client & Service Binding

### Service Binding Architecture

**Files:**
- `apps/storefront/src/lib/api/client.ts` -- Core fetch infrastructure
- `apps/storefront/src/lib/api/context.ts` -- AsyncLocalStorage for per-request bindings
- `apps/storefront/src/middleware.ts` -- Sets up context per request
- `apps/storefront/wrangler.jsonc` -- Declares `BACKEND_API` service binding to `scalius-api`

**How it works:**

1. Middleware reads `BACKEND_API` Fetcher from `cloudflare:workers` env
2. Middleware stores it in `apiContext` (AsyncLocalStorage) via `apiContext.run()`
3. `fetchWithRetry()` checks `import.meta.env.SSR && !import.meta.env.DEV`
4. If true, retrieves `BACKEND_API` from `apiContext.getStore()`
5. Uses `backendApi.fetch(request)` for zero-latency intra-Cloudflare calls
6. Falls back to regular `fetch()` in dev mode or if binding unavailable

**JWT Token Management:**
- Storefront obtains JWT by exchanging `API_TOKEN` (a pre-shared secret) at `/auth/token`
- Token cached in module-level variables with 5-minute pre-expiry refresh
- Token refresh uses a singleton promise (`tokenRefreshPromise`) to deduplicate concurrent refreshes
- On 401 response, token is cleared and request retried (up to 2 retries)

**SDK Integration:**
- Two SDK clients: `sdkClient` (public, no auth) and `sdkAuthClient` (JWT auto-attached)
- Both use `createStorefrontFetch()` which delegates to `fetchWithRetry`
- SDK base URL configured lazily via `getConfiguredSdkClient()` / `getConfiguredSdkAuthClient()`
- Base URL resolution: SSR runtime env -> window.__API_BASE_URL__ -> /api/v1 fallback

**Strengths:**
- Service binding provides zero-latency calls in production (no network hop)
- Token refresh deduplication prevents thundering herd
- 5-minute pre-expiry window prevents token expiration mid-request
- Timeout protection (8s default, 15s for order creation)
- Retry with exponential backoff (300ms * attempt)

**Weaknesses:**
- JWT token stored in module-level variable (`jwtToken`, `tokenExpiry`) -- same concurrent request risk as cacheContext. Under load, two requests could both see expired token and race to refresh.
  - Mitigated by `tokenRefreshPromise` deduplication, but the token update at line 186-190 (`jwtToken = newToken`) is still a write to module-level state from any concurrent request.
- `fetchWithRetry` has default 2 retries. For idempotent GETs this is fine, but the function is also used by `recordDiscountUsage()` (POST) with 2 retries, risking double-recording. (Order creation correctly uses 0 retries.)
- The `fetchWithRetry` retry delay uses `300 * (3 - retries)` which gives 300ms for first retry and 600ms for second. This is quite short for a truly overwhelmed backend.

---

## Import Boundary Compliance

**Result: CLEAN -- No violations detected.**

Grep for `@scalius/core` and `@scalius/database` across all storefront source files returned zero matches:

```
grep -r "@scalius/core|@scalius/database" apps/storefront/src/ -> No matches found
```

The storefront correctly imports only:
- `@scalius/api-client/types` -- SDK response types
- `@scalius/api-client/sdk` -- SDK endpoint functions
- `@scalius/api-client/factory` -- SDK client creation
- `@scalius/shared/currency` -- Currency formatting
- `@scalius/shared/media-url` -- Media URL resolution
- `@scalius/shared/image-optimizer` -- Image optimization
- `@scalius/shared/utils` -- General utilities (via `cn()`)
- `@scalius/shared/css-scope` -- CSS scoping for widgets

**package.json confirms:**
```json
"@scalius/api-client": "workspace:*",
"@scalius/shared": "workspace:*"
```

No `@scalius/core` or `@scalius/database` in dependencies.

---

## Page & Component Architecture

### Pages (`apps/storefront/src/pages/`)

| Route | File | Rendering | Notes |
|-------|------|-----------|-------|
| `/` | `index.astro` | SSR, cacheable | Parallel fetch via `loadPageWithLayout` |
| `/products/[slug]` | `products/[slug].astro` | SSR, cacheable | Parallel fetch, image preload, deferred analytics |
| `/categories/[slug]` | `categories/[slug].astro` | SSR, cacheable | Category product listing |
| `/search` | `search/index.astro` | SSR, cacheable | FTS5 search results |
| `/cart` | `cart.astro` | SSR, no-cache | Client-side cart state from localStorage |
| `/checkout` | `checkout.astro` | SSR, no-cache | Payment gateway selection |
| `/order-success` | `order-success.astro` | SSR, no-cache | Post-purchase confirmation |
| `/account` | `account.astro` | SSR, no-cache | Customer auth + profile |
| `/[slug]` | `[slug].astro` | SSR, cacheable | CMS pages (catch-all) |
| `/404` | `404.astro` | Static | Minimal, no layout |
| `/500` | `500.astro` | Static | Minimal, no layout |
| `/health` | `health.ts` | SSR | JSON health check |
| `/robots.txt` | `robots.txt.ts` | SSR | Dynamic from SEO settings |
| `/sitemap.xml` | `sitemap.xml.ts` | SSR | Index sitemap |
| `/buy/[slug]` | `buy/[slug].ts` | SSR | Direct buy redirect |

### API Proxy Pages (`apps/storefront/src/pages/api/`)

| Route | File | Purpose |
|-------|------|---------|
| `/api/checkout/create-order` | `checkout/create-order.ts` | Order creation proxy (hides API_TOKEN) |
| `/api/checkout/stripe-intent` | `checkout/stripe-intent.ts` | Stripe PaymentIntent proxy |
| `/api/checkout/sslcommerz-session` | `checkout/sslcommerz-session.ts` | SSLCommerz session proxy |
| `/api/checkout/polar-session` | `checkout/polar-session.ts` | Polar session proxy |
| `/api/customer-auth/[...path]` | `customer-auth/[...path].ts` | Customer auth proxy (cookie handling) |
| `/api/auth/logout` | `auth/logout.ts` | Logout proxy (cookie clearing) |
| `/api/purge-cache` | `purge-cache.ts` | Cache invalidation (GET=full, POST=selective) |
| `/api/products/[slug]` | `products/[slug].ts` | Product data JSON endpoint |
| `/api/facebook-feed.xml` | `facebook-feed.xml.ts` | Facebook product feed |
| `/api/__ptproxy` | `__ptproxy.ts` | Partytown reverse proxy |

### Component Organization

**Astro Components (SSR-rendered, zero JS):**
- `components/header/` -- Header, DesktopNav, MobileMenu, HeaderLayout, RecursiveDesktopNav
- `components/Footer.astro` -- Site footer
- `components/hero.astro` -- Hero slider
- `components/collection1.astro`, `components/collection2.astro` -- Collection renderers
- `components/product/` -- ProductBreadcrumbs, ProductDetails, ProductGallery, ProductSummary, RelatedProducts
- `components/cards/ProductCard.astro` -- Product card
- `components/sliders/CustomCarousel.astro` -- Custom carousel
- `components/RichContent.astro` -- HTML content renderer
- `components/RecursiveFooterLink.astro` -- Recursive footer navigation

**React Components (client-side hydrated):**
- `components/CartFlyout.tsx` -- Slide-out cart drawer
- `components/AuthModal.tsx` -- Customer auth modal (client:idle)
- `components/search/CommandPalette.tsx` -- Search modal (client:idle)
- `components/CategoryFilters.tsx` -- Category filter sidebar
- `components/LocationSelector.tsx` -- City/zone/area selector
- `components/ShippingLocationSelector.tsx` -- Shipping location selector
- `components/PhoneField.tsx` -- Phone number input
- `components/ProductImageZoom.tsx` -- Image zoom
- `components/ProductShortcode.tsx` -- Inline product embeds
- `components/OrderSuccessButtons.tsx` -- Post-purchase actions
- `components/CustomDropdown.tsx`, `components/SimpleDropdown.tsx` -- Dropdown components
- `components/sliders/ProductCarousel.tsx` -- Embla carousel wrapper

**UI Primitives (`components/ui/`):**
- accordion, button, carousel, dialog, input, label, radio-group, sheet, slider, sonner, switch, textarea
- Based on Radix UI primitives with shadcn/ui patterns

### State Management

**File:** `apps/storefront/src/store/cart.ts`

- Uses `nanostores/map` for reactive state
- Cart persisted to `localStorage` under key `"cart"`
- SSR-safe: initializes empty object when `window` is undefined
- Cross-component communication via `CustomEvent` dispatches (`cart-updated`, `discount-applied`, `discount-removed`)
- Cart key generation handles product ID, variant ID, and size/color combinations

---

## Performance & SSR

### Optimization Patterns

1. **Parallel Data Loading:**
   - `loadPageWithLayout()` in `apps/storefront/src/lib/page-data.ts` runs `getLayoutData()` and page-specific fetcher in parallel via `Promise.all`
   - Used by homepage, product pages, category pages, and most other pages
   - Eliminates the sequential waterfall of "fetch layout, then fetch page data"

2. **Consolidated API Endpoints:**
   - `getHomepageData()` calls `/api/v1/storefront/homepage` -- single request replaces 4+N calls
   - `getLayoutData()` calls `/api/v1/storefront/layout` -- single request replaces 4 calls (analytics, header, nav, footer)

3. **Image Optimization:**
   - Cloudflare Image Resizing via CDN (`/cdn-cgi/image/...` URLs)
   - Responsive srcset generation (`getResponsiveSrcSet()` in `apps/storefront/src/lib/image-optimizer.ts`)
   - Presets for common sizes: thumbnail (200x200), card (400x400), detail (800x800), hero (1400x600)
   - Primary product image preloaded via `<link rel="preload" as="image" fetchpriority="high">` in product pages

4. **CSS Inlining:**
   - Astro config: `build.inlineStylesheets: "always"` -- eliminates render-blocking CSS requests
   - Vite: `cssCodeSplit: true` for component-level CSS chunks

5. **Deferred Loading:**
   - Product controller deferred to `DOMContentLoaded` via dynamic import
   - Analytics tracking deferred to `window.load` event
   - `CommandPalette` and `AuthModal` use `client:idle` directive (hydrate when browser is idle)
   - Stripe.js loaded dynamically only when user selects Stripe payment

6. **Prefetching:**
   - Astro config: `prefetch.prefetchAll: true` -- prefetches all internal links on hover/viewport

7. **Stale Asset Auto-Reload:**
   - Inline script in Layout.astro detects 404s on `/_astro/` assets and `dynamically imported module` errors
   - Auto-reloads page once (throttled to 30s) to recover from stale HTML referencing removed JS/CSS bundles
   - Prevents the common deployment issue where cached HTML references deleted asset hashes

8. **Preconnect Hints:**
   - DNS-prefetch + preconnect for API origin and CDN domain injected in `<head>`

9. **Partytown Integration:**
   - Analytics scripts (GA4, Facebook Pixel) run in web worker via Partytown
   - Same-origin proxy at `/api/__ptproxy` for CORS-free script fetching
   - `forward: ["dataLayer.push", "fbq", "ga", "gtag"]` for cross-worker event routing

### Bundle Size Concerns

- `sharp` is listed in `dependencies` but Astro's Cloudflare adapter uses `passthrough` imageService. Sharp is a ~10MB native binary. It may be included in the worker bundle unnecessarily.
  - **File:** `apps/storefront/package.json` line 44: `"sharp": "^0.34.5"`
  - The astro config uses `imageService: "passthrough"` which means no server-side image processing. Sharp should be in devDependencies or removed.

- `simple-icons` (line 44 in package.json) is a 13MB+ package containing all brand icons as SVGs. If tree-shaking works correctly only used icons are included, but this should be verified.

---

## Robustness Gaps

### 1. No Retry on Layout Data Failure

**File:** `apps/storefront/src/lib/api/storefront.ts` (lines 116-133)

If `getLayoutData()` fails, the page still renders with fallback defaults (empty header/footer). However, there is no retry mechanism at the page level. The `fetchWithRetry` in the SDK client has 3 retries, but if all fail, the user gets a degraded page with no header, no navigation, and no footer.

**Current fallbacks in Layout.astro (lines 36-52):**
```typescript
const headerData = layoutData?.header ?? {
  topBar: { text: "", isEnabled: false },
  logo: { src: "", alt: "Store" },
  // ... minimal defaults
};
```

This is good defensive coding. The page renders without crashing. But the user experience is poor -- an empty header with no logo or navigation.

**Recommendation:** Consider showing a retry button or auto-retrying the page fetch after a delay for critical layout data failures.

### 2. No Circuit Breaker for API Calls

**Files:** All API modules in `apps/storefront/src/lib/api/`

Every API call retries up to 3 times with 300ms/600ms delays. Under sustained API outage, every page load generates 3-4 API calls (layout + page data) * 3 retries = 9-12 failed requests, each with an 8-second timeout. Total worst case: ~96 seconds of blocking before the page renders with fallbacks.

**Impact:** Under API downtime, storefront response times degrade dramatically. The middleware's Cache API timeout (500ms) and KV timeout (1000ms) have good protection, but the actual API data fetching does not.

**Recommendation:** Implement a circuit breaker pattern that trips after N consecutive failures and short-circuits to cached/fallback data for a cooldown period.

### 3. Checkout Session Data in `sessionStorage`

**File:** `apps/storefront/src/lib/checkout/index.ts` (lines 51-66)

Checkout data is stored in `sessionStorage` and read back on the checkout payment page. If the session is lost (browser crash, tab restore, incognito mode limitations), the user is redirected to `/cart` silently.

**Impact:** Users who navigate away during checkout or experience a browser crash lose their checkout progress. This is standard browser behavior but could be improved with server-side checkout session persistence.

### 4. Order Creation Polling Can Time Out Silently

**File:** `apps/storefront/src/lib/api/orders.ts` (lines 47-73)

When the API returns 202 (queued), the storefront polls for up to 45 seconds (30 * 1.5s). If the timeout is reached, the user gets:
```
"Order processing timed out. Please check your order history."
```

**Impact:** The order may have been created successfully but the polling timed out. The user is told it failed when it may have succeeded. There is no recovery mechanism to check order status later.

### 5. Error Pages Don't Use Layout

**Files:** `apps/storefront/src/pages/404.astro`, `apps/storefront/src/pages/500.astro`

The 404 and 500 error pages render standalone HTML without the site layout (no header, footer, or navigation). This is intentional for 500 (layout fetch might have caused the error) but the 404 page could benefit from including the site layout for a better user experience.

---

## LLM-Friendliness

### Strengths

1. **Clear file organization:** API modules are 1:1 with API resource domains (`products.ts`, `categories.ts`, `settings.ts`)
2. **Comprehensive JSDoc comments:** Most public functions have clear descriptions of purpose, parameters, and return types
3. **Barrel exports:** `apps/storefront/src/lib/api/index.ts` provides a single import point
4. **Explicit cache key naming:** Cache keys like `product_slug_${slug}`, `global_header_data`, `checkout_config` are self-documenting
5. **Type definitions co-located:** `apps/storefront/src/lib/api/types.ts` centralizes all domain types
6. **Config comments:** `wrangler.jsonc` has inline comments explaining each binding

### Weaknesses

1. **Two `runtime-env.ts` files:** `apps/storefront/src/lib/runtime-env.ts` and `apps/storefront/src/lib/api/runtime-env.ts` exist with different purposes. Confusing naming.
2. **Mixed Astro + React patterns:** Some components are `.astro` (SSR-only), some are `.tsx` (React hydrated). The boundary is not always obvious from file names alone.
3. **Widget rendering uses `set:html`:** Multiple places use `<div set:html={widget.htmlContent}>` which bypasses sanitization. An LLM editing this code might not realize the XSS implications.

---

## Recommended Changes

### Priority 1: Critical Fixes

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 1 | **Migrate `cacheContext` to AsyncLocalStorage** | `edge-cache.ts`, `middleware.ts` | Medium |
| 2 | **Fix cart localStorage key mismatch** | `checkout/index.ts` line 209 | Trivial |
| 3 | **Remove dead `setRuntimeEnv()` call** | `middleware.ts`, `api/runtime-env.ts` | Trivial |

### Priority 2: Type Safety

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 4 | **Create typed SDK unwrap helper** | New utility + all 17 API modules | Medium |
| 5 | **Remove or document `withSmartCache`** | `smart-cache.ts` | Trivial |

### Priority 3: Performance

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 6 | **Move `sharp` to devDependencies or remove** | `package.json` | Trivial |
| 7 | **Add circuit breaker for API calls** | `client.ts` | Medium |
| 8 | **Warm product pages after selective cache purge** | `purge-cache.ts` | Low |

### Priority 4: Resilience

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 9 | **Add order status recovery page** | New page | Medium |
| 10 | **Use layout on 404 page** | `404.astro` | Low |
| 11 | **Move JWT token state into ALS** | `client.ts` | Medium |

### Priority 5: Cleanup

| # | Issue | Files | Effort |
|---|-------|-------|--------|
| 12 | **Remove duplicate `runtime-env.ts`** | `lib/runtime-env.ts` | Low |
| 13 | **Remove `inflight.clear()` from `setEdgeCacheContext`** | `edge-cache.ts` line 61 | Trivial |
| 14 | **Consolidate globalThis CDN_DOMAIN into ALS** | `middleware.ts` lines 288-291 | Low |
