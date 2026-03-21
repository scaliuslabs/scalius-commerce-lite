# Re-Audit: Shared Utils + Search (FTS5)

**Date:** 2026-03-21
**Scope:** `packages/shared/src/` (20 files), `packages/core/src/search/` (2 files), search routes in `apps/api/`
**Previous audits:** `.planning/codebase-audit/shared-utils.md`, `.planning/codebase-audit/search.md`

---

## Rating: 8/10

Up from ~7/10 in the previous audit. Two critical fixes landed: the SQL injection vector in `ftsMatch()` is closed via compile-time + runtime allowlists, and the `error-utils.ts` dead module has been deleted. The `barcode-svg.ts` duplication of `escapeXml` was replaced with an import from `html-escape.ts`. Two new well-designed utility modules were added (`timestamps.ts`, `html-sanitize.ts`). The remaining issues are mostly dead exports and minor correctness items that do not affect production safety.

---

## Previous Findings Status

### Shared Utils

| # | Finding | Status | Notes |
|---|---------|--------|-------|
| CQ-1 | `as any` casts for env detection (7 occurrences) | **STILL OPEN** | `packages/shared/src/image-optimizer.ts` lines 85, 86, 92, 102, 106 still have 5 `as any` casts. `error-utils.ts` was deleted (removing 2). Down from 7 to 5. |
| CQ-2 | Dead exports (11 across 6 files) | **PARTIALLY FIXED** | `error-utils.ts` deleted (3 dead exports removed). `barcode-svg.ts` private `escapeXml` replaced. Remaining dead: `getOptimizedImageProps`, `isR2Image` in `image-optimizer.ts`; `reconstructWidgetFromSections` in `html-section-parser.ts`; `StreamingTagParser`, `getTagBasedExampleFormat` in `tag-parser.ts`; `calculatePercentageDiscount` in `price-utils.ts`. ~8 dead exports remain. |
| CQ-3 | `detectCdnBase()`/`detectIsDev()` read `import.meta.env` as fallback | **STILL OPEN** | `packages/shared/src/image-optimizer.ts` lines 82-113 still have both fallback functions. The module header comment now says "This module is PURE" but the fallback functions contradict that claim. |
| CQ-4 | `console.error`/`console.warn` in pure utils | **STILL OPEN** | `packages/shared/src/utils.ts` line 31 (`unixToDate`) and line 65 (`formatDate`) still have `console.error`. `html-section-parser.ts` line 35 still has `console.warn`. |
| CQ-5 | Inconsistent error response shapes in `error-utils.ts` | **FIXED** | Entire file deleted. Zero consumers existed. |
| CQ-6 | Duplicated HTML/XML escaping | **FIXED** | `packages/shared/src/barcode-svg.ts` now imports `escapeHtml` from `./html-escape` (line 6). Private `escapeXml` removed. |
| P-1 | CORS regex compilation per request | **STILL OPEN** | `packages/shared/src/cors-helper.ts` line 18 still creates a new `RegExp` per wildcard origin per request. |
| Rec-5 | Fix `getStatusBadgeClass` return type | **STILL OPEN** | `packages/shared/src/utils.ts` line 108 still returns `{ badgeClass }` object instead of plain `string`. Indentation still wrong (0-indent switch cases). |
| Rec-6 | Fix `formatPriceShort` whole-number detection | **STILL OPEN** | `packages/shared/src/currency.ts` line 97 still uses `val.cents() % Math.pow(10, precision) === 0`. |
| Rec-7 | Fix `calculateDiscountedPrice` falsy-zero check | **STILL OPEN** | `packages/shared/src/price-utils.ts` lines 60, 65 still use `if (discountPercentage)` / `if (discountAmount)` which treats `0` as falsy. |
| Rec-8 | Fix `calculateCustomerStats` float drift | **STILL OPEN** | `packages/shared/src/customer-utils.ts` line 81 still uses plain `+` for `totalSpent` instead of `addPrices()`. |
| Rec-10 | Remove `console.error` from date utils | **STILL OPEN** | Same as CQ-4. |
| Rec-12 | Move `calculateCustomerStats` to `order-utils.ts` | **STILL OPEN** | Still in `customer-utils.ts`. |
| Rec-13 | Move `html-section-parser.ts` to `apps/admin/` | **STILL OPEN** | Still in shared package. Still only consumed by `apps/admin/src/components/admin/widgets/WidgetForm.tsx`. Still has `/// <reference lib="dom" />`. |
| Rec-14 | Move `layout-cache.ts` closer to consumers | **STILL OPEN** | Still in shared package. |
| Rec-15 | Rename conflicting `ParsedSection` type | **STILL OPEN** | Both `html-section-parser.ts` line 14 and `tag-parser.ts` line 19 still export `ParsedSection` with different shapes. |
| Rec-16 | Add `locale` parameter to `formatDate()` | **STILL OPEN** | Still hardcodes `en-US`. |
| Rec-17 | Fix `validateWidgetJSON` dead normalization | **STILL OPEN** | `packages/shared/src/json-repair.ts` lines 180-183 still create `normalized` but never return it. |

