# 22 — Storefront Architecture Audit

## 1. Overview

The storefront is an Astro 6 SSR application deployed as a Cloudflare Worker. It uses React 19 islands for interactive components, nanostores for client-side state, and communicates with the API worker via Cloudflare Service Bindings in production (falling back to HTTP fetch in dev). The app implements a sophisticated two-layer caching strategy (in-memory L1 + Cloudflare Cache API L2) with KV-versioned invalidation.

**Key files:**
- Astro config: `apps/storefront/astro.config.mjs`
- Middleware: `apps/storefront/src/middleware.ts`
- Type declarations: `apps/storefront/src/env.d.ts`
- Layout: `apps/storefront/src/layouts/Layout.astro`
- API client: `apps/storefront/src/lib/api/client.ts`
- Edge cache: `apps/storefront/src/lib/edge-cache.ts`
- Cart store: `apps/storefront/src/store/cart.ts`
- Product controller: `apps/storefront/src/components/product/scripts/product-controller.ts`

---

## 2. API Client Layer

### Service Binding Architecture

The storefront communicates with the API worker through a layered abstraction:

```
Middleware (context.ts / runtime-env.ts)
  -> client.ts (fetchWithRetry)
    -> Service Binding (production) OR HTTP fetch (dev/client)
```

**Middleware bootstrapping** (`middleware.ts` lines 267-299): Two middleware functions run in sequence:
1. `apiContextMiddleware` -- Sets up `AsyncLocalStorage`-based context (`apiContext`) carrying `BACKEND_API`, `PUBLIC_API_URL`, and `CDN_DOMAIN_URL`. Also populates module-level `runtime-env.ts` vars for sync access and `globalThis.__SCALIUS_CDN_DOMAIN__` as a last-resort fallback for SSR rendering.
2. `cachingMiddleware` -- Handles HTML page caching (detailed below).

**URL resolution** (`client.ts` lines 20-34): API base URL resolves through a four-step cascade:
1. SSR runtime env from `runtime-env.ts` (Cloudflare Worker vars)
2. Client-side `window.__API_BASE_URL__` (injected by Layout.astro)
3. Build-time `import.meta.env.PUBLIC_API_URL`
4. Fallback `/api/v1` (same-origin proxy)

**Service binding usage** (`client.ts` lines 149-173): In SSR production mode (`import.meta.env.SSR && !import.meta.env.DEV`), the client dynamically imports `apiContext` to get the `BACKEND_API` Fetcher, achieving 0ms latency via Cloudflare's internal network. Local dev skips this because miniflare runs separate processes.

**JWT token management** (`client.ts` lines 37-109): Module-level singleton manages JWT tokens with:
- 5-minute pre-expiry refresh window
- Promise-based deduplication of concurrent refresh requests
- Token exchange via `X-API-Token` header → JWT response
- Automatic token rotation via `X-New-Token` response header

**Resilient fetching** (`client.ts` lines 121-202): `fetchWithRetry` provides:
- Configurable retry count and timeout (default 2 retries, 8s timeout)
- `AbortSignal.timeout` for hard timeout enforcement
- 401 auto-retry with token invalidation and body cancellation
- Exponential backoff (300ms * attempt number)
- `cache: "no-store"` for authenticated requests to prevent Cloudflare edge caching

### Response Envelope Handling

All API functions consistently unwrap the `{ success: true, data: T }` envelope. Each domain module (products, categories, settings, etc.) manually types and unwraps the response:

```typescript
const json: { success: boolean; data: ProductPageData } = await response.json();
return json.data as ProductPageData;
```

The customer-auth module (`customer-auth.ts`) has a defensive double-unwrap pattern:
```typescript
const data = raw.data ?? (raw as unknown as VerifyOtpData);
```
This handles both `{ success, data: T }` and raw `T` shapes -- a pragmatic guard against envelope inconsistencies.

### Strengths
- Service binding for zero-latency SSR is architecturally correct
- JWT deduplication prevents thundering herd on token refresh
- Body cancellation before retry prevents Worker memory leaks
- AsyncLocalStorage context avoids global state races

### Issues

