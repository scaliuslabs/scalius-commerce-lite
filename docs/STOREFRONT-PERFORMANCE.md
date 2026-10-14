# Storefront performance

Last reviewed: 2026-10-14

This document explains how the storefront renders and caches a page, what each page may cost, and how to measure it. It is for contributors and operators. Dated measurements and release thresholds are in [PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md).

## Render path

```text
Visitor -> storefront Worker (gateway)
             |- hit:  stored HTML, checked against a change frontier
             `- miss: Astro render -> ONE GET /api/v1/storefront/batch
                                        | service binding BACKEND_API
                                        v
                                      API Worker (placed beside D1)
                                        each part: validated Cache API entry, else rendered from D1
```

1. **Gateway.** `StorefrontGateway` (`apps/storefront/src/worker.ts`) calls `servePublicStorefrontRequest` (`apps/storefront/src/lib/public-worker-cache.ts`). It stores anonymous public pages in the Cache API (`caches.default`). The storefront Worker has no KV binding and is not placed, so hits stay at the visitor's edge.
2. **Render.** A page starts all its public reads together, the layout read included. The transport (`apps/storefront/src/lib/api/transport.ts`, `joinReadBatch`) sends them as one `GET /api/v1/storefront/batch?r=<part>&r=<part>`: one service-binding hop and one API invocation.
3. **Batch.** The API Worker answers each part from a validated Cache API entry or renders it in the same invocation.

### Parts of each page

The batch carries at most 8 parts of at most 2,048 characters each (`MAX_STOREFRONT_BATCH_PARTS` in `packages/shared/src/public-api-cache-routes.ts`). A part must be a route in `PUBLIC_API_CACHE_ROUTES`. The batch rejects cookies and credentials.

| Page | Parts |
| --- | --- |
| Home | `storefront/layout`, `storefront/homepage`, `shipping-methods`, `checkout/config` |
| Landing page | `storefront/layout`, `storefront/landing/<slug>`, `shipping-methods`, `checkout/config` |
| Product | `storefront/layout`, `products/<slug>`, `shipping-methods`, `checkout/config`, `storefront/product-apps/<slug>` |
| Category | `storefront/layout`, `categories/<slug>/products?...` |
| Collection | `storefront/layout`, `collections/<id>?...` |
| Search | `storefront/layout`, `products?...&search=...` |
| Cart shell | `storefront/layout`, `locations/cities`, `shipping-methods`, `checkout-languages/active`, `checkout/config`, `products/recommendations?limit=8` |
| Checkout shell | `storefront/layout`, `checkout/config`, `checkout-languages/active` |

Sources: `PAGE_PARTS` in `apps/api/src/storefront-render-budget.test.ts`. Installed apps draw inside these parts and add no call. The API sanitizes the drawn output and caches it under the `plg` and `plgs` dependency keys, so a hit runs no app code (`apps/api/src/plugins/storefront-render.ts`).

### Transport rules

- A read joins the pending batch until the render yields (`setTimeout 0`). A lone read goes as itself unless the page proof needs a batch. Authenticated, private, write and non-cacheable reads are never batched.
- If the API answers the batch with a non-200 status (for example during a deploy), each read goes alone.
- The batch has an 8 s deadline. A read addressed to a public API URL gets a 2 s service-binding deadline, then one HTTPS retry. A read addressed to the internal service origin has no public URL to retry and keeps its full deadline. This includes the first batch of every render, because the platform API URL arrives with the layout.
- The middleware (`apps/storefront/src/middleware.ts`) does not wait for the layout before the pages that `isLayoutBatchedPagePath` lists. Those pages wait for it together with their own reads. Every other route waits for the layout first.

### The batch in the API

Code: `apps/api/src/routes/storefront.ts`, `apps/api/src/storefront-batch.ts`, `apps/api/src/public-read.ts` (`createPublicPartReader`). The strict reader serves every part (`API_PART_CACHE_MODE = "strict"` in `apps/api/src/public-cache-policy.ts`). Its keys, validation statement and storing rules are in [packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md). Batch-specific facts:

- A part comes from the Cache API under `dvcReadCacheKey` (canonical path, sorted query, `__cv=<API Worker version>`). Otherwise `renderPublicRead` renders it from the one snapshot that validated the hits.
- Each part answers as its own GET would, with its status, body and proof. A part that fails fails alone (status 502 for that part).
- Every part of a batch renders at once (`MAX_BATCH_PART_RENDERS` equals the 8-part cap). D1 queues their statements on the invocation's six connections. A lower limit made the fifth part of the product page and the cart wait for the first to finish, one extra D1 wave.
- The batch response is `private, no-store`, and public API responses carry `no-store` CDN headers, so no CDN copy skips validation. Workers Cache entrypoints stay off for the same reason: a hit runs no code and cannot validate. `pnpm check:env` fails when an entrypoint enables it.

### API placement

`apps/api/wrangler.jsonc` sets `"placement": { "region": "aws:ap-east-1" }`, so the API fetch handler runs beside the D1 primary (Hong Kong), not beside the visitor. A render reads D1 in several dependent waves, and from a distant data center each wave costs a full database round trip (about 200 ms from Europe, 1-5 ms beside it). If the database moves, read `served_by_colo` from `wrangler d1 execute <db> --remote --json --command "SELECT 1"` and change the region.

## Page cache

### Which requests use it

A request uses the shared page cache (`getPublicStorefrontCachePolicy`) when all of these hold:

- The method is GET or HEAD.
- The request has no `Authorization` or `X-API-Token` header and no `cs_tok`, `cs_auth` or `stp_theme_preview` cookie. Other cookies do not matter: the render drops every cookie.
- After tracking parameters leave, the query has at most 30 entries, each key at most 64 characters and each value at most 512.
- The URL is not a product page with a `size` or `color` query (a variant selection).
- The path is public (`isPublicCachePath`): pages, feeds, sitemaps, `/robots.txt`, `/llms.txt`, `/.well-known/ucp` and the buyer shells (cart and checkout).

The public and private path lists and the browser `Cache-Control` values are in [apps/storefront/README.md](../apps/storefront/README.md#public-cache-and-private-pages).

`X-Cache-Status` reports the lane: `HIT`, `MISS`, `BYPASS`, `BYPASS_AUTH`, `BYPASS_VARIANT_SELECTION`, `BYPASS_DEGRADED` (the page rendered from a failed read and called `markRenderUncacheable`) and `NO_CACHE`. A stored page is also a `MISS` on the request that renders it. Direct API reads report `HIT`, `MISS`, `REFRESH` or `BYPASS`.

### Key

```text
<origin>/__cache/<BUILD_ID>/<storefront Worker version>/dvc<path><query>
```

- A market presence page keeps its subfolder in the key (`/en-in/products/<slug>`). The gateway renders the root page for it and stores the page after it rewrites the links (MARKETS-DESIGN step 2), so a hit costs no rewrite. The `localization` cookie never bypasses the cache. A presence page's `checkout/config` part carries `?presence=`; every other part is the root page's part.
- The path and query are canonical: sorted query, empty values removed, no tracking parameters or `_sv`, `q` and `search` whitespace collapsed, and default `page=1` and `sortBy=newest` removed on category, collection, blog and search paths. The gateway renders this URL without cookies, so every anonymous visitor gets the same bytes.
- Tracking parameters (`utm_*`, `fbclid`, `gclid`, `ref` and the other click and campaign keys in `isStorefrontTrackingQueryParam`, `packages/shared/src/storefront-cache-path.ts`) do not count toward the query bounds. The browser URL keeps them for client analytics. An unknown parameter stays, because it may change the page.
- `BUILD_ID` comes from `apps/storefront/scripts/generate-build-id.js`. The page reports it in `X-Storefront-Build`, and deploy verification compares it.
- The Worker version is `CF_VERSION_METADATA.id`, read through `readWorkerVersion` (`packages/shared/src/cache-generation.ts`) at no D1 cost. Without the binding it returns null and nothing is cached. `pnpm check:env` fails when a Wrangler config lacks `"version_metadata": { "binding": "CF_VERSION_METADATA" }`.
- Every deploy of a Worker starts its public cache cold: the first page per data center is a miss. Nothing purges old entries, and Cloudflare evicts them. `pnpm run deploy` deploys the API before the storefront, so old storefront HTML stays consistent with the API that rendered it.

### Validity

A page entry is valid by committed dependencies, not by age, so an unchanged entry can hit for months. The registry, triggers, `deps.*` declarations, frontier proofs, `_sv` links and `validUntil` are in [packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md). Facts that shape performance:

- A page entry carries the union of its parts' dependency hashes (at most 1,024). A page is stored only when every API read of its render came through a batch part with a proof.
- The gateway validates a hit against a frontier of its data center that is at most 1 s old (`CACHE_FRONTIER_DELTA_MS`). It refreshes the frontier in the background after 0.5 s. If the frontier cannot refresh in 1.5 s, the page renders. One refresh and one slow check run per isolate. Slow-check limits are in [FREE-PLAN.md](./FREE-PLAN.md#frontier-cache-refresh).
- A scheduled change (a promotion start or end) sets `validUntil`, and the gateway never serves the entry at or after it. Buyer facts have no stale-if-error allowance.
- Public product, search and feed projections carry `availabilityBand`. `stock` and `reservedStock` are stable compatibility values, never exact quantity. A write inside one band changes no bytes and no dependency. Cart and checkout stay the live authority.

## Buyer shells: cart and checkout

The `GET /cart` and `GET /checkout` HTML does not depend on the buyer, so the gateway caches it like a public page (`isBuyerShellPathname` in `apps/storefront/src/lib/cache-policy.ts`). A page that always rendered paid one placed-API round trip per view: from Dhaka about 150 ms for the API hop alone and 285-1,400 ms for `/checkout` (2026-10-14). A shell hit costs what any page hit costs.

- The cart lines live in `localStorage` (`cart:v3`). An inline script paints them, or the empty state, before first paint. The checkout reads its session from the browser. Sign-in state comes from the browser (`cs_auth=1`). Saved details, discounts, cart validation, the tax quote, the payment options of the quote and the order come from no-store APIs or the POST.
- The reads are public and dependency-validated: layout, cities, shipping methods, checkout copy and checkout settings (the checkout needs only the layout, settings and copy).
- The key drops every query. A session cookie (`cs_tok`, `cs_auth`) bypasses the cache. A POST is never cached. `/checkout/quick`, receipts, payment recovery and accounts are never shells.
- A failed read (fail-closed "checkout unavailable") renders for this request only: `markRenderUncacheable` sets `no-store`, the middleware answers `BYPASS_DEGRADED`, and the gateway does not store it. A store that is really unavailable is a valid answer and is stored.
- The browser copy stays `private, no-cache, no-store, must-revalidate`, because the buyer types contact and payment details into the page. Prefetch of `/cart` and `/checkout` stays off.

`cart-shell.render.test.ts` (beside the cart code) renders both real pages with buyer cookies and queries and asserts identical bytes, one API batch and uncacheable failed renders.

## Budgets and guardrails

| Guardrail | Where | Limit |
| --- | --- | --- |
| API calls per page render | `apps/storefront/src/lib/api/render-batch.test.ts` (`PAGE_API_CALL_BUDGET`), `cart-shell.render.test.ts` | 1 for home, product, category, search, cart and checkout |
| D1 round trips and waves of a cold render | `apps/api/src/storefront-render-budget.test.ts` (`PAGE_D1_BUDGETS`) | table below |
| Validation statement | same test | exactly 1, in wave 1. Every render statement starts in wave 2. |
| The same page again (all parts validated hits) | same test | exactly 1 statement, 1 wave, identical bodies |
| A page with one app drawing | same test (`APP_PAGE_D1_BUDGETS`) | home 11 / 2, product 19 / 3 |
| Batch safety, and batchable reads only in read-only route families | `storefront-batch*.test.ts`, `runtime/storefront-render-families.test.ts` | exact |
| API Worker size | `pnpm check:api-bundle` (also in every deploy) | at most 90% of 64 MiB uncompressed |
| Product JSON-LD weight | `commerce-structured-data.product-group.test.ts` | at most 20 KB (`PRODUCT_JSON_LD_MAX_BYTES`) |
| Dependency cache correctness | `cache-dvc.property.test.ts`, `cache-dvc.race.test.ts` | zero findings |
| TTFB, LCP and CLS in a real browser | `pnpm perf:storefront` | [thresholds](#pnpm-perfstorefront) |
| Template fidelity, listing density, navigation at scale, page weights | `pnpm fidelity:check` | [tolerances](#pnpm-fidelitycheck) |
| Free plan D1 and CPU cost per operation | `pnpm free-plan:budget` | [FREE-PLAN.md](./FREE-PLAN.md) |

D1 budgets of a cold render, per page (seeded store; the home page uses every section type; a batch counts as one round trip):

| Page | Round trips | Waves |
| --- | ---: | ---: |
| Home | 10 | 2 |
| Landing page | 10 | 2 |
| Product | 19 | 3 |
| Category | 5 | 3 |
| Collection | 6 | 3 |
| Search | 5 | 2 |
| Cart shell | 13 | 2 |
| Checkout shell | 7 | 2 |

A product with 6 reviews may use 20 round trips in 3 waves. The budgets are the measured values (2026-10-14), so any new statement or wave fails the test.

A wave is a round of D1 calls that must wait for the previous one, and each wave costs a full database round trip. A new sequential `await` in a storefront read fails the budget test even when the query count stays the same. The layout and homepage parts each read in two steps (batch contents: [storefront README](../packages/core/src/modules/storefront/README.md)).

The validation statement reads the clock and the current Platform settings together before any cold render. A cached Platform snapshot cannot replace it, because a new URL after a settings edit must apply at once. The test recognizes the statement by its SQL, counts every other statement against the page budget, and prints each page's counts as `[storefront budget]` lines.

## `pnpm perf:storefront`

`pnpm perf:storefront` (`scripts/storefront-perf.mjs`) measures TTFB, LCP and CLS of built Workers. It sends only GET requests, except for the local `--d1-explorer` option. It checks the home page, the first category and product linked from home, `/search?q=a`, `/cart` and `/checkout`. For each page it records:

- Server TTFB of a cache miss and the median of the hits. A 5xx first response is a failure. Against a remote base, it subtracts the TTFB of the edge's own `/cdn-cgi/trace` (the network round trip) from the hit TTFB and prints both values.
- In headless Chrome, LCP, CLS, TTFB and transfer size, read 1.5 s after load with the browser cache off. The phone profile is 390x844 at DPR 3, 150 ms latency, 1.6 Mbps down, 750 kbps up, 4x CPU slowdown. The desktop profile is 1440x900.

It exits 1 when a threshold is exceeded:

| Metric | Threshold | Flag |
| --- | --- | --- |
| Cache-hit TTFB | 50 ms | `--budget-ttfb-hit-ms` |
| Cache-miss TTFB (and pages that always render) | 300 ms | `--budget-ttfb-miss-ms` |
| Phone LCP | 1200 ms | `--budget-lcp-phone-ms` |
| Desktop LCP | 800 ms | `--budget-lcp-desktop-ms` |
| CLS (either profile) | 0.05 | `--budget-cls` |

Other flags: `--base <origin>` (default `http://localhost:4391`), `--paths "/,/products/x"`, `--runs <n>` (default 3), `--profiles phone,desktop`, `--no-browser` (TTFB only), `--json`, `--media-url <origin>`, `--no-binding-check` and `--cdp-port <port>` (default 9395; the script starts its own headless Chrome when nothing listens there).

