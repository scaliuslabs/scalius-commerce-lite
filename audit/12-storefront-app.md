# Storefront App Audit

## Scope

Audited `apps/storefront/**` end to end, with targeted validation of API-side Hono contracts only where storefront behavior depends on them. Focus areas:

- SSR request lifecycle, runtime env access, and Cloudflare Worker/service-binding usage
- L1/L2 caching, cache invalidation, and stale-content behavior
- Product/category/page/search/cart/checkout/account/order-success flows
- Checkout proxy endpoints, response envelope unwrapping, and auth/logout plumbing
- SEO/sitemaps/structured data and customer-visible drift
- Security, privacy, business logic conflicts, maintainability, and performance

Referenced guidance:

- `workers-best-practices` for per-request runtime state, caching, and secret handling
- `hono-cf` for Hono/OpenAPI envelope semantics and service-binding contract assumptions

Validation run:

- `pnpm --filter @scalius/storefront typecheck` completed with `0 errors`, `0 warnings`, and only Astro hints

## End-to-End Storefront Flow Map

1. Request entry and runtime wiring

- `apps/storefront/src/middleware.ts:131-149` sets per-request cache context, including Cache API handle, KV cache version, hostname, and `waitUntil`.
- `apps/storefront/src/middleware.ts:275-301` sets API/runtime context for downstream SSR calls: `BACKEND_API`, API URLs, `API_TOKEN`, CDN domain, and `STOREFRONT_URL`.
- `apps/storefront/src/middleware.ts:151-270` applies HTML edge caching, browser-facing `no-store` on `/cart` and `/checkout`, and page CSP headers.

2. Storefront data fetching

- Public SSR/data calls go through `apps/storefront/src/lib/api/client.ts:31-45`, `132-184`, and `226-259`.
- In production SSR, those calls try to use `BACKEND_API.fetch(...)` service binding instead of public HTTP when context is available.
- Public content fetchers wrap most reads in `withEdgeCache(...)`, especially products, categories, pages, layout, and listing endpoints.

3. Browsing flows

- Product page: `apps/storefront/src/pages/products/[slug].astro:18-24` loads layout + product payload.
- Category page: `apps/storefront/src/pages/categories/[slug].astro:44-76` loads layout + category + listing + filterable attributes.
- CMS page: `apps/storefront/src/pages/[slug].astro:53-62` loads layout + page content, then processes shortcodes via `apps/storefront/src/lib/shortcodes.ts:88-113`.
- Search UI uses command-palette and search page fetches from API search endpoints.

4. Cart and checkout

- Cart is client-managed, totals and discounts are assembled in `apps/storefront/src/lib/cart/client.ts`.
- COD-only orders submit the cart form directly to `apps/storefront/src/pages/cart.astro:92-125`.
- Multi-gateway flow intercepts cart submit in `apps/storefront/src/pages/cart.astro:626-693`, serializes form/cart state into `sessionStorage`, then redirects to `/checkout`.
- `/checkout` rebuilds totals from session state in `apps/storefront/src/lib/checkout/index.ts:51-113` and triggers gateway handlers.
- Stripe flow creates the order first, then initializes payment in `apps/storefront/src/lib/checkout/handlers/stripe.ts:100-137`.
- SSLCommerz flow creates the order first, then initializes payment in `apps/storefront/src/lib/checkout/handlers/sslcommerz.ts:18-47`.
- Polar flow creates the order first, then initializes payment in `apps/storefront/src/lib/checkout/handlers/polar.ts:18-46`.
- Gateway setup routes proxy through same-origin Astro endpoints under `apps/storefront/src/pages/api/checkout/*.ts`.

5. Customer auth and post-purchase flow

- Customer auth proxies live under `apps/storefront/src/pages/api/customer-auth/[...path].ts`.
- Logout is handled by `apps/storefront/src/pages/api/auth/logout.ts`.
- Order success page fetches full order details in SSR via `apps/storefront/src/pages/order-success.astro:18-38`.

6. SEO and feeds

- Canonicals and JSON-LD are generated on product/category/page routes.
- Sitemaps are emitted from `apps/storefront/src/pages/sitemap*.ts`.
- Facebook feed is emitted from `apps/storefront/src/pages/api/facebook-feed.xml.ts`.

