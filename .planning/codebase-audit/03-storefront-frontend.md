# Storefront Frontend Audit

## Executive Summary

The Scalius storefront is an Astro 6 SSR application deployed on Cloudflare Workers, using React 19 islands for interactive components and nanostores for cross-framework state. The architecture demonstrates strong Cloudflare-native design: service bindings for zero-latency API calls, a two-layer edge cache (L1 in-memory + L2 Cache API) with KV-based versioning, AsyncLocalStorage for per-request isolation, and a generated SDK client with proper envelope unwrapping. The checkout system uses a well-designed gateway handler registry pattern supporting multiple payment providers. Performance optimizations are pervasive: parallel data fetching, LCP image preloads, Partytown for analytics offloading, CSS containment, and build-time cache busting.

The primary weaknesses are: the cart/checkout page (~800+ lines of mixed Astro/inline JS/form handling) which needs decomposition; significant code duplication between the category and search pages; heavy reliance on `window` globals for cross-component communication instead of a typed event bus; the `any` escape hatch used in several critical paths (cart items, SDK query params, variant data); and an image configuration module that uses `node:fs` which is incompatible with the Cloudflare Workers runtime. There are no critical security vulnerabilities, but the CSP policy includes `'unsafe-inline'` and `'unsafe-eval'` which weaken its protective value.

---

## Ratings

| Dimension | Score | Justification |
|---|---|---|
| **Maintainability** | 6/10 | Well-organized module structure with clear separation (lib/api, lib/checkout, components/product). Product page has excellent decomposition (gallery, summary, details, pricing-engine, variant-state-machine, config). However, cart.astro is a monolithic 800+ line file mixing server-side data fetching, form handling, and massive inline scripts. Category and search pages duplicate ~200 lines of pagination/filter/sort logic. The `window` global pattern for inter-component communication (currency, shipping, cart actions) creates implicit coupling. |
| **Robustness** | 7/10 | Strong error handling throughout: every API call has try/catch, order creation has retry logic with double-ingestion prevention, 202 async polling has timeout caps, discount validation re-checks server-side before order submission, stock is validated against server truth before checkout. The edge cache handles failures gracefully with stale-while-revalidate. Weak points: cart/client.ts exposes `updateCartQuantity` and `removeFromCart` on `window` via `onclick` string attributes, which is fragile; `JSON.parse` of cart items in server.ts has no schema validation; some error paths show console.error but return null instead of propagating. |
| **Code Quality** | 7/10 | Consistent patterns: API modules follow SDK call > unwrapData > withEdgeCache. TypeScript is used throughout with explicit interfaces. Product pricing engine and variant state machine are exemplary -- clean pure functions with comprehensive typing. Currency and image utils properly delegate to shared packages. However, `any` casts appear in critical paths (cart item processing, SDK query params, window globals). The `image-config.ts` file uses `node:fs` which will fail on Cloudflare Workers. Footer component has duplicated social link rendering (mobile and desktop blocks). |
| **Scalability** | 8/10 | The architecture is designed for horizontal scaling: stateless Workers, KV for cache versioning, service bindings for backend communication, Cache API for L2 caching, in-memory LRU for L1. The selective cache purge system is sophisticated -- it supports prefix-based invalidation and cache warming. Parallel data fetching is consistent across all pages. The smart-cache has an LRU eviction cap at 1000 entries. The checkout handler registry pattern cleanly supports adding new payment gateways. |
| **Performance** | 8/10 | Extensive optimizations: two-layer edge caching with request deduplication via inflight Map, LCP image preloading with CDN resize URLs, Partytown for analytics script offloading, CSS containment on gallery/thumbnails, lazy loading for below-fold images, `requestIdleCallback` for gallery preloading, `requestAnimationFrame` for scroll indicators and zoom positioning, debounced filter submission, stale asset auto-reload via BUILD_ID comparison. The inline stylesheet strategy (`inlineStylesheets: "always"`) eliminates render-blocking CSS requests. Minor concern: the category/search pages load CategoryFilters React component with `client:load` (blocks on hydration) rather than `client:idle`. |
| **Feature Readiness** | 7/10 | Multi-gateway checkout is production-ready with Stripe, SSLCommerz, Polar, and COD. Customer OTP auth works across email/phone/WhatsApp. Abandoned checkout tracking with debounced saves. Meta CAPI server-side events with proper PII handling. Dynamic checkout language system with full i18n support. Widget system with CSS scoping. However, the checkout page relies heavily on sessionStorage for cross-page data transfer, the account page renders order HTML via string concatenation, and there is no cart persistence across devices (localStorage only). |