**ISSUE-SF-01 (Medium): Module-level mutable state for JWT tokens.** `jwtToken`, `tokenExpiry`, and `tokenRefreshPromise` are module-level variables (`client.ts` lines 37-40). On Cloudflare Workers with isolate reuse, a stale token from a previous request could be served to a different request. The `runtime-env.ts` module has the same pattern. While the inflight map in `edge-cache.ts` is cleared on each request (`setEdgeCacheContext` line 61), the JWT state is not.

**ISSUE-SF-02 (Low): Inconsistent auth requirement defaults.** `getProductBySlug` defaults `requiresAuth = false` (line 33), but `getOrderDetails` uses the `fetchWithRetry` default of `requiresAuth = true` (line 97). This is correct behavior (orders are authenticated, products are public), but the inconsistency of sometimes-explicit/sometimes-default makes the auth contract unclear.

**ISSUE-SF-03 (Low): `searchProductsForForm` has unused `_page` parameter.** The function accepts `_page` (line 258 in products.ts) but never uses it because the `/search` endpoint does not support pagination. The parameter exists only for API compatibility but could mislead callers.

---

## 3. Caching Strategy

### Two-Layer Architecture

The storefront implements a comprehensive caching strategy spanning three scopes:

**L1 -- In-Memory Cache** (`smart-cache.ts`): A `Map<string, CacheEntry>` with TTL-based expiry. Survives warm starts on the same Worker isolate but resets on cold start. No max-size eviction policy -- relies on Worker memory limits and TTL expiry.

**L2 -- Cloudflare Cache API** (`edge-cache.ts`): Persistent edge cache using the Cache API (`caches.default`). Cache keys include KV version and BUILD_ID: `https://{hostname}/_api-cache/{key}?v={version}&build={BUILD_ID}`. This ensures invalidation on both content changes (KV bump) and code deployments (BUILD_ID change).

**HTML Page Cache** (`middleware.ts` lines 83-265): Full-page HTML caching for cacheable paths with:
- BUILD_ID + KV version composite cache keys
- Browser headers: `no-cache, no-store, must-revalidate` (always revalidate)
- Edge storage: `public, max-age=31536000, immutable` (hold until KV bump)
- 500ms timeout on `cache.match` to prevent hanging
- 1000ms timeout on KV lookups

**Request deduplication** (`edge-cache.ts` lines 78-81): An in-flight map prevents duplicate API calls when multiple components request the same data simultaneously (e.g., Layout + page both calling `getLayoutData()`).

### Cache Key Design

- L1 keys include KV version: `{key}:v{kvVersion}` -- ensures KV bump invalidates across all isolates
- L2 keys include KV version + BUILD_ID: `https://{hostname}/_api-cache/{key}?v={version}&build={BUILD_ID}`
- HTML page keys strip tracking params (fbclid, utm_*, etc.) and product variant params (size, color)

### Invalidation

`/api/purge-cache` endpoint supports two modes:
1. **Full purge (GET)**: Bumps KV version, clears all L1, triggers cache warming
2. **Selective purge (POST)**: Optionally bumps version, clears L1 by prefix, conditional warming

Cache warming (`warmCriticalCaches`) fetches the homepage after purge via `waitUntil` to pre-populate L2 for the next visitor.

### TTL Tiers

```
LONG:   86400s (24h) -- Layout, categories, SEO, analytics config, widgets
MEDIUM:  3600s (1h)  -- Product listings, category products
SHORT:    300s (5m)  -- Checkout config, CSP settings
```

### Strengths
- KV-versioned cache keys are elegant -- a single KV write invalidates all cache layers globally
- BUILD_ID in cache keys prevents stale HTML serving removed JS/CSS bundles
- Timeout wrappers on KV and Cache API operations prevent hanging
- Background cache warming via `waitUntil` reduces cold start penalty

### Issues

**ISSUE-SF-04 (Medium): L1 cache has no size limit.** `smart-cache.ts` uses an unbounded `Map`. Under sustained traffic with many unique cache keys (e.g., thousands of product slugs each with unique query params), the in-memory cache could grow large within a Worker isolate's lifetime. Cloudflare Workers have a 128MB memory limit; a runaway L1 cache could approach it.

**ISSUE-SF-05 (Low): Duplicate deduplication maps.** Both `smart-cache.ts` (line 68) and `edge-cache.ts` (line 80) maintain separate `inflight` Maps. The `withSmartCache` function in `smart-cache.ts` is not used by `edge-cache.ts` -- the edge cache has its own implementation. This is technically harmless but creates dead code (`withSmartCache` appears unused by any storefront module since everything goes through `withEdgeCache`).

