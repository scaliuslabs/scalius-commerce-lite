# Public cache validity (DVC)

This document owns how public API reads and storefront pages are cached and proved fresh: the dependency registry, SQL triggers, `deps.*` declarations, frontier proofs and the one-second freshness bound. DVC means dependency validation cache. Read it before you add a buyer-visible table or column, a public reader or a cache key.

## Contract

- The API Worker caches each public read, and the storefront Worker each public page, in the Cache API (`caches.default`). There is no purge, warm list or route generation.
- An entry stores the dependency keys its render read and the change-clock value `s0` the render started at. It stays valid while no key it depends on has a clock value above `s0`.
- The storefront validates a page against a change frontier of its data center that is at most 1 second old (`CACHE_FRONTIER_DELTA_MS`). A page served at time t shows every write acknowledged before t minus 1 second.
- A scheduled change (a promotion start or end) sets `validUntil`: the entry is never served at or after it. Otherwise content has no expiry.
- Objects carry a one-year storage hint (`DEPENDENCY_CACHE_RETENTION_SECONDS`). An eviction costs one render, never correctness. Without proof the Worker renders live and never serves stale content.
- Public API responses carry `no-store` CDN headers. `pnpm check:env` fails when the API default or a named entrypoint enables the Workers Cache, or when `PublicApi` exists.
- The Worker version (`CF_VERSION_METADATA`) is part of every cache key, and page proofs also carry the API Worker version. Without a version, nothing is cached.

```text
write (any path) -> trigger -> cache_dep (key -> seq), cache_clock.seq
render -> withDependencyScope -> keys + s0 -> Cache API entry
hit    -> API: one validation statement | storefront: frontier <= 1 s old
```

## Write side: registry and triggers

`CACHE_DEP_TABLES` in `packages/shared/src/cache-deps.ts` is the one registry. A registered table has `kinds` (the key kinds that cover a read of it), `noise` (columns no public payload outputs; every other column is buyer-visible) and `rules`. A rule gives, per event (insert, update, delete), the row image, the changed columns, a guard and the keys to advance. `CACHE_DEP_EXEMPT_TABLES` lists tables a public read may touch without a key, each with a reason.

`packages/database/scripts/cache-dep-triggers.ts` generates one trigger per rule. The tables `cache_clock` (one row: `seq`, `floor`, `coarse`) and `cache_dep` (`dep`, `seq`) hold the result.

- **SQLite (D1, Turso).** The guard is the trigger `WHEN` clause. The body is one `INSERT INTO cache_dep ... ON CONFLICT DO UPDATE` statement, because remote D1 rejects trigger bodies that embed `SELECT CASE WHEN`. Each key gets `cache_clock.seq + 1`. Two triggers on `cache_dep` raise the clock.
- **PostgreSQL.** Each trigger is a deferred constraint trigger. At commit it calls `scalius_compat."cache_dep_bump"`. From 0151, `cache_dep` is an insert-only change log: a transaction takes one seq from a sequence under a transaction advisory lock (so transactions commit in seq order) and appends one row per key; nothing updates a shared row, so concurrent SERIALIZABLE checkouts do not fail on the clock. The clock is the newest committed seq, readers take each key's largest seq, and the API's every-minute `cache_dep_compaction` drain removes superseded rows (`cache_dep_compact()`). Manual bumps use `advanceCacheDeps` (`@scalius/database/cache-dep-writes`).

The triggers keep these rules:

- A buyer-visible change of a registered row advances every key its rule derives, from the old and the new row image. It does so in the same transaction, whatever code wrote the row. An update rule fires only when a visible column changed. A move out of a menu, category, brand, product or promotion advances the one it left. Every change also advances `t:<table>`.
- A stock change inside the SKU availability band advances nothing. A band change advances the product keys.
- `rebuildCatalogProjections` sets `cache_clock.coarse = 1` for its batches. Every trigger then advances only `store`.
- `POST /api/v1/cache/clear` (Settings, Advanced, "Refresh store"; permission `settings.cache.manage`) advances `store`. Every entry depends on `store`.
- An entry with `s0` below `cache_clock.floor` is invalid. No code prunes `cache_dep`, so the floor stays 0.

### Key kinds

A key is `kind:id[:facet]` or a bare constant. Ids are database row ids. The key builders are `cacheDep` in `packages/shared/src/cache-deps.ts`.

```text
p:<productId>   rec:<productId>   sold:<productId>   popular   recommendation-signals
lm:all  lm:cat:<id>  lm:brand:<id>  lm:seo  lm:shape
lo:<facet>:<scope>   lf:<scope>   srch
c|b|col|pg|attr|promo : <id> or *    (categories, brands, collections, CMS pages, attributes, promotions)
m:<mediaId>   set:<category>:<key>   theme   nav:<menuId> or nav:*
ship  loc  tax  lang  an   cf:<ownerType>   plg:<pluginId> or plg:*   plgs:<pluginId>:<collection>
mk:<marketId>   mk:*   mk:backup   mk:selling   mo:<definitionId> or mo:*
t:<table>   store
```

