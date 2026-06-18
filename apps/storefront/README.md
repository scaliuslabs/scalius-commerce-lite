# Storefront (`apps/storefront/`)

Astro 6 SSR customer-facing storefront deployed as a Cloudflare Worker. Communicates with the API worker via Cloudflare Service Binding (`env.BACKEND_API`). Imports `@scalius/shared` and `@scalius/api-client` -- does NOT import `@scalius/core` or `@scalius/database` directly.

## Entry Point

`src/worker.ts` exports a simple Cloudflare Worker that delegates to the Astro Cloudflare adapter handler.

## Tech Stack

- **Astro 6** -- SSR with `@astrojs/cloudflare` adapter
- **React 19** -- Interactive components (islands architecture)
- **Tailwind CSS 4** -- Styling
- **Nano Stores** -- Client-side state management (cart, toast)
- **Radix UI** -- Accessible UI primitives
- **Lucide React** -- Icons
- **Sonner** -- Toast notifications

## Project Structure

```
src/
  components/        # UI Components (Header, Footer, Product, Cart, etc.)
  config/            # Build ID and runtime config
  layouts/           # Page layouts (Layout.astro)
  lib/               # Utilities, API client, caching, middleware helpers
    api/             # API client modules (per-domain fetch functions + typed unwrap)
    cart/            # Cart utility functions
    checkout/        # Checkout page logic + gateway handlers
    edge-cache.ts    # L2 edge caching (Cache API + KV versioning + ALS)
    smart-cache.ts   # In-memory LRU cache (L1)
    middleware-helper/ # CSP handler
    tracking/        # Analytics tracking
  pages/             # File-based routing
    api/             # Server-side proxy routes
      checkout/      # create-order, stripe-intent, sslcommerz-session, polar-session
      auth/          # Auth proxy routes
      customer-auth/ # Same-origin Customer OTP auth proxy
      products/      # Product data proxy
    products/        # Product detail pages
    categories/      # Category listing pages
    buy/             # Buy/redirect pages
    search/          # Search with filters
    cart.astro       # Cart page
    checkout.astro   # Checkout page
    order-success.astro
    account.astro    # Customer account page
  store/             # Global state (cart.ts, toast)
  middleware.ts      # Edge caching + API context injection
```

## Middleware (`src/middleware.ts`)

Two middleware functions run in sequence via `sequence()`:

### 1. API Context Middleware (`apiContextMiddleware`)

Injects Cloudflare Worker runtime bindings into AsyncLocalStorage for the request lifecycle. The `apiContext` ALS store (`src/lib/api/context.ts`) carries:

- `BACKEND_API` -- Service binding Fetcher for 0ms-latency internal API calls
- `PUBLIC_API_URL` -- Full API URL for client-side use
- `PUBLIC_API_BASE_URL` -- Base URL for image optimization and auth redirects
- `CDN_DOMAIN_URL` -- CDN domain for image URLs (also set on `globalThis.__SCALIUS_CDN_DOMAIN__` as fallback)
- `STOREFRONT_URL` -- This storefront's URL (sitemaps, Facebook feed)
- `API_TOKEN` -- Token for protected API operations

### 2. Caching Middleware (`cachingMiddleware`)

Implements a two-layer edge caching strategy for HTML pages:

**Cacheable paths** (regex-matched):
- Homepage (`/`)
- Product pages (`/products/{slug}`)
- Category pages (`/categories/{slug}`)
- Search (`/search`)
- Sitemaps (`/sitemap.xml`, `/sitemap-*.xml`)
- Generic pages (any path not matching excluded prefixes)

**Non-cacheable paths**: `/api`, `/cart`, `/checkout`, `/buy`, `/order-success`, `/account`, `/health`, `/robots.txt`

**Cache key construction**:
- Strips tracking parameters (fbclid, gclid, UTM params, ref)
- Strips product variant selection params (size, color) on product pages
- Appends `cache_v={kvVersion}-{BUILD_ID}` to ensure deployments never serve stale HTML

**Cache flow**:
1. Check Cloudflare Cache API for cached HTML (with 500ms timeout)
2. On HIT: return cached response with browser no-cache headers
3. On MISS: render page, store in Cache API (with `waitUntil`), return with no-cache headers
4. Browser always gets `Cache-Control: no-cache, no-store, must-revalidate` (edge cache is internal only)
5. Edge-stored responses use `Cache-Control: public, max-age=31536000, immutable` (invalidation via KV version bump)

**Cache context**: Wraps all downstream processing in `cacheContextAls.run()` so `withEdgeCache()` calls in API functions read per-request context instead of module-level state.

## Caching Architecture

### L1: In-Memory LRU Cache (`src/lib/smart-cache.ts`)

- Capped at 1000 entries with LRU eviction
- TTL-based expiry per entry
- Persists across warm Worker starts, dies on cold start
- Provides `deleteByPrefix()` and `deleteByPrefixes()` for targeted invalidation