**Overall Score: 7.2/10**

---

## Detailed Findings

### Strengths

**1. Cloudflare-Native Architecture**
The application is purpose-built for Cloudflare Workers. The `apiContext` AsyncLocalStorage pattern (`src/lib/api/context.ts`) isolates per-request state (API URLs, tokens, KV bindings) cleanly, solving the shared-module-state problem inherent to Workers' isolate model. The `fetchWithRetry` function in `client.ts` intelligently routes through service bindings in production (zero network hop to the API) while falling back to HTTP in development. The `runtime-env.ts` has a well-designed 3-level fallback chain for STOREFRONT_URL (ALS > cloudflare:workers module env > import.meta.env).

**2. Two-Layer Edge Cache**
`src/lib/edge-cache.ts` implements a sophisticated caching strategy:
- L1: In-memory LRU cache (`smart-cache.ts`) with TTL and 1000-entry cap
- L2: Cloudflare Cache API with KV-based version keys for instant invalidation
- Request deduplication via an inflight Map (prevents thundering herd)
- BUILD_ID in cache keys for zero-stale-data across deployments
- Selective purge via POST `/api/purge-cache` with prefix-based L1 clearing and background cache warming via `waitUntil`

**3. Product Page Component Architecture**
The product page is the best-structured section of the codebase:
- `ProductGallery.astro`: Desktop zoom (React island) + mobile pinch-to-zoom (vanilla JS), thumbnail scroll indicators with RAF-throttled layout reads
- `ProductSummary.astro`: Clean props interface, server-rendered pricing with variant data serialized as JSON script tag
- `ProductDetails.astro`: Tabbed interface with keyboard support and scroll indicators
- `lib/pricing-engine.ts`: Pure functions for all price calculations -- variant pricing priority rules are clearly documented and correctly implemented
- `lib/variant-state-machine.ts`: Proper state machine pattern with indexed lookups (Map-based for O(1) variant resolution), stock-aware availability, and validation
- `config.ts`: Centralized UI configuration constants

**4. Checkout Handler Registry**
`src/lib/checkout/registry.ts` + handler files implement a clean extensibility pattern:
- Each gateway (Stripe, SSLCommerz, Polar, COD) is a self-contained module implementing `GatewayHandler`
- The registry maps gateway IDs to handlers
- `create-order.ts` provides shared order creation logic through the same-origin proxy
- Server-side API endpoints (`pages/api/checkout/*`) properly proxy requests with envelope unwrapping

**5. Security Posture**
- Customer auth proxy (`pages/api/customer-auth/[...path].ts`) correctly strips Domain from Set-Cookie headers and downgrades SameSite=None to SameSite=Lax for same-origin context
- Path traversal protection: `subpath.includes("..") || !/^[a-zA-Z0-9\-\/]*$/.test(subpath)`
- API token never exposed to client -- all authenticated requests go through server-side proxies
- Partytown proxy (`__ptproxy.ts`) has an explicit allowlist of hostnames
- Cache purge requires a PURGE_TOKEN check
- CSP headers are dynamically constructed with domain-specific configuration fetched from the API

**6. Analytics Integration**
- Meta Pixel + CAPI dual tracking with proper deduplication (eventID)
- GA4 events via dataLayer pushes
- PII handling: phone/email/name captured in sessionStorage for CAPI, then hashed server-side
- Analytics scripts offloaded to Partytown web worker for main thread performance
- `trackCategoryView` in categories page uses a `viewContentTracked` data attribute to prevent duplicate firing

### Weaknesses