### Forced misses on a local stack

`--d1-explorer <origin>` advances the store dependency and the clock in the local D1 through the Wrangler local explorer. The first timed request carries that clock as `_sv` and must report `MISS` or `REFRESH`. Hit samples count only verified `HIT` responses with status 200. Both origins must be loopback addresses. Without the option, the script reports the first request as "first" (a miss or a hit, whatever the edge had).

```sh
pnpm perf:storefront --base http://localhost:4391 --d1-explorer http://localhost:8811
```

Wrangler's dev registry is shared by every local stack, so a built storefront's `BACKEND_API` binding resolves by Worker name (`scalius-api-local-<api port>` on a non-default port; `node scripts/dev-ports.mjs storefront-config` writes the binding). Against a local base the script first checks that the storefront home page carries its own canonical origin, because another stack's API would render that stack's origins. `--media-url` also checks the media origin, and `--no-binding-check` skips the check. `node scripts/dev-ports.mjs verify-binding` runs the same check for a `pnpm dev` stack.

With the local API running and the storefront built, generate and serve its local config from the repo root (set `SCALIUS_DEV_API_PORT` to match a non-default API):

```sh
SCALIUS_DEV_STOREFRONT_PORT=4391 node scripts/dev-ports.mjs storefront-config
pnpm --dir apps/storefront exec wrangler dev --config wrangler.local.json --local
```