### L2: Cloudflare Cache API + KV Versioning (`src/lib/edge-cache.ts`)

- Uses AsyncLocalStorage for per-request cache context (prevents cross-request state contamination)
- Cache keys include KV version and BUILD_ID: `https://{hostname}/_api-cache/{key}?v={version}&build={BUILD_ID}`
- `stale-while-revalidate=120` and `stale-if-error=300` for resilience
- 500ms timeout on L2 cache operations to prevent hanging
- In-flight request deduplication prevents duplicate API calls when multiple components request the same data simultaneously

### `withEdgeCache(key, fetcher, options)` -- The Main Caching Function

1. Check L1 (in-memory) -- versioned key `{key}:v{kvVersion}`
2. Check in-flight deduplication map
3. Check L2 (Cache API) -- populate L1 from L2 on hit
4. Execute fetcher -- store in both L1 and L2

### Cache Invalidation

When the API triggers `/api/purge-cache` with `Authorization: Bearer PURGE_TOKEN`:
- HTML-affecting or broad prefix purges bump the KV version -- all cache keys change, effectively invalidating everything
- Exact-key purges can delete current-version L2 API keys and exact HTML paths without bumping the KV version
- L1 in-memory cache can be cleared via `clearMemoryCache()` or selectively via `clearL1ByPrefixes()`
- L2 entries with old version keys are never matched

### Cache TTL Constants

| Constant | Seconds | Purpose |
|----------|---------|---------|
| `CACHE_TTL.LONG` | 86400 (24h) | Static data (layout, categories) |
| `CACHE_TTL.MEDIUM` | 3600 (1h) | Semi-dynamic (product listings) |
| `CACHE_TTL.SHORT` | 300 (5m) | Dynamic (CSP settings, checkout config) |

## Page Data Loading

Product detail pages start layout and product reads together, then chain product-scoped widgets from the product promise so widget fetches do not wait for layout. Category pages build product-list options before the first await, then start layout, category, product-list, filter-metadata, and category-widget reads in one promise wave. Search/all-products pages build product-list options first, then start layout, product-list, and search filter metadata together. Entity-scoped widgets may chain from the entity promise because they need the entity id, but unrelated product/list/filter reads must not wait for standalone metadata lookups. Keep `src/lib/page-data-boundaries.test.ts` aligned with this shape until consolidated render-data endpoints replace the separate calls.

## API Client (`src/lib/api/`)

### Architecture

Each API domain has its own module file (e.g., `products.ts`, `categories.ts`, `orders.ts`). Most read paths use generated SDK methods from `@scalius/api-client/sdk` with the configured clients in `client.ts`, so SSR requests can use the runtime API URL, auth token, retry behavior, and service-binding transport where available. Direct `fetch()` helpers remain for proxy routes and flows that need custom request bodies, polling, retries, or raw response handling.

### Typed Envelope Unwrapping (`src/lib/api/unwrap.ts`)

Two helpers centralize the single `as` cast for the API's `{ success: true, data: T }` envelope:

- `unwrapEnvelope<T>(response)` -- Returns `data` if `success === true`, else `null`
- `unwrapData<T>(response)` -- Returns `data` without checking `success` (for cases where caller handles success separately)

### Runtime Environment (`src/lib/api/runtime-env.ts`)

Consolidated accessors for Cloudflare Worker bindings. All delegate to `apiContext.getStore()` (AsyncLocalStorage set per-request by middleware):

- `getRuntimeApiUrl()` -- PUBLIC_API_URL
- `getRuntimeApiBaseUrl()` -- PUBLIC_API_BASE_URL
- `getRuntimeCdnDomain()` -- CDN_DOMAIN_URL
- `getRuntimeApiToken()` -- API_TOKEN
- `getRuntimeStorefrontUrl()` -- STOREFRONT_URL with fallback chain: ALS -> cloudflare:workers env -> import.meta.env -> empty string

### API Module Files

| File | Functions |
|------|-----------|
| `products.ts` | Product catalog, detail, variants |
| `categories.ts` | Category listings, detail |
| `collections.ts` | Homepage collections |
| `orders.ts` | Order creation, status polling |
| `checkout.ts` | Checkout config, gateways |
| `search.ts` | FTS5 search |
| `header.ts` | Header config |
| `footer.ts` | Footer config |
| `navigation.ts` | Navigation menus |
| `pages.ts` | CMS pages |
| `widgets.ts` | Active widgets |
| `discounts.ts` | Discount validation |
| `attributes.ts` | Filterable attributes |
| `shipping.ts` | Shipping methods, locations |
| `settings.ts` | Site settings, SEO |
| `storefront.ts` | Homepage data bundle |
| `customer-auth.ts` | Customer OTP auth API helpers that call the same-origin proxy |
| `abandoned-checkouts.ts` | Abandoned checkout tracking |
| `tracking.ts` | Analytics/tracking config |

