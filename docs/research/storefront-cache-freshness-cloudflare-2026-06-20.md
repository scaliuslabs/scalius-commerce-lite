# Storefront cache freshness on Cloudflare

Date: 2026-06-20  
Scope: Scalius Commerce Lite storefront performance and freshness on Cloudflare Workers, KV, Cache API, Service Bindings, cache tags/generations, stale-while-revalidate-like behavior, precise invalidation, and rewarming.  
Constraint: Platform claims below are based only on current official Cloudflare documentation. Repo findings are based on source inspection.

## Executive conclusion

The repo already has the right broad instincts: canonical cache keys, API KV fence tokens, storefront Cache API L2 entries, KV-backed storefront versions/generations, exact HTML warm paths, and Service Binding reads from the storefront to the API. The biggest gap is not "more caching"; it is making freshness simpler and more explicit.

Recommended direction:

1. Keep Cloudflare Cache API as the storefront's local edge L2 for rendered HTML and hot public JSON/data.
2. Keep KV for small invalidation pointers only: group generation and entity generation keys, not response bodies where Cache API is sufficient.
3. Do not treat KV generation bumps as globally instant. KV is eventually consistent, so exact freshness should either use Cloudflare cache-tag purges, short hard TTLs, or safety-specific bypasses for checkout/payment-sensitive data.
4. Add an internal API-to-storefront Service Binding for invalidation instead of the public `PURGE_URL` + token hop.
5. Move rewarming beyond best-effort `waitUntil()` when it matters: use a Queue for warm jobs that may exceed a few paths, need retries, or should survive `waitUntil()` cancellation.
6. Collapse the current prefix/group string taxonomy into a typed `CacheSubject` invalidation contract, then derive API fences, storefront generations, cache tags, and warm paths from that one contract.

## Official Cloudflare facts that matter

