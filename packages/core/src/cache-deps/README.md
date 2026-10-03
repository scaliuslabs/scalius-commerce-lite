# Public cache validity (DVC)

This document owns how public API reads and storefront pages are cached and proved fresh: the dependency registry, the SQL triggers, the `deps.*` declarations of readers, the frontier proofs and the one-second freshness bound. DVC means dependency validation cache. Read it before you add a buyer-visible table or column, a public reader or a cache key.

## Contract

- The API Worker caches each public read, and the storefront Worker caches each public page, in the Cache API (`caches.default`). There is no purge, no warm list and no route generation.
- An entry stores the dependency keys its render read and the change-clock value `s0` the render started at. The entry is valid while no key it depends on has a clock value above `s0`.
- The API validates all cached parts of one batch with one database statement.
- The storefront validates a page against a change frontier of its data center that is at most 1 second old (`CACHE_FRONTIER_DELTA_MS`). A page served at time t shows every write acknowledged before t minus 1 second.
- A dashboard "view on store" link carries `_sv=<clock>`. The storefront then refreshes its frontier to at least that clock before it serves, so the merchant sees their own write at once.
- Content has no routine expiry. A scheduled change (a promotion start or end) sets `validUntil`: the entry is never served at or after it.
- Cache API objects carry a one-year storage hint (`DEPENDENCY_CACHE_RETENTION_SECONDS`). Cloudflare may evict them sooner. An eviction costs one render and never correctness.
- Without proof the Worker renders live. It never serves stale content.
- Public API responses carry `no-store` CDN headers, so no other CDN cache bypasses validation. `pnpm check:env` fails when the API default or a named entrypoint enables the Workers Cache, or when `PublicApi` exists.
- The Worker version (`CF_VERSION_METADATA`) is part of every cache key. Page proofs also carry the API Worker version. Without a version, nothing is cached.

```text
write (any path) -> trigger -> cache_dep (key -> seq), cache_clock.seq
render -> withDependencyScope -> keys + s0 -> Cache API entry
hit    -> API: one validation statement | storefront: frontier <= 1 s old
```

## Write side: registry and triggers

`CACHE_DEP_TABLES` in `packages/shared/src/cache-deps.ts` is the one registry. Each registered table has:

| Field | Meaning |
| --- | --- |
| `kinds` | Key kinds that cover a read of the table. |
| `noise` | Columns no public payload outputs. A change of only these columns advances no key. Any other column is buyer-visible. |
| `rules` | Per event (insert, update, delete): the row image, the changed columns, a guard and the keys to advance. |

Tables that a public read may touch without a key are in `CACHE_DEP_EXEMPT_TABLES`, each with a reason.

`packages/database/scripts/cache-dep-triggers.ts` generates one trigger per rule from the registry. The tables `cache_clock` (one row: `seq`, `floor`, `coarse`) and `cache_dep` (`dep`, `seq`) hold the result.

- **SQLite (D1, Turso).** The guard is the trigger `WHEN` clause. The body is one `INSERT INTO cache_dep ... ON CONFLICT DO UPDATE` statement. Remote D1 rejects trigger bodies that embed `SELECT CASE WHEN`. Each key gets `cache_clock.seq + 1`. Two triggers on `cache_dep` raise the clock.
- **PostgreSQL.** Each trigger is a deferred constraint trigger. At commit it calls `scalius_compat."cache_dep_bump"`, which locks the clock row. Transactions commit in clock order.

Rules the triggers keep:

- A buyer-visible change of a registered row advances every key its rule derives, from the old and the new row image, in the same transaction as the change, whatever code wrote it.
- An update rule fires only when a visible column changed. A move out of a menu, category, brand, product or promotion advances the one it left (the derived old-image companion rule).
- A stock change that stays inside the SKU availability band advances nothing. A band change advances the product keys.
- Every change of a registered table also advances `t:<table>`.
- `rebuildCatalogProjections` sets `cache_clock.coarse = 1` for its batches. Every trigger then advances only `store`.
- `POST /api/v1/cache/clear` (Settings, Advanced, "Refresh store"; permission `settings.cache.manage`) advances `store`. Every entry depends on `store`.
- `cache_clock.floor` is the pruning floor: an entry with `s0` below it is invalid. No code prunes `cache_dep` today, so it stays 0.

### Key kinds

A key is `kind:id[:facet]` or a bare constant. Ids are the database row ids.

