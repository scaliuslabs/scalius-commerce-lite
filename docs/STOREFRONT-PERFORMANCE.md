# Storefront render performance

Last reviewed: 2026-09-26

How a storefront page is served, what each page is allowed to cost, and how to
check it. The release-wide evidence lives in
[PERFORMANCE-RELEASE.md](./PERFORMANCE-RELEASE.md).

## Render path

1. **Cache hit.** The storefront gateway (`apps/storefront/src/worker.ts`,
   `lib/public-worker-cache.ts`) validates the stored dependency proof against
   a frontier at most one second old, refreshing it through the API when needed.
   The key carries build, storefront Worker version and canonical URL; the
   proof also carries the API Worker version. A fresh local frontier needs no
   API call. The built frontier stack measured 5–9 ms warm HTTP responses in
   the local 2026-09-26 check below.
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
3. **The batch in the API** (`routes/storefront.ts`, `storefront-batch.ts`).
   Only public cacheable routes can be parts (`@scalius/shared/public-api-cache-routes`).
   Parts run inside this invocation through `apps/api/src/public-read.ts`,
   avoiding a separate cold Worker entrypoint for each part.
   - Production uses dependency validation (`API_PART_CACHE_MODE = strict`).
     Part keys contain path, sorted query and API Worker version. One bounded
     validation read checks the batch's cached dependencies against the committed
     clock; misses render in-process. Each successful part returns its dependency
     hashes, clock proof and API Worker version for the HTML cache.
   - Up to four parts render at once (`MAX_BATCH_PART_RENDERS`); D1 queues
     the rest on the invocation's six connections.
   - Only successful public responses without cookies can be stored. The batch
     itself is `private, no-store`; failed parts are never cached. Shared parts
     such as layout remain reusable across unrelated product edits.
   - Direct public reads use the same strict reader. Generation mode remains an
     explicit differential/load-test comparator, not production plumbing.

4. **Placement.** `apps/api/wrangler.jsonc` uses **targeted placement by
   region**: `"placement": { "region": "aws:ap-southeast-1" }`. The API's fetch
   handler runs beside the D1 primary (APAC, served from SIN) instead of beside
   the visitor. The storefront Worker is not placed, so cache hits stay at the
   visitor's edge. Smart Placement (`"mode": "smart"`) was not used: it needs
   steady traffic from several regions before it places anything, and this
   store's traffic is too light. If the database moves, check
   `served_by_colo` in `wrangler d1 execute <db> --remote --json --command "SELECT 1"`
   and change the region to match.

## The cart shell

`/cart` used to render for every request: 0.15-1 s of server time in
production (0.9 s once after a deploy) while every other page answered from
the cache in about 20 ms. Nothing in its GET HTML depends on the buyer:

- the lines live in `localStorage` (`cart:v3`) and an inline script paints
  them (or the empty state) before first paint;
- sign-in state is read in the browser (`cs_auth`), saved details and
  discounts come from no-store APIs, and cart validation, the tax quote and
  the order go through server APIs or the POST;
- the reads are public and dependency-validated: layout, cities, delivery
  methods, checkout settings and the checkout copy. Their committed dependency
  revisions invalidate affected entries.

What was buyer-specific, and where it went:

| Input | Before | Now |
| --- | --- | --- |
| `?quickBuyStorage=blocked` (quick buy could not write session storage) | read on the server, rendered as an error | a hidden notice, revealed from `location.search` by an inline script before first paint; the cache key drops every `/cart` query |
| Session cookie (`cs_tok`, `cs_auth`) | read only by the POST | unchanged: a request carrying one bypasses the cache, like every page |
| POST (COD form, discount form without JavaScript) | rendered | unchanged: never cached, handled on the server |
| A failed read (fail-closed "checkout unavailable", English copy) | rendered | rendered for this request only: `markRenderUncacheable` sets `no-store`, and the middleware answers `X-Cache-Status: BYPASS_DEGRADED` and the gateway does not store it |

So an anonymous `GET /cart` goes through the same gateway lane as a product
page (`isBuyerShellPathname` in `apps/storefront/src/lib/cache-policy.ts`):
one entry per build and Worker version, keyed on `/cart` alone,
rendered from a cookie-less canonical request. Two things differ from a
catalogue page: the browser copy is still
`private, no-cache, no-store, must-revalidate` (the buyer types contact
details and an address into this document), and prefetch of `/cart` stays
off. `/checkout`, payment, receipt and account pages are unchanged:
rendered for every request and `no-store`.

Guardrails: `apps/storefront/src/lib/cart/cart-shell.render.test.ts` renders
the real page with a buyer's cookies and query and asserts the HTML carries
none of them, that different buyers get identical bytes, that the page is one
API batch, that each failed read marks the render uncacheable, and that the
COD form still posts to `/cart` and a POST is still handled.
`apps/storefront/src/lib/public-worker-cache.test.ts` covers the gateway
(canonical key, cookie stripping, browser `no-store`, no Set-Cookie stored,
signed-in and POST requests rendered live).