## Server-Side Proxy Routes (`src/pages/api/`)

Proxy routes handle operations that require the `API_TOKEN` secret or need to unwrap the API envelope before returning to browser JavaScript.

| Route | Purpose |
|-------|---------|
| `checkout/create-order.ts` | Create order via API (queue-based, with polling) |
| `checkout/stripe-intent.ts` | Create Stripe PaymentIntent |
| `checkout/sslcommerz-session.ts` | Create SSLCommerz session |
| `checkout/polar-session.ts` | Create Polar checkout session |
| `purge-cache.ts` | Cache purge endpoint (KV version bumps, exact L1/L2 key deletes, exact HTML path deletes) |
| `auth/` | Auth proxy routes |
| `customer-auth/` | Same-origin Customer OTP auth proxy; preserves `Set-Cookie` on the storefront domain |
| `products/` | Product data proxy |
| `__ptproxy.ts` | Partytown analytics proxy |
| `facebook-feed.xml.ts` | Facebook product feed |

Checkout proxy endpoints unwrap `.data` before returning to the browser -- the checkout page reads top-level fields.

## Cart (`src/store/cart.ts`)

Client-side cart state using Nano Stores (`nanostores/map`):

- Persisted to `localStorage` under key `cart`
- Cart item keys use `{productId}-{variantId}` for variant products, `{productId}-{size}-{color}` for size/color combos, or just `{productId}` for simple products
- Discount support with auto-clear when cart contents change
- Cross-component communication via `CustomEvent` dispatches (`cart-updated`, `discount-applied`, `discount-removed`)

## Checkout (`src/lib/checkout/`)

Gateway-based payment architecture:

- `registry.ts` -- Gateway handler registry (`registerGateway` / `getGateway`)
- `handlers/cod.ts` -- Cash on delivery
- `handlers/stripe.ts` -- Stripe Elements
- `handlers/sslcommerz.ts` -- SSLCommerz redirect
- `handlers/polar.ts` -- Polar redirect
- `index.ts` -- Checkout page initialization: loads checkout data from `sessionStorage`, renders order summary, renders gateway cards, handles payment processing
- Partial payment support: when enabled, COD is hidden and online gateways show "Pay Advance via {gateway}"

## SEO Features

- **Canonical URLs**: `<link rel="canonical">` on all pages via `Layout.astro` `canonicalUrl` prop
- **Open Graph tags**: Full OG meta tags (og:title, og:description, og:image, og:url, og:site_name, og:type) in `Layout.astro`
- **JSON-LD**: Organization and WebSite structured data on all pages (global), Product structured data on product detail pages with offers, availability, and merchant listing spec compliance
- **Product SEO**: Product pages emit JSON-LD with `@type: Product` including price, availability, SKU, brand, seller, images, and aggregate offer data

## Search

- **FTS5 full-text search**: Product search uses SQLite FTS5 via the API worker
- **Bengali support**: FTS5 tables use `unicode61` tokenizer with `categories 'L* N* Co Mc Mn'` for proper Bengali script tokenization (migration 0031)

## Import Boundaries

The storefront imports ONLY:
- `@scalius/shared` -- Pure utility functions (currency formatting, CORS, etc.)
- `@scalius/api-client` -- Generated SDK types, generated endpoint helpers, and client factory/runtime used through the configured clients in `src/lib/api/client.ts`

It does NOT import:
- `@scalius/core` -- Domain services
- `@scalius/database` -- Schema, client, migrations

All data access goes through the API worker via the configured SDK clients, service binding transport, or explicit HTTP fetch/proxy exceptions. Storefront code should not use the generated singleton client when a request needs runtime env, auth, retry, or service-binding behavior.

## Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `CACHE_CONTROL` | KV | Cache version for L2 invalidation |
| `BACKEND_API` | Service | Service binding to API worker (0ms latency) |
| `ASSETS` | Fetcher | Static asset serving |

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.ts` | Cloudflare Worker entry point |
| `src/middleware.ts` | Cache + API context middleware |
| `src/lib/edge-cache.ts` | L1+L2 caching with ALS, deduplication, KV versioning |
| `src/lib/smart-cache.ts` | In-memory LRU cache (1000 entries max) |
| `src/lib/api/context.ts` | AsyncLocalStorage for per-request Cloudflare bindings |
| `src/lib/api/runtime-env.ts` | Runtime env accessors with fallback chains |
| `src/lib/api/unwrap.ts` | Typed envelope unwrap helpers |
| `src/lib/api/client.ts` | API URL builder and fetch client |
| `src/lib/checkout/index.ts` | Checkout page logic + gateway orchestration |
| `src/store/cart.ts` | Nano Stores cart state (localStorage-persisted) |
| `src/config/build-id.ts` | Build ID for cache key versioning |
