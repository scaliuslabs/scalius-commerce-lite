# Stable Release Performance Audit

Last reviewed: 2026-08-08

This note records the performance evidence and release decisions for the Commerce Lite stable-release audit. It is intentionally evidence-led: repeatable buyer and merchant behavior outranks a single synthetic score, and an unscored Lighthouse diagnostic is not treated as a release blocker by itself.

## Architecture and performance boundary

- The storefront is an Astro SSR multi-page application on Cloudflare Workers. Anonymous, canonical public reads use the native Worker cache; browser HTML remains `no-store`; cart, checkout, account, recovery, and other buyer-state routes never enter the shared cache.
- The dashboard is a persistent TanStack Start/Router shell. TanStack Query owns remote-data freshness, route loaders warm the same keys rendered by components, and the shared data table uses server-side pagination, sorting, and filtering.
- The API is a Hono Worker backed by D1. Request bindings are passed from `Env`, commerce writes stay authoritative in the relational provider, and independent reads use bounded D1 batches where that removes network round trips.
- Hosted-service and multi-merchant control-plane concerns remain outside this repository.

## Storefront evidence

### Before the release changes

| Surface | PageSpeed report | Result |
| --- | --- | --- |
| Homepage mobile | [run `e0nkv90xc1`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/e0nkv90xc1?form_factor=mobile) | Performance 94; FCP 1.8 s; LCP 2.9 s; TBT 0; CLS 0 |
| Homepage mobile repeat | [run `biltl1x5vh`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/biltl1x5vh?form_factor=mobile) | Performance 98; FCP 1.8 s; LCP 2.2 s; TBT 0; CLS 0 |
| Product mobile | [run `golsno32t0`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-rider-court-trainers/golsno32t0?form_factor=mobile) | Performance 98; FCP 1.8 s; LCP 2.0 s; TBT 0; CLS 0 |
| Homepage/product desktop | Same reports, desktop tab | 100 performance, accessibility, best practices, and SEO |

### Deployed result

| Surface | PageSpeed report | Result |
| --- | --- | --- |
| Homepage mobile | [run `3quw0ddh0l`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/3quw0ddh0l?form_factor=mobile) | 98/100/100/100; FCP 1.866 s; LCP 2.102 s; TBT 0; CLS 0 |
| Homepage mobile repeat | [run `shwlqeh8ip`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/shwlqeh8ip?form_factor=mobile) | 98/100/100/100; FCP 1.838 s; LCP 2.131 s; TBT 0; CLS 0 |
| Homepage mobile second-pass | [run `hcqj0yu9dn`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/hcqj0yu9dn?form_factor=mobile) | 98/100/100/100; FCP 1.826 s; LCP 2.177 s; TBT 0; CLS 0 |
| Homepage desktop | [run `shwlqeh8ip`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/shwlqeh8ip?form_factor=desktop) | 100/100/100/100; FCP 0.506 s; LCP 0.563 s; TBT 0; CLS 0.00026 |
| Product mobile | [run `3wqcg6981u`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-rider-court-trainers/3wqcg6981u?form_factor=mobile) | 98/100/100/100; FCP 1.832 s; LCP 1.983 s; TBT 0; CLS 0 |
| Final homepage mobile | [run `b28zxipsn7`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/b28zxipsn7?form_factor=mobile) | 98/100/100/100; FCP 1.8 s; LCP 2.2 s; TBT 0; CLS 0 |
| Final homepage desktop | [run `b28zxipsn7`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/b28zxipsn7?form_factor=desktop) | 100/100/100/100; FCP 0.5 s; LCP 0.6 s; TBT 0; CLS 0.005 |
| Final optioned product mobile | [run `esq7kzpb0q`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-echo-mini-bluetooth-speaker/esq7kzpb0q?form_factor=mobile) | 98/100/100/100; FCP 1.9 s; LCP 2.0 s; TBT 0; CLS 0 |
| Final reference product desktop | [run `bkcaistikn`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-rider-court-trainers/bkcaistikn?form_factor=desktop) | 100/100/100/100; FCP 0.5 s; LCP 0.5 s; TBT 0; CLS 0 |
| Early Hints production trial | [run `93ky6dhwf3`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/93ky6dhwf3?form_factor=mobile) | 98/100/100/100; FCP 1.8 s; LCP 2.0 s; TBT 0; CLS 0 |
| Early Hints production repeat | [run `1k7ms6p9x2`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/1k7ms6p9x2?form_factor=mobile) | 98/100/100/100; FCP 1.8 s; LCP 2.1 s; TBT 0; CLS 0 |

