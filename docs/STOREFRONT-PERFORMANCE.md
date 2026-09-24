# Storefront render performance

Last reviewed: 2026-09-24

How a storefront page is served, what each page is allowed to cost, and how to
check it. The release-wide evidence lives in
[PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md).

## Render path

1. **Cache hit.** The storefront gateway (`apps/storefront/src/worker.ts`,
   `lib/public-worker-cache.ts`) reads the store's cache generation from KV and
   serves the page from the Cache API under `build + generation + canonical URL`.
   No API call. Measured server time at the edge: 3-20 ms.
2. **Cache miss.** Astro renders the page. Each page starts all of its public
   reads together, including the layout read, and the storefront transport
   (`lib/api/transport.ts`, `joinReadBatch`) sends them as **one** request:
   `GET /api/v1/storefront/batch?r=<part>&r=<part>`. That is one service-binding
   hop and one API invocation per page, with no sequential layout-then-page hop.
   - The middleware no longer awaits the layout before storefront pages
     (`isLayoutBatchedPagePath`). Those pages await it together with their own
     reads, and the layout promise applies the platform origins when it
     resolves. Every other route (proxies, sitemaps, feeds, account) still gets
     the origins before it runs.
   - A read joins the batch until the render yields (`setTimeout 0`). A lone
     read goes as itself. An API without the batch route (answering non-200)
     makes each read go on its own, so a storefront deployed before the API
     keeps working. Authenticated, private, write and non-cached reads are
     never batched.
   - Public reads on a public API URL get a 2 s service-binding deadline and
     then one HTTPS retry. A read addressed to the internal service origin,
     which includes every render's first batch because the platform API URL
     arrives with the layout, has no public URL to retry. It keeps its full
     deadline, because a short one would turn a slow cold read into a 503.
     Before this change, that turned a cold layout read at HKG into a 503 home
     page.
3. **The batch in the API** (`routes/storefront.ts` `storefront.batch.get`,
   `storefront-batch.ts`). Only public generation-cached routes can be parts
   (`@scalius/shared/public-api-cache-routes`, the same list the API cache
   policy uses). The route serves every part **inside its own invocation**
   (`apps/api/src/public-read.ts`):
   - It first looks the part up in the data center's Cache API
     (`caches.default`) under `publicReadCacheKey`: `path + sorted query +
     __cg=<generation>`. That is the same function the `PublicApi` entrypoint
     path uses, so the two cannot drift apart.
   - On a miss it renders the part in-process with `renderPublicRead`. That
     is the render `PublicApi` itself runs: the runtime app, the baseline
     security headers, and the public cache headers.
   - It stores a part only when the result is a 200 this Worker produced,
     with the public cache headers and no cookie. The stored copy lives
     `PUBLIC_CACHE_MAX_AGE_SECONDS`.
   - Parts shared by many pages (layout, shipping methods, checkout
     settings) are therefore computed once per generation per data center.
   - Up to four parts render at once (`MAX_BATCH_PART_RENDERS`); D1 queues
     the rest on the invocation's six connections.
   - The batch response is `private, no-store`. Each part keeps its own
     status, a failed part fails only that part, and error parts are never
     stored.

   Why the batch does not call the `PublicApi` Workers Cache entrypoint: live
   tails on 2026-09-25 showed that each entrypoint miss runs in a separate
   isolate pool behind the cache layer. At this traffic level that pool is
   usually cold, so each miss paid 350-600 ms of isolate start-up plus
   150-330 ms of CPU for module initialisation, while the storefront's own
   API isolate was warm. With that hop, a product page miss took 0.7-1.2 s.
   Without it, the batch costs about as much as its slowest part. Direct
   browser reads on `api.<store>` still go through the `PublicApi`
   entrypoint (with the cache-layer 5xx fallback below).
   `apps/api/src/storefront-batch-route.test.ts` checks that a part answered
   in-process has the same status, body and cache headers as the same read
   through `PublicApi`.
4. **Placement.** `apps/api/wrangler.jsonc` uses **targeted placement by
   region**: `"placement": { "region": "aws:ap-southeast-1" }`. The API's fetch
   handler runs beside the D1 primary (APAC, served from SIN) instead of beside
   the visitor. The storefront Worker is not placed, so cache hits stay at the
   visitor's edge. Smart Placement (`"mode": "smart"`) was not used: it needs
   steady traffic from several regions before it places anything, and this
   store's traffic is too light. If the database moves, check
   `served_by_colo` in `wrangler d1 execute <db> --remote --json --command "SELECT 1"`
   and change the region to match.

## Cold isolates

A cache miss that lands on a fresh isolate pays module start-up on top of the
render. Measured 2026-09-24 on the production API bundle (`wrangler deploy
--dry-run`, 8.7 MB minified). The bundle was imported into plain Node V8 with
the `cloudflare:*` imports pointed at stubs. Each first request ran with no
database, so only module initialisation was timed. Figures are the median of
three runs:

| Step | Wall | CPU |
| --- | --- | --- |
| Isolate start: parse and compile the whole 8.7 MB script, plus top-level evaluation (zod, drizzle and the schema, the Neon/Turso drivers) | 150 ms | 170 ms |
| First read into the `config` family (layout, storefront, shipping, checkout settings) | 52 ms | 74 ms |
| First read into the `catalog` family (products, categories) | 9 ms | 12 ms |
| First read into the `buyer` family (orders, customer auth, agent contexts) | 28 ms | 43 ms |
| Any of the above again (warm) | about 1 ms | about 1 ms |

These match the production `wrangler tail` figures of 110-250 ms CPU on cold
`PublicApi` invocations. Of the eager evaluation, zod accounts for about 20 ms
and the Neon and Turso drivers for about 5 ms. Everything else in the
start-up cost is V8 parsing a script of that size, so it scales with the
bundle size, not with what a request runs.

What the render path does about it:

- A page is one batch (the cart adds one uncached language read), and every
  part is served inside the batch's own invocation. A render therefore pays
  for at most one API isolate start, and usually none, because the isolate
  that serves storefront renders stays warm. The parts share the module
  promises, so each family loads once.
- `/api/v1/checkout/config` used to sit in the `buyer` family, so every
  home, product and cart render also loaded orders, customer auth and agent
  contexts. It now belongs to `config` beside the layout, which saves
  36-50 ms wall and 48-58 ms CPU on each cold render that reads checkout
  settings. `apps/api/src/runtime/storefront-render-families.test.ts` keeps
  every batchable public read out of the `buyer` family.
- API placement concentrates traffic in one location, so its isolates stay
  warm far more often than when they were spread across visitor colos.

Measured locally, cold home (436 ms in a fresh storefront and API isolate on
the local stack):

- about 45 ms of storefront isolate start-up before the first read;
- 150-270 ms for the batch in a cold API isolate (parse, config family
  initialisation, first D1 connection), against 21-35 ms warm;
- one extra 46-64 ms hop for fallback products, only because the local store
  has no active collections (production home does not make it);
- about 40 ms of render.

What would remove most of the rest (not done; it is an architecture
decision): the ~100 ms parse cost comes from shipping the dashboard,
agent-access (MCP server, OAuth provider), Better Auth, Stripe and the
Postgres driver in the same script as the public reads. The modules the
public render path actually runs are about a fifth of the bundle. Two ways
to cut the parse cost to about a quarter for public reads:

- a separate public-read Worker behind the same service binding;
- a multi-module upload that code-splits the route families so V8 compiles
  a family only when it is imported. This needs a pre-bundle step with
  splitting and `no_bundle` with `find_additional_modules`.

## Known platform failure: a stuck Workers Cache key

Seen on 2026-09-24. In one colo (SIN), one key of the `PublicApi` Workers
Cache entrypoint (`/api/v1/storefront/homepage?__cg=<generation>`) answered
every request with the same broken response, while other colos and every
other key were fine:

- an empty-body `500` with `cf-cache-status: BYPASS`;
- none of our headers (no `X-Request-Id`, no security headers);
- no Worker invocation in `wrangler tail`.

The storefront pins its reads to that generation, so the home page was a 503
in that colo until the generation changed. The most likely trigger is a cache
fill that was cancelled mid-way: the storefront aborted a slow cold read
there. The deadline fix above removes that trigger.

How to recognise it:

```sh
curl -s -o /dev/null -D - https://api.<store>/api/v1/storefront/homepage
```

The same path with an extra query parameter (a different key) answers 200.

Handling: the API treats the generation cache as a hint
(`isCacheLayerServerError` in `apps/api/src/public-cache-policy.ts`). When the
cache entrypoint returns a 5xx without the baseline security headers that
every response of ours carries, the read is rendered directly and uncached,
and one masked `[PublicCache] cache layer answered ...` warning is logged with
the path and colo and no query values. This applies to single reads through
the entrypoint (`worker.ts`); storefront batch parts no longer go through the
entrypoint at all (see the render path above). Our own 5xx
passes through untouched, so a real outage does not double the database load.
Bumping the cache generation (any buyer-visible save) also clears it at once.

## Budgets and guardrails