**1. Cart/Checkout Page Monolith** (Maintainability: High Impact)
`src/pages/cart.astro` is the largest and most complex file in the storefront. It combines:
- Server-side data fetching (5 parallel API calls)
- COD form POST handling with full order processing
- Massive inline `<script>` blocks for client-side cart management
- Analytics tracking setup
- Discount application UI logic
- Abandoned checkout tracking initialization

The actual cart logic lives in `src/lib/cart/client.ts` and `src/lib/cart/server.ts`, which is good, but the page itself still orchestrates too much. The `renderCartItems()` function in `client.ts` generates HTML via template literals (~20 lines of interpolated HTML per item) -- this is fragile and loses type safety.

Files: `apps/storefront/src/pages/cart.astro`, `apps/storefront/src/lib/cart/client.ts`

**2. Category/Search Page Duplication** (Maintainability: Medium Impact)
`src/pages/categories/[slug].astro` and `src/pages/search/index.astro` share nearly identical code:
- `generatePaginationLinks()` function (identical implementation)
- Sort select with the same options and change handler
- Mobile filter toggle/close logic
- Product grid layout
- Active filter count calculation

Both pages should extract shared logic into components or utility modules.

Files: `apps/storefront/src/pages/categories/[slug].astro`, `apps/storefront/src/pages/search/index.astro`

**3. Window Global Coupling** (Code Quality: Medium Impact)
The codebase uses `window` globals extensively for cross-component communication:
- `window.__CURRENCY_SYMBOL__`, `window.__CURRENCY_CODE__`, `window.__CURRENCY_DECIMALS__` -- injected by Layout.astro inline script
- `window.__API_BASE_URL__`, `window.__CDN_DOMAIN__` -- runtime config
- `window.lastShippingEventDetail` -- shipping selection state
- `window.updateCartQuantity`, `window.removeFromCart` -- cart actions exposed as global functions
- `window.handleAbandonedCheckout` -- checkout tracking

This creates implicit dependencies that are invisible to TypeScript (partially mitigated by `env.d.ts` declarations) and makes refactoring risky. A typed event bus or context provider pattern would be more maintainable.

Files: `apps/storefront/src/env.d.ts`, `apps/storefront/src/lib/cart/client.ts`, `apps/storefront/src/layouts/Layout.astro`

**4. `any` Usage in Critical Paths** (Code Quality: Medium Impact)
- `lib/cart/server.ts` line 54: `const cartItemsArray = Object.values(cartItems) as any[]` -- cart items from form data are not validated against a schema before processing. Price manipulation on unvalidated input is a data integrity risk (mitigated by server-side re-fetch of product data).
- `lib/api/discounts.ts` line 47: `query: queryParams as any` -- SDK type mismatch bypassed
- `lib/api/types.ts`: `ProductListOptions` has `[key: string]: any` index signature, making typos in filter keys undetectable
- `lib/cart/client.ts` line 36: `CheckoutFormData` interface has `[key: string]: FormDataEntryValue | ...` which weakens type safety

**5. `image-config.ts` Uses node:fs** (Robustness: High Impact)
`src/lib/image-config.ts` imports `readFileSync` from `node:fs` and `resolve` from `node:path`. These Node.js built-ins are not available in the Cloudflare Workers runtime. If this module is imported during SSR, it will throw. Currently it appears to be used only at build time (for Astro config), but the import is unconditional and the module has no runtime guard.

File: `apps/storefront/src/lib/image-config.ts`

**6. Account Page String HTML Rendering** (Maintainability/Security: Medium Impact)
`src/pages/account.astro` renders order details via a `renderOrder()` function that builds HTML strings with template literals. This bypasses Astro's XSS protections. While the data comes from the API (not user input), if any field (e.g., customer notes, product names) contains HTML, it will be rendered unescaped.

File: `apps/storefront/src/pages/account.astro`

### Critical Issues

**1. CSP Includes `'unsafe-eval'` and `'unsafe-inline'`**
The CSP handler at `src/lib/middleware-helper/csp-handler.ts` includes both `'unsafe-inline'` and `'unsafe-eval'` in the script-src directive. While `'unsafe-inline'` is practically required by Astro's inline script handling, `'unsafe-eval'` is concerning. The Partytown configuration at `src/lib/partytown-config.ts` uses `new Function()` (line 16-34) to create the resolveUrl handler, which requires `'unsafe-eval'`. This should be refactored to a standard function to allow removing `'unsafe-eval'` from the CSP.