### Search (FTS5)

| # | Finding | Status | Notes |
|---|---------|--------|-------|
| 1 | SQL injection via unsanitized table names in `ftsMatch()` | **FIXED** | `packages/core/src/search/fts5.ts` lines 23-36 now define `ALLOWED_FTS_TABLES` and `ALLOWED_SOURCE_TABLES` as const arrays with union types `FtsTable` and `SourceTable`. Runtime validation at lines 55-60 provides defense-in-depth. Both compile-time and runtime protection. |
| 2 | Admin search route missing auth check (defense-in-depth) | **STILL OPEN** | `apps/api/src/routes/admin/search.ts` still has no explicit auth or rate limiting. Relies on admin router-level middleware. |
| 3 | Reindex endpoint is a no-op stub | **STILL OPEN** | `apps/api/src/routes/admin/search.ts` lines 96-98 still return `{ message: "Reindex initiated" }` without performing any reindex operation. |
| 4 | Dynamic import of already-available modules in `searchStorefrontProducts` | **STILL OPEN** | `packages/core/src/modules/products/products.storefront.ts` line 451-452 still dynamically imports `ftsMatch` and `drizzle-orm` operators at call time, despite `ftsMatch` being statically imported elsewhere in the file. |
| 5 | Inconsistent `where` clause construction (`sql.join` vs `and()`) | **STILL OPEN** | `packages/core/src/modules/customers/customers.service.ts` line 56 still uses `sql.join(whereConditions, sql' AND ')`. |
| 6 | Dual search systems: FTS5 vs LIKE | **STILL OPEN** | Collections still uses `LIKE` at `packages/core/src/modules/collections/collections.service.ts` line 43. Inventory still uses `LIKE` at `packages/core/src/modules/inventory/inventory.service.ts` lines 33-34. |
| 7 | `product_variants_fts` only used in one place | **STILL OPEN** | Still only used in `packages/core/src/modules/products/products.admin.ts`. Inventory could use it for SKU search. |
| 8 | Storefront `SearchResults` type includes `success` field | **STILL OPEN** | `apps/storefront/src/lib/api/types.ts` line 472 still has `success: boolean` in the `SearchResults` interface. |
| 9 | Public search route missing timeout error handling | **STILL OPEN** | `apps/api/src/routes/search.ts` does NOT catch the timeout rejection. The `Promise.race` rejection propagates as an unhandled error (generic 500). The admin route (`apps/api/src/routes/admin/search.ts` lines 75-81) correctly catches and converts to `ServiceUnavailableError`. |
| 10 | Orders FTS rank missing COALESCE | **STILL OPEN** | `packages/core/src/modules/orders/orders.admin.ts` line 79 still uses `(SELECT rank FROM orders_fts ...)` without `COALESCE`, risking NULL sort. |
| 11 | `orders_fts` missing `customer_email` | **STILL OPEN** | No migration adds `customer_email` to `orders_fts`. |
| 12 | `abandoned_checkouts_fts` indexes JSON `checkout_data` | **STILL OPEN** | FTS5 still tokenizes the full JSON blob, producing noise matches. |
| 13 | `search()` silently swallows errors | **STILL OPEN** | `packages/core/src/search/index.ts` lines 194-201 still catch all errors and return empty results. |

---

## New Findings

### NEW-1: `timestamps.ts` -- well-designed but zero consumers

**File:** `packages/shared/src/timestamps.ts` (21 lines)

This new module exports three functions: `toISOString()`, `fromUnixSeconds()`, `nowUnixSeconds()`. All are clean, pure, well-documented. However, zero files import from `@scalius/shared/timestamps`. The codebase uses inline `new Date(unixSeconds * 1000).toISOString()` patterns extensively (35+ call sites found via `toISOString` grep), but none import these helpers.

**Impact:** Low -- the module is correct and ready for adoption, but currently dead code.

**Fix:** Adopt throughout the codebase, or remove until needed. It duplicates logic already inline in `packages/shared/src/utils.ts` (`unixToDate` does the same `* 1000` conversion).