These reports contained no CrUX field data; they are repeatable Lighthouse lab evidence, not a claim that real-user p75 LCP is 2.1-2.2 seconds. Cloudflare Web Analytics was not active on the verified live homepage, product, or search routes, so no field-vitals clock or pre/post RUM baseline exists yet. If exactly one Cloudflare collection mode is deliberately enabled later, define `T0` as the first verified beacon POST, treat seven days as provisional and 28 days as final, require adequate cohort samples plus Good LCP/INP/CLS, and label the evidence Chromium-only rather than Safari/Firefox or CrUX.

The live homepage lab result is repeatably 98, not a defensible 100. Lighthouse 13.4.1 gives the representative run a weighted raw score of about 97.65. With that version's curves/weights and SI/TBT/CLS remaining perfect, reaching a displayed 100 requires a large paired FCP/LCP movement—for example about FCP <= 1.57 s and LCP <= 1.55 s—not merely removal of remaining diagnostics. Three additional CLI runs varied from 95 to 97 despite zero TBT/CLS and tiny observed LCP phases, so a lone 100 would be lab variance rather than release evidence.

The first mobile hero is already discovered in initial SSR HTML, media-qualified, preloaded, eager, high priority, and synchronously decoded. Its observed LCP phases improved from roughly 250 ms before deployment to 180 ms after image work, while the scored simulated metrics stayed essentially unchanged. More image compression, more hero priority hints, or commerce-JavaScript removal has no measured path to the missing two displayed points. A later live byte audit did expose a different FCP candidate: roughly 177 KiB of inline CSS precedes `<body>` in the 373 KiB uncompressed homepage. Splitting that into a small measured critical subset plus a cacheable stylesheet is now a higher-value experiment than further image tuning.

Remaining PageSpeed diagnostics have no direct score weight. They can still matter if changing an underlying cause improves a weighted metric, but these items expose no such measured opportunity here:

- Cloudflare Web Analytics beacon cache lifetime: provider-owned one-day TTL, about 5 KiB estimated repeat-view savings.
- Network dependency tree: small application modules and the RUM branch; no missing origin preconnect.
- LCP phase breakdown and third-party attribution.

The earlier mobile SEO 92 was a transient `robots.txt` fetch timeout, not a mobile-only response branch. The first mobile-UA request took 1.981 s in a pattern consistent with cold/stale edge recovery; immediately repeated desktop, Googlebot, and Lighthouse requests took 67-106 ms and returned the same valid body. Fresh PageSpeed runs report SEO 100. Deployment warming now covers robots, all sitemap children, both feeds, homepage, and search, and the gateway attempts one semantic purge-and-refetch when a cached response carries the wrong build stamp.

## Storefront changes retained

- Reduced the first mobile hero CDN quality from 85 to 75. The deployed PageSpeed runs below are the retained outcome evidence; no exact byte-reduction claim is made without a checked-in before/after artifact.
- Reduced hidden mobile carousel image quality from 80 to 70 while keeping desktop hidden slides at 80, delayed warming hidden slides, and removed priority from the first below-fold product rail image.
- Replaced the 281-line product-gallery React island with the SSR base interaction plus a desktop-only dynamic zoom controller. Mobile no longer downloads that island/runtime path, while desktop zoom is loaded only when the desktop media query matches and remains responsive to viewport changes.
- Prevent private/no-store links from participating in broad Astro intent prefetch while retaining intent prefetch for public catalog discovery.
- Preserve Partytown isolation, sparse priority hints, existing CDN preconnect, deferred below-fold regions, fail-closed checkout readiness, and MPA semantics.

## Cloudflare zone and cache audit

Wrangler 4.116.0 verified the deployed Worker cache configuration and active
versions. Wrangler has no zone-settings, Cache Rules, Early Hints, Tiered Cache,
or Cache Reserve command, so the authenticated Cloudflare dashboard supplied
the read-only zone inventory. `scalius.com` is on the Free Website plan, with no
visible Cache Rules. HTTP/2, HTTP/3, HTTP/2-to-origin, and TLS 1.3 are active;
live responses negotiate Brotli, Zstandard, and gzip.