**ISSUE-SF-06 (Low): Stale asset detector could loop.** The stale asset detector in `Layout.astro` (lines 109-144) reloads on 404 of `/_astro/` assets with a 30-second cooldown. If the CDN consistently serves 404 for a valid asset (e.g., during a deployment race), this could trigger unnecessary reloads. The 30s cooldown mitigates but does not eliminate this.

---

## 4. Page Structure

### Page Inventory

| Route | Type | Data Loading | Cache | Notes |
|-------|------|-------------|-------|-------|
| `/` (index) | Astro SSR | `loadPageWithLayout(getHomepageData)` | L1+L2+HTML | Parallel layout+homepage fetch |
| `/products/[slug]` | Astro SSR | `loadPageWithLayout(getProductBySlug)` | L1+L2+HTML | Preloads hero image |
| `/categories/[slug]` | Astro SSR | Parallel fetch | L1+L2+HTML | Paginated product grid |
| `/search` | Astro SSR | `Promise.all([layout, products, attributes])` | L1+L2 | No HTML cache (query-dependent) |
| `/cart` | Astro SSR | Layout + shipping + checkout config | NO CACHE | `private, no-store` enforced |
| `/checkout` | Astro SSR | `Promise.all([layout, checkoutConfig])` | NO CACHE | Payment selection page |
| `/order-success` | Astro SSR | Layout + order details | NO CACHE | Post-purchase confirmation |
| `/account` | Astro SSR | Layout + session | NO CACHE | Customer profile + orders |
| `/[slug]` | Astro SSR | CMS page by slug | L1+L2+HTML | Dynamic pages |
| `/buy/[slug]` | API route | Quick buy redirect | -- | Sets sessionStorage, redirects to /cart |
| `/api/checkout/*` | API routes | Proxy to backend | -- | Order creation, payment sessions |
| `/api/purge-cache` | API route | KV + cache ops | -- | Token-authenticated |
| `/api/customer-auth/[...path]` | API route | Proxy to backend | -- | Same-origin auth proxy |
| `/sitemap*.xml` | TS endpoint | Fetches all entities | -- | SEO sitemaps |
| `/robots.txt` | TS endpoint | SEO settings | -- | Dynamic from admin config |
| `/health` | TS endpoint | -- | -- | Health check |

### Parallel Data Loading

The `loadPageWithLayout` utility (`page-data.ts`) wraps `Promise.all([getLayoutData(), pageDataFetcher()])` to parallelize layout and page-specific data fetches. This reduces cold start latency by eliminating the sequential Layout-then-content waterfall.

Pages that need more than two data sources use direct `Promise.all` (e.g., search page fetches layout + products + attributes in parallel).

### Layout Architecture

`Layout.astro` provides the full document shell:
- Preconnect hints for API and CDN origins
- Runtime config injection (`window.__API_BASE_URL__`, `__CDN_DOMAIN__`, `__CURRENCY_*__`)
- Stale asset detector (auto-reload on 404 for `/_astro/` assets)
- Facebook Pixel stubs (main thread + Partytown worker)
- Dynamic theme color injection via CSS custom properties
- Admin-configurable analytics scripts at head/body_start/body_end positions
- `CommandPalette` and `AuthModal` as `client:idle` React islands

The Layout accepts optional `layoutData` prop for pre-fetched data (parallel loading path) with a fallback `await getLayoutData()` for backward compatibility.

### Strengths
- Parallel data loading is consistently applied across all major pages
- Layout prop-drilling of pre-fetched data avoids redundant API calls
- Clear separation between cached pages and no-cache pages
- Runtime config injection handles the Cloudflare Worker → browser boundary correctly

### Issues

**ISSUE-SF-07 (Low): Checkout page fetches layout data separately.** `checkout.astro` (line 16) uses `Promise.all([getLayoutData(), getCheckoutConfig()])` instead of `loadPageWithLayout`. While functionally equivalent, it bypasses the standardized pattern used by other pages, making the codebase slightly less consistent.

---

## 5. Component Architecture

### React Islands Strategy

The storefront uses Astro's islands architecture with strategic hydration:

