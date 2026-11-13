# Performance thresholds

The performance thresholds release checks use, the policy behind them, and the lessons measurements
taught. How the storefront renders and caches a page, and how to run the checks, are in
[STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md). Dated measurements live in the commit history:
measure again before you compare, and do not present lab figures as field data.

## Thresholds

| Area | Threshold | Enforced by |
| --- | --- | --- |
| Cache-hit TTFB, cache-miss TTFB, phone LCP, desktop LCP, CLS | 50 ms, 300 ms, 1200 ms, 300 ms, 0.01 | `pnpm perf:storefront` (`DEFAULT_BUDGETS` in `scripts/storefront-perf.mjs`) |
| Template fidelity and page weights | `tolerances` and `budgets` in `scripts/storefront-fidelity/reference-metrics.json` (CLS 0.01 there) | `pnpm fidelity:check` |
| API calls, D1 round trips and waves per page render | 1 call; per-page limits in [STOREFRONT-PERFORMANCE.md](./STOREFRONT-PERFORMANCE.md#budgets-and-guardrails) | `render-batch.test.ts`, `storefront-render-budget.test.ts` |
| Dashboard first-render JavaScript (Brotli) | `BUNDLE_BUDGETS` in `scripts/admin-perf-check.mjs` | `pnpm check:admin-perf` |
| Storefront buyer-page JavaScript (gzip): product page first paint and first add to cart; no zod or generated SDK on the product, home or listing pages | `BUDGET_GZIP_KIB` and `buyerPageProblems` in `apps/storefront/scripts/client-chunk-graph.mjs` | every storefront deploy (`pnpm check:storefront-budgets` on the build it ships) |
| API Worker size | 90% of 64 MiB uncompressed | `pnpm check:api-bundle` |
| Public pages report their cache lane | `X-Cache-Status` is `HIT` or `MISS`, also for the checkout shell, whose browser copy stays `private, no-store` | `pnpm release:check` |
| Every Worker declares `CF_VERSION_METADATA`; the API keeps Workers Cache off | n/a | `pnpm check:env` |

Run the heavy gates one at a time on a 16 GB host. `pnpm typecheck` (`scripts/typecheck.mjs`) runs one `tsc --build` with two builders and two checkers (about 4 GB peak), then `astro check`.

Policy (decided 2026-08; no script enforces it):

- Dashboard: a warm navigation shows first feedback within 100 ms at p75, and Interaction to Next Paint (INP) stays at or below 200 ms. Reopen a dashboard architecture change only when a measured hot interaction misses one of these, with at least a 15% or 50 ms p75 gain and no p95 regression.
- Storefront images: reopen image work only when a change that keeps visual fidelity gains at least 100 ms at p75.
- Early Hints: keep the preconnect hint only while a test (at least 20 paired cold runs in three data centers) shows at least 100 ms median or 150 ms p75 LCP gain and unchanged hit latency. Never extend it to a hero, product or query URL. The only other hints are the immutable build files a stored page names in its head: its `/_astro/` stylesheets and preloaded fonts (`pageEarlyHintLinks` in `apps/storefront/src/lib/public-worker-cache.ts`, at most six); never merchant content.
- Field data: treat 7 days of post-release real-user data as provisional and 28 days as final, with adequate cohort samples and Good LCP, INP and CLS. Label it Chromium-only.

## Lessons from measurements

- **Distance to the database dominates a miss.** A render reads D1 in dependent waves; from a distant data
  center each wave is a full round trip. Hence one batch per page, the API placed beside the database,
  and the internal-origin deadline rule.
- **workerd compiles every uploaded module at isolate start**, whatever the request runs. A large dataset
  as a JSON or object literal costs start-up on every isolate (about 120 ms for the Bangladesh places
  directory); the same bytes as a Text module cost almost nothing. Measure start-up in workerd, not Node.
- **Splitting the API bundle does not help** under workerd's default module registry (a split upload
  starts as slowly as one bundle); only code that is not uploaded is free. Retest when the new module
  registry is stable.
- **Images without renditions are the worst LCP case.** A missing rendition serves the original (a
  1 MB original took phone LCP from about 3.3 s to 6.8 s); renditions heal in the background.
- **The Bangladesh network path varies.** Some ISPs reach European data centers as often as SIN or HKG;
  read the data center from `cf-ray` before blaming the server.
- **Zone settings:** Cache Reserve showed no benefit and is metered; a `no-transform` trial disabled Brotli
  and lowered scores. Both stay off.

## Dashboard

The dashboard is a static single-page app (Vite, React, TanStack Router and Query) that the API Worker serves through its `ASSETS` binding. Rules that keep it fast:

- **Navigation.** Preloading, route-code warming and the pending bar are in [apps/admin-v2/README.md](../apps/admin-v2/README.md#navigation-performance). Never warm the adjacent page of Orders or Customers or bulk-sync protected data into the browser: it multiplies requests and keeps an extra page of buyer personal data in the client cache.
- **Tables.** Lists use server-side pagination, sorting and filtering. Pages are small (the shared table defaults to 10 rows, and the product list API caps a page at 100), so tables need no virtualization.
- **Bundles.** The initial group stays one chunk (`admin-shell` in `apps/admin-v2/vite.config.ts`) because the router runtime is strongly connected. `scripts/check-admin-client-boundaries.mjs` fails the build on a circular static chunk import. Tiptap, the QR engine, PDF code, drag and drop and phone metadata stay out of the everyday routes' first download (`LAZY_ONLY_MODULES`).
- **Assets.** Generated JS, CSS and fonts live only under `/assets/immutable/` with content hashes and `public, max-age=31536000, immutable`. `scripts/admin-static-assets.mjs` fails the build when long-lived caching is set for anything else.
- **Compiler.** A global React Compiler trial grew gzip size by 13.76% and Brotli by 12.74%. It is not adopted.
- **Router.** `@tanstack/react-router` follows its caret range (`apps/admin-v2/package.json`). Versions 1.170.19 to 1.170.23 caused a hydration mismatch under server rendering; the dashboard has no server rendering, and 1.170.44 passes the admin tests and `pnpm check:admin-perf`. Run the dashboard browser gates (`pnpm quality:admin`) on a router change.

`pnpm check:admin-perf` builds the dashboard into a temporary directory and holds the entry chunk, the CSS and every route's first-render JavaScript to Brotli budgets (`BUNDLE_BUDGETS`). It fails when a library that must load on demand joins a route's first download. `--explain <route file>` lists what a route downloads. With a local stack running, it times first load, cold and warm route transitions and product-editor typing in headless Chrome:

```sh
pnpm check:admin-perf --runtime --admin http://localhost:4323 --cpu 4 --rtt 40 --mbps 25
```

Other runtime flags: `--runs`, `--cdp-port`, `--typing-product <id>` and `--explorer <api origin>` (D1 calls per transition). `--admin` must be a local address.