| Guardrail | Where | Budget |
| --- | --- | --- |
| API calls per page render | `apps/storefront/src/lib/api/render-batch.test.ts` | 1 for home, product, category and search (the pages' own read functions, started as the pages start them) |
| D1 round trips / dependent waves per page (cache miss, seeded store) | `apps/api/src/storefront-render-budget.test.ts` | home 13 / 2, product 21 / 3, category 9 / 3, search 9 / 2 |
| Batch safety (public parts only, per-part status, generation-keyed parts) | `apps/api/src/storefront-batch.test.ts`, `packages/shared/src/public-api-cache-routes.test.ts` | exact |
| TTFB, LCP and CLS in a real browser | `pnpm perf:storefront` (`scripts/storefront-perf.mjs`) | below |

A "wave" is a round of D1 calls that must wait for the previous one. Each wave
costs a full database round trip, so a new sequential `await` in a storefront
read fails the D1 budget test even when the query count stays the same.

### `pnpm perf:storefront`

The script only sends GET requests. For every page (default: home, the first
category and product linked from home, a search, and the cart) it records:

- server TTFB for a cache miss and the median of three hits. Against a remote
  base, the hit TTFB is judged at the edge: the TTFB of the edge's own
  `/cdn-cgi/trace` on the same connection (the network round trip) is
  subtracted, and both raw values are printed;
- a 5xx first response is a failure;
- in headless Chrome, LCP, CLS, TTFB and bytes on a **phone** profile
  (390x844 at DPR 3, 150 ms RTT, 1.6 Mbps down, 750 kbps up, 4x CPU slowdown,
  browser cache disabled) and a **desktop** profile (1440x900).

It exits 1 when any threshold is exceeded:

| Metric | Threshold |
| --- | --- |
| Cache-hit TTFB | 50 ms |
| Cache-miss TTFB (and TTFB of pages that always render, such as the cart) | 300 ms |
| Phone LCP | 1500 ms |
| Desktop LCP | 1200 ms |
| CLS (either profile) | 0.1 |

Override any threshold with `--budget-<name> <value>`, for example
`--budget-lcp-phone-ms 1800`. Other flags: `--paths "/,/products/x"`,
`--runs 5`, `--profiles phone`, `--no-browser` (TTFB only), `--json`, and
`--cdp-port` (default 9395; the script starts and stops its own headless
Chrome when nothing listens there).

Local stack (forces real misses by writing a fresh `cache:generation` through
the local wrangler explorer):

```sh
pnpm perf:storefront --base http://localhost:4391 --kv-explorer http://localhost:8811
```

Live, read-only. A miss cannot be forced there, so the first request is
judged as a miss only when the edge reports `X-Cache-Status: MISS`:

```sh
pnpm perf:storefront --base https://storefront.scalius.com
```

Miss TTFB measured from a laptop includes the network round trip to the edge.
From Bangladesh, some ISPs reach Cloudflare in Europe (MXP, MAD, CDG, MRS) as
often as in SIN or HKG, which adds 150-450 ms per TLS connection. Read the colo
from `cf-ray` before blaming the server.

## Images

- Uploaded images get WebP renditions `media/<id>.<ext>/<w>.webp` on a fixed
  ladder (`packages/shared/src/media-variants.ts`). Every storefront surface
  uses `srcset` + `sizes` from those renditions. Cloudflare Image
  Transformations are not used.
- The two LCP images, the home hero banner and the product gallery's main
  photo, use `capSizesDensity` (`apps/storefront/src/lib/responsive-image.ts`).
  Every `sizes` entry is repeated first under `(min-resolution: 2.5dppx)`
  with its width scaled by 2/3, so DPR 3 phones fetch about 2x pixels.
  Measured on a 390 px phone:
  - product photo: 960w (9.6 KB) instead of 1600w (25.7 KB);
  - home hero: 960w (29.9 KB) instead of the 1080w master (52.8 KB).

  Thumbnails, cards and every screen below DPR 2.5 keep their full density.
- The product gallery swaps `src`, `srcset`, `sizes` and `alt` together on a
  variant or thumbnail switch and waits for the new image to decode (up to
  500 ms) before swapping. After load it prefetches the images a switch can
  show, two at a time.
- New uploads queue a delayed `media.render_variants` job. The scheduled
  backfill renders what is still missing within a time budget per cron run
  (`packages/core/src/modules/media/README.md`).
- Web fonts from theme presets load with `font-display: swap` and
  metric-matched fallbacks, so they must not move LCP or CLS. If they do,
  `pnpm perf:storefront` shows it.

## Baseline before this work (2026-09-24, live, round 4)

| Page | Miss TTFB (colo) | Hit TTFB at the edge | Phone LCP | Desktop LCP |
| --- | --- | --- | --- | --- |
| Home | 2.2-3.5 s (SIN, MXP); two 503s during measurement | 18 ms | 2.28 s | 0.66 s |
| Category | 2.7-4.6 s (MAD, MXP) | 21 ms | 8.49 s (original 254 KB JPEG) | 0.97 s |
| Product with options | 0.6-4.6 s (SIN, CDG, MRS, MXP) | 19 ms | 5.51 s (original 273 KB WebP) | 1.10 s |
| Search | 0.4-1.9 s (MRS, SIN) | 22 ms | 8.05 s | 1.04 s |
| Cart (always rendered) | 0.27-4.0 s | not applicable | 1.26 s | 0.45 s |

`wrangler tail` showed the causes:

- The API ran in the visitor's colo, far from D1. A product read spent
  1.0-1.9 s of server time outside SIN and 0.5 s at SIN.
- Every page made two or three sequential API hops.
- Each hop was a separate invocation, paying a cold-isolate CPU cost of
  130-250 ms and up to about 400 ms for the Workers Cache miss path outside SIN.
- A cold layout read at HKG exceeded the 2 s service-binding timeout, which
  returned a 503 page.
