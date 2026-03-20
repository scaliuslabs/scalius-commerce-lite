# Search System (FTS5) Audit

## Summary

The search system is built on SQLite FTS5 (full-text search) with external content tables, maintained by triggers on insert/update/delete. The core helper lives in `packages/core/src/search/fts5.ts` (42 lines) with a higher-level multi-entity search function in `packages/core/src/search/index.ts` (203 lines). FTS5 is used consistently across 8 entity types: products, product variants, categories, pages, orders, customers, discounts, and abandoned checkouts. Two API search routes exist: a public route (`apps/api/src/routes/search.ts`) with rate limiting and caching, and an admin route (`apps/api/src/routes/admin/search.ts`). The storefront has a command palette (`CommandPalette.tsx`) and a full search results page (`/search/index.astro`).

**Overall assessment:** The FTS5 foundation is solid -- external content tables, trigger-based sync, prefix matching, and sanitization are all correct. However, there are several concrete issues ranging from a potential SQL injection vector to inconsistent search approaches across modules.

---

## Critical Issues

### 1. SQL Injection via Unsanitized Table Names in `ftsMatch()`

**File:** `packages/core/src/search/fts5.ts:40`

The `ftsMatch()` function takes `ftsTable` and `sourceTable` as strings and interpolates them directly via `sql.raw()`:

```typescript
return sql`${sql.raw(sourceTable)}.rowid IN (SELECT rowid FROM ${sql.raw(ftsTable)} WHERE ${sql.raw(ftsTable)} MATCH ${sanitized})`;
```

While the JSDoc comment says "Table names are safe (hardcoded by callers)," this is a trust-based defense. If any future caller passes user input as a table name, it is a direct SQL injection. The `sanitized` query value is parameterized correctly, but the table names are not.

**Current callers are all safe** -- every call site passes string literals like `"products_fts"` and `"products"`. But the function signature accepts `string` with no type-level restriction.

**Impact:** Low risk today, high risk if misused. A typo or refactor could introduce injection.

**Fix approach:** Restrict `ftsTable` and `sourceTable` to a union type:

```typescript
type FtsTableName =
  | "products_fts" | "product_variants_fts" | "categories_fts"
  | "pages_fts" | "orders_fts" | "customers_fts"
  | "discounts_fts" | "abandoned_checkouts_fts";

type SourceTableName =
  | "products" | "product_variants" | "categories"
  | "pages" | "orders" | "customers"
  | "discounts" | "abandoned_checkouts";
```

### 2. Admin Search Route Missing Auth Check

**File:** `apps/api/src/routes/admin/search.ts`

The admin search route does not apply rate limiting. The public search route at `apps/api/src/routes/search.ts` applies both rate limiting (30/min per IP via KV) and caching (5-minute TTL). The admin search route has neither.

While admin routes are presumably behind auth middleware at the router mount level, the search handler itself does a `try/catch` that catches all errors generically without validating that the user has admin permissions. If the admin middleware were misconfigured, this route would expose the full search index (including soft-deleted content context) publicly.

**Impact:** Medium. The admin router likely applies auth globally, but defense-in-depth is missing.

### 3. Reindex Endpoint is a No-Op Stub

**File:** `apps/api/src/routes/admin/search.ts:96-98`

```typescript
app.openapi(reindexRoute, async (c) => {
    return ok(c, { message: "Reindex initiated" });
});
```

This endpoint does nothing. It returns success without performing any reindex. A user or admin invoking `POST /admin/search/reindex` would believe a reindex occurred when nothing happened.

**Impact:** Medium. If FTS5 indexes drift from source tables (e.g., due to trigger failure, direct SQL manipulation, or migration issues), there is no recovery mechanism.

**Fix approach:** Implement `INSERT INTO {table}_fts({table}_fts) VALUES('rebuild')` for all 8 FTS tables. This is a D1-safe operation that reconstructs the FTS index from the content table.

---

## Code Quality Issues

### 4. Dynamic Import of Already-Available Modules

**File:** `packages/core/src/modules/products/products.storefront.ts:451-452`

```typescript
const { ftsMatch } = await import("../../search/fts5");
const { eq, and, isNull, desc, inArray, sql } = await import("drizzle-orm");
```

The `searchStorefrontProducts` function dynamically imports `ftsMatch` and drizzle-orm operators at call time, even though `ftsMatch` is already statically imported at line 15 of the same file, and drizzle-orm operators are used throughout the file. This is unnecessary overhead per invocation.