Files: `apps/storefront/src/lib/middleware-helper/csp-handler.ts`, `apps/storefront/src/lib/partytown-config.ts`

**2. Shortcode Processing is Sequential**
`src/lib/shortcodes.ts` processes shortcodes sequentially in a `for` loop (line 93-105). Each shortcode triggers an API call (`getWidgetById` or `getProductBySlug`). For pages with multiple shortcodes, this creates a waterfall of API calls. These should be parallelized with `Promise.all`.

File: `apps/storefront/src/lib/shortcodes.ts`

**3. `parseAdditionalDomains` Called Multiple Times Per Request**
In `csp-handler.ts`, `parseAdditionalDomains(env)` is called separately by each CSP directive generator (getScriptSrcDirectives, getConnectSrcDirectives, getFrameSrcDirectives, getImgSrcDirectives, getWorkerSrcDirectives). While `withEdgeCache` handles L2 caching, the function is still invoked 5 times per response for CSP construction. The result should be computed once and passed to all directive builders.

File: `apps/storefront/src/lib/middleware-helper/csp-handler.ts`

### File-by-File Notes

#### Configuration
| File | Notes |
|---|---|
| `astro.config.mjs` | Clean config. `inlineStylesheets: "always"` is a good choice for Workers. `prefetchAll: true` may cause excessive prefetching on pages with many links. |
| `wrangler.jsonc` | Properly configured with service binding, KV namespace, and env vars. |
| `worker.ts` | Minimal 3-line entry point -- correct pattern. |
| `env.d.ts` | Comprehensive type declarations for Cloudflare env, Window globals, and App.Locals. |

#### Middleware & Caching
| File | Notes |
|---|---|
| `middleware.ts` | Two middleware composed in sequence. Cache middleware correctly skips cart/checkout/API routes. Strips tracking params (utm, fbclid, etc.) from cache keys. |
| `lib/edge-cache.ts` | Excellent implementation. Inflight dedup, two-layer cache, KV version keys. The `cacheContextAls` pattern correctly isolates cache state per request. |
| `lib/smart-cache.ts` | Clean LRU with 1000 entry cap. `deleteByPrefix`/`deleteByPrefixes` enable selective invalidation. |

#### API Layer
| File | Notes |
|---|---|
| `lib/api/client.ts` | Well-designed lazy URL resolution. JWT refresh with 5-minute pre-expiry buffer and dedup via `refreshPromise`. Service binding routing in production. |
| `lib/api/context.ts` | AsyncLocalStorage pattern with client-side stub -- correct for SSR+client code. |
| `lib/api/runtime-env.ts` | 3-level fallback for STOREFRONT_URL is well-documented and handles sitemap routes that run outside ALS. |
| `lib/api/unwrap.ts` | Two unwrap helpers: `unwrapEnvelope` (checks success) and `unwrapData` (just reads .data). Simple and correct. |
| `lib/api/types.ts` | Local domain types are well-defined. `ProductListOptions` has `[key: string]: any` -- should use a discriminated union or specific filter types. |
| `lib/api/orders.ts` | 202 polling with 30 attempts x 1.5s = 45s max wait. `retries: 0` prevents double ingestion. Good error handling. |
| `lib/api/discounts.ts` | `queryParams as any` cast bypasses SDK type safety. |
| `lib/api/products.ts` | All functions wrapped with `withEdgeCache`. `getProductVariants` has SDK-then-fallback pattern. |