| Kind | Key | Advances when |
| --- | --- | --- |
| `p` | `p:<productId>` | Any buyer-visible fact of the product (page, card, JSON-LD, feed row) changes. |
| `rec` | `rec:<productId>` | The stored recommendations of that source product change. |
| `sold` | `sold:<productId>` | The visible sold count changes (only at 10 or more units in 30 days). |
| `popular` | `popular` | The popular home list changes (only at 2 or more units). |
| `recommendation-signals` | constant | An order or order line changes. Only the live ranking fallback reads it. |
| `lm` | `lm:all`, `lm:cat:<id>`, `lm:brand:<id>`, `lm:seo`, `lm:shape` | Membership and newest order of a public product set change; sitemap and feed flags and lastmods change; the store-shape counts change. |
| `lo` | `lo:<facet>:<scope>` | An ordering or filter fact of a member changes. Facets: `price`, `band`, `disc`, `name`, `rating`, and `sale` (scope `all` only). |
| `lf` | `lf:<scope>` | Facet values or counts of a listing change. |
| `srch` | `srch` | Searchable text of a product or category changes. |
| `c`, `b`, `col`, `pg`, `attr`, `promo` | `<kind>:<id>`, `<kind>:*` | One row, or any row, of categories, brands, collections, CMS pages, attributes or promotions changes. |
| `m` | `m:<mediaId>` | One media row changes. |
| `set` | `set:<category>:<key>` | One settings document changes. |
| `theme` | `theme` | The published theme changes. |
| `nav` | `nav:<menuId>`, `nav:*` | A published menu or placement changes. |
| `ship`, `loc`, `tax`, `lang`, `an` | constants | Shipping, delivery locations, tax, checkout languages or analytics snippets change. |
| `cf` | `cf:<ownerType>` | A storefront-visible custom field definition of that owner type changes. |
| `plg` | `plg:<pluginId>`, `plg:*` | One app installation (status, version, grant, manifest, settings) and its registrations, or any installation, changes. |
| `plgs` | `plgs:<pluginId>:<collection>` | One storage collection of an app changes. |
| `t` | `t:<table>` | Any buyer-visible change of the table. This is the coarse fallback. |
| `store` | `store` | Everything: "Refresh the storefront" and catalogue rebuilds. |

### Migrations

- Migration 0100 holds the clock tables and the baseline triggers. It is deployed and immutable.
- Migration 0101 holds the triggers of the ordering projections (`product_recommendations`, `product_sales_stats`, `orders`, `order_items`). `pnpm --filter @scalius/database exec tsx scripts/cache-dep-triggers.ts --write` regenerates only 0101.
- A table registered after 0101 gets its triggers in a hand-assembled migration. List the table in `CACHE_DEP_LATER_TABLES` under that migration name. The migration must contain every generated statement verbatim. Examples: 0104 (custom fields), 0108 (promotion customer segments), 0110 (`plugin_installations`, `plugin_registrations`, `plugin_records`).
- Keep every trigger body to one statement and keep the guard in `WHEN` (remote D1 rule).

## Read side: recording

`withDependencyScope(render, options)` runs one public render and returns `{ value, dependencies }`. The scope lives in `AsyncLocalStorage`, so concurrent requests and concurrent batch parts never mix. A nested scope hands its keys to its parent.

- `@scalius/database/read-observer`: every transport (the D1 client, the Turso adapter, the PostgreSQL adapter) calls `observeStatement` for each statement. Outside a scope the call costs one `AsyncLocalStorage.getStore()`. Inside a scope it reports the tables the statement touched. For a settings statement it also reports the SQL and the bound parameters, so coverage can tell which documents the read used. Table extraction is syntactic and errs toward reporting more tables.
- `deps.*`: what readers call to declare precise keys. Every call is a no-op outside a scope.

`dependencies` (`CacheDependencies`) has these fields:

| Field | Meaning |
| --- | --- |
| `keys` | Sorted keys. `store` is always included. |
| `tables` | Every table the render touched. |
| `coarseTables` | Registered tables that no declared key covered. Each added its `t:<table>` key and logged `[CacheDeps] coarse <label> <tables>`. |
| `collapsedKinds` | Kinds that the key budget replaced by their `t:` keys. |
| `softMaxAgeSeconds` | An explicit caller bound. Ordinary reads never set it. |
| `validUntil` | The earliest scheduled transition declared. Never serve the entry at or after it. |
| `uncacheable` | Reasons not to store the entry: an unregistered table was read, `deps.uncacheable()` was called, the entry is over budget, or a nested render failed. |