- `p` advances on any buyer-visible fact of the product (page, card, JSON-LD, feed row). `lm` covers membership and newest order of a public product set, sitemap and feed flags and lastmods, and the store-shape counts (`lm:shape`). `lo` facets are `price`, `band`, `disc`, `name`, `rating` and `sale` (scope `all` only).
- `sold` advances only when the visible sold count changes (10 or more units in 30 days), `popular` only at 2 or more units. `recommendation-signals` advances on any order or order line change; no request reads it any more (the ranking runs only in the refresh jobs, outside a scope), so its triggers are a later migration's to drop.
- `mk:<marketId>` advances on any change of a market's row, countries or presences, and `mk:*` on any market change (the active presence matrix). `mk:backup` advances only when the backup market's `price_increment_minor` changes. Every reader that prices at the increment declares it (`deps.backupMarketPricing()`). `mk:selling` is the set of countries the active markets sell to (`deps.sellingCountries()`): it advances when a country of an active market or a market's status changes, never for a rename or a presence edit; the checkout config declares it beside its own `mk:<id>`.
- `mo:<definitionId>` advances on any change of a metaobject definition or one of its entries; `mo:*` on any definition change. A section that shows a definition's entries declares its `mo:<id>`.
- `t:<table>` is the coarse fallback for any buyer-visible change of the table. `store` is everything.

### Market-keyed and market-invariant reads

`PUBLIC_API_CACHE_ROUTES` (`packages/shared/src/public-api-cache-routes.ts`) gives every public read a `market` field: `{ keyed: true }` or `{ invariant: <reason> }` (MARKETS-DESIGN D4). This is the one list of reads that are the same in every market.

- A keyed read carries the page's presence (`?presence=en-in`), so the presence is part of its key. Only `/api/v1/checkout/config` is keyed. The storefront transport adds the presence to keyed reads only (`withMarketPresence()`), so root pages keep their keys.
- A route learns its presence only through `publicMarketPresence()` (`apps/api/src/utils/public-market.ts`) and reads that market joined with its settings documents (`readPresenceMarketWithDocuments()`), in the statement it already runs. The helper refuses an invariant route, so a read cannot vary by market while its key does not.
- Before a read varies by market (price lists, FX, translations in step 4), mark it keyed. Its presence then enters its key.

### Migrations

Migration 0100 holds the clock tables and the baseline triggers (deployed, immutable). Migration 0101 holds the triggers of the ordering projections (`product_recommendations`, `product_sales_stats`, `orders`, `order_items`). `pnpm --filter @scalius/database exec tsx scripts/cache-dep-triggers.ts --write` regenerates only 0101. A table registered after 0101 gets a hand-assembled migration that contains every generated statement verbatim, and `CACHE_DEP_LATER_TABLES` names that migration (0104 custom fields, 0108 promotion customer segments, 0110 the plugin tables, 0112 the market tables).

## Read side: recording

`withDependencyScope(render, options)` runs one public render and returns `{ value, dependencies }`. The scope lives in `AsyncLocalStorage`, so concurrent requests and batch parts never mix. A nested scope hands its keys to its parent.

- Every database transport (D1, Turso, PostgreSQL) calls `observeStatement` from `@scalius/database/read-observer`. Inside a scope it reports the tables a statement touched (syntactic extraction, biased toward more tables), and for a settings statement also the SQL and bound parameters.
- Readers call `deps.*` to declare precise keys. Outside a scope every call is a no-op.

The `dependencies` result (`CacheDependencies`) holds the sorted `keys` (`store` is always in them), the `tables` touched, `validUntil` (the earliest scheduled transition declared) and:

- `coarseTables`: registered tables that no declared key covered. Each added its `t:<table>` key and logged `[CacheDeps] coarse <label> <tables>`.
- `collapsedKinds`: kinds that the key budget replaced by `t:` keys.
- `uncacheable`: reasons not to store the entry. An unregistered table was read, `deps.uncacheable()` was called, the entry is over budget, or a nested render failed.

Coverage rules:

- A registered table is covered when a declared key has a kind in `cacheDepKindsForTable(table)`, or when `t:<table>` is declared. Any `p:`, `lo:`, `lm:` or `srch` key covers `products`.
- Settings are covered by row (`CACHE_DEP_ROW_KEYED_TABLES`). Every settings source of a statement must pin `category` and `key` (`=` or `IN` against literals or bound values), and every pinned document needs its own `set:<category>:<key>`. A statement that reads the whole table, or joins settings on a column, falls back to `t:settings`.
- Every public render declares `set:platform:document`. The part reader reads that row in the same statement as the clock. A KV hint never enters an entry.
- An uncovered registered table falls back to `t:<table>`, which costs hit rate and never correctness. A table that is neither registered nor exempt makes the entry uncacheable.
- An entry with more than 256 keys (`CACHE_DEP_ENTRY_KEY_BUDGET`) collapses its most numerous kinds to `t:` keys. Still above 256: uncacheable (`over-budget`).