## Findings

### 1. Critical: public `order-success` page exposes full order details through a privileged service-auth lookup

Why it matters:

- `order-success` accepts any `orderId` query parameter and performs a server-side authenticated lookup using the storefront's API token/JWT flow.
- The backing API route is protected from public callers, but the storefront page effectively turns it into a public reader.
- That leaks customer PII and order contents to anyone who obtains or guesses a valid order ID.

Evidence:

- `apps/storefront/src/pages/order-success.astro:8-38`
- `apps/storefront/src/lib/api/orders.ts:107-123`
- `apps/storefront/src/lib/api/client.ts:82-103`
- `apps/storefront/src/lib/api/client.ts:141-178`
- `apps/api/src/app.ts:257-265`
- `apps/api/src/routes/orders.ts:43-135`

Impact:

- Names, phone numbers, email, address, order items, delivery metadata, and status become retrievable from a shareable URL.

Recommended fix:

- Stop using privileged `GET /orders/{id}` for the public success page.
- Replace it with an unguessable, checkout-scoped token or signed receipt token and a minimal public success payload.
- Treat `order-success` as a confirmation view, not a privileged order reader.

### 2. Critical: guest-checkout disablement is only enforced in browser code, while privileged checkout proxies still accept anonymous requests

Why it matters:

- The cart page checks `guestCheckoutEnabled` only in client JS and treats `cs_auth=1` as the login signal.
- A browser can forge that cookie or bypass the page entirely and POST to the same-origin checkout proxy endpoints.
- Those proxy routes still spend the storefront's server-side API token to create orders and initialize payment.

Evidence:

- `apps/storefront/src/pages/cart.astro:595-631`
- `apps/storefront/src/pages/api/checkout/create-order.ts:8-27`
- `apps/storefront/src/lib/checkout/create-order.ts:23-63`
- `apps/storefront/src/lib/checkout/handlers/stripe.ts:100-116`
- `apps/storefront/src/lib/checkout/handlers/sslcommerz.ts:18-35`
- `apps/storefront/src/lib/checkout/handlers/polar.ts:18-34`
- `apps/api/src/routes/orders.ts:210-344`

Impact:

- If merchant policy says guest checkout is disabled, storefront enforcement can still be bypassed from DevTools, scripted requests, or direct POSTs.

Recommended fix:

- Enforce guest-checkout policy on the server-side create-order path before spending API credentials.
- Base auth checks on the real customer session, not `cs_auth=1`.
- Apply the same guard consistently across COD and online-payment flows.

### 3. Critical: discount data is dropped or malformed when cart hands off to multi-gateway checkout

Why it matters:

- Cart stores discount data as a JSON blob in `discountCodeHidden`.
- The checkout page recalculates totals from a flat `discountAmount` field that is never populated by the cart redirect.
- Order creation sends `discountAmount` from that missing flat field while forwarding the JSON blob as `discountCode`.

Evidence:

- `apps/storefront/src/lib/cart/client.ts:275-299`
- `apps/storefront/src/pages/cart.astro:658-693`
- `apps/storefront/src/lib/checkout/index.ts:83-86`
- `apps/storefront/src/lib/checkout/index.ts:260-263`
- `apps/storefront/src/lib/checkout/create-order.ts:36-40`

Impact:

- Discounted online-payment checkouts can display the wrong total, send an unusable discount code payload, or create mismatch between cart summary and backend order math.

Recommended fix:

- Normalize checkout handoff into one canonical shape, for example `discount: { code, amount, type, id }`.
- Rebuild totals from that canonical object in `/checkout`.
- Send the backend the actual discount code and amount fields it expects, not a serialized hidden-input blob.

### 4. High: edge cache L1 keying and in-flight dedupe are not fully scoped by hostname or purge version

Why it matters:

- L2 cache keys are hostname-aware, but the in-memory L1 key and in-flight dedupe key are not.
- In a multi-host or preview/custom-domain scenario, one isolate can reuse wrong/stale data across hostnames.
- In-flight dedupe also ignores the version suffix, so a purge/version bump can still share an older request promise.