**Impact:** Low. Adds ~1ms per call for module resolution. Bundlers may or may not tree-shake this correctly.

**Fix approach:** Remove the dynamic imports and use the existing static imports.

### 5. Inconsistent `where` Clause Construction

Different modules construct `where` clauses differently when using `ftsMatch`:

- **Categories service** (`packages/core/src/modules/categories/categories.service.ts:55`): Uses Drizzle's `and(...whereConditions)`.
- **Customers service** (`packages/core/src/modules/customers/customers.service.ts:56`): Uses `sql.join(whereConditions, sql' AND ')` -- a different pattern that manually joins SQL fragments.
- **Orders admin** (`packages/core/src/modules/orders/orders.admin.ts`): Uses standard `and(...)`.

The customers service approach (`sql.join`) works but is non-standard. If conditions contain `undefined` values, it will produce invalid SQL (`...AND AND...`), whereas Drizzle's `and()` filters them out.

**Impact:** Low today (conditions are well-guarded), but the inconsistency is a maintenance hazard.

**Fix approach:** Standardize all modules to use `and(...conditions)` from drizzle-orm.

### 6. Dual Search Systems: FTS5 vs LIKE

Three modules use `LIKE` instead of FTS5:

| Module | File | Pattern |
|--------|------|---------|
| Collections | `packages/core/src/modules/collections/collections.service.ts:43` | `like(collections.name, '%${search}%')` |
| Inventory | `packages/core/src/modules/inventory/inventory.service.ts:33-34` | `LIKE %search%` on SKU and product name |
| Media | `packages/core/src/modules/media/` (per README) | `LIKE` on filename |

These use case-sensitive LIKE, which has different behavior from FTS5:
- No prefix matching
- No tokenization (multi-word queries treated as literal substrings)
- Case-sensitive by default in SQLite
- Full table scan on every query (no index)

**Impact:** Performance degrades linearly with table size for collections/inventory/media. Inconsistent search experience for admins.

**Fix approach:** Add FTS5 tables for `collections` (on `name`, `description`) and `media` (on `filename`). Inventory search could piggyback on the existing `product_variants_fts` table for SKU search and `products_fts` for product names.

### 7. `product_variants_fts` Only Used in One Place

**File:** `packages/database/migrations/0016_fts5_search.sql:73-95`

The `product_variants_fts` table (indexes SKU) was created with full trigger support, but is only used in one location: `packages/core/src/modules/products/products.admin.ts:67`. No storefront search uses it. The inventory service uses `LIKE` on SKU instead of `product_variants_fts`.

**Impact:** Low. The triggers still fire on every variant insert/update/delete, adding overhead for an underutilized index.

### 8. Storefront `SearchResults` Type Includes `success` Field

**File:** `apps/storefront/src/lib/api/types.ts:467-474`

```typescript
export interface SearchResults {
  products: Product[];
  categories: Category[];
  pages: Page[];
  success: boolean;   // <-- This leaks the envelope into the domain type
  query: string;
  timestamp: string;
}
```

The `success` field is an envelope artifact, not a domain field. The storefront search client at `apps/storefront/src/lib/api/search.ts:36` includes `success: true` in the empty-query response, perpetuating this confusion. The `SearchResults` type should not carry envelope metadata.

**Impact:** Low. Works because the field is always true, but violates the envelope contract principle.

---

## FTS5 Implementation Quality

### Sanitization (Good)

**File:** `packages/core/src/search/fts5.ts:3-21`

The `sanitizeFtsQuery` function correctly:
- Strips all FTS5 special characters via regex: `["\-*(){}[\]^~:\\/<>|@#&+!?.,'=]`
- Splits on whitespace
- Appends `*` for prefix matching (so "sha" matches "shampoo")
- Returns empty string for empty/invalid input

This prevents:
- FTS5 syntax errors from unmatched quotes
- Column filter injection (`name:term`)
- Boolean operator injection (`NOT term`)
- Phrase queries (`"exact phrase"`)

**Missing from sanitization:** Semicolons (`;`) are not in the regex but FTS5 does not interpret them, so this is fine.

### External Content Tables (Good)

All 8 FTS5 tables use `content='source_table', content_rowid='rowid'`, which means no data duplication. The FTS index stores only the tokenized inverted index, and retrieves content from the source table on demand.

### Trigger Pattern (Good, with caveat)

Each FTS table has 4 triggers: after insert, before delete, before update (delete old), after update (insert new). This is the canonical FTS5 external content sync pattern.