- **Service Bindings** let one Worker call another without a public URL. Cloudflare documents them as fast, zero-added-latency calls that usually run both Workers on the same thread of the same server, and as a way to isolate internal services from the public Internet. Source: [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
- **Bindings** are the preferred Worker-native way to access Cloudflare resources, with better performance and fewer restrictions than REST APIs intended for non-Worker applications. Source: [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/).
- **Workers Cache API** provides programmatic access to a Cloudflare cache object, but contents do **not** replicate outside the originating data center. `cache.put()` is also not compatible with Tiered Cache. Source: [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).
- **Cache API headers**: Cloudflare's Cache API honors response `Cache-Control`, `Cache-Tag`, `ETag`, `Expires`, and `Last-Modified` on `cache.put()`. Responses with `Set-Cookie` are never cached unless that header is removed or qualified. Source: [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).
- **Cache API does not support SWR directives**: `stale-while-revalidate` and `stale-if-error` are not supported by `cache.put()` / `cache.match()`. Source: [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) and [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/).
- **Cloudflare CDN stale-while-revalidate is asynchronous** for Free, Pro, and Business zones, with Enterprise migration still noted in docs. A stale cached asset can be served while revalidation happens in the background, but only when the CDN cache is actually in play and the response includes `stale-while-revalidate`. Source: [Revalidation](https://developers.cloudflare.com/cache/concepts/revalidation/) and [Feb. 26, 2026 changelog](https://developers.cloudflare.com/changelog/post/2026-02-26-async-stale-while-revalidate/).
- **KV is eventually consistent**. Writes are usually visible immediately in the location where they occur, but other locations may take 60 seconds or more to observe changes; negative lookups are cached too. Source: [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
- **KV expiration TTL minimum is 60 seconds** for expiring keys. Source: [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
- **Cloudflare purge supports URL, hostname, tag, prefix, and purge everything** across plans, with account-level rate limits. Source: [Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/).
- **Cache tags** can be added through `Cache-Tag` response headers and purged later; Cloudflare strips the header before sending the response to visitors or passing it to a Worker. Source: [Purge by cache-tags](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/).
- **Custom Cache API keys cannot be purged by URL as custom keys**. Cloudflare recommends Cache Rules custom keys for URL purging, or purge by everything/tag/host/prefix. Source: [Purge cache key resources](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-cache-key/).
- **`ctx.waitUntil()` is bounded**. It can extend an HTTP-triggered Worker for up to 30 seconds after response end/disconnect; work that cannot finish within that limit should go to Queues. Source: [Context: waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).
- **Browser `no-store` is stricter than `no-cache`** and can disable BFCache in many browsers; `no-cache` permits storage but requires revalidation. Source: [Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/).
- **Worker `fetch()` supports cache controls and cache tags** through the `cf` request init object, including `cacheEverything`, `cacheKey`, `cacheTags`, `cacheTtl`, and `cacheTtlByStatus`. Source: [Request: cf properties](https://developers.cloudflare.com/workers/runtime-apis/request/).

## Current repo architecture

### Worker topology and bindings

- `apps/storefront/wrangler.jsonc` binds `BACKEND_API` to `scalius-api`, `CACHE_CONTROL` KV for storefront cache metadata, and uses `CACHE_NAMESPACE = storefront.scalius.com`.
- `apps/admin-v2/wrangler.jsonc` binds `API` to `scalius-api`.
- `apps/api/wrangler.jsonc` has D1, API KV `CACHE`, auth KV, queues, R2, Workers AI, and `PURGE_URL = https://storefront.scalius.com/api/purge-cache`.
- There is no API-to-storefront service binding today; API invalidation calls the storefront over public HTTPS using `PURGE_URL` and `PURGE_TOKEN`.

### API cache layer

Key files:

- `apps/api/src/middleware/cache.ts`
- `apps/api/src/utils/kv-cache.ts`
- `apps/api/src/utils/api-cache-fence.ts`
- `apps/api/src/utils/cache-invalidation.ts`
- `apps/api/src/utils/cache-ttls.ts`

Behavior:

- Public GET routes use `cacheMiddleware()` with API KV `CACHE`, usually under key prefixes such as `api:products:`, `api:categories:`, `api:storefront:layout:`, `api:checkout:config:v2:`.
- Cache keys canonicalize query strings and can drop route-specific defaults.
- API cache entries are versioned by a fence token. The middleware captures fence snapshots before work, writes in `waitUntil()`, and refuses to write if a fence changed before the background write completes.
- Invalidators bump fences before deleting KV keys by prefix, which protects against stale in-flight cache writes.
- TTLs are centralized: standard 3600s, short 300s, medium 600s, attributes 1800s, checkout config 60s, and none 0.

This is a strong pattern. The fence-before-delete design is one of the repo's best freshness protections.

### Storefront HTML and data cache layer

Key files:

- `apps/storefront/src/middleware.ts`
- `apps/storefront/src/lib/edge-cache.ts`
- `apps/storefront/src/lib/cache-version.ts`
- `apps/storefront/src/lib/cache-generations.ts`
- `apps/storefront/src/lib/cache-key.ts`
- `apps/storefront/src/lib/product-list-query.ts`
- `packages/shared/src/storefront-cache-path.ts`
- `apps/storefront/src/pages/api/purge-cache.ts`

Behavior:

- `middleware.ts` caches public HTML/XML/text responses in `caches.default`.
- The HTML cache key is the canonical URL plus `cache_v={kvVersion}-{BUILD_ID}` and sometimes `cache_gen={exactGeneration}`.
- It forces browsers to `Cache-Control: no-cache, no-store, must-revalidate`, while the stored Cache API clone gets `public, max-age=31536000, immutable`.
- `withEdgeCache()` wraps storefront API/data fetchers with L1 memory cache plus L2 `caches.default`. L2 keys look like `https://{hostname}/_api-cache/{encodedLogicalKey}?v={kvVersion}&build={BUILD_ID}[&g={generation}]`.
- Exact generations exist for products, variants, widgets, widget scopes, page renders, exact HTML paths, checkout config, checkout language, shipping zones/areas, and shipping methods.
- On exact generation lookup failure, exact risky caches bypass rather than risk stale exact entries.
- Product/category/search URL query handling is canonicalized and strips tracking/noisy params.

This is also the right shape for Cloudflare Cache API because it avoids needing prefix deletion from Cache API.

### Storefront purge and warm path

Key file: `apps/storefront/src/pages/api/purge-cache.ts`

Behavior:

- The purge endpoint rejects URL tokens and requires `Authorization: Bearer` or the configured purge header.
- It decides whether to bump global storefront version versus exact generations through `cache-purge-policy.ts`.
- Broad/group purges bump `v_{cacheNamespace}` in storefront KV.
- Exact purges read the current generation, bump generation keys, best-effort delete old exact Cache API keys, clear local L1 prefixes, and schedule exact HTML warm paths.
- Rewarming uses public `fetch()` back to the storefront origin with `X-Cache-Warm: true` and `Cache-Control: no-cache`.
- Exact warm paths are canonicalized and capped at 20, with concurrency 4.

### Invalidation ownership

Key file: `apps/api/src/utils/cache-invalidation.ts`

Behavior:

- Invalidation groups define API KV prefixes, whether HTML should bump, and storefront logical prefixes.
- Admin writes call `invalidateApiAndScheduleStorefrontGroups()`, `invalidateCatalogCaches()`, or product-availability helpers.
- Product availability invalidation is more precise: it resolves product subjects, bumps API exact/detail/search fences, deletes relevant API key families/patterns, sends product/variant exact storefront keys, and includes exact `/products/{slug}` HTML paths plus CMS shortcode page paths.
- Catalog writes still use broader groups and send warm hints such as `/search` and affected category/product paths when known.

## Repo flaws and freshness risks

### 1. KV generation invalidation is not globally instant

The storefront version/generation model depends on KV reads seeing the latest `v_...` or `g:...` key. Cloudflare KV docs explicitly say writes can take 60 seconds or more to become visible in other locations. That means a user in a different colo may read an old generation and continue matching old Cache API entries for a short window.

This does not make the design wrong, but it means it is not "instant purge" in the Cloudflare CDN sense. It is an eventually consistent application-level pointer flip.

Highest-risk areas:

- Checkout config after a merchant disables or rotates a payment gateway.
- Product availability after payment/order transitions.
- Layout/security/CSP changes where stale policy could keep rendering briefly.

Current mitigations:

- Checkout uses a 60s API KV TTL and a generation-scoped storefront key.
- Exact generation lookup failures bypass exact cache.
- API fences protect against stale background writes.

Remaining gap:

- A stale successful generation read is not treated as failure. A colo that still sees the previous KV value can serve previous Cache API content.

### 2. SWR semantics are mixed up between CDN and Cache API

`apps/api/src/middleware/cache.ts` sets `Cache-Control: public, max-age=0, stale-while-revalidate=120, stale-if-error=300` and comments that Cloudflare async SWR applies.

That is only true for Cloudflare CDN/cache-rule/fetch caching paths where Cloudflare's normal HTTP cache is used. It is not true for `caches.default.match()` / `cache.put()`; Cloudflare docs say those directives are not supported by Cache API methods. The storefront's L2 data and HTML cache are Cache API entries, so they need an explicit Worker-level SWR envelope if stale serving is desired.

### 3. A TTL constant/comment is wrong

`apps/storefront/src/lib/edge-cache.ts` has:

```ts
const DEFAULT_TTL_SECONDS = 8640000; // 24 hours - purge-cache handles invalidation
```

`8,640,000` seconds is 100 days, not 24 hours. This is probably intentional "nearly forever until purge", but the comment is materially misleading for future freshness decisions.

### 4. The repo has two independent public data cache systems

The API caches public JSON in KV, and the storefront caches unwrapped API results in Cache API. Some API endpoints intentionally return `no-store` (`/storefront/homepage`, `/storefront/pages/slug`, widget scoped reads), but the storefront then caches their unwrapped payloads through `withEdgeCache()`.

That can be valid, but it makes the invalidation map the only source of truth. If a route moves, a key changes, or a prefix is missed, stale content can survive both layers.

### 5. Public purge URL is less Cloudflare-native than a Service Binding

The API Worker calls `https://storefront.scalius.com/api/purge-cache` with a purge token. Cloudflare Service Bindings would avoid a public URL, avoid token-bearing HTTP hops, reduce latency/overhead, and make invalidation explicitly internal.

The public endpoint can remain as a manual/admin fallback, but it should not be the primary path between Workers.

### 6. Rewarming can race KV propagation and has no durable retry

The purge endpoint writes KV, then schedules public fetches in `waitUntil()`. Because KV is eventually consistent, a warm request routed through a different location could read the old generation and warm the wrong key. `waitUntil()` is also capped at 30 seconds, so larger warm sets or slow pages can be canceled without retry.

The current cap of 20 paths and concurrency 4 is a useful guardrail, but important warm jobs should be durable Queue messages with idempotency and retries.

### 7. Broad prefix/group invalidation is hard to reason about

The current group map is comprehensive, but it mixes API KV prefixes, storefront data prefixes, HTML bump behavior, and business domains in one large object. This makes it easy to accidentally use broad `products` invalidation where exact entity generation would be enough, or to forget a secondary page like CMS shortcode render targets.

The product-availability helper is the cleaner model: resolve typed subjects, then derive exact API keys/patterns, storefront exact keys, and HTML paths.

### 8. Cloudflare cache tags are not used

Cache API supports `Cache-Tag` on responses passed to `cache.put()`, and Cloudflare supports purge by tag. The repo currently relies almost entirely on KV pointer changes and local exact deletes. Cache tags would provide a Cloudflare-native global purge mechanism for selected classes of content and reduce dependence on KV propagation for urgent invalidations.

Tradeoff: tag purge uses Cloudflare's purge API and rate limits, so it should be a targeted tool, not a replacement for all generation keys.

### 9. Public HTML disables browser storage more aggressively than necessary

Public HTML HIT/MISS responses are returned with `no-cache, no-store, must-revalidate`. For non-sensitive public pages, `no-cache` is usually enough to force revalidation while still allowing browser/BFCache optimizations. `no-store` is appropriate for cart, checkout, account, payment, and authenticated pages, but it is a performance cost for product/category/home/search pages.

## Recommended simplified architecture

### Design principles

1. **One source of invalidation truth**: domain writes emit typed cache subjects; cache-specific prefixes/keys/tags are derived, not hand-maintained at call sites.
2. **Cache API for payloads, KV for pointers**: Cache API stores HTML/data; KV stores small generation and fence records.
3. **Cache tags for urgent global purge**: use tags where "globally gone now" matters, with generation keys still providing normal app-level isolation.
4. **Service Bindings for internal control plane**: API/admin/storefront internal calls should not use public URLs unless they are fallback/manual paths.
5. **Durable warming for important paths**: `waitUntil()` is fine for 1-4 best-effort paths; use Queues for larger or business-critical warm sets.
6. **Different safety classes**: checkout/payment/auth data should fail closed or bypass; catalog/listing/layout may serve bounded stale content.

### Cache subject contract

Replace most direct string-prefix invalidation call sites with a typed shape like:

```ts
type CacheSubject =
  | { kind: "product"; id: string; slug: string; categorySlugs?: string[] }
  | { kind: "category"; id: string; slug: string }
  | { kind: "collection"; id: string }
  | { kind: "page"; id: string; slug: string }
  | { kind: "widget"; id: string; scopes: WidgetScopeTarget[] }
  | { kind: "layout" }
  | { kind: "homepage" }
  | { kind: "checkout" }
  | { kind: "attributes"; categorySlugs?: string[] }
  | { kind: "search" };

interface CacheInvalidationPlan {
  mutationId: string;
  reason: string;
  subjects: CacheSubject[];
  safety: "strict" | "normal" | "best-effort";
  warmPaths?: string[];
}
```

Then derive:

- API fence scopes and exact KV key families.
- Storefront group generation keys.
- Storefront entity generation keys.
- Cache API tags.
- Exact HTML paths.
- Rewarm jobs.

### Storefront generation model

Use three pointer levels:

```text
sfv:{namespace}:global -> rarely bumped; deploy/global emergency
sfg:{namespace}:{group} -> layout, homepage, products-list, categories, collections, pages, widgets, checkout, attributes, search
sfe:{namespace}:{kind}:{idOrSlug} -> product, category, collection, page, widget, html path
```

Recommended page/data dependencies:

| Surface | Cache key depends on | Notes |
|---|---|---|
| `/` | build id + `layout` + `homepage` | Warm immediately after homepage/layout writes. |
| `/products/{slug}` | build id + `layout` + product entity + relevant widget/page shortcode entities | Product availability bumps product entity only; product metadata may also bump products-list/search. |
| `/categories/{slug}` | build id + `layout` + category entity + `products-list` + `attributes` | Category metadata bumps category entity; product assignment/filter changes bump products-list/attributes. |
| `/search?...` | build id + `layout` + `products-list` + `attributes` + canonical query | No tracking params; invalid filters redirect/canonicalize before lookup. |
| CMS `/{slug}` | build id + `layout` + page entity + widget/product shortcode entities | Shortcode dependency scan creates exact targets; fallback to group bump if scan fails or exceeds cap. |
| Checkout config data | `checkout` only | Never bump global HTML for checkout-only writes. Fail closed on read failure. |
| Layout data | `layout` | Header/footer/nav/theme/security/media/currency. |

### Cache API entry tags

When storing Cache API entries, add tags such as:

```text
sf:{namespace}
build:{BUILD_ID}
group:layout
group:products-list
product:{slug}
category:{slug}
page:{slug}
html:/products/{slug}
data:checkout
```

Use tag purge only for:

- Strict/high-risk invalidations where KV propagation delay is unacceptable.
- Emergency broad purge by group or build.
- Cleanup of old generated families when exact Cache API URLs are not known.

Normal invalidation can still rely on generation key changes because it avoids Cloudflare purge API rate pressure.

### Worker-level SWR for Cache API

Because Cache API does not support `stale-while-revalidate`, implement SWR in the cached payload:

```ts
interface CacheEnvelope<T> {
  payload: T;
  cachedAt: number;
  softTtlMs: number;
  hardTtlMs: number;
  generationSnapshot: Record<string, string>;
}
```

Read algorithm:

1. Resolve required generation keys.
2. Read Cache API entry.
3. If no entry, fetch fresh and cache.
4. If generation snapshot does not match current generation, treat as miss.
5. If age is below `softTtlMs`, return fresh HIT.
6. If age is between `softTtlMs` and `hardTtlMs`, return stale HIT and schedule refresh in `waitUntil()`.
7. If refresh succeeds, write only if the generation snapshot is still current.
8. If fetch fails and age is below `hardTtlMs`, return stale for `normal` surfaces; for `strict` surfaces such as checkout config, fail closed instead.

Suggested starting TTL classes:

| Class | Soft TTL | Hard TTL | Stale on error? |
|---|---:|---:|---|
| Product/category/page HTML | 5 min | 24 h | Yes |
| Product listings/search | 2 min | 30 min | Yes, unless stock-sensitive mode is enabled |
| Layout/homepage | 5 min | 24 h | Yes |
| Checkout config | 0-30 sec | 60 sec | No; fail closed |
| CSP/security settings | 0-60 sec | 5 min | Prefer no stale after policy change |

### Exact invalidation flow

After a write commits:

1. Domain/service layer returns `CacheInvalidationPlan`.
2. API cache invalidation:
   - Bump API fence scopes first.
   - Delete exact versioned key families when cheap and known.
   - Avoid depending on KV list/delete for correctness; deletion is cleanup because fence token changes already isolate new writes.
3. Storefront invalidation:
   - API calls storefront invalidation through a Service Binding, not public `PURGE_URL`.
   - The request includes subjects, expected namespace, mutation id, safety level, and warm paths.
4. Storefront invalidation handler:
   - Canonicalizes HTML paths with the shared cache-path helper.
   - Bumps exact entity generations for product/page/category/widget targets.
   - Bumps group generations only when the subject is truly group-wide or exact target count exceeds cap.
   - Writes all generation keys before scheduling warm work.
   - Best-effort clears local L1 entries.
   - Optionally calls Cloudflare purge-by-tag for strict subjects if zone purge credentials are configured.
5. Rewarm:
   - For 1-4 paths, `waitUntil()` is acceptable.
   - For larger sets or strict surfaces, enqueue warm jobs.
   - Warm jobs carry `expectedGeneration` so they do not warm old keys after a race.
   - Use idempotency keys such as `warm:{namespace}:{generation}:{canonicalPath}`.

### Rewarm target policy

Default exact warm paths:

| Write | Warm |
|---|---|
| Product create/update/restore/delete | `/products/{slug}`, `/search`, affected `/categories/{slug}` |
| Product stock/availability only | `/products/{slug}` and CMS shortcode pages that embed it; avoid broad catalog bump |
| Category write | `/categories/{slug}`, `/search`, `/` only if navigation/homepage depends on categories |
| Page publish/update/restore | `/{slug}` plus layout if fallback navigation changed |
| Page unpublish/delete | do not warm hidden page; bump/delete exact path and layout when needed |
| Widget homepage/global | `/` |
| Widget scoped placement | exact product/category/page/collection paths |
| Checkout/payment/delivery settings | no HTML warm; warm checkout config data only if a server-side warm route exists |
| Layout/security/theme/navigation | `/`, plus top N public pages from analytics/search/product/category |

For top-N warming, use Cloudflare Web Analytics/Zaraz/application logs if available, but keep the cache architecture independent of those systems.

## Concrete improvements for this repo

1. Add an API-to-storefront Service Binding, for example `STOREFRONT`, and route invalidation through `env.STOREFRONT.fetch(new Request("https://internal/cache/invalidate", ...))`. Keep `/api/purge-cache` as manual fallback.
2. Replace `PURGE_URL` as the primary path in `apps/api/src/utils/cache-invalidation.ts`.
3. Rename/fix the `DEFAULT_TTL_SECONDS` comment in `apps/storefront/src/lib/edge-cache.ts`; decide whether it is 24h (`86400`) or 100d (`8640000`).
4. Add `Cache-Tag` headers to Cache API stored responses in `middleware.ts` and `edge-cache.ts`.
5. Add optional Cloudflare purge-by-tag support for strict invalidations and emergency admin clears.
6. Introduce a Worker-level SWR envelope for `withEdgeCache()` and HTML Cache API entries; do not rely on HTTP SWR directives for Cache API.
7. Change public cacheable HTML responses from `no-cache, no-store, must-revalidate` to `no-cache, must-revalidate` unless the route is cart/checkout/account/auth/payment or has a private session.
8. Move warm jobs to a Queue for more than a tiny path set; include expected generation in the warm request/job.
9. Make `CacheInvalidationPlan` the only input produced by write routes/domain services. Derive existing `invalidateGroups`, exact keys, tags, and paths from it during migration.
10. Keep the API fence system. It is valuable and should remain even if storefront invalidation is simplified.

## Risks and tradeoffs

- **KV propagation**: generation keys are cheap and simple, but not instant globally. Use cache tags or strict bypass for high-risk freshness.
- **Purge API rate limits**: tag purges are powerful but rate-limited. Use them for strict/emergency cases, not every normal catalog write.
- **Service Binding deployment order**: API depends on storefront binding after introduction. Deploy target Worker first and keep the public purge fallback during rollout.
- **Cache API is per-colo**: a warm in one location does not warm every location. This is acceptable for edge-local performance, but not a global prefill strategy.
- **Worker-level SWR can serve stale content by design**: classify surfaces carefully. Checkout/payment/security should avoid stale serving or use very short hard TTLs.
- **Rewarm load**: popular-path warming can protect TTFB but can also create write-amplified load. Queue concurrency and caps matter.
- **Cache tag cardinality**: tags should be short, ASCII, and bounded. Do not tag every attribute/value combination if it can explode cardinality.

## Test plan

### Unit tests

- `cache-key` and `storefront-cache-path`: canonical query ordering, default param dropping, tracking param stripping, product `size/color` ignoring, repeated param collapse.
- `cache-generations`: group/entity key derivation, checkout-only generation scope, product/category/page/widget exact generation derivation.
- `cache-purge-policy`: checkout-only does not bump HTML/global; unknown prefix falls back to global; exact paths are capped and canonicalized.
- API fence tests: stale background writes after a fence bump are refused.
- `withEdgeCache` SWR envelope: fresh hit, stale hit with refresh, hard-expired miss, generation mismatch miss, strict surface fail-closed.
- Cache tag builder: stable tag set per subject and bounded tag length/count.

### Integration tests

- Product update invalidates API product detail, search/list patterns, exact storefront data, `/products/{slug}`, `/search`, and affected category path.
- Product stock-only write does not bump global storefront version.
- Checkout payment disable invalidates API checkout config and storefront checkout generation without warming `/`.
- CMS page with product/widget shortcode invalidates the exact page render and HTML path.
- Public purge endpoint rejects URL tokens and accepts only header tokens.
- Service Binding invalidation path works without `PURGE_URL` when binding is present; public URL fallback still works when binding is absent.

### Edge/runtime tests

- Simulate stale KV generation reads after a bump and verify strict surfaces bypass/fail closed.
- Simulate warm request routed before generation visibility and verify `expectedGeneration` prevents warming old keys.
- Verify Cache API stored responses with `Cache-Tag` can be purged by tag in a staging zone.
- Verify Cache API entries do not rely on `stale-while-revalidate` headers by testing Worker-level SWR behavior directly.
- Verify public product/category/search HTML can use browser `no-cache` without `no-store`, while checkout/account/cart remain `no-store`.

### Production/staging smoke tests

- After product edit: first request to `/products/{slug}` shows new content and an `X-Cache-Status` MISS/new generation, second request is HIT/new generation.
- After checkout gateway disable: `/checkout` cannot create a new session for the disabled gateway and public checkout config does not expose it.
- After layout/theme/security change: `/`, `/products/{slug}`, and a CMS page render with new layout generation.
- After deploy: old build assets are not referenced because `BUILD_ID` remains in HTML/data keys.
- Rewarm queue dashboards show retries, dead letters, and per-path warm latency.

## Bottom line

The current architecture is close, but it is carrying too many overlapping concepts: API KV cache, API fence tokens, storefront L1, storefront Cache API L2, global version, exact generations, public purge URL, prefix groups, and immediate public rewarm fetches. The simplification is not to remove Cloudflare-native caching; it is to make each layer do one job:

- Service Bindings for internal calls.
- API fences for API KV correctness.
- Cache API for storefront edge payloads.
- KV generations for cheap app-level cache keys.
- Cache tags for urgent global purge.
- Queues for durable warming.
- Typed cache subjects as the one invalidation contract.
