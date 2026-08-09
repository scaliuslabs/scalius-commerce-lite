# Stable Release Performance Audit

Last reviewed: 2026-08-09

This note records the performance evidence and release decisions for the Commerce Lite stable-release audit. It is intentionally evidence-led: repeatable buyer and merchant behavior outranks a single synthetic score, and an unscored Lighthouse diagnostic is not treated as a release blocker by itself.

## Architecture and performance boundary

- The storefront is an Astro SSR multi-page application on Cloudflare Workers. Anonymous, canonical public reads use the native Worker cache; browser HTML remains `no-store`; cart, checkout, account, recovery, and other buyer-state routes never enter the shared cache.
- The dashboard is a persistent TanStack Start/Router shell. TanStack Query owns remote-data freshness, route loaders warm the same keys rendered by components, and the shared data table uses server-side pagination, sorting, and filtering.
- The API is a Hono Worker backed by D1. Request bindings are passed from `Env`, commerce writes stay authoritative in the relational provider, and independent reads use bounded D1 batches where that removes network round trips.
- Hosted-service and multi-merchant control-plane concerns remain outside this repository.

## Dependency and framework audit

Every direct workspace dependency was compared with the public registry on
2026-08-09 and advanced unless a newer line failed a verified compatibility
gate. The resulting stack includes
Astro 7.2.0, the Astro Cloudflare adapter 14.2.0, Vite 8.2.1, the Cloudflare
Vite plugin 1.51.1, Wrangler 4.120.0, Hono 4.13.1, TanStack Start 1.168.35,
TanStack Router 1.170.18, TanStack Table 9.1.0, React 19.2.8, pnpm 11.20.0,
Turbo 2.10.9, and the latest compatible direct commerce, editor, form, schema,
lint, test, and Cloudflare packages. `pnpm outdated -r` is empty except for four
intentional compatibility lanes:

- Node remains on the supported Node 24 LTS runtime, so `@types/node` stays on
  its current 24.x line instead of advertising Node 26 Current APIs that do not
  exist in CI or production tooling.
- TypeScript 7.0.2 is the actual compiler for API, dashboard, core, database,
  shared, and API-client checks. A side-by-side TypeScript 6.0.3 package remains
  as the programmatic compiler API required by stable `typescript-eslint` and
  `@astrojs/check`; this is the migration shape recommended by the TypeScript 7
  release itself, not a stale compiler path.