The storefront uses Workers Caching, not the zone CDN cache. It already receives
Cloudflare's generic tiering and can be invalidated only by the owning cached
entrypoint's `ctx.cache.purge({ tags })`. Zone Cache Everything, Edge TTL,
custom cache keys, Smart Tiered topology, Cache Reserve, and dashboard/zone
purges cannot safely improve or invalidate that SSR lane. Keep the uncached
gateway, allowlisted cached entrypoint, `cross_version_cache: false`, browser
`no-store`, and semantic tag purges. Do not enable Cache Reserve: it is metered,
does not cover Workers-Cached HTML or transformed images, and provides no
credible PageSpeed benefit here.

Production build `src-66e4dbe3370b6f78` now emits exactly one stable anonymous
HTML response hint:

```http
Link: <https://cloud.scalius.com>; rel=preconnect; crossorigin
```

Cloudflare Early Hints is enabled on the zone at no additional feature charge.
After one learning request, three of five fresh HTTP/2 probes received a real
`103 Early Hints` response with that preconnect before the final `200`. The
homepage subsequently returned a native HIT with the new build and header;
checkout and option-selected product responses remained private/no-store with
no final `Link`, while robots remained public revalidation content without the
hint. No hero, product, query-specific, private, or build-hashed URL is eligible,
so Cloudflare's separate URI-only hints cache cannot transfer stale commerce
bytes. This is a cold-connection experiment, not yet a measured claim of a
PageSpeed score increase.

The two immediate PageSpeed website repeats preserved 98/100/100/100 and
reported 2.0-2.1 s LCP versus 2.1-2.2 s in the preceding retained runs. The
rounded samples are compatible with a small improvement but do not establish
causality or meet the 20-run multi-colo retention threshold. The invariant
preconnect remains safe and free while that evidence accumulates; it is not
presented as the missing route to mobile 100.

The durable invalidation ledger was also read live through Wrangler: all 12
semantic groups had equal requested/applied generations, zero attempts, and no
last error. The audit nevertheless found an existing quantity-freshness defect
that blocks stronger caching: same-availability-band inventory changes avoid a
purge even though public projections currently expose exact stock quantities.
Checkout remains authoritative, but a 10-to-9 change can leave buyer-visible
quantity stale until the one-hour backstop. Scheduled CMS publication boundaries
and post-purge warming also need dedicated work. None of the zone settings above
were allowed to mask or lengthen those application-owned gaps.

## Dashboard evidence and changes

Production authentication, desktop and mobile shell navigation, data-heavy inventory/orders screens, and session cleanup were exercised with the demo account. The final fresh-profile smoke passed all 23 authenticated routes with zero console errors and zero page exceptions. Mobile inventory rendered the bounded variant list and all inventory aggregates; mobile orders rendered the paginated 10-of-17 order list without a console warning or error.

The final production repeat-navigation measurements below record click-to-heading DOM response after the route had been visited. They are not background-tab paint or field INP measurements.

| Route | Repeat click-to-heading |
| --- | ---: |
| Products | 27.2 ms |
| Orders | 47.3 ms |
| Customers | 22.3 ms |
| Inventory | 49.6 ms |
| Media | 29.1 ms |
| Discounts | 20.3 ms |
| Analytics | 24.0 ms |

All seven repeat destinations meet the 100 ms responsiveness target. The preceding first visit measured 25.2-66.5 ms for Products, Orders, Customers, Inventory, and Discounts, while Media and Analytics were 356.0 ms and 263.6 ms before their route code/data was resident. That distinction is retained instead of presenting warm navigation as cold-start performance.

Retained changes:

- Intent-preload the seven safe principal list routes and load code-only boundaries for other sidebar destinations.
- Keep pending UI out of fast transitions with a 400 ms delay and 100 ms minimum duration.
- Memoize the shared table row boundary. A 100-row focused test proves a fetch overlay rerenders zero unchanged cells and selecting one row rerenders only that row.
- Replace the shared table's unconditional mount refetch with a five-second intent-prefetch grace period. The immediate navigation does not duplicate the request, while invalidated data and ordinary route returns revalidate even inside longer domain stale windows.
- Reject adjacent-page speculation for Orders and Customers. Warming only the committed list avoids abandoned-hover request amplification and retaining an extra page of buyer PII in the client cache.
- Narrow persistent sidebar/header location subscriptions to pathname and isolate the orders countdown from the 1,342-line route so one-second ticks do not reconstruct the route and table.
- Keep route-search discriminators independent from full editor models. Disposable before/after builds showed a material reduction in the root and login critical closures; the structural boundary tests, rather than untracked raw samples, are the durable regression guard.
- Emit generated dashboard JS/CSS only beneath `/assets/immutable/` with content hashes and one-year immutable caching. HTML, source maps, and copied stable public assets are excluded by a fail-closed build gate, eliminating conditional revalidation for unchanged route chunks on repeat visits.
- Keep the SSR and client Vite asset directories identical. The first live dashboard deploy exposed that a client-only `assetsDir` change left the SSR manifest pointing at three missing legacy URLs. The release gate now resolves every CSS/image/font URL in the server manifest against `dist/client`, so this class of deploy can no longer pass locally.