The generated `apps/storefront/wrangler.local.json` stays beside the project's runtime configuration so Wrangler loads it normally; placing the config inside `dist/server` can leave the frontier client unavailable and every page a `MISS`. Built entry and asset paths are absolute, including with `--out <file>`. A custom output directory needs its own runtime configuration through Wrangler's supported options. The helper does not read or copy secrets. Fully consume the first anonymous page response and require a repeat request to report `X-Cache-Status: HIT` before timing hits.

### Live, read-only

A miss cannot be forced on a live store. The first request counts as a miss only when the edge reports `X-Cache-Status: MISS`.

```sh
pnpm perf:storefront --base https://storefront.scalius.com
```

Miss TTFB from a laptop includes the network round trip to the edge. From Bangladesh, some ISPs reach Cloudflare in Europe (MXP, MAD, CDG, MRS) as often as in SIN or HKG, which adds 150-450 ms per TLS connection. Read the data center from `cf-ray` before you blame the server.

## Comparison with other platforms

`pnpm perf:compare` (`scripts/storefront-compare.mjs`) runs the same profile against any public stores: `--site <label>=<url>` per store, `--runs` at most 3. From each home page it takes the first listing and product link (Scalius `/categories/` and `/products/`, Shopify `/collections/` and `/products/`, WooCommerce `/shop/`, `/product-category/` and `/product/`) and the cart (`/cart` or `/basket`). It records the page TTFB on a warm connection, the TTFB of the site's `/robots.txt` on the same connection (the network and edge floor; "server" is the page less the floor), and phone and desktop LCP, CLS and transfer size. It sends only GET requests, one at a time, and never accepts a cookie dialog or touches a form.