Coverage rules:

- A registered table is covered when a declared key has a kind in `cacheDepKindsForTable(table)`, or when `t:<table>` is declared. Example: `products` is covered by any `p:`, `lo:`, `lm:` or `srch` key.
- Settings are covered by row (`CACHE_DEP_ROW_KEYED_TABLES`). Every settings source of a statement must pin `category` and `key` (`=` or `IN` against literals or bound values). Every document it pins needs its own `set:<category>:<key>`. A statement that reads the whole table, or joins settings on a column, falls back to `t:settings`.
- Every public render declares `set:platform:document`. The part reader reads that row in the same statement as the clock. A KV hint never enters an entry.
- An uncovered registered table falls back to `t:<table>`. This costs hit rate and never correctness.
- A table that is neither registered nor exempt makes the entry uncacheable.
- An entry with more than 256 keys (`CACHE_DEP_ENTRY_KEY_BUDGET`) collapses its most numerous kinds to their `t:` keys. Still above 256: the entry is uncacheable (`over-budget`).

## How to declare deps

Inside core, import `deps` from the `cache-deps` folder (`../../cache-deps` in a domain). The API imports `@scalius/core/cache-deps`.

1. Declare what the output shows, where the data loads. Put the call in the shared loader, not in each route:

   ```ts
   const cards = await loadProductCards(db, ids);
   deps.products(cards.map((card) => card.id));     // p:<id> for every card shown
   ```

2. Pick the key by what would change the output:

   | Output | Declare |
   | --- | --- |
   | A product page, card, JSON-LD block or feed row | `deps.product(id)` / `deps.products(ids)` |
   | Which products are in a listing (and newest order) | `deps.listMembership(scope)`; scope is `"all"`, `categoryScope(id)` or `brandScope(id)` |
   | Sorting or filtering by price, band, discount, name or rating | `deps.listOrder("price" \| "band" \| "disc" \| "name" \| "rating", scope)` |
   | The on-sale home list's candidate window | `deps.listOrder("sale", "all")` plus `deps.products(candidateIds)` for every candidate, shown or not |
   | Facet values and counts | `deps.listFacets(scope)` |
   | Search results | `deps.search()` plus `deps.listMembership("all")` |
   | Sitemap or feed | `deps.listMembership("all")`, `deps.discoveryMembership()`, `deps.products(rowIds)` |
   | Any availability band | `deps.inventoryBands()` (`set:inventory:document`) as well as the product keys |
   | A manual collection | `deps.collection(id)` plus `deps.products(memberIds)` |
   | A dynamic collection | `deps.collection(id)` plus `deps.listMembership(categoryScope(...))`, plus `deps.listOrder(...)` when sorted |
   | One settings document | `deps.settings(category, key)` |
   | Category, brand, CMS page, media, attribute or promotion rows | `deps.category(id)`, `deps.brand(id)`, `deps.page(id)`, `deps.media(id)`, `deps.attribute(id)`, `deps.promotion(id)`, or `deps.anyX()` for a list of all of them |
   | Theme, menus, shipping, locations, tax, languages, analytics | `deps.theme()`, `deps.navigation(menuId)`, `deps.shipping()`, `deps.locations()`, `deps.tax()`, `deps.checkoutLanguages()`, `deps.analytics()` |
   | Custom field values | `deps.customFieldDefinitions(ownerType)` plus the owner's own keys |
   | The store-shape counts | `deps.key(cacheDep.storeShape())` (`lm:shape`) plus the "any row" keys the read uses |
   | App output (sections, product blocks) and the active apps' scripts | `deps.plugin(id)` (one installation), `deps.anyPlugin()` (which apps are active), `deps.pluginCollections(id, reads)` (the storage collections a section declares) |

   Id helpers skip `null` and `undefined`, so you can write `deps.brand(product.brandId)` inline. The generated triggers on `plugin_installations`, `plugin_registrations` and `plugin_records` advance the app keys (migration 0110). `plugin_kv` is exempt because app storefront output never reads it. Declarations for app output live in `packages/core/src/modules/plugins/storefront.ts` and `apps/api/src/plugins/storefront-render.ts`.