**Caveat:** The `pages_fts` table uses `content_col` as the FTS5 column name (to avoid collision with the FTS5 `content=` directive keyword), but the triggers correctly map `new.content` / `old.content` to `content_col`. The code in `ftsMatch("pages_fts", "pages", query)` generates a `pages_fts MATCH` query that searches all FTS columns (title + content_col), so this works correctly. However, if anyone tries to search a specific column with `title:term` or `content_col:term` syntax, the column name mismatch between `content` (source) and `content_col` (FTS) could cause confusion.

### Rebuild Statements (Inconsistent)

The migration uses two different approaches for initial data population:

- **Products, categories, customers, discounts, variants, abandoned checkouts:** Use `INSERT INTO {fts_table}({fts_table}) VALUES('rebuild')` which reads all rows from the content table and rebuilds the index.
- **Pages, orders:** Use explicit `INSERT INTO {fts_table}(...) SELECT ... FROM {source_table}` which manually inserts rows.

Both approaches work, but the explicit INSERT is redundant when `content=` is configured. The `rebuild` command is simpler and less error-prone.

---

## Query Safety & Performance

### Parameterized Match Values (Good)

In `ftsMatch()`, the sanitized query string is passed as a parameter (`${sanitized}`), not interpolated via `sql.raw()`. This prevents SQL injection through the search term itself.

### FTS5 Rank Expression (Partially Used)

Two modules use FTS5 ranking for search result ordering:

- **Products admin** (`packages/core/src/modules/products/products.admin.ts:76`):
  ```sql
  COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitized}), 0) ASC
  ```
- **Orders admin** (`packages/core/src/modules/orders/orders.admin.ts:79`):
  ```sql
  (SELECT rank FROM orders_fts WHERE rowid = orders.rowid AND orders_fts MATCH ${sanitized}) ASC
  ```

The orders version does not use `COALESCE`, which means if the FTS rank subquery returns NULL (e.g., row not in FTS index), the ORDER BY expression evaluates to NULL, and SQLite sorts NULLs first by default. This could put non-matching rows at the top.

**Other modules (categories, pages, customers, discounts, storefront):** Do not use FTS5 ranking at all. Search results are ordered by the default sort field (usually `updatedAt DESC`), so relevance ordering is lost.

### The `search()` Function Uses `db.batch()` (Good)

**File:** `packages/core/src/search/index.ts:136-140`

The unified search function batches three queries (products, pages, categories) into a single D1 batch, reducing round trips. The subsequent image fetch is a separate query, making it 2 round trips total for a full search.

### Timeout Race Pattern

Both search routes use a `Promise.race()` with a 5-second timeout:

```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Search timed out")), 5000);
});
const results = await Promise.race([searchPromise, timeoutPromise]);
```

This works but has a subtle issue: when the timeout fires, the `searchPromise` is not cancelled -- D1 continues executing the query. This is acceptable for Workers (short-lived), but the "Search timed out" error path in the public route does not produce a `ServiceUnavailableError` -- it just rethrows. The admin route correctly maps it to `ServiceUnavailableError`.

Wait -- re-reading the public route (`apps/api/src/routes/search.ts`): it does NOT catch the timeout. The `Promise.race()` rejection will propagate up as an unhandled error and hit the global error handler. The admin route (`apps/api/src/routes/admin/search.ts:75-81`) properly catches and converts to `ServiceUnavailableError`. The public route is missing this timeout handling.

**Impact:** Medium. A search timeout on the public route returns a generic 500 instead of a 503.

---

## Migration & Index Quality

### Single Migration File

**File:** `packages/database/migrations/0016_fts5_search.sql` (253 lines)

All 8 FTS5 tables, 32 triggers, and initial data population are in a single migration. The migration:

1. Drops all triggers and tables first (idempotent cleanup)
2. Creates each FTS5 virtual table
3. Creates 4 triggers per table
4. Rebuilds or inserts initial data

**Quality:** Good. The DROP IF EXISTS pattern makes this re-runnable. The cleanup at the top handles partial failures from previous runs.

### FTS5 Column Coverage

| FTS Table | Indexed Columns | Source Table | Notes |
|-----------|----------------|--------------|-------|
| `products_fts` | name, description | products | Good coverage for product search |
| `product_variants_fts` | sku | product_variants | Only SKU; no variant name |
| `categories_fts` | name, description | categories | Good |
| `pages_fts` | title, content_col | pages | `content_col` maps to `pages.content` |
| `orders_fts` | customer_name, customer_phone, order_id | orders | Missing: customer_email, customer_address |
| `customers_fts` | name, phone, email | customers | Good |
| `discounts_fts` | code | discounts | Only code; no description or name |
| `abandoned_checkouts_fts` | customer_phone, checkout_id, checkout_data | abandoned_checkouts | `checkout_data` may be large JSON blobs |