#### Cart & Checkout
| File | Notes |
|---|---|
| `store/cart.ts` | Nanostores with localStorage persistence. SSR-safe initialization. Cart item key generation supports variants. |
| `lib/cart/server.ts` | Server-side order processing with price re-validation against product data, stock checks, discount re-validation. Parallel product fetches. |
| `lib/cart/client.ts` | HTML generation via template literals is fragile. `processQuickBuy()` reads from sessionStorage and clears immediately -- good pattern to prevent re-add on refresh. |
| `lib/checkout/registry.ts` | Clean registry pattern for gateway handlers. |
| `lib/checkout/create-order.ts` | Shared order creation via same-origin proxy. |
| `lib/checkout/handlers/*.ts` | Each handler is self-contained. SSLCommerz/Polar handlers follow identical structure. Stripe handler dynamically loads stripe.js. |

#### Pages
| File | Notes |
|---|---|
| `pages/index.astro` | Parallel layout+homepage fetch via `loadPageWithLayout`. Widget placement logic is clean. |
| `pages/products/[slug].astro` | Excellent: parallel fetch, LCP preload, CDN image URL construction, deferred analytics, variant data serialized as JSON. |
| `pages/cart.astro` | Needs decomposition -- too much responsibility in one file. |
| `pages/checkout.astro` | Payment selection page. JS-heavy (payment cards populated by JS). Stripe card element mounting. |
| `pages/categories/[slug].astro` | Duplicates search page logic. Pagination, sort, filter toggle should be extracted. |
| `pages/search/index.astro` | Near-identical to categories page. |
| `pages/account.astro` | HTML rendering via string concatenation. Should use Astro components or React islands. |
| `pages/order-success.astro` | Clean. Parallel fetch, FB Purchase tracking, print styles. |
| `pages/[slug].astro` | CMS pages. Good slug validation (rejects file extensions, invalid paths). Shortcode processing is sequential (see Critical Issues). |

#### Components
| File | Notes |
|---|---|
| `components/product/ProductGallery.astro` | Excellent: CDN-optimized image URLs, scroll indicators with RAF, image preloading with connection-aware strategy, pinch-to-zoom mobile modal, CSS containment. |
| `components/product/ProductSummary.astro` | Clean props interface. Variant data serialized as JSON in a script tag. |
| `components/product/ProductImageZoom.tsx` | React island. Direct DOM manipulation for instant image switching (bypasses React reconciliation for performance). Global image cache with Map. |
| `components/product/lib/pricing-engine.ts` | Exemplary: pure functions, clear documentation, comprehensive type safety. |
| `components/product/lib/variant-state-machine.ts` | Proper state machine. `createVariantIndex` builds O(1) lookup maps. Reducer pattern for state transitions. |
| `components/CartFlyout.tsx` | Sheet-based with swipe-to-dismiss and auto-close timer. Good UX. |
| `components/AuthModal.tsx` | Multi-step flow (method_select > input > otp > profile_setup > authenticated). Country filtering. Deferred config fetch. |
| `components/search/CommandPalette.tsx` | Cmd+K shortcut, debounced search, keyboard navigation. Portal-based rendering. |
| `components/CategoryFilters.tsx` | Well-documented with extensive comments. Price state management handles the tricky "preserve price across filter changes" case. Desktop auto-submit + mobile manual apply. |
| `components/LocationSelector.tsx` | Cascading dropdowns (city > zone > area). Custom events for cross-component communication. |
| `components/ShippingLocationSelector.tsx` | RadioGroup with fee display. Sets `window.lastShippingEventDetail` directly to eliminate race condition. |
| `components/cards/ProductCard.astro` | Clean. Uses shared pricing engine and image optimizer. |
| `components/header/header.astro` | Event delegation for clicks. Cart count animation with scale bounce. Menu toggle with overlay. |
| `components/Footer.astro` | Recursive menu rendering. Social link optimization via CDN. Duplicated social links for mobile vs desktop layout. |