| Component | Hydration | Purpose |
|-----------|-----------|---------|
| `CommandPalette` | `client:idle` | Global search overlay |
| `AuthModal` | `client:idle` | Customer login/signup |
| `CartFlyout` | `client:idle` | Slide-over cart panel |
| `LocationSelector` | `client:load` | City/zone/area cascading dropdowns |
| `PhoneField` | `client:load` | International phone input |
| `CategoryFilters` | `client:load` | Search page attribute filters |
| `Toaster` (sonner) | inline | Toast notifications |

Heavy components (CommandPalette, AuthModal, CartFlyout) use `client:idle` to defer hydration until the browser is idle. Form-critical components (LocationSelector, PhoneField) use `client:load` for immediate interactivity.

### Vanilla JS Product Controller

The product page uses a notable pattern: the product controller (`product-controller.ts`) is **not a React component**. It is a vanilla TypeScript module loaded via dynamic import:

```javascript
import('@/components/product/scripts/product-controller').then(m => m.init());
```

This architecture defers the variant/pricing bundle from the critical path. The controller uses direct DOM manipulation (`document.getElementById`, `classList` operations) rather than React state, keeping the product page's interactive footprint minimal.

The controller coordinates with React islands via custom DOM events:
- `add-to-cart` -- triggers CartFlyout open
- `open-cart` -- opens cart panel
- `product-image-change` -- syncs gallery state
- `controller-image-update` -- notifies other components

### Cross-Component Communication

The storefront uses three communication patterns:
1. **Nanostores** (`cartStore`, `cartOpenState`) -- React islands share state via nanostores with `@nanostores/react` bindings
2. **Custom DOM events** -- Vanilla JS components dispatch events (`add-to-cart`, `zone-selected`, `shippingLocationChange`, `phone-prefill`)
3. **Window globals** -- Runtime config (`__API_BASE_URL__`, `__CURRENCY_SYMBOL__`), shipping state (`lastShippingEventDetail`)

### Strengths
- Astro islands with strategic hydration directives minimizes JS payload
- Vanilla JS product controller avoids React overhead for the most JS-heavy page
- Custom events provide loose coupling between Astro/React/vanilla components
- nanostores is an excellent choice for cross-island state (tiny, framework-agnostic)

### Issues

**ISSUE-SF-08 (Medium): Cart client uses innerHTML for rendering.** `cart/client.ts` `renderCartItems()` (lines 296-344) builds HTML via template literals and sets `innerHTML`. While XSS risk is low (data comes from the cart store, not user input), the `item.name` and `item.size`/`item.color` fields originate from the API and could theoretically contain malicious content. The function also does not escape HTML entities.

**ISSUE-SF-09 (Low): Mixed patterns for cart interaction.** The CartFlyout (React) uses nanostores directly, while the cart page (`cart/client.ts`) uses DOM manipulation with `window.updateCartQuantity` / `window.removeFromCart` globals. This dual approach works but makes the cart behavior harder to reason about -- changes must be synchronized across both implementations.

---

## 6. Cart Implementation

### State Management

Cart state lives in a nanostore (`store/cart.ts`) with localStorage persistence:

```typescript
export type CartStore = {
  items: Record<string, CartItem>;
  totalItems: number;
  totalAmount: number;
  discount: Discount | null;
};
```

**Key generation** uses a composite key strategy:
- Products with variants: `{productId}-{variantId}`
- Products with size/color but no variantId: `{productId}-{size}-{color}`
- Simple products: `{productId}`

**Discount management**: Discounts are automatically cleared when cart contents change (add/remove/update quantity) or when the shipping method changes. This prevents stale discounts from applying to modified orders.

**Abandoned checkout tracking**: The cart client (`cart/client.ts`) implements debounced (1.5s) abandoned checkout tracking. On any cart or form change, checkout data is serialized and sent to the backend. A session-scoped `checkoutId` (`chk_session_{nanoid}`) identifies the checkout session.

### Quick Buy Flow

The `/buy/[slug]` route implements a "Buy Now" flow:
1. Product page writes cart item + analytics events to `sessionStorage.quickBuyData`
2. Redirects to `/cart`
3. Cart client reads and processes `quickBuyData` on init, adding to cart and firing analytics

