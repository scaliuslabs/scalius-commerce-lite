# Storefront performance

Last reviewed: 2026-10-03

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

1. **Gateway.** `StorefrontGateway` (`apps/storefront/src/worker.ts`) calls `servePublicStorefrontRequest` (`apps/storefront/src/lib/public-worker-cache.ts`). It stores anonymous public pages in the Cache API (`caches.default`). The storefront Worker has no KV binding and is not placed, so cache hits stay at the visitor's edge.
2. **Render.** A page starts all of its public reads together, the layout read included. The transport (`apps/storefront/src/lib/api/transport.ts`, `joinReadBatch`) sends them as one `GET /api/v1/storefront/batch?r=<part>&r=<part>`. One page is one service-binding hop and one API invocation.
3. **Batch.** The API Worker answers each part from a validated Cache API entry or renders it in the same invocation.
4. **Placement.** The API Worker runs next to its D1 primary. See [API placement](#api-placement).

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
| Cart shell | `storefront/layout`, `locations/cities`, `shipping-methods`, `checkout-languages/active`, `checkout/config` |

Sources: `PAGE_PARTS` in `apps/api/src/storefront-render-budget.test.ts` and the reads in `apps/storefront/src/pages/cart.astro`.

Installed apps draw inside these parts and never add a call. App sections come in the homepage part. A product page's app blocks come in their own part, which is always in the product batch. The API sanitizes the drawn output and caches it under the `plg` and `plgs` dependency keys, so a hit runs no app code (`apps/api/src/plugins/storefront-render.ts`).

### Transport rules

- A read joins the pending batch until the render yields (`setTimeout 0`). A lone read goes as itself unless the page proof needs a batch.
- Authenticated, private, write and non-cacheable reads are never batched.
- If the API answers the batch with a non-200 status (for example during a deploy), each read goes alone.
- The batch has an 8 s deadline. A public read addressed to a public API URL gets a 2 s service-binding deadline and then one HTTPS retry. A read addressed to the internal service origin has no public URL to retry, so it keeps its full deadline. This includes the first batch of every render, because the platform API URL arrives with the layout. A short deadline would turn a slow cold read into an error page.
- The middleware (`apps/storefront/src/middleware.ts`) does not wait for the layout before the pages that `isLayoutBatchedPagePath` lists. Those pages wait for it together with their own reads. The layout promise applies the platform origins when it resolves. Every other route waits for the layout first.

### The batch in the API

Code: `apps/api/src/routes/storefront.ts`, `apps/api/src/storefront-batch.ts`, `apps/api/src/public-read.ts` (`createPublicPartReader`). The strict reader serves every part (`API_PART_CACHE_MODE = "strict"` in `apps/api/src/public-cache-policy.ts`). Its keys, validation statement, storing rules and audit sampling are in [packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md). Batch-specific facts:

- A part comes from the Cache API under `dvcReadCacheKey` (canonical path, sorted query, `__cv=<API Worker version>`). Otherwise `renderPublicRead` renders it in the same invocation.
- Each part answers as its own GET would, with its status, body and proof. A part that fails fails alone (status 502 for that part).
- Up to 4 parts render at once (`MAX_BATCH_PART_RENDERS`). D1 queues the rest on the invocation's six connections.
- Misses and rejected hits render in the batch's invocation, from the one snapshot that validated the hits.
- The batch response is `private, no-store`. Public API responses carry `no-store` CDN headers, so no CDN copy skips validation.
- Workers Cache entrypoints stay off, because a Workers Cache hit runs no code and cannot validate. `pnpm check:env` fails when the default or a named entrypoint enables it.

### API placement

`apps/api/wrangler.jsonc` sets `"placement": { "region": "aws:ap-southeast-1" }`. The API fetch handler runs beside the D1 primary, not beside the visitor. A render reads D1 in several dependent waves. From a distant data center each wave costs a full round trip to the database (about 200 ms from Europe, 1-5 ms beside it, as measured in the config comment). The database is in APAC and served from Singapore. If the database moves, read `served_by_colo` from `wrangler d1 execute <db> --remote --json --command "SELECT 1"` and change the region.

## Page cache

### Which requests use it

A request uses the shared page cache (`getPublicStorefrontCachePolicy`) when all of these hold:

- The method is GET or HEAD.
- The request has no `Authorization` or `X-API-Token` header and no `cs_tok`, `cs_auth` or `stp_theme_preview` cookie. Other cookies (analytics, ad click) do not matter: the render drops every cookie.
- After tracking parameters leave, the query has at most 30 entries, each key at most 64 characters and each value at most 512.
- The URL is not a product page with a `size` or `color` query (a variant selection).
- The path is public: home, `/products|categories|brands|collections/<slug>`, `/products/<slug>/reviews`, `/pages/<slug>`, one-segment CMS pages, the category index, `/navigation/panels`, `/search`, the blog and its feed, `/llms.txt`, `/robots.txt`, the sitemaps and `/sitemap.xsl`, both product feeds, `/.well-known/ucp`, and the cart shell.

The private paths, the cart exception and the browser `Cache-Control` values are in [apps/storefront/README.md](../apps/storefront/README.md#public-cache-and-private-pages). Private paths render for every request and are `no-store`.

`X-Cache-Status` reports the lane: `HIT`, `MISS`, `BYPASS`, `BYPASS_AUTH`, `BYPASS_VARIANT_SELECTION`, `BYPASS_DEGRADED` (the page rendered from a failed read and called `markRenderUncacheable`) and `NO_CACHE`. A stored page is also a `MISS` on the request that renders it. Direct API reads report `HIT`, `MISS`, `REFRESH` or `BYPASS`.

### Key

```text
<origin>/__cache/<BUILD_ID>/<storefront Worker version>/dvc<path><query>
```

- The path and query are canonical: sorted query, empty values removed, no tracking parameters or `_sv`, `q` and `search` whitespace collapsed, and default `page=1` and `sortBy=newest` removed on category, collection, blog and search paths.
- The gateway renders the canonical URL without cookies, so every anonymous visitor gets the same bytes.
- `BUILD_ID` comes from `apps/storefront/scripts/generate-build-id.js` (see "Build" in [apps/storefront/README.md](../apps/storefront/README.md#build)). The page reports it in `X-Storefront-Build`, and deploy verification compares it.
- The Worker version comes from `CF_VERSION_METADATA.id` through `readWorkerVersion` (`packages/shared/src/cache-generation.ts`). Cloudflare assigns a new id to every deployed version, and the same id to every isolate of it. `wrangler dev` assigns a new id on every start and reload. Reading it costs no KV or D1 call.
- Without the binding, `readWorkerVersion` returns null and nothing is cached. `pnpm check:env` fails when a Wrangler config lacks `"version_metadata": { "binding": "CF_VERSION_METADATA" }`.
- The key uses the Worker version, not a hash of the response schemas. A schema hash misses a fix to how a field is computed under the same schema.
- Every deploy of a Worker starts its public cache cold. The first page per data center after a deploy is a miss. Nothing purges old entries: nothing addresses them, and Cloudflare evicts them.
- `pnpm run deploy` deploys the API before the storefront. Old storefront HTML stays consistent with the API that rendered it until the storefront version changes.

### Ad-click and campaign parameters

The canonical URL drops these query keys (`isStorefrontTrackingQueryParam` in `packages/shared/src/storefront-cache-path.ts`): every `utm_*`, `fbclid`, `gclid`, `gbraid`, `wbraid`, `gad_source`, `gad_campaignid`, `srsltid`, `msclkid`, `ttclid`, `yclid`, `mc_cid`, `mc_eid`, `igshid`, `_ga` and `ref`. The key also drops `_sv`. An unknown parameter stays, because it may change the page. The render sees the canonical URL, so canonical links, filters and pagination links never carry them. They do not count toward the query bounds. There is no redirect: the browser URL keeps them for client analytics. Tests: `packages/shared/src/storefront-cache-path.test.ts`, `apps/storefront/src/lib/public-worker-cache.test.ts`.

### Validity

A page entry is valid by committed dependencies, not by age. An unchanged entry can hit for months. The full contract (registry, triggers, `deps.*` declarations, frontier proofs, one-second freshness bound) is in [packages/core/src/cache-deps/README.md](../packages/core/src/cache-deps/README.md). The parts that shape performance:

- A page entry carries the union of its parts' dependency hashes (at most 1,024) and the oldest `s0`. A page is stored only when every API read of its render came through a batch part with a proof.
- The gateway validates a hit against a frontier of its data center that is at most 1 s old (`CACHE_FRONTIER_DELTA_MS`). It refreshes the frontier in the background after 0.5 s. One refresh and one slow check run per isolate, and concurrent requests join them. If the frontier cannot refresh in 1.5 s, the page renders.
- `decideCacheFrontierHit` (`packages/shared/src/cache-frontier.ts`) serves an entry, renders it again, or asks the slow check. Limits of the slow check are in [FREE-PLAN.md](./FREE-PLAN.md#frontier-cache-refresh).
- A scheduled change (a promotion start or end) sets `validUntil`. The gateway never serves the entry at or after it. Buyer facts have no stale-if-error allowance.
- The dashboard "view on store" link adds `_sv=<clock>`. The gateway refreshes its frontier to at least that clock before it reuses an older proof. `_sv` never enters a key or a render.
- `DEPENDENCY_CACHE_RETENTION_SECONDS` (one year) is a storage hint for the Cache API, not a validity period. Cloudflare may evict earlier, which costs one render.
- Public product, search and feed projections carry `availabilityBand`. `stock` and `reservedStock` are stable compatibility values, never exact quantity. A write inside one band changes no bytes and no dependency. Cart and checkout stay the live authority.

Gates: `apps/api/src/cache-dvc.property.test.ts` (random writes against every cached read), `apps/api/src/cache-dvc.race.test.ts` (commit-order races), `scripts/cache-dvc-long.mjs` and `scripts/cache-dvc-load.test.ts` (local only).

## The cart shell

The `GET /cart` HTML does not depend on the buyer, so the gateway caches it like a public page (`isBuyerShellPathname` in `apps/storefront/src/lib/cache-policy.ts`):

- The cart lines live in `localStorage` (`cart:v3`). An inline script paints them, or the empty state, before first paint.
- Sign-in state comes from the browser (`cs_auth=1`). Saved details and discounts come from no-store APIs. Cart validation, the tax quote and the order go through server APIs or the POST.
- The reads are public and dependency-validated: layout, cities, shipping methods, checkout copy and checkout settings.

| Input | Handling |
| --- | --- |
| `?quickBuyStorage=blocked` | A hidden notice that an inline script reveals from `location.search`. The key drops every `/cart` query. |
| Session cookie (`cs_tok`, `cs_auth`) | The request bypasses the cache, like any page. |
| POST (cash-on-delivery form, discount form without JavaScript) | Never cached. The server handles it. |
| A failed read (fail-closed "checkout unavailable") | Rendered for this request only: `markRenderUncacheable` sets `no-store`, the middleware answers `BYPASS_DEGRADED`, and the gateway does not store it. |

One entry serves `/cart` for a build and Worker version, rendered from a cookie-less request. The browser copy stays `private, no-cache, no-store, must-revalidate`, because the buyer types contact details into the page. Prefetch of `/cart` stays off.

Guardrails: `apps/storefront/src/lib/cart/cart-shell.render.test.ts` renders the real page with buyer cookies and queries and asserts identical bytes, one API batch, uncacheable failed renders, and a working cash-on-delivery POST. `public-worker-cache.test.ts` covers the gateway.

## Budgets and guardrails

| Guardrail | Where | Limit |
| --- | --- | --- |
| API calls per page render | `apps/storefront/src/lib/api/render-batch.test.ts` (`PAGE_API_CALL_BUDGET`), `cart-shell.render.test.ts` | 1 for home, product, category, search and cart |
| D1 round trips and waves of a cold render | `apps/api/src/storefront-render-budget.test.ts` (`PAGE_D1_BUDGETS`) | table below |
| Validation statement | same test | exactly 1 statement, in wave 1. Every render statement starts in wave 2. |
| The same page again (all parts validated hits) | same test | exactly 1 statement, 1 wave, identical bodies |
| A page with one app drawing | same test (`APP_PAGE_D1_BUDGETS`) | home 12 / 2, product 20 / 3 |
| Batch safety: public parts only, per-part status, versioned keys | `apps/api/src/storefront-batch.test.ts`, `storefront-batch-route.test.ts`, `packages/shared/src/public-api-cache-routes.test.ts` | exact |
| Cold start: every batchable read is in a read-only route family | `apps/api/src/runtime/storefront-render-families.test.ts` | exact |
| Generated payloads stay unloaded outside their routes | `apps/api/src/runtime/generated-payload-boundaries.test.ts` | exact |
| API Worker size | `pnpm check:api-bundle` (also in every deploy) | at most 90% of 64 MiB uncompressed |
| Product JSON-LD weight | `apps/storefront/src/lib/commerce-structured-data.product-group.test.ts` | at most 20 KB (`PRODUCT_JSON_LD_MAX_BYTES`); see [Images](#images) |
| Dependency cache correctness | `apps/api/src/cache-dvc.property.test.ts`, `cache-dvc.race.test.ts` | zero findings |
| TTFB, LCP and CLS in a real browser | `pnpm perf:storefront` | [thresholds](#pnpm-perfstorefront) |
| Template fidelity, listing density, navigation at scale, page weights | `pnpm fidelity:check` | [tolerances](#pnpm-fidelitycheck) |
| Free plan D1, KV, queue and CPU cost per operation | `pnpm free-plan:budget` | [FREE-PLAN.md](./FREE-PLAN.md) |

D1 budgets of a cold render, per page (seeded store; the home page uses every section type; a batch counts as one round trip):

| Page | Round trips | Waves |
| --- | ---: | ---: |
| Home | 13 | 2 |
| Landing page | 13 | 2 |
| Product | 21 | 3 |
| Category | 7 | 3 |
| Collection | 7 | 3 |
| Search | 7 | 2 |

A product with 6 reviews may use 22 round trips in 3 waves.

Parts that read in more than one step:

- The layout part uses 2 round trips in 2 waves. The first batch reads analytics, settings documents, theme, checkout language, store-shape counts, the category tree, brand images, active apps and placed menus. The second batch reads the policy pages and the resources the menus link to.
- The homepage part uses 2 batches. The first reads the SEO document, the active collections and the published theme. The second reads every product list, section image, category tile, brand, promotion and a product homepage's product.

A wave is a round of D1 calls that must wait for the previous one. Each wave costs a full database round trip. A new sequential `await` in a storefront read fails the budget test even when the query count stays the same.

The validation statement reads the clock and the current Platform settings together before any cold render. A cached Platform snapshot cannot replace it: a new URL after a settings edit must apply at once. The test recognizes this statement by its SQL, counts it separately, and counts every other statement against the page budget. The test prints each page's measured counts as `[storefront budget]` lines.

## `pnpm perf:storefront`

`pnpm perf:storefront` (`scripts/storefront-perf.mjs`) measures TTFB, LCP and CLS of built Workers. It sends only GET requests, except for the local `--d1-explorer` option. It checks these pages by default: the home page, the first category and product linked from home, `/search?q=a` and `/cart`. For each page it records:

- Server TTFB of a cache miss and the median of the hits. A 5xx first response is a failure. Against a remote base, it subtracts the TTFB of the edge's own `/cdn-cgi/trace` (the network round trip) from the hit TTFB and prints both values.
- In headless Chrome, LCP, CLS, TTFB and transfer size. The phone profile is 390x844 at DPR 3, 150 ms latency, 1.6 Mbps down, 750 kbps up, 4x CPU slowdown. The desktop profile is 1440x900. The browser cache is off. Metrics are read 1.5 s after load.

It exits 1 when a threshold is exceeded:

| Metric | Threshold | Flag |
| --- | --- | --- |
| Cache-hit TTFB | 50 ms | `--budget-ttfb-hit-ms` |
| Cache-miss TTFB (and TTFB of pages that always render) | 300 ms | `--budget-ttfb-miss-ms` |
| Phone LCP | 1500 ms | `--budget-lcp-phone-ms` |
| Desktop LCP | 1200 ms | `--budget-lcp-desktop-ms` |
| CLS (either profile) | 0.1 | `--budget-cls` |

Other flags: `--base <origin>` (default `http://localhost:4391`), `--paths "/,/products/x"`, `--runs <n>` (default 3), `--profiles phone,desktop`, `--no-browser` (TTFB only), `--json`, `--media-url <origin>` and `--no-binding-check`. `--cdp-port <port>` (default 9395) names the Chrome debugging port. The script starts and stops its own headless Chrome when nothing listens there. `--kv-explorer` is retired.

### Forced misses on a local stack

`--d1-explorer <origin>` advances the store dependency and the clock in the local D1 through the Wrangler local explorer. The first timed request carries that clock value as `_sv` and must report `MISS` or `REFRESH`. Hit samples count only verified `HIT` responses with status 200. Both origins must be loopback addresses.

```sh
pnpm perf:storefront --base http://localhost:4391 --d1-explorer http://localhost:8811
```

The ports above are examples. Without `--d1-explorer`, the script reports the first request as "first" (a miss or a hit, whatever the edge had).

Wrangler's dev registry is shared by every local stack on the machine, so a built storefront's `BACKEND_API` binding resolves by Worker name:

- `scripts/dev-ports.mjs` gives an API on a non-default port the name `scalius-api-local-<api port>`. The default stack keeps `scalius-api-local`. `apps/api` `pnpm dev` passes the name as `--name`.
- `node scripts/dev-ports.mjs storefront-config` writes `apps/storefront/dist/server/wrangler.local.json`, which binds the built storefront to that name. `astro dev` calls the API over HTTP and never uses the binding.
- Against a local base the script first checks that the storefront home page carries its own canonical origin. Another stack's API would render that stack's origins, and the run stops. `--media-url` also checks the media origin. `--no-binding-check` skips the check. `node scripts/dev-ports.mjs verify-binding` runs the same check for a `pnpm dev` stack.

### Live, read-only

A miss cannot be forced on a live store. The first request counts as a miss only when the edge reports `X-Cache-Status: MISS`.

```sh
pnpm perf:storefront --base https://storefront.scalius.com
```

Miss TTFB from a laptop includes the network round trip to the edge. From Bangladesh, some ISPs reach Cloudflare in Europe (MXP, MAD, CDG, MRS) as often as in SIN or HKG. That adds 150-450 ms per TLS connection. Read the data center from `cf-ray` before you blame the server. Do not use the Astro development server as a baseline.

## `pnpm fidelity:check`

`pnpm fidelity:check` (`scripts/storefront-fidelity/check.mjs`) measures the built storefront templates against reference sites. It reads the reference numbers from `scripts/storefront-fidelity/reference-metrics.json` and exits 1 on any breach. Attach its report to every storefront pull request.

```sh
pnpm fidelity:check                                   # everything
pnpm fidelity:check --only spec-catalogue --report-only
pnpm fidelity:check --only listing,marketplace --state-cache /tmp/fidelity-cache
```

One run does these steps in order:

1. Run `astro build` for the storefront. `--skip-build` reuses `dist/`.
2. Seed a temporary D1, KV and R2 state that the run owns (`seed-large.mjs`). The seed is the catalogue-scale store ([below](#load-data)) plus:
   - the 400 categories reshaped into a 25/125/125/125 four-level tree with long and Bangla names, and 300 brand entities;
   - 240 generated photos with real rendition ladders (`pool.mjs`, sharp), 1% legacy primary images with no renditions, 2% products without a photo, and three video products (ffmpeg);
   - a 12-category homepage tile section, theme hero slides, and five navigation menus (`menus.mjs`: 20 links, 150, 136 on 3 levels, 1,150, and a flat 12);
   - the catalogue projections (migration 0091's statements).

   `--state-cache <dir>` keeps a copy keyed by a fingerprint of the seed code and the migrations. Later runs copy it instead of seeding.
3. Start the API and the built storefront under `wrangler dev` on that state. Defaults: API 9001, storefront 4601, admin 4602, media 4603, Chrome 9601 (`--api-port`, `--storefront-port`, `--admin-port`, `--media-port`, `--chrome-port`).
   - The API runs as `scalius-api-local-<api port>` and the storefront binding targets that name. Both use a private dev registry. The run stops unless the storefront home page carries this stack's origins.
   - Secrets are random values in a temporary env file. No `.dev.vars` is read.
   - The run refuses a state inside any repo `.wrangler` directory and any hosted database (`DATABASE_PROVIDER`, `TURSO_*`, `POSTGRES_*`).
   - The Platform `mediaUrl` points to a small static server over the photo pool (`scripts/storefront-fidelity/lib/media-server.mjs`). Image traffic stays off the Workers under test.
   - If a Worker dies, the stage restarts the stack once and resumes. A stage that fails twice is a failing check.
4. Measure with one headless Chrome over CDP:
   - `matrix.mjs` and `probe.js`: every template on home, category and product at 1440x900 and 390x844 (DPR 3). It records header, search, card, listing, facet column, buy box and footer geometry, type sizes, and HTML, header and JSON-LD weight.
   - `variants.mjs`: each card variant and each listing layout of `department-mall` swapped alone, compared pixel by pixel.
   - `navscale.mjs`: every template with the five menus at 1440, 1280 and 1024: open panel, "More", keyboard, phone drawer, and no JavaScript.
   - `perf.mjs`: dependency-cache TTFB miss and hit, and phone and desktop LCP and CLS for home, category and product on every template, plus the 100-SKU, legacy-image and video products.
   - `hover.mjs`: hover photo latency at 10 Mbps and 60 ms.
   - The small-catalogue pass (`seed-tiny.mjs`): 20 active products in two leaf categories and the 20-link menu.
5. Compare (`scripts/storefront-fidelity/lib/compare.mjs`, tested in `compare.test.mjs`), write the report, stop every process tree it started, and delete the temporary state.

The report goes to `.wrangler/fidelity/` (`--out` changes it):

- `summary.md`: the verdict, pass or fail per template and block, and every breach with our value, the reference, the rule and the source.
- `scorecard.json`: every check and the raw measurements.
- `pairs/`: the reference first screen beside ours. `shots/`: our screenshots.

 Reference screenshots are not in the repository. `--ref-shots <dir>[,<dir>]` names the folders. Without them the pairs report "unverified".

Tolerances (`DEFAULT_TOLERANCES` in `scripts/storefront-fidelity/lib/compare.mjs`, overridable in `reference-metrics.json`):

| Rule | Metrics | Passes when |
| --- | --- | --- |
| size | header, search, card, CTA, footer, facet column, row pitch | within 10% (never tighter than 2 px) |
| gap | card gap | within 4 px |
| font | card title and price, product h1 and price | size within 1 px, weight within 100 |
| exact | grid columns | equal |
| ratio | card image ratio | within 0.05 |
| min | products visible; filters visible (large-catalogue templates) | at least the reference |
| scroll | bottom of the 20th product | at most 1.1x the reference |
| firstY | first product position | at most the reference + 40 px |

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
| Card variants | at least 25% of pixels differ and at least 3 buyer-visible treatments differ; card photo fetched at most 1.2x its drawn width; phone card title at least 14 px |

Blocks for `--only`: `header`, `card`, `listing`, `pdp`, `footer`, `size`, `perf`, `nav`, `variants`, `hover`, `tiny`, and any template name. A filter also skips the stages it does not need. `--report-only` writes the same report and exits 0. Use it while a slice closes its gaps. The merge gate is the plain command.

Each template maps each block to one reference site (`templates` in `reference-metrics.json`). For example `spec-catalogue` uses Star Tech for every block, and `mass-retail` takes its header from Target and its cards from the Pickaboo card. `node scripts/storefront-fidelity/density.mjs --out refs.json` re-measures the reference listings. It makes read-only page loads and never accepts a cookie dialog.

Other flags: `--keep-run` (keep the temporary run directory), `--min-free-pct` (default 25) and `--max-swap-mb` (default 7000). The run aborts when free memory falls below `--min-free-pct` (macOS `memory_pressure`) or, where that is unreadable, when used swap passes `--max-swap-mb`. A full run takes about 25 minutes and peaks near 3 GB of physical memory (measured when the harness was written, not re-run in this review). Never run it beside a typecheck or another stack on a 16 GB host. Generated studio photos compress 3-5 times better than real photos, so image bytes are understated.

## Catalogue scale

### Load data

`scripts/catalog-scale-seed.mjs` fills a migrated local D1 state that you own with a deterministic store at the scale of Star Tech and Apple Gadgets. The store has:

- about 30,000 products (60% simple, 40% optioned) and about 80,000 SKUs, with ledger v2 stock edges;
- 400 categories in four levels, 300 published brands, 30 spec attributes and 1-4 images per product;
- 50 collections, 20,000 customers and 50,000 orders.

Options: `--products`, `--customers`, `--orders`, `--seed`. The seed fills the catalogue projections at the end. It refuses the shared repo `.wrangler` state and a state that already has products.

```sh
SCALIUS_WRANGLER_STATE=/tmp/catalog-scale/state node scripts/deploy.mjs --migrate-only --local
node scripts/catalog-scale-seed.mjs --state /tmp/catalog-scale/state
```

Opt-in harnesses use it. Each skips unless its variable is set:

- `scripts/catalog-scale-profile.test.ts` runs API routes in-process on a Miniflare D1 over a copy of the state. It reports p50, p95, D1 statements, dependent waves and `rows_read` per route (`CATALOG_SCALE_STATE`, `CATALOG_SCALE_TARGETS`, `CATALOG_SCALE_OUT`; see its header).
- `apps/storefront/src/lib/route-tests/api/catalog-feed-scale.test.ts` walks the whole XML product feed against a running local API (`CATALOG_SCALE_API`) and reports reads, time, heap and size per window.
- `scripts/cache-dvc-load.test.ts` replays reads and buyer-visible writes against the dependency cache (see its header).

### Projections

Listings, counts, the product sitemap and recommendations read stored projections, not per-request eligibility and ranking over every SKU. The code is `packages/core/src/modules/products/catalog-projections.ts`.

- `product_buyer_state`: one row per product with the public flag, category, brand, card SKU, from, to and base price, discount depth, availability and the card SKU's band.
- `product_facet_values`: one row per product attribute value and per SKU option value.
- `product_recommendations` (stored top 24 per product) and `product_sales_stats` (units sold in 30 days, used by the home "popular" list).

Every product, SKU, option-matrix, stock and checkout write appends the refresh statements to its own D1 batch, after the ledger v2 edge and the `stockVersion` check. The projection commits with the write. Projections are not authority: cart validation and checkout stay authoritative.

- Migration `0091_catalogue_projection_fill` fills both projections. It is generated from `catalogProjectionFillStatements` (`packages/core/scripts/catalog-projection-fill.ts --write`), and a test keeps the checked-in files equal to that output.
- Repair: `POST /api/v1/admin/catalog/projections/rebuild`, the queue job `catalog.projections.rebuild`, and a nightly pass at the first 15-minute cron tick after 20:00 UTC. The first cron tick of every new API version queues one full rebuild (KV hint `catalog:projections:rebuilt-for-version`). A rebuild that finds no drift advances no dependency. `catalog-projections.d1.test.ts` compares the projections with a fresh computation after random writes.
- Recommendations: a product page reads its stored list, filtered by the current buyer state. Products never computed, carts and pages without a source use a live ranking. Product writes queue `catalog.recommendations.refresh` for the product, the products that list it and its newest category peers. The nightly pass refreshes `product_sales_stats` and the 3,000 oldest or missing lists.

Facet and listing rules are in [`packages/core/src/modules/catalog/README.md`](../packages/core/src/modules/catalog/README.md). `facets-scale.local.test.ts` checks every facet count against a brute-force count on the 30,000-product seed.

### Listing reads

The plan sets the count cap and the page depth (`planLimits().lists`: `countCap` and `maxOffset`; see the catalog README and [FREE-PLAN.md](./FREE-PLAN.md#large-lists)). For the plain shop-all page:

- The count is `SELECT count(*) FROM (SELECT 1 ... LIMIT cap + 1)`.
- `MIN(from_minor)` is one probe of `product_buyer_state_price_idx`. `MAX(to_minor)` has no index and reads the public rows. No migration adds an index on `(is_public, to_minor)`.
- A scoped listing (category, brand, collection, search) or a filtered listing reads its own rows once for count, `MIN` and `MAX`. The scope bounds that read.

A numbered page deeper than `maxOffset` is an empty page and reads no rows. The storefront answers it with 404. `newest`, `price-asc` and `price-desc` continue with the `cursor` from `pageInfo.endCursor`.

## Cold start

A cache miss that lands on a fresh API isolate pays module start-up on top of the render. These rules keep that cost low:

- A page is one batch, and every part runs in the batch's own invocation. A render pays for at most one API isolate start, and usually none, because the isolate that serves renders stays warm. The parts share module promises, so each route family loads once.
- API placement concentrates traffic in one data center, so isolates stay warm far more often.
- The API loads route families lazily (`classifyPublicRuntimePath` in `apps/api/src/runtime/public-app.ts`): `config`, `catalog`, `content`, `buyer` and `proxy`. A render must not load the `buyer` family (orders, customer auth, agent contexts), so every batchable read, including `checkout/config`, lives in a read-only family. `storefront-render-families.test.ts` enforces it.
- The generated payloads (`apps/api/src/generated/openapi-contract.gen.ts`, `agent-operations.gen.ts`) stay unevaluated outside their own routes.
- Worker size is a coarse proxy for start-up cost. `pnpm check:api-bundle` budgets 90% of the 64 MiB uncompressed limit.
- Splitting the API into more bundles does not help under the default workerd module registry. See the 2026-09-25 experiment in [PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md#cold-start-experiments). The Worker stays one script, and the storefront and API stay two Workers.

## Images

- Uploads get WebP renditions at `media/<id>.<ext>/<w>.webp` on a fixed ladder (`MEDIA_VARIANT_WIDTHS` in `packages/shared/src/media-variants.ts`: 144 to 1600, each step at most 1.2 times the one below; master up to 2400). The dashboard browser pipeline or the API `IMAGES` binding renders them at upload. No image transformation service runs on the delivery path. The storefront image service is `passthrough`.
- Every storefront surface uses `srcset` and `sizes` from those renditions (`apps/storefront/src/lib/responsive-image.ts`).
- The two large LCP images, the home hero and the product gallery's main photo, use `capSizesDensity`. It repeats each `sizes` entry first under `(min-resolution: 2.5dppx)` with the width scaled by 0.666. A DPR 3 phone then fetches about 2x pixels, not 3x. Card photos use the phone-only variant `capPhoneSizesDensity`. Thumbnails and screens below DPR 2.5 keep full density.
- The product gallery waits for a new photo to decode (up to 500 ms) before it swaps `src`, `srcset`, `sizes` and `alt` together. After load it preloads the photos a switch can show, 2 at a time, up to 8 (3 on a 3G connection, none with data saver or 2G).
- A new upload queues a delayed `media.render_variants` job (about two minutes). The scheduled backfill renders what is still missing within a time budget per cron run.
- An image without renditions heals itself. When a rendered (miss) public API read still publishes an original `media/<id>.<jpg|png|webp|avif>`, the API queues that media id's `media.render_variants` job at once. A 15-minute KV marker deduplicates it, and one read queues at most 24 ids (`apps/api/src/utils/media-rendition-hints.ts`). Buyers see the original until the job renders. The job then advances the media dependency, and pages switch to the renditions. `apps/api/src/routes/admin/media-upload-paths.test.ts` checks that every upload path queues the job.
- Images inside rich descriptions that have no renditions (external images, or an original URL saved in the text) keep their source. They always get `loading="lazy" decoding="async"` (the first image of priority content stays eager), their authored `width` and `height`, and a size from the URL when an image CDN states both. A description that saved an original URL before its renditions existed keeps pointing at the original. The saved text cannot show that renditions exist.
- Product JSON-LD states the description once (plain text, at most 1,000 characters), never per variant. Each variant carries one photo and no repeated brand. The script is capped at 20 KB. A product whose variants do not fit lists the complete variants that do, in order. The page still sells every SKU.
- Web fonts from theme presets load with `font-display: swap` and metric-matched fallbacks, so they must not move LCP or CLS. `pnpm perf:storefront` shows it if they do.

## Delivery rules

Build output, the CSS inline limit, the preconnect `Link` header and the prefetch deny list are in [apps/storefront/README.md](../apps/storefront/README.md). Rules that protect first paint:

- Astro sessions are off (`session: false` in `apps/storefront/astro.config.mjs`). Nothing reads `Astro.session`, so the adapter adds no KV session driver.
- Analytics scripts that run in Partytown load through a hashed bootstrap after first paint (`apps/storefront/integrations/deferred-partytown.mjs`). The bootstrap renders only on pages whose enabled analytics script runs in Partytown.
- The Cloudflare Web Analytics beacon loads as a module script with `fetchpriority="low"` (`apps/storefront/src/lib/analytics-script-delivery.ts`).
- The preconnect `Link` header must stay a fixed CDN origin. A preconnect transfers no merchant bytes, so Cloudflare's URI-keyed Early Hints cache cannot serve stale price, stock or hero content.
- The product gallery loads its desktop zoom controller only when the desktop media query matches.