- TanStack Start 1.168.36 through 1.168.40 and Router 1.170.19 through 1.170.23
  produce a reproducible document hydration mismatch in this dashboard. A
  local production-build bisect found 1.168.35/1.170.18 clean and the very next
  pair failing; the boundary coincides with TanStack's
  [large lane-match loader rewrite](https://github.com/TanStack/router/commit/45c4ad8d629e291fab70c37900525449e415ffcd).
  The newest independently clean pair is pinned until that upstream regression
  is fixed and the same production hydration gate passes.

The complete peer-dependency check and both full and production-only package
audits pass with zero findings. Astro 7.2 can remove its SSR session runtime
when `session: false` is safe, but the storefront deliberately keeps its
Cloudflare KV-backed session driver because cart and customer behavior use it.
The Cloudflare adapter's new build-time image-binding path and Astro's
incremental static build mode do not replace this storefront's dynamic SSR,
custom CDN image policy, or semantic cache invalidation. They were therefore
not enabled merely because the packages now expose them.

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
| Full CSS externalization trial (rejected) | [run `ywvpf3r7fz`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/ywvpf3r7fz?form_factor=mobile) | 97/100/100/100; FCP 1.7 s; LCP 2.1 s; SI 3.8 s; the second render-blocking layout stylesheet cost 470 ms |
| Hybrid CSS delivery | [run `kyxhyyehck`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/kyxhyyehck?form_factor=mobile) | 98/100/100/100; FCP 1.7 s; LCP 2.0 s; SI 1.7 s; TBT 0; CLS 0 |
| Final cache-safe homepage mobile | [run `4ng4chsvag`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/4ng4chsvag?form_factor=mobile) | 98/100/100/100; FCP 1.7 s; LCP 2.0 s; SI 1.7 s; TBT 0; CLS 0 |
| Final cache-safe homepage desktop | [run `fjgkvoc5ni`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/fjgkvoc5ni?form_factor=desktop) | 100/100/100/100; FCP 0.5 s; LCP 0.5 s; SI 0.5 s; TBT 0; CLS 0.007 |
| Final deployed homepage mobile | [run `7ty0yncvp0`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/7ty0yncvp0?form_factor=mobile) | 98/100/100/100; FCP 1.7 s; LCP 2.0 s; SI 1.7 s; TBT 0; CLS 0; Agentic Browsing 3/3 |
| Phone-critical homepage mobile | [run `0n8727pz0r`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/0n8727pz0r?form_factor=mobile) | 99/100/100/100; FCP 1.7 s; LCP 2.0 s; SI 1.7 s; TBT 0; CLS 0 |
| Phone-critical product mobile | [run `x9ujro18af`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-orbit-gan-charger-65w/x9ujro18af?form_factor=mobile) | 99/100/100/100; FCP 1.7 s; LCP 1.9 s; SI 1.7 s; TBT 0; CLS 0 |
| Stabilized cart mobile | [run `aza5e3mdhr`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-cart/aza5e3mdhr?form_factor=mobile) | Performance 99; FCP 1.7 s; LCP 2.0 s; SI 1.7 s; TBT 0; CLS 0. The prior cart baseline was 94 with CLS 0.12. Accessibility remains 98 for heading order, while `noindex` intentionally prevents a private cart from receiving a public-page SEO score. |
| Optimized CMS page mobile | [run `ibx0gy7agx`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-about/ibx0gy7agx?form_factor=mobile) | 98/100/100/100; FCP 1.7 s; LCP 2.1 s; SI 1.7 s; TBT 0; CLS 0; the prior 14 KiB image-delivery opportunity is gone |
| Final upgraded reference product mobile | [run `bdzvdv5knm`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-orbit-gan-charger-65w/bdzvdv5knm?form_factor=mobile) | 99/100/100/100; FCP 1.7 s; LCP 1.8 s; SI 1.7 s; TBT 0; CLS 0 |
| Final upgraded homepage mobile | [run `zprdvocjol`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/zprdvocjol?form_factor=mobile) | 98/100/100/100; FCP 1.7 s; LCP 2.1 s; SI 1.7 s; TBT 0; CLS 0 |
| Final product target mobile | [run `mhyslx3d8t`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-orbit-gan-charger-65w/mhyslx3d8t?form_factor=mobile) | **100/100/100/100**; FCP 0.9 s; LCP 1.8 s; SI 0.9 s; TBT 0; CLS 0; Agentic Browsing 3/3 |
| Optioned product mobile | [run `lrrvk40mkj`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-echo-mini-bluetooth-speaker/lrrvk40mkj?form_factor=mobile) | 99/100/100/100; FCP 0.9 s; LCP 2.2 s; SI 0.9 s; TBT 0; CLS 0 |
| Optioned product immediate repeat | [run `wtty9edxpz`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-echo-mini-bluetooth-speaker/wtty9edxpz?form_factor=mobile) | 98/100/100/100; FCP 0.9 s; LCP 2.3 s; SI 0.9 s; TBT 0; CLS 0 |
| Final console-clean product mobile | [run `xpbog0z7bg`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com-products-orbit-gan-charger-65w/xpbog0z7bg?form_factor=mobile) | 99/100/100/100; FCP 1.1 s; LCP 2.0 s; SI 1.1 s; TBT 0; CLS 0; proves the optional Meta dispatch no longer fails Best Practices |

These reports contained no CrUX field data; they are Lighthouse lab evidence, not a claim about real-user p75. The Cloudflare account now uses one explicit first-class Web Analytics integration and automatic zone injection is disabled, so storefront and dashboard documents each load exactly one canonical module beacon with `fetchpriority="low"`. No clean pre-release cohort snapshot was captured, so this release still makes no before/after field-vitals claim. Treat seven days of post-release data as provisional and 28 days as final, require adequate cohort samples plus Good LCP/INP/CLS, and label the evidence Chromium-only rather than Safari/Firefox or CrUX.

The requested reference product now has a permanent hosted PageSpeed 100/100/100/100 report. That result is the retained marketing evidence, but it is not presented as a deterministic all-product guarantee: the optioned Echo product repeated at 99 and 98 while its FCP, Speed Index, TBT, and CLS remained excellent. Its 10,376-byte hero transferred in 60 ms on one hosted run and 230 ms on the next, while Orbit's 2,612-byte hero is less sensitive to network variance. Lowering dimensions or image quality further could improve the synthetic tail but would violate the pixel-fidelity constraint, so this release keeps the visual asset contract intact.

The retained product path makes the eager, high-priority, synchronous-decoding mobile hero discoverable 14,077 HTML bytes earlier by ordering it before the desktop thumbnail rail while preserving the exact responsive grid geometry. A deterministic phone-shell stylesheet paints that hero without waiting for the complete 167.7 KiB shared Tailwind sheet. One media-qualified immutable link stays render-blocking at desktop widths, fetches at `VeryLow` priority on phones, and activates after load plus two animation frames; a `noscript` copy preserves the complete page without JavaScript. Fully externalizing compact route CSS regressed Speed Index, a fully dormant shared-sheet link produced unstable paint scheduling, and inlining the hero bytes regressed FCP, so all three trials were rejected.

Remaining PageSpeed diagnostics have no direct score weight. They can still matter if changing an underlying cause improves a weighted metric, but these items expose no such measured opportunity here:

- Cloudflare Web Analytics beacon cache lifetime: provider-owned one-day TTL, about 5 KiB estimated repeat-view savings.
- Network dependency tree: small application modules and the RUM branch; no missing origin preconnect.
- LCP phase breakdown and third-party attribution.

The intermittent mobile SEO 92 is a PageSpeed `robots.txt` fetch timeout, not a mobile-only response branch. It reproduced in [run `sc6enabcnz`](https://pagespeed.web.dev/analysis/https-storefront-scalius-com/sc6enabcnz?form_factor=mobile), while ten deliberately cold unique requests split between mobile and Googlebot user agents all returned the same valid absolute-sitemap body with 200 responses in 158-428 ms. The immediate PageSpeed repeat `4ng4chsvag` reported SEO 100. The route remains merchant-controlled and semantic-purgeable; no unpurgeable zone Cache Rule or inaccurate fallback policy was added to suppress an external audit timeout. Deployment warming covers robots, all sitemap children, both feeds, homepage, and search, and the gateway attempts one semantic purge-and-refetch when a cached response carries the wrong build stamp.

## Storefront changes retained

- Reduced the first mobile hero CDN quality from 85 to 75. The deployed PageSpeed runs below are the retained outcome evidence; no exact byte-reduction claim is made without a checked-in before/after artifact.
- Reduced hidden mobile carousel image quality from 80 to 70 while keeping desktop hidden slides at 80, delayed warming hidden slides, and removed priority from the first below-fold product rail image.
- Replaced the 281-line product-gallery React island with the SSR base interaction plus a desktop-only dynamic zoom controller. Mobile no longer downloads that island/runtime path, while desktop zoom is loaded only when the desktop media query matches and remains responsive to viewport changes.
- Prevent private/no-store links from participating in broad Astro intent prefetch while retaining intent prefetch for public catalog discovery.
- Scope Tailwind source detection to storefront source files and use Astro's hybrid CSS threshold: cache the large build-scoped shared stylesheet across pages while leaving compressed sub-8 KiB route/layout CSS in the first response.
- Give product phones a build-generated first-viewport Tailwind sheet while loading the immutable complete shared sheet without blocking first paint; keep the complete sheet render-blocking at desktop widths and in a `noscript` fallback. The focused visual comparison found no first-viewport geometry or computed-style differences, and the live product retained zero CLS.
- Parse the mobile product hero before the desktop thumbnail rail and explicitly place both desktop grid cells, moving hero discovery 14,077 HTML bytes earlier without changing mobile or desktop geometry.
- Do not create desktop navigation resize observers, animation frames, or the one-second reveal timeout on phones. Hidden header social images retain no `src` until their matching desktop surface or the mobile drawer becomes visible.
- Replace Astro's immediate Partytown bootstrap with a hashed post-load bootstrap. Forwarding stubs remain available from parse time, an early buyer interaction starts the sandbox immediately, and the normal path starts after load plus two frames with a four-second ceiling. The current `@qwik.dev/partytown` package also fixes the previously broken Facebook queue stubs without putting provider work on the first-paint path.
- Keep best-effort Meta browser-event dispatch console-silent on page teardown. The API-side circuit breaker owns actionable provider diagnostics; an aborted optional beacon is not a broken buyer interaction and must not fail Lighthouse Best Practices.
- Reserve the empty-cart result height before its client controller resolves, removing the prior 0.12 cart CLS and raising its live mobile PageSpeed result from 94 to 99.
- Add 384/768-pixel CMS image candidates with bounded mobile quality so the prior 14 KiB image-delivery diagnostic disappears without changing CMS-page CLS.
- Preserve Partytown isolation, sparse priority hints, existing CDN preconnect, deferred below-fold regions, fail-closed checkout readiness, and MPA semantics.

## Cloudflare zone and cache audit

Wrangler 4.120.0 verified the deployed Worker cache configuration and active
versions. Wrangler has no zone-settings, Cache Rules, Early Hints, Tiered Cache,
or Cache Reserve command, so the authenticated Cloudflare dashboard supplied
the read-only zone inventory. `scalius.com` is on the Free Website plan, with no
visible Cache Rules. HTTP/2, HTTP/3, HTTP/2-to-origin, and TLS 1.3 are active;
live responses negotiate Brotli, Zstandard, and gzip.

The free plan permits no hostname/path-level Web Analytics exclusion rules.
Automatic zone injection is disabled and the existing first-class Scalius Web
Analytics integration is the single source of the official module beacon. Its
token/snippet is canonicalized on save, obvious placeholders are rejected, it
cannot be routed through Partytown, and delivery is explicitly low priority.
This preserves one real-user telemetry stream without Cloudflare mutating the
HTML response behind the application. The provider-owned one-day beacon cache
lifetime remains an unscored diagnostic. A production `no-transform` trial
removed automatic injection but also disabled Brotli, produced 138 KiB of
missing-compression opportunity, and fell to 94-95; it remains rejected.

The storefront uses Workers Caching, not the zone CDN cache. It already receives
Cloudflare's generic tiering and can be invalidated only by the owning cached
entrypoint's `ctx.cache.purge({ tags })`. Zone Cache Everything, Edge TTL,
custom cache keys, Smart Tiered topology, Cache Reserve, and dashboard/zone
purges cannot safely improve or invalidate that SSR lane. Keep the uncached
gateway, allowlisted cached entrypoint, `cross_version_cache: false`, browser
`no-store`, and semantic tag purges. Do not enable Cache Reserve: it is metered,
does not cover Workers-Cached HTML or transformed images, and provides no
credible PageSpeed benefit here.

Current production build `src-51656c78805f6590` emits exactly one stable anonymous
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
last error. The same audit found and closed a quantity-freshness defect before
any broader caching was considered. Persistent public product, search, and feed
projections now expose an explicit `availabilityBand` and replace exact stock and
reservation counts with stable compatibility sentinels. A 10-to-9 change inside
the same band is therefore byte-stable and needs no purge; transitions between
untracked, in-stock, low-stock, and out-of-stock still advance the existing
semantic invalidation ledger. UCP no longer advertises the sentinel as an exact
quantity, and cart/checkout remain the live authority for requested quantity.
Scheduled CMS publication boundaries and post-purge warming still need dedicated
work. None of the zone settings above were allowed to mask or lengthen those
application-owned gaps.

## Dashboard evidence and changes

Production authentication, desktop and mobile shell navigation, data-heavy inventory/orders screens, and session cleanup were exercised with the demo account. The final fresh-profile smoke passed all authenticated routes with zero console errors and zero page exceptions. Mobile inventory rendered the bounded variant list and all inventory aggregates; mobile orders rendered the paginated order list without a console warning or error. The final compressed deployment also hydrated cleanly with Cloudflare's injected RUM node at 1280x720 and 390x844, with no horizontal overflow.

The final production repeat-navigation measurements below record click-to-heading DOM response after the route had been visited. They are not background-tab paint or field INP measurements.

| Route | Cold click-to-heading | Repeat click-to-heading |
| --- | ---: | ---: |
| Products | 391 ms | 69 ms |
| Orders | 352 ms | 87 ms |
| Customers | 329 ms | 83 ms |
| Inventory | 408 ms | 98 ms |
| Media | 627 ms | 67 ms |
| Discounts | 320 ms | 62 ms |
| Analytics | 330 ms | 63 ms |

All seven repeat destinations meet the 100 ms responsiveness target. True cold navigation remains 320-627 ms while route code and data become resident; that distinction is retained instead of presenting warm navigation as cold-start performance.

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

TanStack Table 9.1.0 is now native rather than hidden behind the v8 compatibility
adapter. One typed table configuration registers only pagination, selection,
sorting, visibility, and sizing; server-owned filtering and client row-model
features are absent. The 100-row rendering regression test still proves that a
fetch overlay rerenders zero unchanged cells and one selection rerenders only
the selected row. This is a maintainability and future reactivity foundation,
not a fabricated bundle win: the representative table entry fell from 12.18 to
8.53 KiB gzip, but its associated column-factory chunk grew enough that the two
measured chunks together increased from 16.96 to 20.17 KiB gzip. Scalius's
10-row default and 100-row cap also mean v9's large-table memory headline is not
a meaningful current dashboard claim. Retention depends on the post-deployment
interaction measurements and complete behavior gates, not the version number.
The final live table smoke proved 50 products across five server-owned pages,
selection, ascending name sort, URL search state, and the 11-20 pagination
range with zero console errors.

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
- Retain the single native Cloudflare RUM mode as the Chromium field-vitals source, but do not claim a before/after field result without a captured baseline and adequate 7/28-day cohorts. Retain cross-browser interaction testing because Cloudflare does not currently cover Safari or Firefox vitals.

Measured post-release spikes, not release rewrites:

- React 19.2 `Activity` around already-visited settings panes, gated on preserved draft state, focus, effects, and lower p75 interaction cost.
- Native cross-document `@view-transition` for public browse routes only; this targets continuity, not Lighthouse score, and that MPA opt-in remains limited availability/not Baseline.
- Narrow TanStack Table v9 Store selectors/leaf subscriptions, but only after a
  trace proves table-wide state notification is a remaining hot interaction.
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
7. Before changing Cloudflare Web Analytics from its current automatic mode, match the official module snippet, enforce one active Cloudflare integration, and ensure automatic injection and manual snippet modes cannot coexist. Preserve Brotli and start a new 7/28-day observation window only after one successful production beacon POST is visible for the exact storefront hostname.

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

Final deployed versions verified on 2026-08-09:

- API Worker `25e60e28-4eae-4924-a726-eeca61b0d8d1`.
- Dashboard Worker `a687648b-fcad-439b-82dd-102405fe7734`.
- Storefront Worker `e810ed39-f109-4e27-b2cd-c7e647e86ea9`, build `src-51656c78805f6590`.
- Live public feed and product-detail variants expose `availabilityBand` and `lowStockThreshold` with stable `99/0` compatibility values instead of exact inventory; a repeated product request was a native HIT and emitted a real HTTP/2 103 before its 200 response.
- The final authenticated browser smoke passed desktop and 390x844 mobile dashboard hydration/navigation, TanStack Table v9 behavior, product option selection, cart add/remove restoration, checkout validation failure, zero horizontal overflow/browser exceptions, and dashboard sign-out without placing an order.
- `pnpm release:check` and `pnpm ops:check --queues` passed against the deployed surfaces; all local lint, test, typecheck, build, environment, dashboard-performance, secret, and repository gates passed before deployment.

The product-page mobile 100 target is achieved on the reference marketing URL. Do not manufacture a deterministic all-SKU claim from one hosted run: retain the same architecture across products, watch the 7/28-day RUM cohorts, and reopen image work only when a visual-fidelity-preserving format or delivery change yields at least 100 ms p75. Reopen a dashboard architecture rewrite when a measured hot interaction misses p75 100 ms first-feedback/warm-heading or the INP 200 ms release ceiling, and require at least a 15% or 50 ms p75 win without a p95 regression.
