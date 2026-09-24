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
   policy uses). The route runs each part through the `PublicApi` Workers Cache
   entrypoint under `path + sorted query + __cg=<generation>`, so parts shared
   by many pages (layout, shipping methods, checkout settings) are computed once
   per generation. The batch response is `private, no-store`. Each part keeps
   its own status, a failed part fails only that part (as a failed read did
   before), and error parts are never cached.
4. **Placement.** `apps/api/wrangler.jsonc` uses **targeted placement by
   region**: `"placement": { "region": "aws:ap-southeast-1" }`. The API's fetch
   handler runs beside the D1 primary (APAC, served from SIN) instead of beside
   the visitor. The storefront Worker is not placed, so cache hits stay at the
   visitor's edge. Smart Placement (`"mode": "smart"`) was not used: it needs
   steady traffic from several regions before it places anything, and this
   store's traffic is too light. If the database moves, check
   `served_by_colo` in `wrangler d1 execute <db> --remote --json --command "SELECT 1"`
   and change the region to match.

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