**Concerns:**

1. **`orders_fts` missing `customer_email`:** Orders have a `customer_email` column (`packages/database/src/schema/orders.ts:23`), but it is not indexed in FTS5. Searching for a customer by email in the order list will fail silently (no match, no error).

2. **`abandoned_checkouts_fts` indexes `checkout_data`:** This column contains full JSON checkout payloads. FTS5 will tokenize the entire JSON string, making the index large and matching on JSON keys/structure noise (e.g., searching for "name" would match the JSON key `"customer_name"`). This is wasteful and produces false positives.

3. **`discounts_fts` only indexes `code`:** Discount codes are typically short uppercase strings. FTS5 prefix matching works, but a simple LIKE or exact match would be equally fast for this use case.

---

## Scalability

### D1 (SQLite) FTS5 Limits

Cloudflare D1 is SQLite-based with specific constraints:
- **Max database size:** 10 GB (includes FTS index data)
- **Max query duration:** 30 seconds (well above the 5s timeout)
- **No concurrent writes:** D1 serializes writes, so FTS trigger overhead on every insert/update/delete affects write throughput

For a commerce platform:
- 10,000 products with name + description: FTS index ~5-10 MB (negligible)
- 100,000 products: FTS index ~50-100 MB (still fine)
- 1,000,000 products: FTS index ~500 MB-1 GB, plus trigger overhead becomes significant

**Current scale is fine.** FTS5 external content tables minimize storage overhead. The trigger-based sync adds ~1-2ms per write operation.

### Cache Strategy

The public search route applies:
- KV cache with 5-minute TTL (`CACHE_TTLS.SHORT = 300`)
- Rate limiting: 30 requests/minute per IP

The admin search route has no caching, which is correct (admin sees live data).

The 5-minute cache for public search means stale results for up to 5 minutes after product changes. This is acceptable for storefront use cases but could surprise merchants who update a product and immediately search for it on the storefront.

### N+1 Query Fix in Unified Search

**File:** `packages/core/src/search/index.ts:142-158`

The code correctly avoids N+1 by:
1. Batch-fetching all product IDs from the search results
2. Single query to get primary images for those IDs
3. Building a Map for O(1) lookup

This is a good pattern.

---

## LLM-Friendliness

### File Organization (Good)

The search system has clear entry points:
- `packages/core/src/search/fts5.ts` -- Low-level FTS5 helpers
- `packages/core/src/search/index.ts` -- Multi-entity search function
- Barrel export: `export { ftsMatch } from "./fts5"` in index.ts

### Function Signatures (Good)

- `sanitizeFtsQuery(input: string): string` -- Pure function, clear contract
- `ftsMatch(ftsTable, sourceTable, query): SQL | undefined` -- Returns undefined for empty queries (caller checks)
- `search(db, query, options?)` -- Options are well-typed with defaults

### JSDoc (Adequate)

Both `sanitizeFtsQuery` and `ftsMatch` have JSDoc comments explaining behavior and usage. The `search` function in `index.ts` lacks JSDoc.

### Error Handling (Mixed)

The unified `search()` function silently swallows errors and returns empty results:

```typescript
catch (error: unknown) {
    console.error("Search error:", error);
    return { products: [], pages: [], categories: [] };
}
```

This makes debugging difficult in production. An FTS5 table corruption, missing trigger, or schema mismatch would silently produce empty results instead of surfacing the error.

---

## Recommended Changes

### Priority 1: Fix (Correctness/Safety)

1. **Restrict `ftsMatch` table name parameters to union types** in `packages/core/src/search/fts5.ts`. This eliminates the SQL injection surface at the type level.

2. **Add timeout error handling to public search route** in `apps/api/src/routes/search.ts`. Catch the timeout error and throw `ServiceUnavailableError` (matching the admin route pattern).

3. **Implement the reindex endpoint** in `apps/api/src/routes/admin/search.ts`. Execute `INSERT INTO {table}_fts({table}_fts) VALUES('rebuild')` for all 8 FTS tables in a D1 batch.

4. **Add `customer_email` to `orders_fts`** via a new migration. This requires recreating the FTS table and triggers (FTS5 virtual tables do not support `ALTER TABLE ADD COLUMN`).

