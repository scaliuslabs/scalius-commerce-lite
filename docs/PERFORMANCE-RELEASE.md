# Performance baselines and thresholds

Last reviewed: 2026-10-03

This document holds the performance thresholds that release checks use and the dated measurements that serve as baselines. It is for contributors and operators. How the storefront renders and caches a page, and how to run the checks, are in [STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md).

A baseline is one measurement at one date on one build. Measure again before you compare. Lab figures are not field data: no Chrome UX Report (CrUX) data and no pre-release real-user baseline exist, so none of these figures claims a before-and-after result for real visitors.

## Thresholds

| Area | Threshold | Enforced by |
| --- | --- | --- |
| Cache-hit TTFB, cache-miss TTFB, phone LCP, desktop LCP, CLS | 50 ms, 300 ms, 1500 ms, 1200 ms, 0.1 | `pnpm perf:storefront` (`DEFAULT_BUDGETS` in `scripts/storefront-perf.mjs`) |
| Template fidelity and page weights | `tolerances` and `budgets` in `scripts/storefront-fidelity/reference-metrics.json` (CLS 0.05 there) | `pnpm fidelity:check` |
| API calls and D1 round trips and waves per page render | 1 call; per-page limits in [STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md#budgets-and-guardrails) | `render-batch.test.ts`, `storefront-render-budget.test.ts` |
| Dashboard first-render JavaScript (Brotli) | `BUNDLE_BUDGETS` in `scripts/admin-perf-check.mjs` | `pnpm check:admin-perf` |
| API Worker size | 90% of 64 MiB uncompressed | `pnpm check:api-bundle` |
| Public pages report their cache lane | `X-Cache-Status` is `HIT` or `MISS`; checkout is `NO_CACHE` | `pnpm release:check` |

Policy (decided 2026-08; no script enforces it):

- Dashboard: a warm navigation shows first feedback within 100 ms at p75. Interaction to Next Paint (INP) stays at or below 200 ms. Reopen a dashboard architecture change only when a measured hot interaction misses one of these. Require at least a 15% or 50 ms p75 gain and no p95 regression.
- Storefront images: reopen image work only when a change that keeps visual fidelity gains at least 100 ms at p75.
- Early Hints: keep the preconnect hint only while a test shows a gain. The test needs at least 20 paired cold runs in three data centers. The gain is at least 100 ms median or 150 ms p75 LCP, with unchanged hit latency. Never extend the hint to a hero, product, query or build-hashed URL.
- Field data: treat 7 days of post-release real-user data as provisional and 28 days as final. Require adequate cohort samples and Good LCP, INP and CLS. Label the data Chromium-only.

## Storefront baselines

### Hosted PageSpeed Insights, mobile (August 2026, production demo store)

Lighthouse lab runs on PageSpeed Insights. Final deployed versions were verified on 2026-08-09. Scores are Performance, Accessibility, Best Practices and SEO. TBT is 0 in every run.

| Page | Before | After |
| --- | --- | --- |
| Home | 94-98 performance, FCP 1.8 s, LCP 2.2-2.9 s | 98-99 / 100 / 100 / 100, FCP 1.7-1.9 s, LCP 2.0-2.2 s, CLS 0 |
| Home, desktop | 100 / 100 / 100 / 100 | 100 / 100 / 100 / 100, FCP 0.5 s, LCP 0.5-0.6 s, CLS at most 0.007 |
| Product | 98, LCP 2.0 s | 99-100, FCP 0.9-1.7 s, LCP 1.8-2.0 s, CLS 0 |
| Product with options | not measured | 98-99, FCP 0.9-1.9 s, LCP 2.0-2.3 s, CLS 0 |
| Cart | 94, CLS 0.12 | 99, LCP 2.0 s, CLS 0. Accessibility is 98 (heading order). `noindex` removes the SEO score. |
| CMS page | an image-delivery opportunity of 14 KiB | 98 / 100 / 100 / 100, LCP 2.1 s |

One product page reached 100 / 100 / 100 / 100 once ([hosted report](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-orbit-gan-charger-65w/mhyslx3d8t?form_factor=mobile): FCP 0.9 s, LCP 1.8 s, SI 0.9 s). That is not a guarantee for every product. The optioned product repeated at 98 and 99, and its 10,376-byte hero image transferred in 60 ms on one hosted run and 230 ms on the next.

Notes:

- The CSS and image delivery in use in August 2026 has since changed. Use this table as a historical baseline only.
- An intermittent mobile SEO score of 92 was a PageSpeed `robots.txt` fetch timeout, not a mobile-only response. Ten cold requests with mobile and Googlebot user agents all returned the same valid body with 200 in 158-428 ms, and the next PageSpeed run scored 100.

### Local built stack (2026-09-26)

Method: `pnpm perf:storefront` against built local Workers and local D1, three browser runs per profile. Every forced first request was a `MISS` and every timed hit was a `HIT`. These are local figures, not worldwide latency.

| Page | Cold TTFB | Warm TTFB | Phone LCP | Desktop LCP | CLS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home | 122 ms | 6 ms | 980 ms | 108 ms | 0 |
| Product with video | 118 ms | 9 ms | 988 ms | 128 ms | 0 |
| Category | 68 ms | 6 ms | 912 ms | 100 ms | 0 |
| Search | 58 ms | 5 ms | 920 ms | 96 ms | 0 |
| Cart shell | 58 ms | 5 ms | 900 ms | 76 ms | 0 |

### Cart shell (2026-09-25)

Method: local built stack, forced misses, 5 runs, plus 10 sequential `curl` requests. Before the shell, `/cart` rendered for every request: 0.15-1 s of server time in production (0.9 s once after a deploy), while other pages answered from the cache in about 20 ms.

| Metric | Rendered for every request | Cached shell |
| --- | --- | --- |
| First request after a dependency change | 30-33 ms | 31-41 ms (once per build and data center) |
| Later requests | 14-16 ms (`curl` median 13.5 ms) | 5-6 ms (`curl` median 3.0 ms), `HIT` |
| API calls per render | 2 | 1 |
| Phone / desktop LCP, empty cart | 896 / 108 ms | 900 / 80 ms |
| CLS | 0 | 0 |

A cash on delivery order through the cached shell (native form POST) reached `/order-success?orderId=...` with the receipt cookie. A cross-origin POST got 403 (Astro's origin check).

### Live store before one-batch renders and placement (2026-09-24)

Method: live store from Bangladesh, round 4. TTFB of a miss varies by Cloudflare data center (`cf-ray`).

| Page | Miss TTFB (data centers) | Hit TTFB at the edge | Phone LCP | Desktop LCP |
| --- | --- | --- | --- | --- |
| Home | 2.2-3.5 s (SIN, MXP); two 503s | 18 ms | 2.28 s | 0.66 s |
| Category | 2.7-4.6 s (MAD, MXP) | 21 ms | 8.49 s (original 254 KB JPEG) | 0.97 s |
| Product with options | 0.6-4.6 s (SIN, CDG, MRS, MXP) | 19 ms | 5.51 s (original 273 KB WebP) | 1.10 s |
| Search | 0.4-1.9 s (MRS, SIN) | 22 ms | 8.05 s | 1.04 s |
| Cart (always rendered) | 0.27-4.0 s | not applicable | 1.26 s | 0.45 s |

`wrangler tail` showed four causes:

- The API ran in the visitor's data center: 1.0-1.9 s of server time for a product read outside SIN, 0.5 s at SIN.
- Every page made two or three sequential API hops.
- Each hop was a separate invocation with 130-250 ms of cold-isolate CPU.
- A cold layout read at HKG passed the 2 s service-binding deadline and returned a 503 page.

One batch per page, API placement and the internal-origin deadline rule answer these.

### Live read smoke (2026-09-28)

Method: `pnpm perf:storefront --base https://storefront.scalius.com --no-browser --runs 2 --no-binding-check`. Cache-hit TTFB was 24-34 ms. The first category, product and search requests took 439, 312 and 303 ms, above the 300 ms miss threshold. The sample does not isolate a cause. The miss threshold stays open for a controlled built-stack check.

### Large catalogue

Category page (2026-09-28): a fresh built 30,000-product store, a category with 3,780 products and four child shelves, 36 cards. The bounded shelf preview added no D1 statement. Miss TTFB was 1790, 273 and 250 ms (median 273 ms). Hit TTFB was 6, 6 and 5 ms. The HTML was 233 KB. The home page miss in the same run was 748 ms and breached its threshold. Test: `packages/core/src/modules/categories/categories.tree.d1.test.ts`.

Route profile (September 2026, 30,000-product seed, in-process Miniflare D1, p50 and D1 rows read; harness `scripts/catalog-scale-profile.test.ts`):

| Read | p50 | Rows read |
| --- | ---: | ---: |
| Shop-all, newest | 35 ms | 31,000 |
| Shop-all, price | 35 ms | not recorded |
| Category with 3,300 products, newest | 139 ms | 180,000 |
| Search "asus" | 49 ms | not recorded |
| Product page | 54 ms | 2,700 |
| Recommendations | 13 ms | not recorded |
| Manual collection | 37 ms | not recorded |
| Sitemap page | 56 ms | not recorded |

A numbered page 500 of shop-all newest read 0 rows, and the same position by cursor read about 76 rows.

### Images without renditions (2026-09-25)

Method: local built stack with a copy of the demo state. One product had a 2400 px, 1,068 KB JPEG original with no renditions (a failed render). Two products had a 4 KB rich description with that original inlined (6 and 150 SKUs). Bytes are what a 390 px DPR 3 phone fetched by load plus 2.5 s.

| Page | Product JSON-LD | Image on load | Phone LCP |
| --- | --- | --- | --- |
| Product with no renditions | 4.6 KB to 3.8 KB | 1,081 KB to 370 KB | 6,848 ms to 3,342 ms |
| Product with a description image (6 SKUs) | 31.3 KB to 6.2 KB | 1,080 KB to 12 KB | 748 ms to 740 ms |
| Product with 150 SKUs | 662.4 KB to 19.8 KB (23 of 150 variants listed) | 1,076 KB to 8 KB | 854 ms to 786 ms |

The "after" column of the first row is after the self-healing render job ran, 2 min 9 s after the first read queued it. The generated test photo is noise-heavy, so its 960 px rendition is 344 KB. A real photo's 960 px rendition is 60-100 KB.

## Cold-start experiments

### API isolate start (2026-09-24)

Method: the production API bundle (`wrangler deploy --dry-run`, 8.7 MB minified) imported into plain Node V8 with `cloudflare:*` imports stubbed. Each first request ran with no database, so only module initialisation was timed. Median of three runs.

| Step | Wall | CPU |
| --- | --- | --- |
| Isolate start: parse and compile the script and run top-level code | 150 ms | 170 ms |
| First read into the `config` family (layout, storefront, shipping, checkout settings) | 52 ms | 74 ms |
| First read into the `catalog` family | 9 ms | 12 ms |
| First read into the `buyer` family (orders, customer auth, agent contexts) | 28 ms | 43 ms |
| Any of these again | about 1 ms | about 1 ms |

These match the 110-250 ms of CPU that `wrangler tail` showed on cold production invocations. About 20 ms of the eager start is zod and about 5 ms is the database drivers. The rest is V8 parsing a script of that size, so it scales with bundle size. Moving `checkout/config` from the `buyer` family to `config` saved 36-50 ms wall and 48-58 ms CPU on each cold render that reads checkout settings.

### Module registry and code splitting (2026-09-25)

Method: workerd 1.20260831, one fresh process per run, timed until `/api/v1/health` answers and then the first read into each route family, with no database. Median of 9-11 runs.

| Build | Uploaded JS | Ready | First config read |
| --- | --- | --- | --- |
| Trivial Worker | 0 MB | 21 ms | not measured |
| Single bundle (as `wrangler deploy` builds it) | 8.5 MB | 152-160 ms | 31-36 ms |
| esbuild `splitting`: 146 ESM modules, route families lazy | 8.5 MB | 148 ms | 19 ms |
| Same split, lazy chunks left out of the upload | 1.2 MB | 67 ms | not measured |
| Split with the `new_module_registry` flag | 8.5 MB | 92 ms | 41 ms |
| Generated payloads as Text modules | 5.1 MB JS and 4.7 MB text | 139 ms | 29 ms |

- Workerd's default (legacy) module registry compiles every uploaded module at isolate start. A split upload therefore starts as slowly as one bundle. Only code that is not uploaded is free.
- The `new_module_registry` flag loads modules lazily and saved 73 ms on the cold public-read path. In this test workerd refused to start without `--experimental`, so it could not be deployed. Test again when the flag is no longer experimental.
- In the split spike, ESM chunks skipped zod's OpenAPI extension side effect and failed with `z.custom(...).openapi is not a function` until the extension was imported before any route family.
- The two generated payloads are 40% of the script but only about 18 ms of start-up. Serving them as Text modules saves 13 ms and needs a `.txt` loader in every toolchain that imports them. That is not worth the tooling cost.

## Cloudflare zone notes (2026-08-09)

Wrangler cannot read zone settings, so these facts came from the Cloudflare dashboard for the demo zone and were not re-checked:

- The zone is on the Free Website plan with no Cache Rules. HTTP/2, HTTP/3 and TLS 1.3 are on. Responses negotiate Brotli, Zstandard and gzip.
- Zone Cache Everything, Edge TTL, custom cache keys and purges do not apply to the SSR page cache, which uses the Cache API with dependency validation. Do not enable Cache Reserve: it is metered and showed no PageSpeed benefit.
- A production `no-transform` trial removed automatic Web Analytics injection but also disabled Brotli, added a 138 KiB compression finding and dropped the score to 94-95. It stays rejected.
- Automatic zone injection of Web Analytics is off. The one Web Analytics integration in the dashboard loads the beacon as a module script with `fetchpriority="low"` (`apps/storefront/src/lib/analytics-script-delivery.ts`).
- Early Hints is on. After one learning request, 3 of 5 fresh HTTP/2 probes got a `103 Early Hints` response with the preconnect before the final `200`. Two PageSpeed repeats scored 98 with LCP 2.0-2.1 s against 2.1-2.2 s before. That does not establish a gain, and it does not meet the retention test in [Thresholds](#thresholds).

## Dashboard

The dashboard is a static single-page app (Vite, React, TanStack Router and Query) that the API Worker serves through its `ASSETS` binding. Rules that keep it fast:

- **Navigation.** Hover or focus on a link fetches the route's code and runs its loader (`defaultPreload: "intent"` in `apps/admin-v2/src/router.tsx`). The router never replaces content with a pending screen (`defaultPendingMs: Infinity`). A navigation that takes longer than 180 ms shows a 3 px progress bar (`AdminNavigationProgress.tsx`).
- **Route code warming.** The first page settles, then the dashboard waits 2 s and for browser idle. It then fetches the code of the Orders, Products, Customers and Inventory routes that the user may open (`apps/admin-v2/src/lib/warm-route-code.ts`). It reads no data. Data Saver and 2G skip it.
- **Tables.** Lists use server-side pagination, sorting and filtering. Row components are memoized, so a fetch overlay does not re-render unchanged rows. A read that a link's hover preloaded in the last 5 s counts as fresh on mount (`INTENT_PREFETCH_MOUNT_GRACE_MS`). Older data revalidates.
- **Protected lists.** Do not warm the adjacent page of Orders or Customers, and do not bulk-sync protected data into the browser. Warming the next page multiplies requests when the user hovers and leaves, and keeps an extra page of buyer personal data in the client cache.
- **Virtualization.** Pages are small: the shared table defaults to 10 rows, and the product list API caps a page at 100. Tables do not need virtualization. Add route-local virtualization only for a workflow that renders hundreds of continuous rows.
- **Bundles.** The initial group stays one chunk (`admin-shell` in `apps/admin-v2/vite.config.ts`) because the router runtime is strongly connected. `scripts/check-admin-client-boundaries.mjs` runs after `vite build` and fails the build on a circular static chunk import (a forced split can break ESM initialization). Tiptap, the QR engine and PDF code stay out of every route's first download. Drag and drop and phone metadata stay out of the everyday routes' first download (`LAZY_ONLY_MODULES` in `scripts/admin-perf-check.mjs`).
- **Assets.** Generated JS, CSS and fonts exist only under `/assets/immutable/` with content hashes and `public, max-age=31536000, immutable`. HTML, source maps and copied public files stay out of that path. The same script (`scripts/admin-static-assets.mjs`) fails the build when long-lived caching is set for anything else.
- **Compiler.** A global React Compiler trial grew gzip size by 13.76% and Brotli by 12.74%. It is not adopted.
- **Router pin.** `@tanstack/react-router` is pinned to `1.170.18` in `apps/admin-v2/package.json`. Versions 1.170.19 to 1.170.23 caused a document hydration mismatch when the dashboard was server-rendered with TanStack Start 1.168.36 to 1.168.40. The dashboard is a client-only single-page app. Lift the pin only after the dashboard browser gates pass on the newer version.

`pnpm check:admin-perf` builds the dashboard into a temporary directory and holds the entry chunk, the CSS and every route's first-render JavaScript to Brotli budgets (`BUNDLE_BUDGETS`). It fails when a library that must load on demand joins a route's first download (`LAZY_ONLY_MODULES`). `--explain <route file>` lists what a route downloads. With a local stack running, it times first load, cold and warm route transitions and product-editor typing in headless Chrome:

```sh
pnpm check:admin-perf --runtime --admin http://localhost:4323 --cpu 4 --rtt 40 --mbps 25
```

Other runtime flags: `--runs`, `--cdp-port`, `--typing-product <id>` and `--explorer <api origin>` (D1 calls per transition). `--admin` must be a local address.

### Navigation timing (production, August 2026)

Method: production dashboard, demo account. The figures are click to the route's heading in the DOM. A repeat click comes after the route was visited once. They are not paint timing and not field INP.

| Route | First click | Repeat click |
| --- | ---: | ---: |
| Products | 391 ms | 69 ms |
| Orders | 352 ms | 87 ms |
| Customers | 329 ms | 83 ms |
| Inventory | 408 ms | 98 ms |
| Media | 627 ms | 67 ms |
| Discounts | 320 ms | 62 ms |
| Analytics | 330 ms | 63 ms |

All seven repeat clicks meet the 100 ms target. A first click takes 320-627 ms while route code and data load. Do not present warm navigation as cold-start performance.

## Release checks

Run the heavy gates one at a time on a 16 GB host. `pnpm typecheck` already runs with `--concurrency=1`.

| Command | What it checks for performance |
| --- | --- |
| `pnpm check:env` | Every Worker declares `CF_VERSION_METADATA`. The default and named API entrypoints keep Workers Cache off. |
| `pnpm check:api-bundle` | The API Worker stays within 90% of the 64 MiB limit. |
| `pnpm check:admin-perf` | Dashboard bundle budgets and lazy-only libraries. |
| `pnpm check:dist-secrets` and `pnpm check:build-canaries` | Builds inline no local environment value. |
| `pnpm perf:storefront` | TTFB, LCP and CLS thresholds on a built stack. |
| `pnpm release:check` | Read-only live smoke, including the cache lane of public pages. |