```sh
pnpm perf:compare --site scalius=https://storefront.scalius.com \
  --site shopify-dawn=https://theme-dawn-demo.myshopify.com --site woo-storefront=https://wp-skins.com
```

2026-10-14 from Dhaka (Cloudflare DAC), 3 runs per page, median. Shopify: the official Dawn theme demo. WooCommerce: a public Storefront-theme store (the official Storefront demo now redirects to woocommerce.com). The Scalius row is the live demo before the buyer-shell, cart and font changes of this date (its cart LCP was the late popular-products photo, about 1.0 s after them in the local A/B).

| Site | Page | TTFB server / page / floor (ms) | Phone LCP (ms) | Phone CLS | Phone KB | Desktop LCP (ms) | Desktop CLS |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Scalius | home | 2 / 27 / 25 | 1376 | 0 | 209 | 436 | 0 |
| Scalius | listing | 0 / 30 / 31 | 1316 | 0 | 235 | 280 | 0.001 |
| Scalius | product | 0 / 25 / 26 | 1516 | 0 | 257 | 276 | 0 |
| Scalius | cart | 2 / 26 / 24 | 2592 | 0 | 238 | 648 | 0 |
| Shopify Dawn | home | 18 / 148 / 130 | 3816 | 0 | 849 | 236 | 0 |
| Shopify Dawn | listing | 158 / 275 / 117 | 1800 | 0 | 701 | 344 | 0 |
| Shopify Dawn | product | 47 / 169 / 122 | 2372 | 0 | 530 | 264 | 0 |
| Shopify Dawn | cart | 0 / 128 / 140 | 1860 | 0 | 383 | 256 | 0 |
| WooCommerce Storefront | home | 4 / 250 / 246 | 4732 | 0 | 1042 | 1992 | 0.223 |
| WooCommerce Storefront | listing | 6 / 251 / 245 | 11668 | 0.034 | 2258 | 2328 | 0.042 |
| WooCommerce Storefront | product | 26 / 274 / 248 | 4788 | 0.001 | 961 | 1064 | 0 |
| WooCommerce Storefront | cart | 158 / 409 / 251 | 1428 | 0 | 224 | 1012 | 0 |