Evidence:

- `apps/storefront/src/lib/edge-cache.ts:202-208`
- `apps/storefront/src/lib/edge-cache.ts:216-254`
- `apps/storefront/src/middleware.ts:142-147`

Impact:

- Cross-host cache bleed, stale data after purge boundaries, and wrong content under shared isolates.

Recommended fix:

- Include hostname and cache version in both L1 keys and `inflight` keys.
- Keep cache identity symmetric across L1, L2, and request dedupe layers.

### 5. High: logout proxy does not reliably clear the real session cookie shape used by the backend

Why it matters:

- The storefront logout proxy always clears host-only cookies locally and ignores backend `Set-Cookie` headers.
- The backend logout route issues both base clears and domain-scoped clears when `STOREFRONT_URL` requires them.
- If the active session cookie was set with a `Domain` attribute, the storefront proxy can leave a valid HttpOnly session cookie behind.

Evidence:

- `apps/storefront/src/pages/api/auth/logout.ts:16-21`
- `apps/storefront/src/pages/api/auth/logout.ts:46-69`
- `apps/api/src/routes/customer-auth.ts:272-283`

Impact:

- Logout can appear successful in UI while the real authenticated session remains active.

Recommended fix:

- Forward backend `Set-Cookie` headers through the proxy, or centralize logout cookie clearing in one place with identical cookie config.
- Add regression coverage for host-only and domain-scoped storefront deployments.

### 6. High: CSP allowlist loader parses the wrong response shape, so merchant-configured CSP domains never apply

Why it matters:

- Storefront fetches `/api/v1/storefront/csp` and reads it as `{ cspAllowedDomains }`.
- The Hono route returns the standard success envelope `{ success: true, data: { cspAllowedDomains } }`.
- The storefront caches the empty sentinel on failure or unwrap mismatch, so broken CSP config can persist across requests.

Evidence:

- `apps/storefront/src/lib/middleware-helper/csp-handler.ts:29-59`
- `apps/api/src/routes/storefront.ts:80-109`

Impact:

- Merchant-added analytics, widgets, payment embeds, or third-party origins can silently fail site-wide even though configuration exists in admin/API.

Recommended fix:

- Unwrap the response envelope correctly before reading `cspAllowedDomains`.
- Cache only successful parses, or store a distinct failure sentinel with short TTL and observability.

### 7. High: canonical content routes turn upstream/storefront fetch failures into false 404s or false empty states

Why it matters:

- Product, category, and CMS page fetchers return `null` on both genuine not-found and transient API/service-binding errors.
- Route files then convert `null` straight to `404`.
- Category/product listing paths can also degrade to an empty successful payload instead of surfacing an error state.

Evidence:

- `apps/storefront/src/lib/api/products.ts:47-60`
- `apps/storefront/src/pages/products/[slug].astro:18-24`
- `apps/storefront/src/lib/api/categories.ts:49-62`
- `apps/storefront/src/pages/categories/[slug].astro:44-52`
- `apps/storefront/src/lib/api/products.ts:156-179`
- `apps/storefront/src/lib/api/products.ts:210-223`
- `apps/storefront/src/lib/api/pages.ts:26-39`
- `apps/storefront/src/pages/[slug].astro:55-62`

Impact:

- Temporary backend incidents become search-engine-visible 404s on canonical URLs.
- Listing failures look like “no products found,” which is customer-visible drift and easy to misdiagnose.

Recommended fix:

- Distinguish `404/not_found` from transport/runtime failure in fetchers.
- Serve `500` or a recoverable SSR error state on transient failures.
- Avoid caching synthetic empty results that originate from contract or transport errors.

### 8. Medium: async order timeout path can lead to duplicate orders when customers retry

Why it matters:

- Gateway handlers create the order before payment session creation.
- The storefront polls order status for a while, then surfaces a timeout error if completion is slow.
- The UI resets and allows retry, but the first create-order call may still complete afterward.

Evidence:

- `apps/storefront/src/lib/api/orders.ts:53-86`
- `apps/storefront/src/lib/checkout/handlers/stripe.ts:100-137`
- `apps/storefront/src/lib/checkout/handlers/sslcommerz.ts:18-47`
- `apps/storefront/src/lib/checkout/handlers/polar.ts:18-46`
- `apps/storefront/src/lib/checkout/index.ts:277-300`

Impact:

- Duplicate orders, double inventory holds, and customer confusion under slow queue/payment initialization paths.

Recommended fix:

- Persist checkout attempt identity client-side and make retries resumable/idempotent.
- If an order is already created for a checkout session, resume payment initialization instead of creating another order.

### 9. Medium: the cart page is advertised in the static sitemap and is not explicitly marked `noindex`

Why it matters:

- `/cart` is session-specific, thin utility UX, and not a target for search discovery.
- It is currently included in the static sitemap.

Evidence:

- `apps/storefront/src/pages/sitemap-static.xml.ts:17-32`
- `apps/storefront/src/pages/cart.astro:133-145`

Impact:

- Low-value URL indexing and crawl budget waste.

Recommended fix:

- Remove `/cart` from sitemap output.
- Add `noindex,nofollow` on cart if business wants it hidden from search entirely.

### 10. Medium: product JSON-LD always advertises `InStock` regardless of actual inventory state

Why it matters:

- Structured data should reflect real stock state; otherwise search engines receive inaccurate offer metadata.

Evidence:

- `apps/storefront/src/pages/products/[slug].astro:102-110`

Impact:

- SEO trust and merchant listing quality risk.

Recommended fix:

- Drive JSON-LD availability from actual product/variant stock state and choose the correct schema URL.

## Cache, Runtime, SEO, and Checkout Notes

What is working well:

- `apps/storefront/src/middleware.ts:131-149` uses per-request context rather than module-level mutable cache state for most cache/runtime reads.
- `apps/storefront/src/middleware.ts:241-270` correctly forces browser `no-store` on `/cart` and `/checkout`, which is the right default for payment-sensitive HTML.
- `apps/storefront/src/lib/api/client.ts:157-178` uses service bindings during SSR when available, which is the right performance model for Worker-to-Worker calls.
- Secrets are generally consumed from runtime env/context rather than baked `import.meta.env`, which is the safer pattern for Workers.

Remaining runtime concerns:

- `apps/storefront/src/lib/media-url.ts:22-31` falls back to global `__SCALIUS_CDN_DOMAIN__`, and `apps/storefront/src/middleware.ts:285-290` mutates that global per request. That is safer than build-time secret baking, but it is still shared-isolate mutable state and can drift under concurrency.
- `apps/storefront/src/lib/api/runtime-env.ts:28-35` and `68-70` have no fallback chain for API URL/token the way `STOREFRONT_URL` does. If AsyncLocalStorage context is absent on a route that still needs API access, the failure mode is abrupt rather than explicit.

Customer-visible drift risks:

- Error-to-404 flattening on canonical pages
- Empty-list fallbacks on category/search/product-list errors
- Discount/total drift across the cart-to-checkout transition
- Logout success UI without guaranteed cookie invalidation

## Prioritized Follow-Ups

1. Replace public `order-success?orderId=` reads with a receipt token or checkout-scoped public confirmation endpoint.
2. Enforce guest-checkout policy server-side on create-order and payment-init proxy paths; stop trusting `cs_auth=1`.
3. Redesign cart-to-checkout serialization so discount, shipping, and totals share one canonical schema.
4. Fix cache key symmetry across L1, L2, and in-flight dedupe using hostname + version everywhere.
5. Forward backend logout cookies exactly, including domain-scoped clears.
6. Fix Hono success-envelope unwrapping for CSP config and add a regression test around it.
7. Split “not found” from “upstream failure” in product/category/page fetchers and stop caching synthetic empty results caused by failures.
8. Add checkout idempotency at the storefront handoff layer so slow async order creation cannot create duplicate orders on retry.
9. Remove `/cart` from sitemap, add `noindex` where appropriate, and make product JSON-LD stock-aware.
10. Add storefront integration coverage for guest-checkout-disabled flows, discount-preserving online checkout, logout under domain-scoped cookies, CSP admin allowlist propagation, and transient API failure on canonical product/category/page routes.