Measured 2026-09-25 on a local built stack (`astro build` served by
`wrangler dev`, the API under `wrangler dev`, local D1; `pnpm perf:storefront`
with `--kv-explorer` forcing misses, 5 runs, plus 10 sequential `curl`s):

| `/cart` | Before (rendered for every request) | After (shell) |
| --- | --- | --- |
| After a generation change | 30-33 ms | 31-41 ms (once per generation, build and data center) |
| Every later request | 14-16 ms (curl median 13.5 ms) | 5-6 ms (curl median 3.0 ms), `X-Cache-Status: HIT` |
| API calls on a render | 2 (the batch and the checkout copy) | 1 batch |
| Phone / desktop LCP (empty cart) | 896 / 108 ms | 900 / 80 ms |
| CLS, empty cart and a cart with a line | 0 | 0 |

The local API is warm and next to its database, so the saving here is the
render itself. In production the render cost 0.15-1 s; a hit now costs what
any cached page costs at the edge. A cash on delivery order placed through the
cached shell (native form POST) reached `/order-success?orderId=...` with the
receipt cookie, and a cross-origin POST is refused with 403 (Astro's origin
check).

## Cache keys: data and code

API part keys carry the API Worker version; page keys carry the storefront
Worker version and build. Page proofs also carry the API Worker version, so
an API-only deploy invalidates HTML built from the previous API. Versions come
from `CF_VERSION_METADATA.id` through `readWorkerVersion`.

Committed dependency revisions, rather than content age, determine validity.
An unchanged retained entry can HIT after months or a year. Internal
`DEPENDENCY_CACHE_RETENTION_SECONDS` is a one-year storage hint, renewed only
when a slow horizon check rebases a page's proof without rendering its body.
Ordinary hot hits do not rewrite it. It is not a
validity TTL or a promise that Cloudflare will keep the object: eviction causes
a normal miss. Browser cache policy remains separate.

The buyer freshness allowance is at most one second of frontier proof age.
Slow validation must finish within that bound and recheck scheduled deadlines
at completion; stale or incomplete proofs fail closed to a render. Scheduled
promotion boundaries invalidate content even when no row was edited. There is
no stale-if-error allowance for buyer facts. Merchant links use `_sv` as a
read-your-writes hint, forcing catch-up before reusing an older proof; the hint
never enters a cache key or render. Future/forged hints cause bounded work and
cannot certify stale content.

Sensitive paths, authenticated/session-bearing requests, writes, variant
selections and degraded renders bypass shared storage. Checkout, account,
payment and receipt responses remain no-store. Anonymous cart HTML contains
only the public shell and is always no-store to the browser.

Why this identity and not the others considered:

- **Worker version metadata (chosen).** Cloudflare assigns a new id to every
  deployed version (every deploy, secret change or version upload) and the
  same id to every isolate of that version, so entries are still shared
  across isolates and requests. `wrangler dev` (the API) assigns a fresh id
  on every start and every reload (checked with `unstable_startWorker` on
  wrangler 4.128: same id within a run, new id after a code reload and after
  a restart); the Vite plugin under `astro dev` (the storefront) takes its
  bindings from the same Miniflare plugin, so a fresh id on every start. It
  covers local development with no script to remember. Reading it is a property access: no KV or D1 read on
  the hot path. It covers every input, including bundled packages,
  dependencies, compatibility flags and payloads whose schema did not change.
- A content hash of the public route response schemas, generated beside
  `openapi-contract.gen.ts`. Rejected: it changes only when a declared
  schema changes. A fix to how a field is computed, or any change in
  `packages/core` under the same schema, would still serve the old payload. It also depends on
  `generate:sdk` having run.
- A deploy-time generation bump in `scripts/deploy.mjs`. Rejected: it does
  not cover local restarts, couples every deploy to a database write, and is
  skipped by any deploy that does not go through the script.

