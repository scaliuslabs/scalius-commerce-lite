# Cache dependency recording

Read side of the dependency-validated public cache (DVC), described in
`audit/rewrite-2026-09-23/CACHE-DESIGN.md` §6.5. The keys and the table
registry live in `@scalius/shared/cache-deps`. The database triggers advance
those keys on every committed buyer-visible change.

## Pieces

- `@scalius/database/read-observer`: the transports call `observeStatement(sql)`
  for every statement. That covers the D1 request client (`prepare`, batches
  included), the Turso adapter and the PostgreSQL adapter.
  - Outside a scope it costs one `AsyncLocalStorage.getStore()`.
  - Inside a scope it reports the tables the statement touched, and for a
    settings statement its SQL and bound parameters (D1 at `bind` time), so
    coverage can tell which documents it read.
- `withDependencyScope(render, options)`: runs one public render and returns
  `{ value, dependencies }`. The scope is request-scoped through
  AsyncLocalStorage, so concurrent requests and concurrent batch parts never
  mix. A nested scope hands its keys to its parent.
- `deps.*`: what readers call to declare precise keys. Every call is a no-op
  outside a scope.

`dependencies` (`CacheDependencies`) has these fields:

| Field | Meaning |
| --- | --- |
| `keys` | Sorted keys, `store` always included. The entry is valid while no key has `seq > s0`. |
| `tables` | Every table the render touched. |
| `coarseTables` | Registered tables no declared key covered. Each one added its `t:<table>` key and logged `[CacheDeps] coarse <label> <tables>`. |
| `collapsedKinds` | Kinds that the 256-key budget replaced by their `t:` keys. |
| `softMaxAgeSeconds` | Set when a soft table was read (`product_recommendations`, `product_sales_stats`, `orders`, `order_items`) or `deps.softOrdering()` was called. |
| `validUntil` | The earliest scheduled transition declared. Never serve the entry at or after it. |
| `uncacheable` | Reasons the entry must not be stored: an unregistered table was read, `deps.uncacheable()` was called, the entry is over budget, or a nested render failed. |

## How to declare deps (S3a/S3b)

Import from inside core with `import { deps } from "../../cache-deps";`.

1. **Declare what the output shows, where the data is loaded.** Put the call
   in the shared loader, not in each route:

   ```ts
   const cards = await loadProductCards(db, ids);
   deps.products(cards.map((card) => card.id));     // p:<id> for every card shown
   ```

2. **Pick the key by what would change the output:**

   | Output | Declare |
   | --- | --- |
   | A product page, card, JSON-LD block or feed row | `deps.product(id)` / `deps.products(ids)` |
   | Which products are in a listing (and newest order) | `deps.listMembership(scope)`; scope is `"all"`, `categoryScope(id)` or `brandScope(id)` |
   | Sorting or filtering by price, band, discount or name | `deps.listOrder("price" \| "band" \| "disc" \| "name", scope)` |
   | The on-sale home list's candidate window | `deps.listOrder("sale", "all")` plus `deps.products(candidateIds)` for every candidate, shown or not |
   | Facet values and counts | `deps.listFacets(scope)` |
   | Search results | `deps.search()` plus `deps.listMembership("all")` |
   | Sitemap or feed | `deps.listMembership("all")`, `deps.discoveryMembership()`, `deps.products(rowIds)` |
   | Any availability band | `deps.inventoryBands()` (`set:inventory:document`) as well as the product keys |
   | A manual collection | `deps.collection(id)` plus `deps.products(memberIds)` |
   | A dynamic collection | `deps.collection(id)` plus `deps.listMembership(categoryScope(...))`, plus `deps.listOrder(...)` when sorted |
   | One settings document | `deps.settings(category, key)` |
   | Category, brand, CMS page, media, attribute or promotion rows | `deps.category(id)`, `deps.brand(id)`, `deps.page(id)`, `deps.media(id)`, `deps.attribute(id)`, `deps.promotion(id)`, or `deps.anyX()` for a list of all of them |
   | Theme, menus, hero, shipping, locations, tax, languages, analytics | `deps.theme()`, `deps.navigation(menuId)`, `deps.hero()`, `deps.shipping()`, `deps.locations()`, `deps.tax()`, `deps.checkoutLanguages()`, `deps.analytics()` |

   Id helpers skip `null` and `undefined`, so optional relations can be written
   inline, for example `deps.brand(product.brandId)`.

3. **Time.** When the output depends on a scheduled switch, such as a
   promotion's `starts_at` or `ends_at`, call `deps.validUntil(nextTransition)`
   with the next future instant among the facts read.

4. **Facts no key can validate.** A KV hint, a live provider call or a
   per-buyer value makes the output uncacheable. Call
   `deps.uncacheable("short-code")`, and never put a value in the reason.

5. **Soft ordering.** Recommendation and popularity order may lag by up to
   10 minutes. Reading the soft tables sets this automatically. Every card
   shown still needs its hard `p:` key.

6. **Check coverage.** Run the reader under
   `withDependencyScope(render, { strict: true })`. Strict mode throws
   `CacheDepCoverageError` when:
   - a table is not covered by a declared key;
   - a table is neither registered nor exempt;
   - a key is malformed.

   Strict mode is inherited by nested scopes, so one strict outer scope checks
   a whole request.

Coverage is decided by kind. A table is covered when a declared key's kind is
one of `cacheDepKindsForTable(table)`, or when its own `t:<table>` is
declared. For example, `products` is covered by any `p:`, `lo:`, `lm:` or
`srch` key.

Settings are the exception (`CACHE_DEP_ROW_KEYED_TABLES`): every render
declares `set:platform:document`, so a kind rule would cover any settings
read. Each settings source of each statement must pin `category` and `key`
(`=` or `IN` against literals or bound values, `pinnedSourceValues`), and
every document it pins needs its own `set:<category>:<key>` declared. A
statement that reads the whole table, or joins settings on a column, falls
back to `t:settings`. Declare the precise keys the output actually depends on. The
kind rule is only the safety net, and the S6 differential property test
checks that the declared keys are enough.

A missing declaration costs hit rate in production, never correctness: the
fallback adds `t:<table>`, which every change of that table advances. Reading
a table that is neither registered nor exempt makes the entry uncacheable.

## Not observed

- Statements sent through a raw binding (`env.DB.prepare`) and not through
  `getDb(...)`. None exist in `apps/api/src` or `packages/core/src` today.
- KV, R2 and provider calls. Declare them with `deps.uncacheable(...)`, or with
  the settings key whose row the KV value mirrors.

## Cost

Measured by `overhead.test.ts` on Node 24 (Apple silicon), for a
376-character Drizzle join:

| Case | Cost |
| --- | --- |
| No scope | about 21 ns per statement |
| In a scope, memoised parse | about 140 ns per statement |
| First parse of a new statement shape | about 2 µs |
| `deps.product(id)` | about 125 ns |

An end-to-end node:sqlite Drizzle query took 42.2 µs without a scope and
43.9 µs with one, within run-to-run noise. A hosted D1 read costs 0.5-5 ms.

The parse memo keeps only statements without string literals, so no literal
value is retained across requests. It is bounded to 1,024 statement shapes.