Scalius pages are edge hits (about 25 ms at the DAC edge); Shopify pages pass to its origin (120-140 ms floor from Dhaka, 0-160 ms more). Phone LCP follows bytes on slow 4G: Scalius pages move 210-260 KB, Dawn 380-850 KB, the WooCommerce store 220-2,260 KB. A store's `/robots.txt` can itself be dynamic (WordPress), so read the floor column before comparing server times.

## `pnpm fidelity:check`

`pnpm fidelity:check` (`scripts/storefront-fidelity/check.mjs`) measures the built storefront templates against reference sites. It reads the reference numbers from `scripts/storefront-fidelity/reference-metrics.json` and exits 1 on any breach. Attach its report to every storefront pull request.

```sh
pnpm fidelity:check                                   # everything
pnpm fidelity:check --only department-mall --report-only
pnpm fidelity:check --only listing,marketplace --state-cache /tmp/fidelity-cache
```

One run builds the storefront (`--skip-build` reuses `dist/`) and seeds a temporary D1 and R2 state that it owns (`seed-large.mjs`: the catalogue-scale store ([below](#load-data)) plus a four-level category tree, generated photos, video products and five navigation menus of 12 to 1,150 links). `--state-cache <dir>` keeps a copy keyed by a fingerprint of the seed code and the migrations. It starts the API and the built storefront under `wrangler dev` on that state and measures them with one headless Chrome over CDP (`scripts/storefront-fidelity/*.mjs`). Then it compares the numbers (`lib/compare.mjs` in that folder), writes the report, stops every process tree it started and deletes the state.

- Default ports: API 9001, storefront 4601, admin 4602, media 4603, Chrome 9601 (`--api-port`, `--storefront-port`, `--admin-port`, `--media-port`, `--chrome-port`).
- The API runs as `scalius-api-local-<api port>` on a private dev registry. The run stops unless the storefront home page carries this stack's origins.
- Secrets are random values in a temporary env file. No `.dev.vars` is read. The run refuses a state inside any repo `.wrangler` directory and any hosted database (`DATABASE_PROVIDER`, `TURSO_*`, `POSTGRES_*`).
- If a Worker dies, the stage restarts the stack once. A stage that fails twice is a failing check.

The report goes to `.wrangler/fidelity/` (`--out` changes it): `summary.md` (verdict, and every breach with our value, the reference, the rule and the source), `scorecard.json`, `pairs/` (the reference first screen beside ours) and `shots/`. Reference screenshots are not in the repository. `--ref-shots <dir>[,<dir>]` names the folders. Without them the pairs report "unverified".

Tolerances (`DEFAULT_TOLERANCES` in `scripts/storefront-fidelity/lib/compare.mjs`, overridable in `reference-metrics.json`):

- Block sizes within 10% (never tighter than 2 px), card gap within 4 px, font size within 1 px, card image ratio within 0.05.
- Grid columns equal. Visible products and filters at least the reference.
- The 20th product's bottom at most 1.1x, and the first product at most 40 px below, the reference.

Budgets (`budgets` in `reference-metrics.json`):

| Budget | Value |
| --- | --- |
| TTFB hit / miss | 50 ms / 300 ms |
| LCP phone / desktop | 1500 ms / 1200 ms |
| CLS | 0.05 |
| Product page HTML | 120 KB |
| Category page HTML | 150 KB |
| Header HTML | 45 KB; at most 150 links |
| Product JSON-LD | 20 KB |
| Buy box top (1440x900) | 400 px |
| Hover photo visible after pointerenter | 150 ms |
| Card settings (every facts and action pair) | card photo fetched at most 1.2x its drawn width; a product without facts still renders a whole card; phone card title at least 14 px |

`--only` takes blocks (`header`, `card`, `listing`, `pdp`, `footer`, `size`, `perf`, `nav`, `variants`, `hover`, `tiny`) or a template name, and skips the stages it does not need. `--report-only` writes the same report and exits 0. Use it while a slice closes its gaps. The merge gate is the plain command. `node scripts/storefront-fidelity/density.mjs --out refs.json` re-measures the reference listings with read-only page loads and never accepts a cookie dialog.

Other flags: `--keep-run`, `--min-free-pct` (default 25) and `--max-swap-mb` (default 7000). The run aborts when free memory falls below `--min-free-pct` (macOS `memory_pressure`) or, where that is unreadable, when used swap passes `--max-swap-mb`. A full run takes about 25 minutes and peaks near 3 GB of physical memory. Never run it beside a typecheck or another stack on a 16 GB host. Generated studio photos compress 3-5 times better than real photos, so image bytes are understated.

## Catalogue scale

### Load data

`scripts/catalog-scale-seed.mjs` fills a migrated local D1 state that you own with a deterministic store at the scale of Star Tech and Apple Gadgets: about 30,000 products (60% simple, 40% optioned), about 80,000 SKUs with ledger v2 stock edges, 400 categories in four levels, 300 published brands, 30 spec attributes, 1-4 images per product, 50 collections, 20,000 customers and 50,000 orders. Options: `--products`, `--customers`, `--orders`, `--seed`. The seed fills the catalogue projections at the end. It refuses the shared repo `.wrangler` state and a state that already has products.

```sh
SCALIUS_WRANGLER_STATE=/tmp/catalog-scale/state node scripts/deploy.mjs --migrate-only --local
node scripts/catalog-scale-seed.mjs --state /tmp/catalog-scale/state
```

#### Huge profile

`--profile huge` makes a store the owner would call hundreds of thousands of products and millions of orders, in proportion: about 50,000 products and 150,000 SKUs, 800 categories, 500 brands, 200,000 customers and 1,000,000 orders over three years with seasonality. The orders have 1-5 lines, real statuses, payment states, fulfilments, returns and refunds, discounts and tax, and a few foreign-currency (USD, EUR) markets. It also writes about 100,000 reviews, 2,000 promotions, gift cards, 20,000 inbox conversations with 150,000 messages, 15 staff users, notification history and audit events. The edge data is mixed in: names over 120 characters, about 20% Bangla names, products with 0 and with 20 images, a 100-SKU product on five option axes, a customer with 500 orders, an order with 99 lines, zero-stock and backorder SKUs, draft, archived and trashed records, and empty optional fields. The whole run takes under about 30 minutes and ends near 4 GB. It stops with no write when less than 6 GB of disk is free. Everything goes through the real constraints and triggers, except the event outbox: the `evt_*` triggers are dropped for the run and recreated at the end, and `event_outbox` is emptied, so the queue does not replay a million order events.

Use an absolute state directory outside the repository:

```sh
STATE=/absolute/path/outside/the/repo/huge-state
mkdir -p "$STATE"
SCALIUS_WRANGLER_STATE="$STATE" node scripts/deploy.mjs --migrate-only --local
node scripts/catalog-scale-seed.mjs --state "$STATE" --profile huge
node scripts/catalog-scale-seed.mjs --state "$STATE" --verify --deep   # optional: invariant checks
pnpm dev --state "$STATE"                                               # in another terminal
pnpm dev:admin:create --state "$STATE" --no-start --skip-migrations     # once the stack is up (add --api <origin> for non-default ports)
node scripts/catalog-scale-seed.mjs --state "$STATE" --staff-roles      # after the admin exists
```

Staff users are written without role assignments, because the one-shot setup (`scripts/dev-admin.mjs`) refuses once any user holds permissions. `--staff-roles` assigns the seeded staff their system roles after the admin exists. If a run stops before it ends, `--restore-triggers` recreates the dropped event triggers (the seed refuses to start while their saved SQL file is present). `--verify` prints one PASS/FAIL line per invariant (unique SKUs and barcodes, the one-default-SKU rule, order totals against line sums, payment ledger, fulfilment projection, customer counters, ledger edges, FTS rows and more); `--deep` adds a foreign-key check and `quick_check`.

Opt-in harnesses use it and skip unless their variable is set (see each header): `scripts/catalog-scale-profile.test.ts` (`CATALOG_SCALE_STATE`; p50, p95, D1 statements, waves and `rows_read` per route on a Miniflare D1 copy), `apps/storefront/src/lib/route-tests/api/catalog-feed-scale.test.ts` (`CATALOG_SCALE_API`; walks the whole XML product feed) and `scripts/cache-dvc-load.test.ts` (replays reads and buyer-visible writes against the dependency cache).

### Projections

Listings, counts, the product sitemap and recommendations read stored projections (`product_buyer_state`, `product_facet_values`, `product_recommendations`, `product_sales_stats`), not per-request eligibility and ranking over every SKU. Every product, SKU, option-matrix, stock and checkout write appends the refresh statements to its own D1 batch, so the projection commits with the write. Projections are not authority: cart validation and checkout stay authoritative. Columns, refresh, rebuild and recommendation rules are in the [products](../packages/core/src/modules/products/README.md#catalogue-projections) and [catalog](../packages/core/src/modules/catalog/README.md) READMEs.

Migration `0091_catalogue_projection_fill` fills both projections. It was generated from `catalogProjectionFillStatements` (`packages/core/scripts/catalog-projection-fill.ts`) and is immutable: a test keeps the D1/Turso file and its PostgreSQL sidecar at their recorded ledger digest, and proves the current builders still fill a seeded store the same way. Changing the price increment (Settings → Markets, on the backup market) queues a full rebuild, because card prices round to it. A rebuild that finds no drift advances no dependency, and the first cron tick of every new API version queues one full rebuild (the `system_kv` claim `catalog:projections:rebuilt-for-version`).

### Listing reads

The plan sets the count cap and the page depth (`planLimits().lists`: `countCap` and `maxOffset`; see [FREE-PLAN.md](./FREE-PLAN.md#large-lists)). For the plain shop-all page:

- The count is `SELECT count(*) FROM (SELECT 1 ... LIMIT cap + 1)`.
- `MIN(from_minor)` is one probe of `product_buyer_state_price_idx`. `MAX(to_minor)` has no index and reads the public rows. No migration adds an index on `(is_public, to_minor)`.
- A scoped listing (category, brand, collection, search) or a filtered listing reads its own rows once for count, `MIN` and `MAX`. The scope bounds that read.

A numbered page deeper than `maxOffset` is an empty page, reads no rows and gets 404 from the storefront. `newest`, `price-asc` and `price-desc` continue with the `cursor` from `pageInfo.endCursor`.

## Cold start

A cache miss on a fresh API isolate pays module start-up on top of the render. A page is one batch, so a render pays for at most one isolate start, and API placement keeps isolates warm more often. The API loads route families lazily (`classifyPublicRuntimePath` in `apps/api/src/runtime/public-app.ts`): `config`, `catalog`, `content`, `buyer` and `proxy`. A render must not load the `buyer` family (orders, customer auth, agent contexts), so every batchable read, including `checkout/config`, lives in a read-only family. Splitting the API into more bundles does not help ([experiments](./PERFORMANCE-RELEASE.md#cold-start-experiments)), so the API stays one script.

workerd compiles every JavaScript module when an isolate starts, whatever the request runs. A Text module is a string and is not compiled. Large data is in Text modules:

- The OpenAPI contract and the agent operation manifest: `apps/api/src/generated/*.gen.txt` (Wrangler's default `*.txt` rule). Their generated `.gen.ts` loaders parse the manifest when an agent route first loads it and serve the contract on the first `/openapi.json` request.
- The Bangladesh places dataset: a `rules` entry in `apps/api/wrangler.jsonc` makes `places/places.json` a Text module. The pack parses it when a seed runs.

This took the JavaScript that a new API isolate compiles from 14.6 MiB to 7.7 MiB (2026-10-14). In workerd on one host, the compile before the first request went from 235 ms to 153 ms. `pnpm check:api-bundle` fails above 9 MiB of JavaScript (`API_SCRIPT_BUDGET_BYTES`). Vitest (`vitest.config.ts`) and Node scripts (`scripts/text-module-hooks.mjs`) load a `*.txt` import as its text, as Wrangler does.

A database client is made per call, so no binding outlives its request. Its relational schema (the `db.query` API) comes from the schema module only, so `packages/database/src/drizzle-clients.ts` derives it once per isolate. `drizzle(client, { schema })` derived it on every call: about 1.3 ms of CPU (15 ms the first time), and a batch makes one client per part. In the workerd harness (`FREE_PLAN_WORKERD=1`), a warm product page batch went from 6 ms to 4 ms of CPU, and the first product page of a fresh isolate from 145 ms to 136 ms.

Rules that keep the first view after a deploy fast:

- Put a large dataset in a Text module and parse it where it is used. A JSON or object literal is code that every API isolate compiles.
- The storefront server build is minified (`vite.build.rolldownOptions.output.minify` in `apps/storefront/astro.config.mjs`); Astro turns `build.minify` off for it.

## Images

- Uploads get WebP renditions at `media/<id>.<ext>/<w>.webp` on a fixed ladder (`MEDIA_VARIANT_WIDTHS` in `packages/shared/src/media-variants.ts`: 144 to 1600, each step at most 1.2 times the one below; master up to 2400). The dashboard browser pipeline or the API `IMAGES` binding renders them. No image transformation runs on the delivery path (the storefront image service is `passthrough`).
- Every storefront surface uses `srcset` and `sizes` from those renditions (`apps/storefront/src/lib/responsive-image.ts`). The home hero and the product gallery's main photo use `capSizesDensity`: it repeats each `sizes` entry first under `(min-resolution: 2.5dppx)` with the width scaled by 0.666, so a DPR 3 phone fetches about 2x pixels, not 3x. Card photos use the phone-only `capPhoneSizesDensity`. Thumbnails and screens below DPR 2.5 keep full density.
- The dashboard uploads renditions with the original, and the scheduled backfill renders what is still missing within a time budget per sweep run. On the Paid plan profile, an image without renditions also heals itself: when a rendered (miss) public API read still publishes an original `media/<id>.<jpg|png|webp|avif>`, the API renders up to 4 such images right after the response (`apps/api/src/utils/media-rendition-hints.ts`; a 15-minute per-colo Cache API marker deduplicates it). On Free, only the backfill renders. Buyers see the original until a render advances the media dependency.
- Images inside rich descriptions that have no renditions (external images, or an original URL saved in the text) keep their source. They get `loading="lazy" decoding="async"` (the first image of priority content stays eager), their authored `width` and `height`, and a size from the URL when an image CDN states both.
- Product JSON-LD states the description once (plain text, at most 1,000 characters), never per variant. Each variant carries one photo and no repeated brand. The script is capped at 20 KB. A product whose variants do not fit lists the complete variants that do, in order. The page still sells every SKU.

## Delivery rules

Build output, the CSS inline limit, the preconnect `Link` header and the prefetch deny list are in [apps/storefront/README.md](../apps/storefront/README.md). Rules that protect first paint:

- Astro sessions are off (`session: false` in `apps/storefront/astro.config.mjs`), so the adapter adds no KV session driver.
- Analytics scripts that run in Partytown load through a hashed bootstrap after first paint (`apps/storefront/integrations/deferred-partytown.mjs`). The Cloudflare Web Analytics beacon loads as a module script with `fetchpriority="low"` (`apps/storefront/src/lib/analytics-script-delivery.ts`).
- The theme's heading face is preloaded only from 640 px (`media` on the preload in `ThemeFonts.astro`). On a phone on slow 4G the 47 KB preload shared the link with the render-blocking CSS and the LCP photo and cost 150 ms of LCP (A/B of the live home page, 5 runs each: 1,056 ms to 908-916 ms). Every face swaps over a metric-matched fallback, so CLS stays 0.
- Content that buyers see at first paint is in the HTML, not fetched by a page script. The empty cart's "Popular now" products are drawn in the cached cart shell (one more batch part, lazy photos, so a full cart never fetches them). Fetched by the cart script, they were the phone LCP at 2.6 s; drawn in the shell, about 1.0 s in the same A/B.
- The preconnect `Link` header stays a fixed CDN origin. A preconnect transfers no merchant bytes, so Cloudflare's URI-keyed Early Hints cache cannot serve stale price, stock or hero content.