TanStack Table v9.1.0 was evaluated after v9.0.0 became stable on 2026-08-04. Scalius stays on v8 for this release: v9 had only four days of stable-channel exposure, its headline gains target client row models and very large tables, while Scalius uses authoritative server pagination with a 10-row default and a 100-row cap. A disposable native-v9 explicit-feature comparison was larger and slower for this bounded workload, while the checked-in v8 row-boundary test already proves the relevant reactivity gain. Reassess after four to six weeks only if a real table crosses 250 rendered rows/2,000 cells, a table action exceeds 16 ms, or a reproducible native-v9 benchmark saves at least 5 KiB gzip or 20% and 10 ms p95 CPU without behavior regressions.

## API evidence and changes

- Dashboard summary reads that were independent now use one five-statement D1 batch instead of two concurrent Worker-to-D1 calls/connections. This removes a provider round trip and gives the projection one read snapshot; it is not presented as a latency win until post-deployment comparison supports one.
- Customer listing no longer reads all non-deleted delivery locations for each paginated result. Production evidence showed a 10-row customer page scanning 11,548 location rows, 31.47 ms SQL, and at least 424,859 bytes of raw location text. The equivalent joined resolution read 56 rows in 1.44 ms across all 18 non-deleted customers—a roughly 99.5% row-read reduction—and retains the stored-ID fallback when a referenced location is deleted or missing. Inactive but non-deleted location names remain resolvable, matching the former dictionary behavior.
- Inventory overview previously awaited page, count, and stats in three waves: live median TTFB was 273.5 ms even though the three current SQL statements total roughly 1.6 ms. They now execute in one provider-portable three-statement batch with unchanged projections.
- Checkout readiness previously made two waves: live median TTFB was 348.2 ms despite under 0.5 ms of current SQL. Delivery and sign-in readiness now start together in the common path, using three concurrent reads—within D1's six-connection invocation limit—while preserving provider and fail-closed branches.
- Current production D1 is already served from SIN for the dashboard client; read replication or Smart Placement would not improve this baseline. Products, orders, analytics list, and theme workspace retain measured round-trip-collapse opportunities, but their SQL, response delivery, and payload sizes do not justify expanding this release patch further.

## T3 Code and browser research decisions

T3 Code was studied at public commit `4eaf5ef8bb47b870397d5c61cd216b1a6bdd1510`. Its transferable advantage is a persistent shell with fine-grained subscriptions, structural sharing, stable row identities, targeted virtualization for genuinely unbounded lists, and non-blocking route selection. It does not derive its speed from global scheduler calls or unusual router configuration. T3 Chat is closed source, so no code-level claims are based on it.

Adopted or retained:

- Narrow subscriptions and stable render identities.
- Non-blocking list shells, intent code/data warming, and Query-owned freshness.
- Server pagination for bounded commerce grids.
- Prefer one native Cloudflare RUM mode as the future Chromium field-vitals source, but do not claim field evidence until a real beacon POST and dashboard data are verified. Retain cross-browser interaction testing because Cloudflare does not currently cover Safari or Firefox vitals.

Measured post-release spikes, not release rewrites:

- React 19.2 `Activity` around already-visited settings panes, gated on preserved draft state, focus, effects, and lower p75 interaction cost.
- Native cross-document `@view-transition` for public browse routes only; this targets continuity, not Lighthouse score, and that MPA opt-in remains limited availability/not Baseline.
- TanStack Table v9 native explicit features plus narrow Store subscriptions after stable-channel soak.
- Route-local virtualization only for a future workflow that truly renders hundreds of continuous rows.
- Header-logo priority and hero decoding A/B only if a repeated trace attributes a stable, controllable FCP/LCP delay.
- Cloudflare 103 Early Hints measurement across at least 20 paired cold runs and three colos. The production trial is limited to an invariant CDN preconnect that transfers no speculative asset bytes. Retain it only with at least 100 ms median or 150 ms p75 LCP improvement and unchanged hot-hit latency; never extend it to dynamic hero/build URLs without a separate invalidation proof.