## How to declare deps

Inside core, import `deps` from the `cache-deps` folder (`../../cache-deps` in a domain). The API imports `@scalius/core/cache-deps`. The full method list is `deps.ts`.

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
   | Custom field values | `deps.customFieldDefinitions(ownerType)` plus the owner's own keys |
   | The store-shape counts | `deps.key(cacheDep.storeShape())` (`lm:shape`) plus the "any row" keys the read uses |
   | App output (sections, product blocks) and active apps' scripts | `deps.plugin(id)` (one installation), `deps.anyPlugin()` (which apps are active), `deps.pluginCollections(id, reads)` (storage collections a section declares) |

   One row, one settings document or a global fact has a same-named call: `deps.category(id)`, `deps.brand(id)`, `deps.settings(category, key)`, `deps.theme()`, `deps.navigation(menuId)`, `deps.shipping()` and so on. `deps.anyX()` covers a list of all rows. Id helpers skip `null` and `undefined`, so `deps.brand(product.brandId)` works inline. `plugin_kv` is exempt because app storefront output never reads it. App declarations live in `packages/core/src/modules/plugins/storefront.ts` and `apps/api/src/plugins/storefront-render.ts`.

3. For a scheduled switch such as a promotion `starts_at` or `ends_at`, call `deps.validUntil(nextTransition)` with the next future instant among the facts read.
4. Facts no key can validate (a KV hint, a live provider call, a per-buyer value) make the output uncacheable. Call `deps.uncacheable("short-code")`. Never put a value in the reason.
5. Ordering projections. Stored recommendation readers declare `deps.recommendations(sourceId)` even when rows are missing. Card fact readers declare `deps.sold(productId)`, and the popular home list also declares `deps.popular()`. An unchanged refresh only updates `computed_at`, which advances no key. The request-path fallback (no stored list) declares its list memberships, `deps.popular()` and the products it read, never order signals. The refresh's ranking still declares `deps.recommendationSignals()` and `validUntil` (the earliest included order's 30-day popularity exit or 365-day co-purchase exit, plus one second), which matter only inside a scope.
6. Run the reader under `withDependencyScope(render, { strict: true })`. Strict mode throws `CacheDepCoverageError` when a table has no covering key, a table is neither registered nor exempt, or a key is malformed. A nested scope inherits strict mode.

## Validate and serve

### API part reader

`createPublicPartReader` in `apps/api/src/public-read.ts` serves every public read inside the calling invocation: each part of `GET /api/v1/storefront/batch` (at most 8 parts) and each direct public GET (`PUBLIC_API_CACHE_ROUTES`).

1. The reader keys each part by the canonical URL plus `__cv=<Worker version>` and matches it in the Cache API. One statement (`readValidationSnapshot`) then reads the clock, the floor, the Platform settings row and every key of the hit entries that changed after the smallest `s0`.
2. An entry is valid when all of these hold: `s0` is not ahead of the clock, `validUntil` and the soft age have not passed, `s0` is not below the floor, and no key it depends on has a clock value above `s0`. A valid hit raises its `s0` to the clock without rewriting the body.
3. A miss or rejected hit renders under `withDependencyScope` with `s0` set to the snapshot clock. The reader stores the entry only when the response is cacheable, `uncacheable` is empty, `validUntil` is still ahead and the key list fits a 16,384-character header.
4. A failed validation fails the part (a direct read answers 503). The reader never serves an unvalidated body.
5. After the response, the reader re-renders 1 in 1,000 validated hits (`DVC_AUDIT_RATE`). A different body with no moved key evicts the entry and logs one masked line `[CacheAudit] stale`.

The reader gives the storefront a proof per part: the API version, `status` (`hit`, `miss`, `refresh`), `s0`, the keys as 48-bit hashes (`hashCacheDep`), `validUntil` and `renderedAt`. Key names never leave the API.

### Storefront page reader

`servePublicStorefrontRequest` in `apps/storefront/src/lib/public-worker-cache.ts` serves anonymous HTML and discovery files. The key is `<origin>/__cache/<BUILD_ID>/<storefront Worker version>/dvc<path><query>`.

