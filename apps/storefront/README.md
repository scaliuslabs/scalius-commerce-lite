# Storefront (`apps/storefront/`)

The buyer-facing store: an Astro 7 server-rendered app that runs as the `scalius-storefront` Cloudflare Worker. This guide is for contributors and coding agents. The Worker holds no database. It reads everything from the API Worker through a service binding.

Install, configure and deploy from the repository root (see the [root README](../../README.md)). Deploy with `pnpm run deploy:storefront`. Render budgets and the render path are in [docs/STOREFRONT-PERFORMANCE.md](../../docs/STOREFRONT-PERFORMANCE.md).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev:storefront` (root) | Starts the API Worker and `astro dev` together. Ports come from `scripts/dev-ports.mjs` (default storefront `:4322`, API `:8787`). |
| `pnpm --filter ./apps/storefront build` | Runs `scripts/generate-build-id.js`, then `astro build`. The deploy (and `pnpm check:dist-secrets`) scans the dist once; `astro check` runs once, in `typecheck`. |
| `pnpm --filter ./apps/storefront typecheck`, `lint` | `astro check` (after the build ID), and ESLint for the `.astro` files in `src/` (Oxlint covers the rest). |
| `pnpm perf:storefront` | Checks TTFB, LCP and CLS budgets against a running stack (`scripts/storefront-perf.mjs`). |
| `pnpm fidelity:check` | Measures the built storefront against reference sites (`scripts/storefront-fidelity/`). |
| `pnpm check:env`, `pnpm check:build-canaries` | Check Worker bindings, and prove that local env values never reach `dist/`. |

## Stack

Astro 7 with `@astrojs/cloudflare` (passthrough image service), React 19 islands, Tailwind CSS 4, Nano Stores (cart state), Radix primitives, Lucide icons and Partytown (third-party analytics).

## Worker, bindings and request path

`wrangler.jsonc` is the adapter input. `astro build` writes the deploy config to `dist/server/wrangler.json`, and `scripts/deploy.mjs` deploys that file. The public domain is the `custom_domain` route in the source config.

| Binding | Purpose |
| --- | --- |
| `BACKEND_API` | Service binding to `scalius-api`. Every data read and write goes through it. |
| `ASSETS` | Static assets from `./dist` (required by the adapter). |
| `CF_VERSION_METADATA` | The Worker version. It is part of every page cache key. Without it, pages render uncached. |
| `SCALIUS_SECRET` | The only installed secret. The Worker derives `API_TOKEN` from it on every request (HKDF, `@scalius/shared/runtime-secrets`). |

There are no Wrangler `vars`, no KV and no `workers_dev` URL. `pnpm check:env` enforces the binding set. The committed config is the Free config: `pnpm run deploy --plan paid` adds `limits.cpu_ms` to the generated file ([docs/FREE-PLAN.md](../../docs/FREE-PLAN.md)).

The entry is `src/worker.ts` (`StorefrontGateway`). For each request it:

1. Applies a signed front-proxy header, if one is present and valid.
2. Redirects plain HTTP on a named host to HTTPS (308).
3. Rewrites an RFC 8058 one-click unsubscribe POST so the page can read it.
4. Calls `servePublicStorefrontRequest()` (`src/lib/public-worker-cache.ts`), which serves a cached page or renders through the Astro handler.

Astro middleware (`src/middleware.ts`) runs three functions in order. `transportSecurityMiddleware` redirects plain HTTP and adds security headers. `requestRuntimeMiddleware` seeds the per-request runtime: pages start the layout read together with their own reads, and other routes wait for the layout first. `responsePolicyMiddleware` sets `Cache-Control`, `X-Cache-Status` and `X-Storefront-Build`, and builds the page CSP.

## Runtime configuration and API access

`src/lib/api/runtime.ts` keeps a per-request store in `AsyncLocalStorage`. Nothing is kept in module globals, and nothing is read from Wrangler vars or build-time env.

- **Origins.** The storefront, API, dashboard and media origins come from the `platform` field of `GET /api/v1/storefront/layout` (Platform settings). If the read fails, no API URL is set and API callers fail closed. `STOREFRONT_URL` then stays the request origin, so sitemaps, feeds and JSON-LD still emit absolute URLs.
- **CSP.** Merchant "Trusted websites" arrive in the same layout payload (`cspAllowedDomains`). `src/lib/middleware-helper/csp-handler.ts` builds the page CSP from them, the platform origins and the hosts of approved app scripts.
- **Getters.** Code reads the store through the `getRuntime*()` getters in `runtime.ts`. A missing value stays missing.
- **Transport.** `src/lib/api/transport.ts` owns every server-side call (`apiFetch`, default 8 s timeout, 2 retries). It uses the `BACKEND_API` binding in production and plain HTTP to the local API under `astro dev`. A safe public read may fall back once to the public HTTPS API URL. Sensitive reads and every write fail closed.
- **Batching.** Public reads that a render starts before it yields travel as one `GET /api/v1/storefront/batch` request (at most 8 parts, `MAX_STOREFRONT_BATCH_PARTS`). Authenticated, private and write requests are never batched. Page code starts all its reads together. `loadPageWithLayout()` (`src/lib/page-data.ts`) joins the layout with the page's own data.
- **Envelope.** The API answers `{ success, data }`. Read modules in `src/lib/api/` call generated SDK methods from `@scalius/api-client/sdk` through the configured clients. `unwrapEnvelope()` and `unwrapData()` (`src/lib/api/unwrap.ts`) hold the one `as` cast. Use direct `fetch` only for proxy routes and flows that need a custom body, polling or raw responses.

## Public cache and private pages

The gateway stores anonymous public pages in the Cache API (`caches.default`) with a dependency proof from the API and serves a hit only after it validates the proof. The contract (frontier, proofs, storing rules) is in [packages/core/src/cache-deps/README.md](../../packages/core/src/cache-deps/README.md).

- The key carries `BUILD_ID` and the Worker version. A deploy therefore starts with a cold cache, and nothing is purged.
- **Market presences** (MARKETS-DESIGN step 2). A subfolder such as `/en-in/...` serves the same route tree. The gateway (`src/lib/market-presence.ts`) removes the subfolder, renders the root route with the presence in the gateway-only `X-Scalius-Presence` header, and rewrites the page links of the response with HTMLRewriter. The key keeps the subfolder. An unknown or draft subfolder answers 404. The `localization` cookie (set by the selector's POST to `/localization`) redirects only a top-level navigation and never bypasses the cache. Code that builds a page URL itself uses `pagePath()` or `logicalPathname()` (`src/lib/presence-url.ts`) or `serverPagePath()`; `src/lib/presence-links.test.ts` enforces it.
- `@scalius/shared/storefront-cache-path` maps tracking, default-valued and permuted query forms of a page URL to one canonical URL. `src/lib/canonical-query.ts` does the same for API read keys. The gateway strips the `Cookie` header before it renders the canonical URL.
- `isPublicCachePath()` in `public-worker-cache.ts` defines the public paths: the home page, product, category, brand, collection, CMS and blog pages, search, the category index, `/navigation/panels`, the discovery files and the buyer shells (cart and checkout).
- Product variant-selection parameters, a bounded-query violation, an `Authorization` or `X-API-Token` header, and the cookies `cs_tok`, `cs_auth` and `stp_theme_preview` bypass the cache. Analytics and ad-click cookies never do.
- Private paths (`PRIVATE_STOREFRONT_PATHNAME_RE` in `src/lib/cache-policy.ts`): `/account`, `/buy`, `/cart`, `/checkout`, `/newsletter`, `/order-success`, `/payment-recovery`, `/theme-preview`, `/track-order`. They render for every request with `Cache-Control: private, no-cache, no-store, must-revalidate`.
- `/cart` and `/checkout` are the private pages the edge may store (`isBuyerShellPathname`): their HTML is a buyer-agnostic shell (cart lines come from `localStorage`; the checkout session, quote and payment options from no-store APIs). The key drops every query. The browser copy stays `no-store`. A signed-in buyer's cart or checkout and every `POST /cart` render live. `src/lib/cart/cart-shell.render.test.ts` proves a stored shell carries nothing from the request.
- Public HTML is `Cache-Control: no-cache` for browsers. Discovery files are `public, max-age=0, no-cache, must-revalidate` (`src/lib/public-discovery-cache.ts`).
- A page built from a failed read calls `markRenderUncacheable()`. The middleware then answers `X-Cache-Status: BYPASS_DEGRADED`, and the gateway does not store it.
- Public HTML carries only a `Link` header with a `preconnect` to the media CDN, and none while media is served on the store origin (`/media/`, `lib/media-proxy.ts`). Never add merchant, product, query-specific or build-versioned URLs to it (Early Hints ignores cache validity).
- Public product, search and feed data is band-stable: `availabilityBand` is the buyer-visible truth, and `stock` and `reservedStock` are not exact quantities. Never render them as stock counts. Cart and checkout validate quantity against the live API.
- Speculative prefetch stays on for anonymous public pages. `src/lib/prefetch-policy.ts` is the deny list for private routes and product option URLs. Keep account, buy, cart, checkout, order-success, payment-recovery, track-order and theme-preview links opted out, also inside merchant-authored content.

## Routes (`src/pages/`)

The routes are the files in `src/pages/`. Rules for a few of them:

- Buying and account routes (`/cart`, `/checkout`, `/checkout/quick`, `/buy/[slug]`, `/order-success`, `/payment-recovery`, `/track-order`, `/account/*`) are private.
- `/agent/continue*` and `/checkout/continue*` (agent handoff) are private, `noindex` and `no-store`.
- `/apps/[pluginId]/[...path]` forwards to an installed app's public API route through `BACKEND_API` (`src/lib/app-proxy.ts`). It never caches, forwards only the `cs_tok` cookie, and draws an app's `{ page }` answer inside the store layout after sanitizing it.
- `/theme-preview*` serves the dashboard theme editor preview. `/health` answers JSON with `buildId` and `no-store`.
- Discovery routes: `/robots.txt`, the sitemaps, `/llms.txt`, `/.well-known/ucp`, `/ucp/catalog/{search,lookup,product}` and the two product feeds (see Discovery).

## Same-origin proxies (`src/pages/api/`)

Proxies exist where the browser needs a same-origin cookie, the derived `API_TOKEN`, or an unwrapped response. Every `POST` proxy rejects cross-origin requests with `shouldRejectCrossOriginCookieRequest()`. Read-only `GET` routes do not need it.

- `checkout/create-order.ts` creates the order, then the first payment session for an online gateway. It passes the buyer session as `X-Customer-Session`, sets the receipt cookie and keeps `details.itemIssues` so the cart can repair lines.
- `checkout/payment-session/[gateway].ts` creates or replays a payment session. It reads the receipt proof from the cookie, never from the body, and passes a backend `202 processing` answer through with `Retry-After`.
- `customer-auth/[...path].ts` is the customer sign-in proxy. It rewrites `Set-Cookie` onto the storefront origin. `auth/logout.ts` clears `cs_tok`, `cs_auth` and every receipt cookie.
- The other proxies cover cart validation, quotes, receipts, payment recovery, reviews, warranties, messages, downloads, agent handoff and product data for browser scripts.
- `ptproxy.ts` is the Partytown reverse proxy. Its host allowlist is exactly the hosts that `src/lib/partytown-config.ts` proxies. Never add a shared CDN.
- `product-feed.xml.ts` and `facebook-feed.xml.ts` serve the catalog feeds (see Discovery).

## Cart and checkout

- **Cart state.** `src/store/cart.ts` (Nano Stores) persists to `localStorage` key `cart:v3`. Lines are keyed by product, SKU and a hash of the buyer inputs (`line:v3:<product>:variant:<variant>:p:<hash>`). The older `cart` key is dropped, never read. Discount codes live in the store, and every amount comes from the server quote. Components talk through `CustomEvent`s (`cart-updated`).
- **Cart to checkout.** The cart writes `scalius_checkout_data` (plus gateway and payment-method keys) to `sessionStorage` and reads it back before it leaves `/cart`. If storage is blocked, the cart shows an error and stays. `src/lib/checkout/session-state.ts` owns these keys. Quick buy stores `quickBuyData` the same way and redirects to `/cart?quickBuyStorage=blocked` when the write fails. Quick buy without JavaScript posts to `/checkout/quick`, which runs checkout as server POST steps and places a cash on delivery order.
- **Gateway handlers.** `src/lib/checkout/registry.ts` holds the handlers. `handlers/cod.ts` and `handlers/gift-card.ts` place the order, `handlers/stripe.ts` mounts the card form, and `handlers/hosted.ts` is the one handler for every redirect gateway, including an app provider's `<plugin id>:<provider id>`.
- **Partial payment.** When the store enables it, COD is hidden and online gateways show "Pay Advance via {gateway}". The API decides whether a gateway switch is allowed.
- **No sensitive URLs.** Contact details, OTP codes, tokens, cart, payment and discount values travel in POST bodies or browser storage, never in a URL or query string. Forms post without JavaScript where the flow allows it.
- **Order request.** It carries a `checkoutRequestId` and the `expectedQuoteFingerprint` of the verified total (`src/lib/checkout/create-order.ts`). `createOrder()` in `src/lib/api/orders.ts` never retries (`retries: 0`), so a slow answer cannot create a second order. Hosted gateways send an already committed order to receipt recovery without a retry loop.

## Receipts, order lookup and payment recovery

- **Receipt proof.** The API returns a receipt token at order creation. The storefront stores it in an httpOnly, secure cookie `scalius_receipt_<order>_<hash>` (7 days, `src/lib/order-receipt-cookie.ts`) and a short checkout marker cookie (10 minutes, path `/order-success`). Proxies read the cookie and send the proof to the API on the server (the `X-Receipt-Token` header, or the body of a payment-session call). The browser never reads it. Never put a receipt token in a URL, analytics payload or log.
- **Track an order** (`/track-order`). The order number alone shows a status-only view. Full details need a one-time code sent to a contact saved on the order, and a correct code stores the receipt cookie. All fields travel in POST bodies, and the page works without JavaScript.
- **Payment recovery** (`/payment-recovery?orderId=...`). A merchant can send this link. It opens nothing by itself: a one-time code sent to the order's saved contact proves the buyer, then the receipt opens with the payment choices. A signed-in owner goes straight to the receipt. Never create a bearer recovery URL.
- **Account order payments** (`/account/orders/[id]`). The page reads `paymentRecovery` from `GET /api/v1/customer-auth/orders/{id}` and creates sessions with `POST /api/v1/customer-auth/orders/{id}/payment-session`. Only the API's `paymentRecovery` eligibility may show a pay action. A positive balance alone never does. This flow must not use receipt tokens, `/order-success` or checkout finalization.

## Customer accounts

- `/api/customer-auth/*` proxies to `/api/v1/customer-auth/*`. The session is `cs_tok` (httpOnly). `cs_auth` is a readable hint for hydration only. Submit-time checks call `/api/customer-auth/me`.
- Browser helpers in `src/lib/api/customer-auth.ts` use bounded reads and return an explicit `unavailable` state for timeouts, malformed answers, `429` and `5xx`. The account pages then show a retryable error and never treat `unavailable` as logged out or as empty history.
- `AuthModal` (`src/components/AuthModal.tsx`) is a `method="post"` form, so Enter never puts an identity or OTP field in a URL.
- The account pages render on the server from the session cookie and work without JavaScript. Order history pages with the API's opaque cursor.

## Discovery, SEO and structured data

- **Robots.** `src/pages/robots.txt.ts` is fixed text: `User-agent: *`, a `Disallow` list for private, search and sort or filter paths (anchored, so CMS slugs are never blocked), `Allow: /`, and one `Sitemap: <Store URL>/sitemap.xml` line only when the Store URL is a valid absolute origin.
- **Sitemaps.** `sitemap.xml` indexes the static, category, brand, collection, page and article sitemaps and `sitemap-products.xml?page=N` (5000 products per page). The index has no `lastmod`. Each active market presence serves its own `/<presence>/sitemap.xml` and child sitemaps with presence URLs, and the root index also lists those children. `sitemap.xsl` is the browser view. All XML fails closed (an unavailable response) when the Store URL is not absolute.
- **Product feeds.** `/api/product-feed.xml` is the Google/Base feed (`in_stock`, `out_of_stock`). `/api/facebook-feed.xml` is the Meta feed (`in stock`, `out of stock`). Both come from `createCatalogFeedGet()` in `facebook-feed.xml.ts`. Each presence serves both feeds with presence links (`/en-in/api/product-feed.xml`). They return `404` when the dashboard disables the catalog feed, and page with `?cursor=` and `limit` (default 1000, max 5000; `?page=` answers `400`). Rows follow `@scalius/shared/catalog-feed-row`.
- **Agents.** `/llms.txt` points agents to the discovery files. `/.well-known/ucp` advertises only `dev.ucp.shopping.catalog.search` and `.lookup` over REST. `POST /ucp/catalog/search`, `lookup` and `product` serve the same buyer-resolvable SKU projection as the feeds (`src/lib/ucp/catalog.ts`). The profile requires an HTTPS Store URL. Do not advertise checkout, cart or payment capabilities.
- **Canonical and Open Graph.** `Layout.astro` sets `<link rel="canonical">` and Open Graph tags. Products, categories, collections and CMS pages may use a validated same-store `canonicalPath`. A resource with `noIndex`, and a listing with any filter or sort query, gets `noindex,follow`. A page number past the last page answers `404`. A presence page's canonical and Open Graph URLs use its presence. Hreflang alternates (with `x-default` = the root) appear only when two or more presences are active.
- **JSON-LD.** `Layout.astro` emits `OnlineStore` and `WebSite`. `OnlineStore` is omitted unless the Store URL, a logo and a company or legal name exist. Product pages emit `Product` or `ProductGroup` (`src/lib/commerce-structured-data.ts`) with `brand`, `seller`, `shippingDetails` and `itemCondition` only when saved data exists. `shippingDetails` has one destination per country the page's market sells to, only where one shipping zone serves every address there (`countries[].entire` of the rate list); the feeds state `<g:shipping>` the same way. They never emit a placeholder or `priceValidUntil`. Category, collection and brand pages emit `CollectionPage`. Catalog and blog pages emit `BreadcrumbList`. A `noIndex` resource emits no resource JSON-LD. Always build image URLs with the absolute SEO URL helper (`src/lib/seo-base-url.ts`).
- **Analytics.** Partytown loads only on pages whose enabled analytics script runs in it (`src/lib/partytown-config.ts`, `integrations/deferred-partytown.mjs`).

## Theme and layout

`Layout.astro` renders the published theme document, or the merchant's draft while the `stp_theme_preview` cookie is valid. `src/lib/storefront-theme-context.ts` upgrades older documents in memory and falls back to `DEFAULT_STOREFRONT_THEME` for an invalid one. It resolves once per request and shares the result through `locals`. Default tokens are in `src/styles/theme-foundation.css`. Per-store tokens and font faces are inline. Components must not restyle the page canvas: imported component CSS also reaches routes that omit the component.

## Build

- `scripts/generate-build-id.js` writes `src/config/build-id.ts` (git-ignored). `BUILD_ID` is `commit-<16 chars of the commit SHA>` when the CI provider sets one, else `src-<hash of src/, public/, bundled workspace packages, config and the lockfile>`.
- Generated JS and CSS live under `/_astro/<BUILD_ID>/`. Keep that build-scoped path: an Astro entry file name can stay the same when a client module changes, and Cloudflare serves generated assets as immutable.
- `integrations/build-env-isolation.mjs` keeps `.dev.vars`, `.env*` and `process.env` values out of `dist/`. Only the built-in `import.meta.env` keys (`ASSETS_PREFIX`, `BASE_URL`, `DEV`, `MODE`, `PROD`, `SITE`, `SSR`) are inlined. Never write a bare `import.meta.env` (not even in a comment) or `process.env` in source. `__SCALIUS_DEV_API_ORIGIN__` exists only for `astro dev`.
- `astro.config.mjs` lists React, React DOM, `react-dom/server` and the JSX runtimes in `resolve.dedupe`. Keep them together: two React copies cause invalid-hook errors in the account and cart islands under `astro dev`.

## Import boundaries

The storefront imports only `@scalius/shared` (pure helpers and contracts) and `@scalius/api-client` (generated SDK and client factory, used through the configured clients in `src/lib/api/transport.ts`). It must not import `@scalius/core` or `@scalius/database`. Do not use the generated singleton client when a request needs runtime origin, auth, retry or service-binding behavior.

Browser code never imports the SDK, `transport.ts` or a zod schema. It calls `fetch` with `browserApiUrl()` (`src/lib/api/browser-url.ts`), or a browser read such as `src/lib/api/browser-products.ts` that sends the SDK's request and shares the server's normalizers. `scripts/client-chunk-graph.test.ts` fails when zod or the generated SDK reaches the product, home or listing pages, their first add to cart, sign-in or search (run it after `pnpm --filter ./apps/storefront build`; `node apps/storefront/scripts/client-chunk-graph.mjs` prints the product page's chunks).

## Search client rules

- Normalize search input with `normalizeSearchQuery()` (`src/lib/search-query.ts`) before you build an API URL or a `/search?q=` link. Equivalent queries then share one cache key.
- Cancel superseded typeahead requests with `AbortController` and ignore stale answers (`src/components/search/CommandPalette.tsx`).
- Product-only lookups call `getApiV1ProductsSearch()` (`/api/v1/products/search`), not the broader global search.
