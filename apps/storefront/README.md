# Storefront (`apps/storefront/`)

Astro 7 SSR customer-facing storefront deployed as a Cloudflare Worker. Communicates with the API worker via Cloudflare Service Binding (`env.BACKEND_API`). Imports `@scalius/shared` and `@scalius/api-client` -- does NOT import `@scalius/core` or `@scalius/database` directly.

## Entry Point

Astro generates the Worker entrypoint at `dist/server/entry.mjs` and the deploy-ready Wrangler config at `dist/server/wrangler.json`. The source `wrangler.jsonc` is the adapter input for bindings, vars, and compatibility settings; production deploys must run after `astro build` and use the generated config. The production custom domain is currently managed in Cloudflare outside this source config, so do not add `route`/`routes` unless route ownership moves into IaC.

## Tech Stack

- **Astro 7** -- SSR with `@astrojs/cloudflare` adapter
- **React 19** -- Interactive components (islands architecture)
- **Tailwind CSS 4** -- Styling
- **Nano Stores** -- Client-side state management (cart, toast)
- **Radix UI** -- Accessible UI primitives
- **Lucide React** -- Icons
- **Sonner** -- Toast notifications

## Local Dev Runtime Notes

`astro.config.mjs` treats React, React DOM, and their JSX runtime entrypoints as Vite singleton dependencies. Keep those entries together in `resolve.dedupe`, including `react-dom/server`. If Vite resolves one React copy for `react-dom/server` and another for SSR-rendered islands, local `astro dev` can blank React account/cart shells with invalid-hook errors even when `astro preview` and production builds are healthy. Do not exclude React from the SSR dependency optimizer for this Cloudflare target; the worker-like dev runner still needs Vite to bundle React instead of externalizing it through `require()`.

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
    edge-cache.ts    # Concurrent SSR read coalescing (no retained values)
    canonical-query.ts # Canonical public query-string handling
    public-worker-cache.ts # Native cache eligibility, keys, tags, and TTL
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
    account/orders/[id].astro # Private order detail, timeline, shipment/payment history, and owned payment recovery
  store/             # Global state (cart.ts, toast)
  middleware.ts      # Public/private response policy + API context injection