### Strengths
- localStorage persistence means cart survives page refreshes and browser restarts
- Discount auto-reset on cart change prevents inconsistent pricing
- Quick buy via sessionStorage avoids URL parameter pollution
- Abandoned checkout tracking captures partial checkouts for recovery

### Issues

**ISSUE-SF-10 (Medium): No cart item limit.** There is no maximum on the number of items or total quantity in the cart. A user (or bot) could add thousands of items, causing localStorage limits to be reached and potentially creating enormous order payloads.

**ISSUE-SF-11 (Low): Cart totals recalculated synchronously on every change.** `updateCartTotals()` iterates all items on every add/remove/update. With a reasonable cart size this is negligible, but the function is called multiple times in sequence (e.g., `addToCart` calls `updateCartTotals`, then the store subscription triggers `renderCartItems` which calls `updateTotals` again).

---

## 7. Product Experience

### Variant State Machine

The variant selection system (`variant-state-machine.ts`) is a well-architected pure functional state machine:

**State shape:**
```typescript
interface VariantSelectionState {
  selectedSize: string | undefined;
  selectedColor: string | undefined;
  selectedVariant: Variant | null;
  availableSizes: Set<string>;
  availableColors: Set<string>;
}
```

**Index structure:** `createVariantIndex()` pre-computes lookup structures:
- `variantBySizeColor` -- O(1) lookup for exact size+color combination
- `variantsBySize` / `variantsByColor` -- O(1) partial selection lookup
- `inStockSizesByColor` / `inStockColorsBySize` -- Stock-aware availability

**Action dispatching:** `applyAction()` follows a reducer pattern with toggle semantics (clicking the same option deselects it). Available options are dynamically recalculated based on the current selection and stock levels.

**Auto-selection:** When only one option exists for a dimension, it is auto-selected on init. URL params (`?size=X&color=Y`) are applied during initialization for shareable product links.

### Pricing Engine

`pricing-engine.ts` implements clear pricing rules:
1. Variant price overrides product price when present
2. Variant discount overrides product discount when present
3. Flat discounts subtract directly; percentage discounts multiply
4. `Math.round()` ensures integer arithmetic (no floating point issues)
5. `Math.max(0, ...)` prevents negative prices

The engine also provides cart-level calculations: line totals, subtotals, cart-level discounts, and price range formatting for multi-variant products.

### Strengths
- State machine pattern with immutable state transitions is testable and predictable
- Pre-computed index avoids O(n) scans on every selection change
- Separation of state machine (pure logic) from controller (DOM effects) is clean
- Pricing engine handles all discount combinations correctly with integer arithmetic

---

## 8. Search

### Command Palette

The `CommandPalette` component (`CommandPalette.tsx`) provides a Cmd+K searchable overlay:

- Opens via `Ctrl/Cmd+K` keyboard shortcut or `open-search-palette` custom event
- 300ms debounce on input before API call
- Flattened result list with keyboard navigation (arrow keys + Enter)
- Results grouped by type: Products (with image + price), Categories (with icon), Pages
- Portal-rendered to escape layout stacking contexts
- Full-screen on mobile, centered modal on desktop

The search uses the public API directly:
```typescript
const res = await fetch(`${apiBaseUrl}/search?${params}`);
```

Note: This bypasses `fetchWithRetry` (no JWT auth needed for public search). The search API is called directly from the client-side React component rather than through the SSR API layer.

### Search Page

`/search/index.astro` provides a full search results page with:
- Server-side data fetching (parallel: layout + products + filterable attributes)
- Sidebar filters (mobile: slide-over overlay, desktop: sticky sidebar)
- Sort options (newest, price asc/desc)
- Pagination with ellipsis rendering
- Facebook Pixel ViewContent tracking for search results

### Strengths
- 300ms debounce prevents excessive API calls while typing
- Keyboard navigation with visible selection state is accessible
- Server-side search page means results are indexable by search engines
- Parallel fetching of layout + products + attributes minimizes TTFB

---

## 9. Performance

### Build Configuration

- `output: "server"` -- Full SSR, no static pages
- `compressHTML: true` -- Minified HTML output
- `prefetch: { prefetchAll: true }` -- Speculative link prefetching
- `build: { inlineStylesheets: "always" }` -- Eliminates CSS render-blocking
- `cssCodeSplit: true` + `minify: true` -- Optimized CSS delivery
- Partytown for third-party scripts (Facebook Pixel, Google Analytics)
- `react-dom/server.edge` alias in production for Cloudflare edge compatibility