1. A miss renders inside a collector (`apps/storefront/src/lib/page-dependencies.ts`). The page entry joins its parts: `s0` is the minimum, the keys are the union, `validUntil` is the minimum.
2. The page is stored only when every API read of the render came through a batch part with a proof. It also needs at most 1,024 keys and one API version across all parts.
3. `decideCacheFrontierHit` serves a hit only when the API versions match, `validUntil` and the soft age have not passed, `s0` is not below the floor and no key hash changed after `s0`. The slow path of step 4 checks an `s0` below the frontier horizon.
   - The frontier is one Cache API object per data center, build and Worker version. A hit needs a frontier at most 1 second old.
   - A refresh starts in the background once the frontier is older than 0.5 second. A request blocks on a refresh when the frontier is older than 1 second or behind `_sv`.
   - A frontier call longer than 1.5 seconds renders the page live.
4. The slow path (`POST /api/v1/storefront/frontier/check`) sends the key hashes. The API scans at most 4,000 changes after `s0` and answers "changed" beyond that. One check runs per entry and isolate; concurrent requests join it.
5. `GET /api/v1/storefront/frontier` and the check route answer 404 without the `X-Scalius-Frontier-Key` header. Both Workers derive the key as an HKDF of `SCALIUS_SECRET` (purpose `cache-frontier`). A frontier answer holds at most 4,000 changes: the newest ones, with the horizon raised to the first change left out (an entry older than that takes the slow path). An answer always reaches the clock: a key row holds its latest change, so a cut below the clock could miss a key that changed again after it.
6. Private requests (checkout, account, a session cookie, variant selections) always render.

### Read your writes

A successful admin write answers with `X-Scalius-Commit-Seq`, the clock after the write (`apps/api/src/middleware/commit-seq.ts`). The dashboard keeps the newest value in memory (`apps/admin-v2/src/lib/store-commit-seq.ts`) and adds `_sv=<clock>` to "view on store" links. The storefront refreshes its frontier to at least that clock before it serves, so the merchant sees their own write at once. `_sv` never splits the cache key or reaches a render.

### Modes

Production runs the API reader in `strict` mode (`API_PART_CACHE_MODE`) and the storefront in `frontier` mode (`STOREFRONT_PAGE_CACHE_MODE`). The modes `generation` and `shadow` exist for differential tests and the load harness only.

## Add or change a schema element

New buyer-visible table:

1. Add the table to `CACHE_DEP_TABLE_RULES` with `kinds`, `noise` and `rules`. If no public read touches it, add it to `CACHE_DEP_EXEMPT_TABLES` with a reason of more than 20 characters instead. `packages/database/__tests__/cache-dep-triggers.test.ts` fails for a table in neither list or in both, and when the registry, triggers and migrations disagree on a provider.
2. Add a migration that installs every generated trigger verbatim, on every provider (SQLite and the PostgreSQL sidecar). Keep each trigger body to one statement and the guard in `WHEN`. List the table in `CACHE_DEP_LATER_TABLES`. Never edit 0100.
3. Declare precise `deps.*` in every public reader of the table.
4. Run the DVC gate (below).

New column on a registered table: the column is buyer-visible unless you list it in `noise`. List it only when no public payload outputs it. `apps/api/src/cache-deps-noise-audit.test.ts` (opt-in with `CACHE_DEP_NOISE_AUDIT_DB`) checks this on a copy of a real store. A visible column changes the generated update triggers, so add a migration that recreates the trigger.

New public reader: declare its keys where the data loads, run it under a strict scope, mark a date-dependent fact with `deps.validUntil`, and keep per-buyer values out (or call `deps.uncacheable`).

## Deploy and restore

- Deploy the API Worker and the storefront Worker together. Page proofs carry the API version, so an API-only deploy re-renders every cached page.
- After a database restore or an authority replacement, deploy both Workers before you serve traffic. Commit clocks order one database history only, and a restore can reuse earlier clock values. New Worker versions start with empty caches.

## Gate

The release gate must report zero findings. The property test runs random writes against every cached read. The race test checks commit order.

```bash
DVC_COLLECT=1 DVC_SEEDS=5 pnpm exec vitest run apps/api/src/cache-dvc.property.test.ts apps/api/src/cache-dvc.race.test.ts
```

`DVC_COLLECT=1` lists every distinct finding instead of stopping at the first, and `DVC_SEEDS` sets the number of seeds. With more than one seed, each seed runs in its own vitest process (up to `DVC_SHARDS` at a time, default: cores less one), so the wall time is that of the slowest seed. The header of the property test lists the other modes. `apps/api/src/cache-deps-coverage.test.ts` checks that every table a cached public read touches is registered or exempt.

## Not observed

- Statements sent through a raw binding (`env.DB.prepare`) instead of `getDb(...)`. None exist in `apps/api/src` or `packages/core/src`.
- KV, R2 and provider calls. Declare them with `deps.uncacheable(...)`, or with the settings key whose row the KV value mirrors.

Page and render budgets: [docs/STOREFRONT-PERFORMANCE.md](../../../../docs/STOREFRONT-PERFORMANCE.md).