```

## Middleware (`src/middleware.ts`)

Two middleware functions run in sequence via `sequence()`:

### 1. API Context Middleware (`apiContextMiddleware`)

Injects Cloudflare Worker runtime bindings into AsyncLocalStorage for the request lifecycle. The `apiContext` ALS store (`src/lib/api/context.ts`) carries:

- `BACKEND_API` -- Service binding Fetcher for 0ms-latency internal API calls
- `PUBLIC_API_URL` -- Full API URL for client-side use
- `PUBLIC_API_BASE_URL` -- Base URL for image optimization and auth redirects
- `CDN_DOMAIN_URL` -- CDN domain for image URLs (also set on `globalThis.__SCALIUS_CDN_DOMAIN__` as fallback)
- `STOREFRONT_URL` -- This storefront's URL (sitemaps and catalog feeds)
- `API_TOKEN` -- Token for protected API operations

### 2. Response Policy Middleware (`responsePolicyMiddleware`)

The default Worker entrypoint is an uncached safety gateway. It delegates only
allowlisted anonymous `GET`/`HEAD` requests to the native `PublicStorefront`
entrypoint. The public entrypoint owns canonical cache keys, a one-day edge
safety TTL, and semantic tags. Browser HTML is `no-store`; discovery XML/text is public but
must revalidate. Requests with authorization, cookies, variant-selection
parameters, cart, checkout, account, recovery, or other buyer state stay
private and never reach the shared cache.

Public keys canonicalize safe query strings by sorting parameters, collapsing
search text, and dropping tracking parameters. The request host remains part of
the key, so custom domains and preview hosts do not share rendered responses.

**Generated browser assets**:
- Astro emits generated JS/CSS beneath `/_astro/{BUILD_ID}/...`. Do not flatten
  this back to a shared `/_astro/...` directory: an Astro entry filename can stay
  stable when a referenced client module changes, while Cloudflare correctly
  marks generated assets immutable. The build-scoped path ensures an existing
  browser requests the new code after every source deployment.
- The generated build ID is validated as a path-safe token before Astro config
  uses it. Cloudflare may deduplicate identical file bodies internally; the
  public URL still remains build-scoped.

## Caching Architecture

- `StorefrontGateway` classifies public requests before cache lookup.
- `PublicStorefront` renders eligible responses and attaches `Cache-Tag` plus
  `Cloudflare-CDN-Cache-Control: public, max-age=86400, must-revalidate`.
- The API calls authenticated `POST /api/purge-cache` with bounded domain groups
  after a merchant write. That endpoint awaits the owning entrypoint's native
  tag purge; there is no KV version, prefix scan, warm queue, or abandoned key.
- `withEdgeCache()` only shares an in-flight Promise between identical reads in
  the same isolate. It removes the Promise immediately after settlement and is
  not a persistent cache layer.

### Cache Key Canonicalization

- `src/lib/canonical-query.ts` owns canonical query handling for API read keys.
- `@scalius/shared/storefront-cache-path` owns rendered public-path canonicalization.
- Equivalent filter objects and tracking-decorated URLs map to one key; product
  variant-selection parameters bypass public caching entirely.

### Cache Invalidation

When the API triggers `/api/purge-cache` with `Authorization: Bearer
PURGE_TOKEN`, the storefront validates and deduplicates at most 30 known domain
groups, then awaits `PublicStorefront.purgeGroups()`. Unknown groups are ignored
by the cache owner. `GET` and query-string tokens are rejected. A failed purge
is observable but never rolls back an already committed database mutation; the
one-day TTL is only the final correctness backstop. Normal successful writes purge
their semantic tags immediately.

### Cache TTL Constants

| Constant | Seconds | Purpose |
|----------|---------|---------|
| `STOREFRONT_EDGE_TTL_SECONDS` | 86,400 | Edge residency and last-resort expiry; semantic purges own freshness |
The legacy `CACHE_TTL` names remain as call-site hints while `withEdgeCache()`
is request-only deduplication. Persistent public TTL is centrally fixed in
`public-worker-cache.ts`.

## Page Data Loading

Product detail pages start layout, product, and shipping reads together. Category pages build product-list options before the first await, then start layout, category-products, and filter metadata in one promise wave; `getProductsByCategory()` must use the full category object returned by `/api/v1/categories/{slug}/products` and the page must not issue a second `getCategoryBySlug()` read. Search/all-products pages build product-list options first, then start layout, product-list, and search filter metadata together. CMS page routes use the consolidated render-data endpoint. Keep `src/lib/page-data-boundaries.test.ts` aligned with these boundaries.

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
| `discounts.ts` | Discount validation |
| `attributes.ts` | Filterable attributes |
| `shipping.ts` | Shipping methods, locations |
| `settings.ts` | Site settings, SEO |
| `storefront.ts` | Homepage data bundle |
| `customer-auth.ts` | Customer OTP auth, account order detail, and owned-order payment-session helpers that call the same-origin proxy |
| `abandoned-checkouts.ts` | Abandoned checkout tracking |
| `tracking.ts` | Analytics/tracking config |

### Search Client Rules

- Browser search inputs must normalize semantic whitespace with `normalizeSearchQuery()` before building API URLs or `/search?q=` navigation links. This keeps API KV, storefront L2, and HTML cache keys aligned for equivalent queries.
- Live typeahead/search-palette requests must cancel superseded requests with `AbortController` and ignore stale responses, so slower old searches cannot replace newer results after a user keeps typing or closes the palette.
- Product-only lookup UI should call `/api/v1/products/search` through `getApiV1ProductsSearch()` so it receives product pagination and variants without using the broader global `/api/v1/search` route.

## Server-Side Proxy Routes (`src/pages/api/`)

Proxy routes handle operations that require the `API_TOKEN` secret or need to unwrap the API envelope before returning to browser JavaScript.

| Route | Purpose |
|-------|---------|
| `checkout/create-order.ts` | Create order via API with synchronous D1 checkout-attempt idempotency; normal online checkout creates gateway sessions through gateway-specific proxies after order commit |
| `checkout/stripe-intent.ts` | Create Stripe PaymentIntent |
| `checkout/sslcommerz-session.ts` | Create SSLCommerz session |
| `checkout/polar-session.ts` | Create Polar checkout session |
| `purge-cache.ts` | Authenticated semantic cache-tag purge endpoint for public storefront responses |
| `auth/` | Auth proxy routes |
| `customer-auth/` | Same-origin Customer OTP auth proxy; preserves `Set-Cookie` on the storefront domain |
| `products/` | Product data proxy |
| `ptproxy.ts` | Partytown analytics proxy |
| `product-feed.xml.ts` | Canonical Google/Base product feed. Reuses the shared catalog feed generator with Google availability values (`in_stock`/`out_of_stock`). |
| `facebook-feed.xml.ts` | Shared catalog feed generator plus Facebook/Meta compatibility endpoint. Availability comes from the public product list `availableForSale` SKU projection so feed XML matches product-page structured data and checkout purchasability. Feed links require an absolute storefront URL, honor valid product canonical path overrides, preserve variant query params, and skip rows without a safe absolute `http(s)` primary image or a positive original/effective price after feed precision. Discounted rows emit original `price` plus a strictly lower positive `sale_price`; unsupported zero-price subscription/contract rows are not fabricated. True brand/GTIN data is preserved when provided, and the feed never invents a `Generic` brand. |

Checkout proxy endpoints unwrap `.data` before returning to the browser -- the checkout page reads top-level fields.
`checkout/create-order.ts` must preserve structured `details.itemIssues` from the API; checkout gateway handlers use those issues to return buyers to the cart repair UI instead of collapsing catalog freshness failures into a string-only payment error.

## Cart (`src/store/cart.ts`)

Client-side cart state using Nano Stores (`nanostores/map`):

- Persisted to `localStorage` under key `cart`
- Cart item keys use `{productId}-{variantId}` for option SKUs, `{productId}-{option1}-{option2}` for legacy option rows without a variant ID, or just `{productId}` for simple products.
- Discount support with auto-clear when cart contents change
- Cross-component communication via `CustomEvent` dispatches (`cart-updated`, `discount-applied`, `discount-removed`)
- Cart-to-checkout payment transfer uses `src/lib/checkout/session-state.ts` and must persist/read back `scalius_checkout_data` before leaving `/cart`; blocked or quota-full storage restores the submit button and shows a top-of-cart error instead of redirecting to a broken `/checkout`. The gateway snapshot is optional and checkout falls back to fresh public config if it is missing.
- Checkout repair handoff uses a one-shot `sessionStorage` key (`scalius_cart_repair_state`) written by `/checkout`; `src/lib/cart/client.ts` consumes it, renders line-level issues immediately, then runs the normal backend cart validation as authority. Direct or stale `/checkout` visits show an explicit Return to cart recovery action instead of silently bouncing.
- Quick-buy still uses a short-lived `quickBuyData` storage payload after server-side SKU/cart validation; if that storage write cannot be proven, `/buy/{slug}` redirects to `/cart?quickBuyStorage=blocked` so the cart can render a server-side explanation instead of an empty-cart mystery.

## Checkout (`src/lib/checkout/`)

Gateway-based payment architecture:

- `registry.ts` -- Gateway handler registry (`registerGateway` / `getGateway`)
- `handlers/cod.ts` -- Cash on delivery
- `handlers/stripe.ts` -- Stripe Elements
- `handlers/sslcommerz.ts` -- SSLCommerz redirect
- `handlers/polar.ts` -- Polar redirect
- `index.ts` -- Checkout page initialization: loads checkout data from `sessionStorage`, validates cart freshness on load and before payment, renders order summary, renders gateway cards, handles payment processing, redirects stale cart snapshots back to `/cart?checkoutIssues=1`, and shows an inline recovery state when the cart-to-checkout transfer is missing or unreadable.
- Partial payment support: when enabled, COD is hidden and online gateways show "Pay Advance via {gateway}"
- Payment-session proxies preserve backend `202 processing` responses. Hosted gateways send already-committed orders to receipt recovery without retry loops; Stripe stays on checkout with retryable copy until a real client secret is available. `/order-success` reads fresh checkout config before rendering retry actions: callback-only failed/cancelled returns expose only the current hosted gateway, while durable `payment_issue` states may offer another currently visible hosted gateway such as SSLCommerz <-> Polar. The API is still the authority for whether a gateway switch is allowed.

## Account Order Payments (`src/pages/account/orders/[id].astro`)

The private order-detail page can recover failed or remaining online payments for orders owned by the signed-in customer. It reads the API-provided `paymentRecovery` preview from `GET /api/v1/customer-auth/orders/{id}`, creates sessions through `POST /api/v1/customer-auth/orders/{id}/payment-session`, and sends only an empty JSON body because the API derives gateway, payment type, amount, currency, and proof from the customer session and order state. Stripe mounts a local card form and refreshes the order after confirmation; SSLCommerz and Polar redirect to hosted checkout and return to `/account/orders/{id}` with neutral status query params. If a durable payment-session attempt is still processing, the helper surfaces retryable copy instead of treating the response as a usable session. This account flow must not use receipt tokens, `/order-success`, cart clearing, or checkout purchase-finalization side effects.

## Customer Auth Read Resilience

Browser helpers in `src/lib/api/customer-auth.ts` use bounded same-origin proxy reads/writes and return an explicit `unavailable` state for timeouts, malformed responses, `429`, and `5xx` account/order reads. `/account` and `/account/orders/{id}` must render retryable account/order error states for `unavailable` instead of treating those failures as logged out or empty history. Cart checkout auth-gating may use the readable `cs_auth` cookie only as a hydration hint; submit-time guest-disabled checkout must verify `/api/customer-auth/me`, block with retry copy when that read is unavailable, and open the auth modal only for a real unauthenticated session.

## SEO Features

- **Canonical URLs**: `<link rel="canonical">` on all pages via `Layout.astro` `canonicalUrl` prop. Products, categories, collections, and CMS pages may use a validated same-store `canonicalPath` override; blank values use the normal public route.
- **Open Graph tags**: Full OG meta tags (og:title, og:description, og:image, og:url, og:site_name, og:type) in `Layout.astro`
- **JSON-LD**: OnlineStore and WebSite structured data on all pages when enabled, with schema names sourced only from business company/legal name and optional MerchantReturnPolicy sourced from saved SEO return-policy settings
- **Product SEO**: Product pages emit Product/ProductGroup JSON-LD with price, availability, SKU, safe primary images from the same catalog-discovery media helper used by feeds/UCP, GTINs from variant barcodes, active-method shipping details, aggregate offer data, optional seller identity from business settings, and brand only from explicit product data. Product schema must not fabricate condition, price expiry, placeholder images, or a generic seller.
- **Discovery XML**: Robots, sitemap index/children, and product feeds are dashboard-policy governed. Product-level sitemap/feed exclusions keep the product page public while removing it from matching XML output. Product, category, collection, and CMS page `noindex` controls keep public pages reachable with `noindex,follow`, remove them from sitemap XML, and suppress resource-specific JSON-LD. Valid same-store canonical path overrides become the sitemap `<loc>` for included resources. Sitemap XML stays loc/lastmod-only, the sitemap index must not advertise disabled child sections, and the browser XSL preview mirrors that contract.
- **UCP Catalog**: `/.well-known/ucp` and `/ucp/catalog/*` stay read-only and catalog-only. UCP products are projected from the same feed-ready SKU/image/availability truth as XML feeds; products without safe catalog media are omitted rather than exposing weaker catalog data.

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
| `BACKEND_API` | Service | Service binding to API worker (0ms latency) |
| `ASSETS` | Fetcher | Static asset serving |

## Key Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Source Cloudflare binding/vars/routes config consumed by the Astro adapter |
| `dist/server/wrangler.json` | Generated deploy config produced by `astro build`; deploy this file, not the source config |
| `src/worker.ts` | Uncached gateway and native cached public entrypoint |
| `src/middleware.ts` | Public/private response policy and API context |
| `src/lib/public-worker-cache.ts` | Public eligibility, canonical keys, tags, and TTL |
| `src/lib/edge-cache.ts` | Request-only duplicate-read coalescing |
| `src/lib/canonical-query.ts` | Canonical API query strings |
| `src/lib/api/context.ts` | AsyncLocalStorage for per-request Cloudflare bindings |
| `src/lib/api/runtime-env.ts` | Runtime env accessors with fallback chains |
| `src/lib/api/unwrap.ts` | Typed envelope unwrap helpers |
| `src/lib/api/client.ts` | API URL builder and fetch client |
| `src/lib/checkout/index.ts` | Checkout page logic + gateway orchestration |
| `src/store/cart.ts` | Nano Stores cart state (localStorage-persisted) |
| `src/config/build-id.ts` | Build-scoped generated asset paths |