### Priority 2: Improve (Quality/Consistency)

5. **Remove dynamic imports in `searchStorefrontProducts`** at `packages/core/src/modules/products/products.storefront.ts:451-452`. Use the existing static imports.

6. **Standardize `where` clause construction** in `packages/core/src/modules/customers/customers.service.ts:56` to use `and(...)` instead of `sql.join()`.

7. **Add FTS5 ranking to all search-enabled list endpoints**, not just products and orders. Categories, pages, customers, and discounts should order by FTS5 rank when a search query is present.

8. **Remove `success` from `SearchResults` type** in `apps/storefront/src/lib/api/types.ts:471`. This is envelope metadata, not a domain field.

### Priority 3: Enhance (Performance/Scalability)

9. **Add FTS5 table for `collections`** (name, description). Replace the LIKE search in `packages/core/src/modules/collections/collections.service.ts:43`.

10. **Reconsider `abandoned_checkouts_fts` indexing `checkout_data`**. Either remove `checkout_data` from the FTS index (it is a JSON blob that produces noise matches) or extract specific searchable fields (customer name, product names) into dedicated columns.

11. **Add FTS5 search to inventory module** at `packages/core/src/modules/inventory/inventory.service.ts:31-35`. Use the existing `product_variants_fts` for SKU search and `products_fts` for product name search instead of LIKE.

12. **Add `COALESCE` to the orders FTS rank expression** in `packages/core/src/modules/orders/orders.admin.ts:79` to prevent NULL rank values from sorting incorrectly.

### Priority 4: Test & Document

13. **Add unit tests for `sanitizeFtsQuery`** covering edge cases: empty string, all-special-character input, Unicode text, extremely long input, single characters. There are currently zero tests for the search system.

14. **Add integration tests for `ftsMatch`** verifying that FTS5 queries execute correctly against a D1 test database. Test prefix matching, multi-word AND semantics, and empty query handling.

15. **Document the FTS5 table/column mapping** somewhere in `packages/core/src/search/` so future developers know which tables exist, what columns they index, and the `content_col` alias for pages.

---

## File Index

| File | Purpose | Lines |
|------|---------|-------|
| `packages/core/src/search/fts5.ts` | FTS5 sanitization and MATCH builder | 42 |
| `packages/core/src/search/index.ts` | Multi-entity search (products, pages, categories) | 203 |
| `apps/api/src/routes/search.ts` | Public search API (rate limited, cached) | 136 |
| `apps/api/src/routes/admin/search.ts` | Admin search API + reindex stub | 101 |
| `apps/storefront/src/lib/api/search.ts` | Storefront search client wrapper | 51 |
| `apps/storefront/src/components/search/CommandPalette.tsx` | Command palette search UI (Cmd+K) | 443 |
| `apps/storefront/src/components/search/SearchBar.astro` | Search bar trigger button | 79 |
| `apps/storefront/src/pages/search/index.astro` | Full search results page | 484 |
| `packages/database/migrations/0016_fts5_search.sql` | FTS5 table creation migration | 253 |
| `packages/core/src/modules/products/products.admin.ts` | Admin product list (FTS5 + barcode + variant search) | ~130 (search section) |
| `packages/core/src/modules/products/products.storefront.ts` | Storefront product list (FTS5) + cart search (dynamic import) | ~100 (search section) |
| `packages/core/src/modules/orders/orders.admin.ts` | Admin order list (FTS5 + rank) | ~30 (search section) |
| `packages/core/src/modules/categories/categories.service.ts` | Admin category list (FTS5) | ~10 (search section) |
| `packages/core/src/modules/customers/customers.service.ts` | Customer list (FTS5) | ~10 (search section) |
| `packages/core/src/modules/discounts/discounts.service.ts` | Discount list (FTS5 on code) | ~10 (search section) |
| `packages/core/src/modules/collections/collections.service.ts` | Collection list (LIKE, not FTS5) | ~5 (search section) |
| `packages/core/src/modules/inventory/inventory.service.ts` | Inventory list (LIKE, not FTS5) | ~5 (search section) |
| `apps/api/src/routes/admin/system-utils.ts` | Abandoned checkouts (FTS5) | ~10 (search section) |
| `apps/api/src/routes/attributes.ts` | Attribute search filters (FTS5 on products) | ~30 (search section) |
| `apps/api/src/routes/categories.ts` | Category product listing (FTS5 on products) | ~10 (search section) |