3. Time. When the output depends on a scheduled switch, such as a promotion `starts_at` or `ends_at`, call `deps.validUntil(nextTransition)` with the next future instant among the facts read.

4. Facts no key can validate. A KV hint, a live provider call or a per-buyer value makes the output uncacheable. Call `deps.uncacheable("short-code")`. Never put a value in the reason.

5. Ordering projections.
   - Stored recommendation readers declare `deps.recommendations(sourceId)` (`rec:<id>`) even when rows are missing.
   - Card fact readers declare `deps.sold(productId)`. The popular home list also declares `deps.popular()`.
   - Unchanged refreshes only update `computed_at`, which advances no key. Counts leaving the thresholds (10 for sold, 2 for popular) advance the key.
   - Only the live ranking fallback declares `deps.recommendationSignals()`. It also declares `validUntil` at the earliest included order's 30-day popularity exit or 365-day co-purchase exit, plus one second. A quiet order set has no deadline.

6. Check coverage. Run the reader under `withDependencyScope(render, { strict: true })`. Strict mode throws `CacheDepCoverageError` when a table has no covering key, a table is neither registered nor exempt, or a key is malformed. A nested scope inherits strict mode.

## Validate and serve

### API part reader

`createPublicPartReader` in `apps/api/src/public-read.ts` serves every public read inside the calling invocation: each part of `GET /api/v1/storefront/batch` (at most 8 parts) and each direct public GET. The routes are `PUBLIC_API_CACHE_ROUTES`.

1. The key is the canonical URL plus `__cv=<Worker version>`. A missing version means no caching.
2. The reader matches every part in the Cache API. One statement (`readValidationSnapshot`) then reads the clock, the pruning floor, the Platform settings row and every key of the hit entries that changed after the smallest `s0`.
3. An entry is valid when `s0` is not ahead of the clock, it is not at or past `validUntil`, not past its soft age, not below the floor, and no key it depends on has a clock value above `s0`. A valid hit raises its `s0` to the clock without rewriting the body.
4. A miss or a rejected hit renders under `withDependencyScope` with `s0` set to the snapshot clock. The reader stores the entry only when the response is cacheable, `uncacheable` is empty, `validUntil` is still ahead and the key list fits a 16,384-character header.
5. A failed validation fails the part (a direct read answers 503). It never serves an unvalidated body.
6. The reader re-renders 1 in 1,000 validated hits after the response (`DVC_AUDIT_RATE`). A different body with no moved key evicts the entry and logs one masked line `[CacheAudit] stale`.

The reader gives the storefront a proof per part: the API version, `status` (`hit`, `miss`, `refresh`), `s0`, the keys as 48-bit hashes (`hashCacheDep`), `validUntil` and `renderedAt`. Key names never leave the API.

### Storefront page reader

`servePublicStorefrontRequest` in `apps/storefront/src/lib/public-worker-cache.ts` serves anonymous HTML and discovery files. The key is `<origin>/__cache/<BUILD_ID>/<storefront Worker version>/dvc<path><query>`.

1. A miss renders inside a collector (`apps/storefront/src/lib/page-dependencies.ts`). The page entry joins its parts: `s0` is the minimum, the keys are the union, `validUntil` is the minimum.
2. The page is stored only when every API read of the render came through a batch part with a proof, the keys number at most 1,024 and the API version is the same for all parts.
3. A hit needs a frontier at most 1 second old. The frontier is one Cache API object per data center, build and Worker version. A refresh starts in the background once it is older than 0.5 second. A request blocks on a refresh when the frontier is older than 1 second or behind `_sv`. A frontier call that takes longer than 1.5 seconds renders the page live.
4. `decideCacheFrontierHit` decides: render when the API versions differ, `validUntil` or the soft age has passed, or `s0` is below the floor; use the slow path when `s0` is below the frontier horizon; render when a key hash changed after `s0`; otherwise serve.
5. The slow path (`POST /api/v1/storefront/frontier/check`) sends the key hashes. The API scans at most 4,000 changes after `s0` and answers "changed" beyond that. One check runs per entry and isolate; concurrent requests join it.
6. The frontier routes `GET /api/v1/storefront/frontier` and `POST /api/v1/storefront/frontier/check` answer 404 without the `X-Scalius-Frontier-Key` header. The key is an HKDF of `SCALIUS_SECRET` (purpose `cache-frontier`) that both Workers derive. A frontier answer holds at most 4,000 changes.
7. Private requests (checkout, account, a session cookie, variant selections) always render.