#### Utilities
| File | Notes |
|---|---|
| `lib/utils.ts` | Only contains `debounce`. `cn()` correctly migrated to @scalius/shared. |
| `lib/currency.ts` | Pure re-export from @scalius/shared. |
| `lib/image-optimizer.ts` | Wraps shared image optimizer with storefront-specific CDN context. |
| `lib/image-config.ts` | **Uses node:fs** -- incompatible with Cloudflare Workers runtime. |
| `lib/shortcodes.ts` | Sequential processing -- should parallelize API calls. |
| `lib/page-data.ts` | `loadPageWithLayout` -- simple parallel fetch utility. |
| `lib/sitemap-utils.ts` | Clean XML generation with proper escaping and XSL stylesheet support. |
| `lib/partytown-config.ts` | Uses `new Function()` which requires `'unsafe-eval'` in CSP. |
| `lib/analytics.ts` | Comprehensive FB Pixel + GA4 + CAPI tracking. |
| `lib/media-url.ts` | 3-level CDN URL fallback. |
| `lib/tracking/meta-capi.ts` | CAPI dispatcher with proper user data collection from cookies and sessionStorage. |
| `lib/middleware-helper/csp-handler.ts` | Dynamic CSP with API-fetched domains. `parseAdditionalDomains` called 5x per request. |

#### API Endpoints
| File | Notes |
|---|---|
| `pages/api/checkout/create-order.ts` | Clean proxy. Proper error handling. |
| `pages/api/checkout/stripe-intent.ts` | Unwraps `{ success, data }` envelope correctly. |
| `pages/api/checkout/polar-session.ts` | Good logging. Unwraps envelope. |
| `pages/api/checkout/sslcommerz-session.ts` | Follows same pattern as polar-session. |
| `pages/api/customer-auth/[...path].ts` | Excellent security: path traversal check, allowlisted methods, cookie rewriting, service binding routing. |
| `pages/api/purge-cache.ts` | Selective purge with prefix-based L1 clearing, KV version bumping, and background cache warming. Both GET (full purge) and POST (selective purge) supported. |
| `pages/api/__ptproxy.ts` | Hostname allowlist for proxied scripts. 10s timeout. Cache-Control headers. |

---

## Recommendations

### High Priority

1. **Decompose cart.astro** -- Extract the checkout form into a dedicated `CheckoutForm.astro` component. Move inline script blocks into separate `.ts` modules. Convert the HTML template literal rendering in `cart/client.ts` to either an Astro component or a React island.

2. **Fix image-config.ts runtime incompatibility** -- Guard the `node:fs` import behind a build-time-only check, or restructure so this module is only imported by `astro.config.mjs` (which runs in Node.js) and never by SSR code.

3. **Remove `'unsafe-eval'` from CSP** -- Refactor `partytown-config.ts` to use a standard function instead of `new Function()`. This is the only reason `'unsafe-eval'` is in the CSP.

4. **Parallelize shortcode processing** -- Replace the sequential `for` loop in `processShortcodes()` with `Promise.all` to resolve all widget/product shortcodes concurrently.

### Medium Priority

5. **Extract shared category/search logic** -- Create a shared `ProductListingLayout` component or utility that handles pagination, sort, and filter UI. Both `categories/[slug].astro` and `search/index.astro` should use it.

6. **Replace window globals with typed event bus** -- Create a `src/lib/event-bus.ts` module with typed CustomEvent wrappers for cart actions, shipping selection, and currency config. This makes dependencies explicit and enables IDE support.

7. **Add Zod validation for cart items on server** -- In `lib/cart/server.ts`, validate the parsed `cartItemsJson` against a Zod schema before processing. This prevents malformed data from reaching the price calculation logic.

8. **Compute CSP domains once per request** -- Call `parseAdditionalDomains()` once in `setPageCspHeader()` and pass the result to all directive builders instead of calling it 5 times.

### Low Priority

9. **Migrate account page rendering** -- Replace the `renderOrder()` string concatenation in `account.astro` with proper Astro components or a React island to get XSS protection and type safety.

10. **Change CategoryFilters hydration** -- Switch from `client:load` to `client:idle` on the CategoryFilters component in category pages. The filters are in the sidebar and not immediately interactive on page load.

11. **Evaluate `prefetchAll: true`** -- On pages with many product links (category pages with 20+ products), this triggers prefetch requests for every product URL. Consider switching to `prefetchAll: false` with explicit `data-astro-prefetch` on high-value links.

12. **Consolidate Footer social link rendering** -- The mobile and desktop social link blocks in `Footer.astro` are nearly identical. Extract a `SocialLinks.astro` component to eliminate the duplication.