### NEW-2: `html-sanitize.ts` -- well-designed but zero consumers

**File:** `packages/shared/src/html-sanitize.ts` (26 lines)

Exports `sanitizeHtml()` which strips `<script>` tags, `on*` event handlers, and `javascript:` URLs. Correct regex patterns, good coverage of common XSS vectors.

Zero files import this module. Widget HTML content from the admin is rendered unsanitized in the storefront.

**Impact:** Medium -- the module exists but is not wired into the widget rendering pipeline. If admin-authored widget HTML contains malicious content (e.g., a compromised admin account), it would execute unsanitized in the storefront.

**Fix:** Wire `sanitizeHtml()` into the storefront widget rendering path, or at minimum into the API route that saves widget content.

### NEW-3: `html-sanitize.ts` regex bypass via case/encoding tricks

**File:** `packages/shared/src/html-sanitize.ts` lines 20-23

The `javascript:` URL regex only matches lowercase `javascript:` within `href`, `src`, and `action` attributes. It can be bypassed with:
- Mixed case: `JAVASCRIPT:alert(1)` or `JaVaScRiPt:alert(1)`
- HTML entity encoding: `&#106;avascript:`
- Other URL schemes like `data:text/html,...` or `vbscript:` (IE legacy)

The regex also only looks at `href`, `src`, and `action`, missing `formaction`, `xlink:href`, `data`, `dynsrc`, `lowsrc`, and other attributes that accept URLs.

**Impact:** Low while the module has zero consumers. Medium if adopted for production sanitization without hardening.

**Fix:** Add the `/i` flag (which is already present on other regexes in the file -- line 12, 17 have `/gi`). Wait -- line 21 already has `/gi` on the javascript URL regex. Re-reading: the regex is `/(href|src|action)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi`. The `i` flag makes `javascript` case-insensitive, so `JAVASCRIPT:` IS handled. But the regex only matches when `javascript:` appears immediately after the `=` and opening quote. A space or tab before `javascript:` (e.g., `href=" javascript:..."`) would bypass it. Also does not cover `data:` URLs.

### NEW-4: `aggressiveRepairJSON()` corrupts legitimate content

**File:** `packages/shared/src/json-repair.ts` lines 92-94

```typescript
repaired = repaired.replace(/\n/g, "\\n");
repaired = repaired.replace(/\r/g, "\\r");
repaired = repaired.replace(/\t/g, "\\t");
```

This blindly replaces ALL newlines and tabs, including those already inside JSON string values that were correctly escaped, and those in JSON structure (between keys/values). For example, a JSON value like `"line1\\nline2"` (which represents a literal `\n` in the string) would become `"line1\\\\nline2"` (double-escaped), corrupting the data.

This was noted in the previous audit as well. No fix applied.

**Impact:** Low -- `aggressiveRepairJSON` is only invoked as the 4th fallback strategy in `parseJSONSafely`, meaning it only fires when the first 3 strategies fail. Corruption would only matter if the aggressive repair produces parseable-but-wrong JSON.

### NEW-5: `validateWidgetJSON` creates but discards normalized object

**File:** `packages/shared/src/json-repair.ts` lines 179-183

```typescript
const normalized = { ...record };
if (normalized.htmljs && !normalized.html) {
    normalized.html = normalized.htmljs;
}
```

The `normalized` object is created but never returned. The function returns `{ valid: true }` without the normalized data. Any caller expecting the `htmljs` -> `html` normalization to take effect gets no benefit.

This was noted in the previous audit. No fix applied.

### NEW-6: Overlap between `timestamps.ts` and `utils.ts` date utilities

**Files:**
- `packages/shared/src/timestamps.ts` -- `fromUnixSeconds(n)` returns `new Date(n * 1000)`
- `packages/shared/src/utils.ts` -- `unixToDate(n)` returns `new Date(n * 1000)` (with additional handling for ms vs s detection, string input, Date passthrough, null safety)

These do the same core operation. `unixToDate` is the existing, battle-tested version with more guard rails. `fromUnixSeconds` is the new, simpler version that assumes the input is always seconds and always a number. Having both creates confusion about which to use.

**Impact:** Low -- `fromUnixSeconds` has zero consumers currently.

**Fix:** Either adopt `timestamps.ts` as the canonical module and migrate existing consumers, or remove it and add any missing functionality (like `nowUnixSeconds`) to `utils.ts`.

### NEW-7: Public search route does not handle timeout (confirmed, search-audit issue #9)

**File:** `apps/api/src/routes/search.ts` lines 117-122