### Read your writes

A successful admin write answers with `X-Scalius-Commit-Seq`, the clock after the write (`apps/api/src/middleware/commit-seq.ts`). The dashboard keeps the newest value in memory (`apps/admin-v2/src/lib/store-commit-seq.ts`) and adds `_sv` to "view on store" links. `_sv` never splits the cache key or reaches a render.

### Modes

| Layer | Production | Test comparators |
| --- | --- | --- |
| API reader (`ApiPartCacheMode`) | `strict` (constant `API_PART_CACHE_MODE`) | `generation`, `shadow` |
| Storefront (`StorefrontPageCacheMode`) | `frontier` (constant `STOREFRONT_PAGE_CACHE_MODE`) | `generation` |

`generation` keys entries by an opaque token (`__cg`) and no production code supplies one. `shadow` serves like `generation` and compares what `strict` would have served. Differential tests and the load harness use both. Never enable a Workers Cache entrypoint: its hits would skip validation.

## Add or change a schema element

New buyer-visible table:

1. Add the table to `CACHE_DEP_TABLE_RULES` with `kinds`, `noise` and `rules`. If no public read touches it, add it to `CACHE_DEP_EXEMPT_TABLES` with a reason of more than 20 characters instead. `packages/database/__tests__/cache-dep-triggers.test.ts` fails for a table in neither list or in both.
2. Add a migration that installs every generated trigger verbatim, on every provider (SQLite and the PostgreSQL sidecar). List the table in `CACHE_DEP_LATER_TABLES`. Never edit 0100.
3. Declare precise `deps.*` in every public reader of the table.
4. Run the DVC gate (below).

New column on a registered table:

- The column is buyer-visible unless you list it in `noise`. List it only when no public payload outputs it. `apps/api/src/cache-deps-noise-audit.test.ts` (opt-in) checks this on a copy of a real store.
- A visible column changes the generated update triggers. The test compares the installed trigger text with the generator output, so the change needs a migration that recreates the trigger.

New public reader:

- Declare its keys where the data loads and run it under a strict scope.
- Add a date-dependent fact with `deps.validUntil`.
- Keep per-buyer values out of public reads, or call `deps.uncacheable`.

## Deploy and restore

- Deploy the API Worker and the storefront Worker together. Page proofs carry the API version, so an API-only deploy re-renders every cached page.
- After a database restore or an authority replacement, deploy both Workers before serving traffic. Commit clocks order one database history only, and a restore can reuse earlier clock values. New Worker versions start from empty caches.

## Tests and gates

| Check | Where |
| --- | --- |
| Registry, triggers and migrations agree on every provider | `packages/database/__tests__/cache-dep-triggers.test.ts` |
| Every table a cached public read touches is registered or exempt | `apps/api/src/cache-deps-coverage.test.ts` |
| Noise columns never change a public payload (opt-in, needs `CACHE_DEP_NOISE_AUDIT_DB`) | `apps/api/src/cache-deps-noise-audit.test.ts` |
| Recording, coverage and budget | `packages/core/src/cache-deps/cache-deps.test.ts` |
| A missed invalidation cannot ship: random writes against every cached read | `apps/api/src/cache-dvc.property.test.ts` |
| Commit-order races | `apps/api/src/cache-dvc.race.test.ts` |
| Long runs and load model (local only) | `scripts/cache-dvc-long.mjs`, `scripts/cache-dvc-load.test.ts` |

The release gate must report zero findings:

```bash
DVC_COLLECT=1 DVC_SEEDS=5 pnpm exec vitest run apps/api/src/cache-dvc.property.test.ts apps/api/src/cache-dvc.race.test.ts
```

`DVC_COLLECT=1` lists every distinct finding instead of stopping at the first. `DVC_SEEDS` sets the number of seeds. The header of the property test lists the other modes (`DVC_MODE=long`, `DVC_SEED` replay, `DVC_PROVIDER=turso`).

## Not observed

- Statements sent through a raw binding (`env.DB.prepare`) instead of `getDb(...)`. None exist in `apps/api/src` or `packages/core/src`.
- KV, R2 and provider calls. Declare them with `deps.uncacheable(...)`, or with the settings key whose row the KV value mirrors.

Page and render budgets: [docs/STOREFRONT-PERFORMANCE.md](../../../../docs/STOREFRONT-PERFORMANCE.md).