### SSR-specific optimizations

- React deduplication in Vite config prevents duplicate React bundles
- `noExternal` list ensures Radix UI, lucide-react, nanostores, and embla-carousel are bundled (not treated as external CJS modules)
- `ssr.external` for Node builtins prevents bundling polyfills
- `ssr.resolve.conditions: ["workerd", "node", "worker"]` ensures Cloudflare-compatible module resolution

### Image Optimization

- CDN domain with Cloudflare Image Resizing (`/cdn-cgi/image/...` URLs)
- Hero image preloaded via `<link rel="preload" as="image" fetchpriority="high">`
- DNS prefetch + preconnect for API and CDN origins in layout
- `loading="lazy"` on non-critical images (cart items, etc.)
- `imageService: "passthrough"` in Cloudflare adapter (relies on CDN-side resizing)

### Script Loading

- Product controller deferred via dynamic `import()` to break critical chain
- Analytics tracking deferred to `window.load` event
- Facebook Pixel ViewContent loaded only when `fbq` is available
- `is:inline` scripts for critical runtime config (non-module, synchronous)

### Caching Performance

- Edge HTML cache: 0ms TTFB on cache hit (overrides browser cache headers to force revalidation)
- API data cache: L1 hit ~0ms, L2 hit ~5-10ms, miss depends on service binding latency
- Cache warming after purge pre-populates critical paths
- Selective purge (by prefix) avoids full cache invalidation for targeted changes

### Strengths
- The caching architecture is production-grade -- KV versioning, BUILD_ID, timeouts, warming
- Preconnect/prefetch hints in the layout minimize connection setup time
- Deferred analytics and product controller keep the critical path lean
- Partytown offloads third-party scripts to a web worker

### Issues

**ISSUE-SF-12 (Medium): `prefetchAll: true` may cause excessive prefetching.** On pages with many links (homepage with collections, category pages with product grids), Astro will speculatively prefetch every link. For a catalog with hundreds of products, this generates significant background traffic. Consider `prefetch: { defaultStrategy: "hover" }` instead.

**ISSUE-SF-13 (Low): No bundle size monitoring.** `package.json` has no bundle analysis tooling. Dependencies like `react-phone-number-input` (includes all country metadata), `simple-icons`, and `lucide-react` can be large if not tree-shaken properly.

---

## 10. LLM-Friendliness Assessment

### Strengths
- **Clear file organization**: API client modules are domain-separated (`products.ts`, `categories.ts`, `orders.ts`, etc.) with a barrel export (`index.ts`)
- **Comprehensive type definitions**: `types.ts` provides 520+ lines of well-documented interfaces with TODO annotations about SDK migration
- **Explicit patterns**: Every API function follows the same pattern -- `createApiUrl` -> `fetchWithRetry` -> unwrap `json.data` -> return typed result
- **State machine documentation**: Variant state machine has clear selection rules documented in comments
- **Pricing rules documented**: Pricing engine comments explain the priority cascade
- **Cache architecture is traceable**: L1 -> L2 -> backend fallback chain is straightforward to follow
- **Env boundary well-documented**: `env.d.ts` has clear comments about what goes in `ImportMetaEnv` vs `Env` interface

### Weaknesses
- **Cart client mixes concerns**: `cart/client.ts` handles rendering, analytics, discount validation, abandoned checkout, quick buy processing, and DOM event binding in a single 565-line file
- **Three env access patterns**: Cloudflare env can be accessed via `cfEnv` (module import), `apiContext.getStore()` (AsyncLocalStorage), or `runtime-env.ts` getters. An LLM must understand when to use each
- **Implicit cross-component contracts**: Custom events (`add-to-cart`, `zone-selected`, etc.) have no typed payload definitions visible at the dispatch site

---

## 11. Issues & Recommendations Summary

### Priority: Medium