The `Promise.race` between the search and a 5s timeout will reject with `Error("Search timed out")`, but there is no `try/catch` around it. The error propagates to the global error handler and returns a generic 500 instead of a 503 Service Unavailable.

The admin route at `apps/api/src/routes/admin/search.ts` lines 75-81 correctly catches this and throws `ServiceUnavailableError`. The public route lacks this.

**Impact:** Medium -- search timeouts on the public storefront return misleading 500 errors instead of a proper 503 with a clear message.

---

## Summary of All Open Issues

### Critical (0)

No critical issues.

### High Priority (2)

1. **Public search timeout handling** -- `apps/api/src/routes/search.ts` needs try/catch around `Promise.race` to convert timeout to `ServiceUnavailableError` (matching admin route pattern).
2. **Reindex endpoint is a no-op** -- `apps/api/src/routes/admin/search.ts` lines 96-98 should implement `INSERT INTO {table}_fts({table}_fts) VALUES('rebuild')` for all 8 FTS tables.

### Medium Priority (6)

3. **`html-sanitize.ts` has zero consumers** -- Module exists but is not wired into widget rendering pipeline. Admin-authored HTML renders unsanitized.
4. **`calculateCustomerStats` uses plain `+` for money** -- `packages/shared/src/customer-utils.ts` line 81 should use `addPrices()`.
5. **`detectCdnBase()`/`detectIsDev()` fallback functions** -- `packages/shared/src/image-optimizer.ts` lines 82-113 read `import.meta.env` despite the module claiming to be "PURE".
6. **Dynamic imports in `searchStorefrontProducts`** -- `packages/core/src/modules/products/products.storefront.ts` lines 451-452 dynamically import already-available modules.
7. **Inconsistent `where` clause: `sql.join` vs `and()`** -- `packages/core/src/modules/customers/customers.service.ts` line 56.
8. **`search()` silently swallows errors** -- `packages/core/src/search/index.ts` lines 194-201 catch and discard all errors.

### Low Priority (12)

9. **5 `as any` casts** in `packages/shared/src/image-optimizer.ts` for env detection.
10. **~8 dead exports** across `image-optimizer.ts`, `html-section-parser.ts`, `tag-parser.ts`, `price-utils.ts`.
11. **`console.error` in pure functions** -- `utils.ts` lines 31, 65.
12. **`getStatusBadgeClass` returns `{ badgeClass }` not `string`** -- `utils.ts` line 108. Indentation wrong.
13. **`formatPriceShort` whole-number detection** -- `currency.ts` line 97.
14. **`calculateDiscountedPrice` falsy-zero** -- `price-utils.ts` lines 60, 65.
15. **CORS regex not pre-compiled** -- `cors-helper.ts` line 18.
16. **`ParsedSection` name conflict** -- two types in `html-section-parser.ts` and `tag-parser.ts`.
17. **`html-section-parser.ts` requires DOM** but lives in Worker-friendly package.
18. **`validateWidgetJSON` dead normalization** -- `json-repair.ts` lines 180-183.
19. **`timestamps.ts` and `html-sanitize.ts` have zero consumers** -- dead code, albeit well-designed.
20. **`timestamps.ts` overlaps with `utils.ts` `unixToDate()`** -- duplicated date conversion logic.

### Search-Specific (Deferred/Enhancement)

21. **Collections and inventory use LIKE instead of FTS5** -- `collections.service.ts` line 43, `inventory.service.ts` lines 33-34.
22. **`orders_fts` missing `customer_email`** column.
23. **`abandoned_checkouts_fts` indexes JSON blobs** -- noise matches.
24. **FTS5 ranking not used consistently** -- only products and orders use rank; others sort by `updatedAt`.
25. **Orders FTS rank missing `COALESCE`** -- `orders.admin.ts` line 79.
26. **Storefront `SearchResults` type has `success` field** -- envelope leak.

---

## What Was Fixed Since Last Audit

1. **`ftsMatch()` SQL injection surface closed** -- Compile-time union types + runtime allowlist validation in `packages/core/src/search/fts5.ts` lines 23-65.
2. **`error-utils.ts` deleted** -- All 3 dead exports removed, file no longer exists.
3. **`barcode-svg.ts` deduplication** -- Private `escapeXml` replaced with `import { escapeHtml } from "./html-escape"`.
4. **New `timestamps.ts` module added** -- Clean timestamp conversion utilities (albeit unused).
5. **New `html-sanitize.ts` module added** -- XSS sanitization for widget HTML (albeit unused).
6. **`drizzle-orm` phantom dependency removed** -- `packages/shared/package.json` no longer lists `drizzle-orm` (confirmed clean dependencies).