Trade-off: every deploy of a Worker starts its public cache cold (the API's
parts, or the storefront's pages), even a redeploy of identical code. The
first page per data center after a deploy is a cache miss (see the cold
render figures below); nothing else changes. The old entries are never
purged; they are simply no longer addressed, and age out.

Fail-closed: without the binding `readWorkerVersion` returns null and
nothing is cached (an unversioned key could serve another build's payload).
`pnpm check:env` fails when any Wrangler config lacks
`"version_metadata": { "binding": "CF_VERSION_METADATA" }`.

The storefront key still carries `BUILD_ID` too, which the pages report in
`X-Storefront-Build` and deploy verification compares. `BUILD_ID` is a source
hash (`apps/storefront/scripts/generate-build-id.js`); it now also hashes the
workspace packages the storefront bundles (`@scalius/shared`,
`@scalius/api-client`), which it used to miss. It is still not a complete
build identity (toolchain, root config), which is why the key does not rely
on it alone.

Deploy order matters across the two Workers: a full `pnpm run deploy`
deploys the API before the storefront. Old storefront HTML stays consistent
with the API it was rendered from until the storefront deploy changes its
own version.

### Ad-click and campaign parameters

The canonical URL in the page key drops a fixed allowlist of tracking
parameters: every `utm_*`, `fbclid`, `gclid`, `gbraid`, `wbraid`,
`gad_source`, `gad_campaignid`, `srsltid`, `msclkid`, `ttclid`, `yclid`,
`mc_cid`, `mc_eid`, `igshid`, `_ga` and `ref`
(`isStorefrontTrackingQueryParam` in `@scalius/shared/storefront-cache-path`).
An unknown parameter is kept, since it may be functional. The render sees the
canonical URL, so canonical links, listing filters and pagination links never
carry them, and they do not count toward the bounded-query guard (a 600-byte
`fbclid` used to bypass the cache). There is no redirect: the browser URL
keeps them for client analytics.

Measured on the local built stack (product and category page, plain URL
warm):

| Visit | Before | After |
| --- | --- | --- |
| `?fbclid=…` | HIT | HIT |
| `?gclid=…&gad_source=1&gad_campaignid=…` | product MISS; category **302** to the bare URL (the tags were stripped from the browser URL) | HIT, 200 |
| `?srsltid=…` (Google Merchant listings) | product MISS; category **302** | HIT, 200 |
| `?utm_source=…&utm_id=…` | product MISS; category **302** | HIT, 200 |
| `?yclid&mc_cid&mc_eid&igshid&_ga` | product MISS; category **302** to `?igshid=4&yclid=1` | HIT, 200 |
| `?fbclid=` with a 600-byte value | BYPASS | HIT |

Live, a MISS from Bangladesh costs 0.9-2.3 s against 0.11-0.36 s for a hit
(fidelity audit §5.2), so every such ad click was paying the full miss.

### Historical generation baseline: what a save cost

The following measurements describe the former store-wide generation design,
retained as a comparison baseline. Production now invalidates only entries
whose declared dependencies changed; saves no longer make the entire store
cold. The generation comparator can still reproduce these measurements.

Measured cost of one bump (local built stack, the demo store's 18 sitemap
pages plus home, search and cart; 2 runs):

| | Pages | Sum of TTFB | p50 | p95 |
| --- | --- | --- | --- | --- |
| First pass after the bump | 18/18 MISS | 695-777 ms | 35-39 ms | 74-75 ms |
| Second pass | 18/18 HIT | 139-188 ms | 7-8 ms | 28-34 ms |

With the `perf:storefront` forced miss, the local miss is 65-300 ms and the
hit 4-20 ms. Live from Bangladesh the same step is 0.9-2.3 s against
0.11-0.36 s, paid once per page, per data center, per bump. The API's public
read cache uses the same generation, so both the page and its API parts
miss together. On a store where the merchant edits during trading hours, the
long tail of product pages is effectively always cold in low-traffic data
centers.

Dependency validation replaces the former options to coalesce or partition
store-wide bumps. New buyer-visible writes must be represented in the dependency
registry, and public reads must declare the keys they consume.

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

- A page is one batch (the cart and checkout copy,
  `/api/v1/checkout-languages/active`, is a batch part too), and every
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
  had no active collections. That hop is gone: the newest products a store
  without homepage collections shows now come in the homepage batch part
  with every other section list;
- about 40 ms of render.

### What is left, and why it stays

The rest of the cold cost is start-up of the one API script. The owner has
decided the storefront and the API stay two Workers, so a separate
public-read Worker is out.

Measured 2026-09-25 under workerd 1.20260831 (the production runtime). A
fresh process ran per run, timing until `/api/v1/health` answers, then the
first read into each route family, with no database. Medians of 9-11 runs:

| Build | Uploaded JS | Ready | First config read |
| --- | --- | --- | --- |
| Trivial worker | 0 MB | 21 ms | - |
| Single bundle (as `wrangler deploy` builds it) | 8.5 MB | 152-160 ms | 31-36 ms |
| esbuild `splitting`: 146 ESM modules, route families lazy, static graph 1.1 MB | 8.5 MB | 148 ms | 19 ms |
| Same split, dynamic chunks removed from the upload | 1.2 MB | 67 ms | - |
| Split with the `new_module_registry` flag | 8.5 MB | 92 ms | 41 ms |
| Generated payloads as Text modules | 5.1 MB JS + 4.7 MB text | 139 ms | 29 ms |
| Generated payloads removed (upper bound) | 5.1 MB | 134-140 ms | 31 ms |

**Code splitting is blocked on `new_module_registry`.** Workerd's default
(legacy) module registry compiles every module in the upload when the
isolate starts, whether or not anything imports it. So a split upload
starts as slowly as one bundle (148 vs 152 ms). Only code that is not
uploaded at all is free (67 ms).

The `new_module_registry` compatibility flag loads modules lazily: 92 ms
ready, and 73 ms saved on the cold public-read path (ready plus first config
read). It is experimental in workerd, though: without `--experimental` the
runtime refuses to start ("The new ModuleRegistry implementation is an
experimental feature"), so it cannot be deployed. Revisit when the flag is
no longer experimental. The design notes for that day:

- Build: a pre-bundle step with esbuild `splitting: true`, using the
  conditions, target and nodejs_compat (unenv) handling wrangler uses.
  Wrangler then deploys the output with `no_bundle: true` and
  `find_additional_modules: true`. Same `pnpm run deploy*` commands, same
  two Workers.
- Evaluation order: ESM chunks import `@hono/zod-openapi`'s re-exported `z`
  straight from zod's chunk and skip its `extendZodWithOpenApi` side effect.
  The spike failed with `z.custom(...).openapi is not a function` until the
  extension was imported explicitly before any route family.
- Boundaries: a test that the entry's static graph never includes the admin,
  auth, payment or agent families, and a start-up budget on the static graph
  (about 1.1 MB today).

**The generated contract payloads stay JavaScript.**

- `openapi-contract.gen.ts` (2.3 MB, one JSON string) and
  `agent-operations.gen.ts` (1.1 MB) are 40% of the script but only about
  18 ms of start-up, because string and object literals parse cheaply.
  Shipping them as Text modules would save 13 ms (152 to 139 ms).
- Doing so needs a `.txt` loader in every toolchain that imports them: the
  two vitest configs, `tsx` for `generate:sdk` (`generate-spec.ts` imports
  the contract app) and `generate:agent-contract`, and the CLI's contract
  test.
- Serving `/openapi.json` from the dashboard's static assets would put an
  API artefact into `apps/admin-v2/dist`, and it breaks local dev, whose
  wrangler config has no assets binding. That would save 8 ms.
- A slim agent-operation index does not apply: the MCP runtime reads full
  operation entries.
- Neither is worth the tooling cost at this size. Both payloads already stay
  unevaluated outside their own routes
  (`runtime/generated-payload-boundaries.test.ts`).

What production does beyond this: API placement keeps the isolate that
serves storefront renders warm, and storefront batch parts never start a
second isolate (see the render path).

## Historical platform failure: a stuck Workers Cache key

Seen on 2026-09-24. In one colo (SIN), one key of the `PublicApi` Workers
Cache entrypoint (`/api/v1/storefront/homepage?__cg=<generation>`, before
the key also carried `__cv=<version>`) answered
every request with the same broken response, while other colos and every
other key were fine:

- an empty-body `500` with `cf-cache-status: BYPASS`;
- none of our headers (no `X-Request-Id`, no security headers);
- no Worker invocation in `wrangler tail`.

The storefront then pinned its reads to that generation, so the home page was a 503
in that colo until the generation changed. The most likely trigger is a cache
fill that was cancelled mid-way: the storefront aborted a slow cold read
there. The deadline fix above removes that trigger.

How to recognise it:

```sh
curl -s -o /dev/null -D - https://api.<store>/api/v1/storefront/homepage
```

The same path with an extra query parameter (a different key) answers 200.

Historical handling: the API treated the generation cache as a hint
(`isCacheLayerServerError` in `apps/api/src/public-cache-policy.ts`). When the
cache entrypoint returns a 5xx without the baseline security headers that
every response of ours carries, the read is rendered directly and uncached,
and one masked `[PublicCache] cache layer answered ...` warning is logged with
the path and colo and no query values. This applies to single reads through
the entrypoint (`worker.ts`); storefront batch parts no longer go through the
entrypoint at all (see the render path above). Our own 5xx
passes through untouched, so a real outage does not double the database load.
A generation bump or API deploy also changed the affected key. Production
strict reads now bypass that entrypoint; this incident is retained as context.

## Budgets and guardrails

| Guardrail | Where | Budget |
| --- | --- | --- |
| API calls per page render | `apps/storefront/src/lib/api/render-batch.test.ts`, `apps/storefront/src/lib/cart/cart-shell.render.test.ts` | 1 for home, product, category, search and cart (the pages' own read functions, started as the pages start them) |
| D1 render-only round trips / dependent waves (cache miss, seeded store; home uses every section type). Original render limits remain unchanged; every declared dependency read is included | `apps/api/src/storefront-render-budget.test.ts` | home ≤13 / 2, product ≤21 / 3, category ≤7 / 3, search ≤7 / 2 |
| Authoritative freshness read before a cold render: exact clock + Platform + dependency validation SQL | Same test, separately identified from render statements | Exactly 1 statement / 1 first wave; every render starts in wave 2 |
| Total measured cold D1 round trips / waves, including authoritative freshness | Same seeded integration measurement | home 12 / 3, product 20 / 4, category 8 / 4, search 8 / 3 |
| Same page again, all validated hits | Same test | Exactly 1 statement / 1 wave; identical response bodies |
| Batch safety (public parts only, per-part status, dependency-validated and version-keyed parts) | `apps/api/src/storefront-batch.test.ts`, `apps/api/src/storefront-batch-route.test.ts`, `packages/shared/src/public-api-cache-routes.test.ts` | exact |
| TTFB, LCP and CLS in a real browser | `pnpm perf:storefront` (`scripts/storefront-perf.mjs`) | below |
| Product JSON-LD weight | `apps/storefront/src/lib/commerce-structured-data.product-group.test.ts` (also runs the release-check Product JSON-LD smoke on the output) | 20 KB, description once |
| Ad-click and campaign parameters never split the page cache | `packages/shared/src/storefront-cache-path.test.ts`, `apps/storefront/src/lib/public-worker-cache.test.ts` | exact |

| Similarity to the reference sites, listing density, navigation at scale, page weights (30k-product seeded store) | `pnpm fidelity:check` (`scripts/storefront-fidelity/`) | below |

The mandatory first wave reads current Platform settings and the dependency
clock together before any cold render. A cached Platform snapshot cannot
replace it: a new URL after a settings edit must use the new origins immediately.
The test recognizes this exact SQL, requires it once in the first wave, and
counts every other statement against the unchanged render limits. Total cold
cost is their sum; the 300 ms miss and 50 ms hit HTTP budgets remain unchanged.

The homepage part itself reads in two waves whatever its sections are: the
settings, banners, collections, category rail and published theme first,
then one batch with every product list the sections name (each scoped to
the products it returns, with the media statement of exactly those rows),
the section images and the banner rendition lookup
(`packages/core/src/modules/storefront/README.md`).

A "wave" is a round of D1 calls that must wait for the previous one. Each wave
costs a full database round trip, so a new sequential `await` in a storefront
read fails the D1 budget test even when the query count stays the same.

### `pnpm perf:storefront`

Verified 2026-09-26 against built local Workers and local D1, three browser runs
per profile. Every forced first request was a MISS; every timed hit was a HIT.
These are local measurements, not worldwide latency promises.

| Page | Cold TTFB | Warm TTFB | Phone LCP | Desktop LCP | CLS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home | 122 ms | 6 ms | 980 ms | 108 ms | 0 |
| Video product | 118 ms | 9 ms | 988 ms | 128 ms | 0 |
| Category | 68 ms | 6 ms | 912 ms | 100 ms | 0 |
| Search | 58 ms | 5 ms | 920 ms | 96 ms | 0 |
| Cart shell | 58 ms | 5 ms | 900 ms | 76 ms | 0 |

The script sends only GET requests unless its local-only `--d1-explorer`
option is supplied. For every page (default: home, the first
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
| Cache-miss TTFB (and TTFB of pages that always render) | 300 ms |
| Phone LCP | 1500 ms |
| Desktop LCP | 1200 ms |
| CLS (either profile) | 0.1 |

Override any threshold with `--budget-<name> <value>`, for example
`--budget-lcp-phone-ms 1800`. Other flags: `--paths "/,/products/x"`,
`--runs 5`, `--profiles phone`, `--no-browser` (TTFB only), `--json`, and
`--cdp-port` (default 9395; the script starts and stops its own headless
Chrome when nothing listens there).

For repeatable cold measurements, the local explorer option atomically advances
the store dependency and clock. The first timed request carries that commit
sequence and must report a genuine MISS or REFRESH; hit measurements include
only verified HIT responses. Both origins must be loopback addresses:

```sh
pnpm perf:storefront --base http://localhost:4391 --d1-explorer http://localhost:8811
```

Wrangler's dev registry is shared by every local stack on the machine, so a
built storefront's `BACKEND_API` binding resolves by Worker name.
`scripts/dev-ports.mjs` gives the API on a non-default port its own name,
`scalius-api-local-<api port>`: apps/api `pnpm dev` passes it as `--name`,
and `node scripts/dev-ports.mjs storefront-config` writes
`apps/storefront/dist/server/wrangler.local.json`, which binds the built
storefront to it. The default stack keeps `scalius-api-local`. Against a local
base the script first checks that the storefront's home page carries its own
canonical origin: another stack's API would render that stack's origins, and
the run stops. `--media-url <origin>` also checks the media origin, and
`--no-binding-check` skips the check. `node scripts/dev-ports.mjs
verify-binding` runs the same check for a `pnpm dev` stack. (`astro dev`
calls the API over HTTP on the API port and never uses the binding.)

Live, read-only. A miss cannot be forced there, so the first request is
judged as a miss only when the edge reports `X-Cache-Status: MISS`:

```sh
pnpm perf:storefront --base https://storefront.scalius.com
```

Miss TTFB measured from a laptop includes the network round trip to the edge.
From Bangladesh, some ISPs reach Cloudflare in Europe (MXP, MAD, CDG, MRS) as
often as in SIN or HKG, which adds 150-450 ms per TLS connection. Read the colo
from `cf-ray` before blaming the server.

### `pnpm fidelity:check`

The acceptance bar for storefront templates is visual similarity to their
reference sites, measured. `scripts/storefront-fidelity/` measures the built
storefront against the reference numbers in `reference-metrics.json` and exits
1 on any breach. Every storefront PR attaches its report.

```sh
pnpm fidelity:check                                   # everything, ~25 min
pnpm fidelity:check --only spec-catalogue --report-only
pnpm fidelity:check --only listing,marketplace --state-cache /tmp/fidelity-cache
```

What one run does, sequentially:

1. `astro build` of the storefront (`--skip-build` reuses `dist/`).
2. Seeds a temp D1/KV/R2 state the run owns (`seed-large.mjs`, about 2.5 min):
   `scripts/catalog-scale-seed.mjs` (30,000 products, about 83,500 SKUs, 300
   brands as brand entities), the 400 categories reshaped into a 25/125/125/125
   four-level tree with long and Bangla names, 240 generated photos with real
   rendition ladders (`pool.mjs`, sharp), 1% legacy primaries with no
   renditions, 2% products without a photo, three video products (ffmpeg),
   hero sliders, the five scale menus (`menus.mjs`: 20, 150, 136 on 3 levels,
   1,150, and the live store's flat 12), and the catalogue projections
   (migration 0091's statements). `--state-cache <dir>` keeps a pristine copy
   keyed by a fingerprint of the seed code and the migrations, and later runs
   copy it instead of seeding.
3. Starts the API and the built storefront under `wrangler dev` on that state
   (ports 9001/4601, Chrome on 9601; override with `--api-port`,
   `--storefront-port`, `--admin-port`, `--media-port`, `--chrome-port`). The
   API runs as `scalius-api-local-<api port>` (`scripts/dev-ports.mjs
   api-worker-name`), the storefront's BACKEND_API binding targets that name,
   both use a private dev registry, and the run stops at once unless the
   storefront's home page carries this stack's canonical and media origins
   (another stack's API would render its own). Secrets are fresh
   random values in a temp env file: no `.dev.vars` is read. It refuses a
   state inside any repo `.wrangler` directory and any hosted database
   (`DATABASE_PROVIDER`, `TURSO_*`, `POSTGRES_*`). The Platform `mediaUrl`
   points at a small static server over the pool (`lib/media-server.mjs`,
   port 4603) that serves the same object keys R2 would: browsers abort image
   downloads constantly, and a burst of aborted responses crashes local
   `wrangler dev` 4.128 (reproduced), so image traffic stays off the Workers
   under test. If a Worker still dies, the stage restarts the stack once and
   resumes; a stage that fails twice is a failing check.
4. Measures, with one headless Chrome over CDP:
   - `matrix.mjs` + `probe.js`: every template x {home, category, product}
     x {1440x900, 390x844 DPR 3}: header rows and search, card size,
     columns, gap, image ratio, title and price type, first product y,
     products at least half visible, filter controls visible without a click,
     bottom of the 20th product, facet column width and row pitch, buy box
     type, CTA and top, footer, HTML, header and JSON-LD weight;
   - `variants.mjs`: department-mall with each card variant and each listing
     layout swapped alone; the first cards are compared pixel by pixel;
   - `navscale.mjs`: every template x the five menus x {1440, 1280, 1024},
     the open panel, "More", keyboard, the phone drawer, and no JavaScript;
   - `perf.mjs`: dependency-cache TTFB miss and hit, phone and desktop
     LCP and CLS for home, category and product on every template, plus the
     100-SKU, legacy-image and video products;
   - `hover.mjs`: hover photo latency at 10 Mbps / 60 ms;
   - the small-catalogue pass (`seed-tiny.mjs`: 20 active products in two
     leaves, the 20-link menu).
5. Compares (`lib/compare.mjs`, unit-tested in `compare.test.mjs`), writes
   the report, kills every process tree it started (the wrangler parents with
   their esbuild services and workerd, and Chrome) and deletes the temp state.

The report goes to `.wrangler/fidelity/` (`--out` to change): `summary.md`
(verdict, pass/fail per template and block, every breach with ours, the
reference, the rule and the source note), `scorecard.json` (every check plus
the raw measurements), `pairs/<template>-<page>-<d|m>.jpg` (the reference's
first screen next to ours, labelled with the numbers) and `shots/`.

Tolerances, from AUDIT.md §8 (`audit/rewrite-2026-09-23/fidelity/`):

| Rule | Metrics | Passes when |
| --- | --- | --- |
| size | header, search, card, CTA, footer, facet column, row pitch | within ±10% (never tighter than 2px) |
| gap | card gap | within ±4px |
| font | card title and price, product h1 and price | ±1px, weight ±100 |
| exact | grid columns | equal |
| ratio | card image ratio | ±0.05 |
| min | products visible; filters visible (large-catalogue templates) | ≥ the reference |
| scroll | bottom of the 20th product | ≤ 1.1x the reference |
| firstY | first product y | ≤ the reference + 40px |
| budgets | TTFB hit/miss, LCP, CLS, HTML, header, JSON-LD, anchors, buy-box top, hover, card distinctness | the §8 budgets in `reference-metrics.json` |

Blocks for `--only`: `header`, `card`, `listing`, `pdp`, `footer`, `size`,
`perf`, `nav`, `variants`, `hover`, `tiny`, and any template name. A filter
also skips the stages it does not need, so `--only listing` runs the matrix
alone. `--report-only` writes the same report but exits 0: use it while a
slice is still closing its gaps; the merge gate is the plain command.

Each template maps each block to one reference site
(`reference-metrics.json` `templates`): for example marketplace takes its
header from Amazon and its cards and listing from Daraz. Every reference value
carries its source: the storefront study's site notes or the live density and
facet measurements of the audit. To refresh the live listing numbers,
`node scripts/storefront-fidelity/density.mjs --out refs.json` measures the
reference listings read-only. The pairs read the reference screenshots from
`audit/rewrite-2026-09-23/{storefront-study,fidelity}/shots` in the main
checkout (gitignored); `--ref-shots` points elsewhere.

Resources: about 2.5 min of seeding, then roughly 1.5 min per template for all
stages. Peak memory is about 3 GB of physical footprint (the API's wrangler
about 1.3 GB, the storefront's about 0.65 GB, Chrome about 0.75 GB); the run
aborts cleanly when swap passes `--max-swap-mb` (default 7000). Never run it
beside a typecheck or another stack on a 16 GB host. The generated studio
photos compress 3-5x better than real photos, so image bytes are understated.

### Catalogue-scale load data

`scripts/catalog-scale-seed.mjs` fills a migrated local D1 state that you own
with a deterministic Startech-sized store: 30,000 products, about 83,000 SKUs,
400 categories, a 300-value Brand attribute plus 30 spec attributes, 75,000
images, 50 collections, 20,000 customers and 50,000 orders (about 40 s). It
refuses the shared repo `.wrangler` state and a state that already has
products.

```sh
SCALIUS_WRANGLER_STATE=/tmp/catalog-scale/state node scripts/deploy.mjs --migrate-only --local
node scripts/catalog-scale-seed.mjs --state /tmp/catalog-scale/state
```

Two opt-in harnesses read it (both skip unless their variable is set):

- `scripts/catalog-scale-profile.test.ts` runs API routes in-process on a
  Miniflare D1 over a copy of that state and reports, per route, p50/p95,
  D1 statements, dependent waves and `rows_read` (`CATALOG_SCALE_STATE`,
  `CATALOG_SCALE_TARGETS`, `CATALOG_SCALE_OUT`; see its header).
- `apps/storefront/src/lib/route-tests/api/catalog-feed-scale.test.ts` walks
  the whole XML product feed against a running local API
  (`CATALOG_SCALE_API`) and reports reads, time, heap and size per window.

Findings and measured timings: `audit/rewrite-2026-09-23/CATALOG-SCALE.md`.

The seeder writes rows directly, so fill the catalogue projections before
profiling listings: apply migration 0091's statements, call
`POST /api/v1/admin/catalog/projections/rebuild` until `done`, or run
`rebuildCatalogProjections` in-process (30k products: 34 chunks of 900, about
14 s locally).

### Catalogue projections

Listings, counts, the product sitemap and recommendations read two stored
projections instead of evaluating public eligibility and ranking every SKU per
request (`packages/core/src/modules/products/catalog-projections.ts`):

- `product_buyer_state`, one row per product: public or not, category, brand,
  the card SKU and its from/to/base price, discount depth, availability and
  the card SKU's band;
- `product_facet_values`, one row per product attribute value and per SKU
  option value.

Every product, SKU, option-matrix, stock (reserve, release, deduct, restore,
expiry, adjust, alert level, order transitions) and checkout batch appends the
refresh statements after its ledger-v2 edge and `stockVersion` CAS, so the
projection commits with the write. Stock writes refresh the buyer state only.
They are projections like `availabilityBand`: cart validation and checkout stay
authoritative.

Nothing ever reads them empty. Migration `0091_catalogue_projection_fill` fills
both for every product in the release that adds their readers (about 3 s at
30k products; the migration applies before the new Worker goes live). It is
generated from `catalogProjectionFillStatements`, the same builders the writes
use (`packages/core/scripts/catalog-projection-fill.ts --write`), and a test
keeps the checked-in D1/Turso file and its PostgreSQL sidecar equal to that
output and equal to the rebuild on a seeded store. The demo-store seed ends
with the same statements. Writes the previous API version commits between the
migration and the new Worker going live do not refresh them, so the first cron
tick of every new API version (`CF_VERSION_METADATA`, KV hint
`catalog:projections:rebuilt-for-version`) queues one full rebuild.

The rebuild route, the queued `catalog.projections.rebuild` chain and the
nightly cron (first 15-minute tick after 20:00 UTC) heal drift;
`catalog-projections.d1.test.ts` walks random product, SKU, stock and checkout
writes and compares the projections with a fresh computation after every step.

Precomputed recommendations: a product page reads its stored top 24
(`product_recommendations`) filtered by the current buyer state; the live
ranking (buyer state only, about 0.1 s at 30k products) runs for products never
computed, carts and pages without a source. Product writes queue
`catalog.recommendations.refresh` for the product, the products recommending it
and its newest category peers; the nightly pass refreshes `product_sales_stats`
(units sold in 30 days, the home "popular" list) and the 3,000 oldest or
missing lists.

Shop-all facet counts are computed live only while the public catalogue has at
most 2,000 products (`SHOP_ALL_LIVE_FACET_PRODUCT_LIMIT`). A live count on the
unscoped set reads every attribute and option row (397k rows at 30k products);
large stores filter inside a category, whose counts stay bounded by its own
products. This cap replaced a per-category facet-count cache: no extra table,
nothing to keep fresh.

Facets (slice 1b) read only the projections: one statement per listing counts
brand, option-axis and typed-attribute values over the materialized scope, and
the filters are primary-key probes of `product_facet_values`. The URL contract,
caps and measurements are in `packages/core/src/modules/catalog/README.md`
("Facets"); `facets-scale.local.test.ts` checks every count against a brute
force on the 30k seed.

Measured on the 30k seed (in-process, p50 ms, D1 rows read, before → after):
shop-all newest 3,219 → 35 (6.05M → 31k), shop-all price 3,696 → 35,
Laptop (3.3k) newest 600 → 139 (1.02M → 180k), search "asus" 213 → 49, product
page 1,090 → 54 (1.73M → 2.7k), recommendations 1,045 → 13, manual collection
172 → 37, sitemap page 381 → 56.

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
  (`packages/core/src/modules/media/README.md`). Every cron sweep before it
  is isolated, so one sweep that keeps failing can no longer starve the
  backfill (before, any failing sweep aborted the run before it).
- An image without renditions is a transient state that heals itself. When a
  public API read renders (a cache miss) and still publishes an original
  (`media/<id>.<jpg|png|webp|avif>`), it queues that media id's
  `media.render_variants` job, deduplicated by a 15-minute KV marker and at
  most 8 ids per read (`apps/api/src/utils/media-rendition-hints.ts`). Buyers
  see the original until the job renders; the job then advances the media dependency
  and every page switches to the renditions. Every upload path goes through
  the two media upload routes, which also queue the job
  (`media-upload-paths.test.ts` holds that).
- Images inside rich descriptions that have no renditions (external images,
  or an original URL saved in the text) keep their source but always get
  `loading="lazy" decoding="async"` (the first image of priority content stays
  eager), their authored `width`/`height`, and a size from the URL when an
  image CDN states both (`?w=…&h=…`). Known gap: a description that saved an
  original URL of ours before its renditions existed keeps pointing at the
  original, because the saved string does not say renditions now exist.
  Rewriting saved URLs to the current rendition needs an API-side lookup by
  object key in the product read (slice 5).
- Product JSON-LD states the description once (plain text, at most 1,000
  characters), never per variant; each variant carries one photo and no
  repeated brand, and the script is capped at 20 KB
  (`PRODUCT_JSON_LD_MAX_BYTES`). A product whose variants would not fit lists
  the complete variants that do, in order; the page still sells every SKU.
- Web fonts from theme presets load with `font-display: swap` and
  metric-matched fallbacks, so they must not move LCP or CLS. If they do,
  `pnpm perf:storefront` shows it.

## Live-store quick wins (2026-09-25, local built stack)

Built storefront served by `wrangler dev` plus the local API. The data is a
copy of the demo state with:

- `r2-cat-panjabi`'s primary photo replaced by a 2400 px, 1,068 KB JPEG
  original without renditions (a failed render). It also shows in the
  related rails.
- a 4 KB rich description, with that original inlined as an image, on
  `bb-catalog-panjabi` (6 SKUs) and `f5-variant-table-150` (150 SKUs).

Before is `lean/fidelity`, after is `live-perf-quickwins`. Bytes are what a
390 px DPR 3 phone fetched by load + 2.5 s (CDP network, unthrottled). The
after column for the legacy product is after its self-healing render job ran:
it was queued by the first read and rendered 2 min 9 s later.

| Page | HTML KB | Product JSON-LD KB | Image KB on load | Phone LCP ms |
| --- | --- | --- | --- | --- |
| `/products/r2-cat-panjabi` (no renditions) | 139.8 → 138.9 | 4.6 → 3.8 | 1,081 → 370 | **6,848 → 3,342** |
| `/products/bb-catalog-panjabi` (description image) | 177 → 151.9 | 31.3 → **6.2** | 1,080 → **12** | 748 → 740 |
| `/products/f5-variant-table-150` | 996.5 → **354** | 662.4 → **19.8** (150 → 23 variants listed) | 1,076 → **8** | 854 → 786 |
| `/` (legacy product in a rail) | - | - | 1,080 → 142 | 1,018 → 1,040 |

The generated test photo is noise-heavy, so its 960 px rendition is still
344 KB. A real photo's 960 px rendition is 60-100 KB, which is the audit's
0.72-0.95 s phone LCP for products with renditions. The rest of the product
page HTML (150-SKU variant data, header) is slice 5's budget; this change
takes out only the JSON-LD.

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