Rejected for this release:

- Global React Compiler: the measured trial increased gzip by 13.76% and Brotli by 12.74%.
- A duplicate atom/entity store, dashboard WebSocket rewrite, SPA conversion, site-wide Astro `ClientRouter`, broad speculation-rule prerendering, service-worker app shell, blanket `content-visibility`, `scheduler.yield()`, or `startTransition`.
- Unscored PageSpeed-warning suppression presented as a performance gain.

## Measured post-release simplification backlog

These are ordered experiments, not authorization for a broad rewrite:

1. Make React Hook Form the only order-form value authority. Delete the module-global calculation store, move subtotal/charge/discount reads into leaf `useWatch` subscribers, prune unused broad context fields, and stabilize the quote dependencies. Estimated net deletion is 70-110 lines. Require at least 20% p75 render-duration improvement, p75 <= 8 ms/p95 <= 16 ms updates, and unchanged quote/submit/focus behavior before considering the larger 250-400-line controller split.
2. Simplify the product option matrix before virtualizing it. Desktop and mobile representations currently mount together, and a bulk apply can perform up to 150 full 150-variant maps (22,500 comparisons). Render one responsive representation and apply one set-based patch pass first.
3. Debounce navigation workspace search and stop remounting rows on revision changes. An eight-character query can issue seven RPCs and up to 28 D1 reads; 100 rows can also own roughly 400 DnD hook instances. Split search presentation from DnD before measuring virtualization.
4. Page media folders instead of loading up to 20 pages sequentially and mounting duplicate mobile/desktop trees. For the media gallery, add memoized selected-ID and media-ID maps before considering virtualization around 240 loaded cards.
5. Stage barcode picker changes or fetch only newly added IDs. Selecting 150 SKUs one by one currently has a cumulative 11,325-row response ceiling even though the server lookup itself is correctly batched.
6. Collapse the measured third query wave in product and order lists, then batch analytics count/page and published/draft theme reads. Keep authenticated admin GETs uncached and do not add indexes, replication, or streaming without new evidence.
7. If Cloudflare Web Analytics is activated, match the official module snippet, enforce one active Cloudflare integration, and ensure automatic injection and manual snippet modes cannot coexist. Start the 7/28-day observation window only after one successful production beacon POST is visible for the exact storefront hostname.

## Release verification contract

Run heavyweight gates sequentially on the 16 GB development host:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build --concurrency=1
pnpm check:env
pnpm check:admin-perf
pnpm check:dist-secrets
pnpm repo:check
pnpm release:check
pnpm ops:check --queues
```

The authenticated admin read smoke additionally covers inventory, orders, order detail/form, all browser routes, and session cleanup. Browser verification covers sign-out/sign-in, desktop/mobile dashboard navigation, inventory and orders, storefront search, product option selection, add/remove cart restoration, checkout form readiness, and validation failure states without placing an order or charging a payment method.

Final deployed versions verified on 2026-08-08:

- API Worker `1a2e2266-738f-43a6-b4d1-8de235925ed6`.
- Dashboard Worker `f287784b-1ed1-477b-b408-383006c28b6d`.
- Storefront Worker `370d540e-e8e6-4995-b5f3-e703f8c479dd`, build `src-66e4dbe3370b6f78`.
- `pnpm release:check`, `pnpm ops:check --queues`, and the authenticated 23-route admin read smoke all passed against those live surfaces.

For synthetic 100 work, representative Lighthouse 13.4.1 paired reductions from the 1.826/2.177-second run are approximately 255/632, 464/385, or 759/243 ms for FCP/LCP. These metrics share causes, so their sum is not a physical critical-path duration and one source need not own the entire gap. Reopen storefront work sooner for a real-user RUM regression or a new controllable opportunity worth at least 100 ms p75 even when it cannot create a synthetic 100. Reopen a dashboard architecture rewrite when a measured hot interaction misses p75 100 ms first-feedback/warm-heading or the INP 200 ms release ceiling, and require at least a 15% or 50 ms p75 win without a p95 regression.