| ID | Issue | Location | Recommendation |
|----|-------|----------|----------------|
| SF-01 | Module-level JWT state risks cross-request leakage | `client.ts:37-40` | Move JWT state into AsyncLocalStorage context or clear on each request in middleware |
| SF-04 | L1 cache has no size limit | `smart-cache.ts` | Add LRU eviction or max entry count (e.g., 1000 entries) |
| SF-08 | innerHTML rendering of cart items | `cart/client.ts:296-344` | Escape HTML entities in item names, or refactor to use DOM API |
| SF-10 | No cart item limit | `store/cart.ts` | Add max items constant (e.g., 50) and max quantity per item (e.g., 99) |
| SF-12 | Aggressive prefetchAll | `astro.config.mjs:22` | Switch to `defaultStrategy: "hover"` or `"viewport"` |

### Priority: Low

| ID | Issue | Location | Recommendation |
|----|-------|----------|----------------|
| SF-02 | Inconsistent auth requirement defaults | Various API modules | Always pass `requiresAuth` explicitly for clarity |
| SF-03 | Unused `_page` parameter | `products.ts:258` | Remove parameter or add deprecation comment |
| SF-05 | Duplicate deduplication maps | `smart-cache.ts:68`, `edge-cache.ts:80` | Remove `withSmartCache` if all callers use `withEdgeCache` |
| SF-06 | Stale asset detector loop risk | `Layout.astro:109-144` | Add max-retry counter in sessionStorage |
| SF-07 | Inconsistent loadPageWithLayout usage | `checkout.astro:16` | Use `loadPageWithLayout` for consistency |
| SF-09 | Mixed cart rendering patterns | `CartFlyout.tsx` vs `cart/client.ts` | Document the dual-path architecture or consolidate |
| SF-11 | Redundant cart total recalculation | `store/cart.ts` | Debounce `updateCartTotals` or batch `setKey` calls |
| SF-13 | No bundle size monitoring | `package.json` | Add `vite-bundle-visualizer` or similar to build pipeline |

---

## 12. Architecture Diagram

```
Browser
  |
  |-- [Astro SSR Pages] ---- Layout.astro (injects window globals)
  |     |                         |
  |     |-- [React Islands]       |-- CommandPalette (client:idle)
  |     |     |-- CartFlyout      |-- AuthModal (client:idle)
  |     |     |-- LocationSelector|-- CategoryFilters (client:load)
  |     |     |-- PhoneField      |
  |     |                         |
  |     |-- [Vanilla JS]          |
  |           |-- product-controller.ts (dynamic import)
  |           |-- cart/client.ts (checkout page)
  |
  |-- nanostores (cartStore) <-> localStorage
  |
  |-- Custom DOM Events (add-to-cart, zone-selected, etc.)
  |
  +--> API Client (fetchWithRetry)
        |
        |-- [SSR Path] --> AsyncLocalStorage (apiContext)
        |                    |
        |                    +-> Service Binding (BACKEND_API.fetch)
        |                         |
        |                         +-> API Worker (0ms latency)
        |
        |-- [Client Path] --> window.__API_BASE_URL__
                               |
                               +-> HTTP fetch → API Worker

Cache Layers:
  L1 (smartCache) -> L2 (CF Cache API) -> Backend API
  HTML Cache: CF Cache API with KV-versioned keys
  Invalidation: /api/purge-cache bumps KV version -> new cache keys
```

---

## 13. Key Patterns for Contributors

### Adding a new API function
1. Create or extend a file in `apps/storefront/src/lib/api/`
2. Use `createApiUrl()` + `fetchWithRetry()` from `./client`
3. Wrap with `withEdgeCache()` and appropriate TTL from `CACHE_TTL`
4. Unwrap `json.data` from the response envelope
5. Export from `./index.ts` barrel file
6. Add types to `./types.ts`

### Adding a new page
1. Create `.astro` file in `apps/storefront/src/pages/`
2. Use `loadPageWithLayout()` for parallel data loading
3. Pass `layoutData` to `<Layout>` component
4. For interactive content, use React islands with appropriate hydration directive

### Adding a new React island
1. Create component in `apps/storefront/src/components/`
2. Use nanostores for shared state (not React context -- islands are isolated)
3. Add to Astro page with `client:idle` (non-critical) or `client:load` (form elements)
4. Communicate with non-React code via custom DOM events

### Cache invalidation
When adding new cached data, ensure the cache key prefix is included in the selective purge groups used by the admin dashboard. Otherwise, content updates from admin will not reflect until TTL expiry.
