# Shared Utilities Package Audit

**Package:** `packages/shared/` (`@scalius/shared`)
**Source files:** 19 files in `src/`, 2,323 total lines
**Date:** 2026-03-20
**Scope:** Complete deep-read of every source file, all import sites across the monorepo

---

## Summary

The shared package provides 2,323 lines of utility code across 19 modules. It is the leaf node of the dependency graph -- zero imports from `@scalius/core` or `@scalius/database`. Consumed heavily across all three apps and the core package (100+ import sites for `cn()` alone). The package is well-structured overall with clean per-module exports and no barrel file. Since the prior audit (earlier this session), two major issues have been resolved: the phantom `drizzle-orm` dependency has been removed, and the rate limiter has been rewritten from in-memory `setInterval` to KV-based with TTL. The remaining concerns are: `import.meta.env` fallback paths in `image-optimizer.ts` and `error-utils.ts`, dead exports across multiple files, a DOM-dependent module in a Worker-friendly package, duplicated XML/HTML escaping logic, and several minor correctness issues.

---

## Critical Issues

None. The package has no security vulnerabilities, no data corruption risks, and no production-breaking bugs.

---

## Code Quality Issues

### CQ-1: `as any` casts for environment detection (7 occurrences)

**Files:**
- `packages/shared/src/image-optimizer.ts` lines 85, 86, 92, 102, 106
- `packages/shared/src/error-utils.ts` lines 13, 80

Both files cast `import.meta` and `globalThis.process` to `any` to probe for environment variables. This is the only `any` usage in the package.

```typescript
// image-optimizer.ts:85
(import.meta as any).env?.MODE === "development"

// error-utils.ts:13
typeof (globalThis as any).process !== "undefined" && (globalThis as any).process.env?.NODE_ENV === "development"
```

**Problem:** These bypass TypeScript's type system entirely. The `image-optimizer.ts` usage also violates the project convention ("Never use `import.meta.env` for secrets" -- while these are not secrets, the pattern is confusing).

**Fix:** Define a minimal `ImportMeta` augmentation in `packages/shared/src/types.ts` or accept the cast with a suppression comment. For `image-optimizer.ts`, the better fix is making `ctx` required (see CQ-3).

### CQ-2: Dead exports (confirmed zero consumers outside own file + README)

| Export | File | Lines | Reason Dead |
|--------|------|-------|-------------|
| `honoSafeError` | `error-utils.ts` | 74-83 | API uses `ApiError` classes, never calls this |
| `zodErrorResponse` | `error-utils.ts` | 59-64 | API uses Hono's Zod validation, never calls this |
| `safeErrorResponse` | `error-utils.ts` | 8-53 | Zero import sites in `apps/**/*.ts` |
| `getOptimizedImageProps` | `image-optimizer.ts` | 234-251 | Zero import sites in any app |
| `isR2Image` | `image-optimizer.ts` | 205-223 | Zero import sites in any app |
| `validateEAN13` | `barcode-utils.ts` | 26-30 | Only used internally by its own module |
| `calculateEAN13CheckDigit` | `barcode-utils.ts` | 18-24 | Only used internally by `generateEAN13` and `validateEAN13` |
| `calculatePercentageDiscount` | `price-utils.ts` | 41-46 | Zero import sites (callers use `calculateDiscountedPrice` instead) |
| `reconstructWidgetFromSections` | `html-section-parser.ts` | 295-332 | Zero import sites in any app |
| `getTagBasedExampleFormat` | `tag-parser.ts` | 234-272 | Zero import sites in any app |
| `StreamingTagParser` class | `tag-parser.ts` | 197-229 | Zero import sites in any app |

**Impact:** 11 dead exports across 6 files. They inflate bundle size, confuse developers about which functions to use, and create maintenance burden.

**Fix:** Remove `honoSafeError`, `zodErrorResponse`, `safeErrorResponse` entirely (the API's `ApiError` system is the canonical error pattern). Keep `validateEAN13` and `calculateEAN13CheckDigit` as they are legitimate utilities even if currently unused externally. Mark `getOptimizedImageProps`, `isR2Image`, `reconstructWidgetFromSections`, `getTagBasedExampleFormat`, and `StreamingTagParser` for review -- remove if no planned usage.

### CQ-3: `detectCdnBase()` and `detectIsDev()` read `import.meta.env` as silent fallback

**File:** `packages/shared/src/image-optimizer.ts` lines 82-113

When callers omit the `ctx` parameter, these functions silently probe `import.meta.env.R2_PUBLIC_URL`, `import.meta.env.CDN_DOMAIN_URL`, `import.meta.env.MODE`, and `import.meta.env.DEV`. All current callers DO pass `ctx` explicitly (storefront wraps them in `apps/storefront/src/lib/image-optimizer.ts`, admin passes nothing and gets fallback behavior).

**Problem:** The fallback creates hidden coupling between a "pure" shared package and Vite/Astro build-time variables. In Cloudflare Workers, `import.meta.env` resolves to whatever was baked at build time, not runtime values from `wrangler secret`.

**Fix:** Remove the fallback functions. Make `ctx` a required parameter, or at minimum make `cdnBase` required and `isDev` default to `false`.

### CQ-4: `console.error`/`console.warn` calls in pure utility functions

**Locations:**
- `packages/shared/src/utils.ts` lines 31, 65 -- `unixToDate` and `formatDate`
- `packages/shared/src/cors-helper.ts` line 40 -- KV read failure
- `packages/shared/src/html-section-parser.ts` line 35 -- DOMParser unavailable
- `packages/shared/src/error-utils.ts` lines 10, 79 -- error logging

Pure utility functions should not have side effects. The `console.error` in `unixToDate` fires when `new Date()` throws, which is an edge case that the caller should handle. The `cors-helper.ts` log is acceptable (infrastructure-level).

**Fix:** Remove `console.error` from `unixToDate` and `formatDate` -- they already return `null`/`"Invalid date"` on failure, which is sufficient.

### CQ-5: Inconsistent error response shapes across `error-utils.ts`

The file exports three functions that produce different response shapes:

```typescript
// safeErrorResponse: { status: "error", timestamp, message }
// zodErrorResponse:  { status: "error", message: "Validation failed", details }
// honoSafeError:     { success: false, error: message, timestamp }
```

The project convention is `{ success: boolean, data?: T }`. None of these match. The API's `ApiError` system has superseded all of them.

**Fix:** Delete the entire file once all consumers are migrated (currently zero consumers in app code).

### CQ-6: Duplicated HTML/XML escaping

**Files:**
- `packages/shared/src/html-escape.ts` -- `escapeHtml()` (escapes `& < > " '`)
- `packages/shared/src/barcode-svg.ts` lines 200-206 -- private `escapeXml()` (escapes `& < > "`, missing `'`)

The `escapeXml` function in `barcode-svg.ts` is a subset of `escapeHtml` with one fewer character handled. It could import from `html-escape.ts` instead.

**Fix:** Replace the private `escapeXml` in `barcode-svg.ts` with `import { escapeHtml } from "./html-escape"`.

---

## API Surface Analysis

### Export Map

The `package.json` uses a wildcard export: `"./*": "./src/*.ts"`. This means every `.ts` file in `src/` is a public module. There is no barrel file (`index.ts`), which is correct for tree-shaking.

### Module-by-Module Import Counts (real app/package consumers)

| Module | Exports | Used Exports | Dead Exports | Consumer Apps | Import Count |
|--------|---------|-------------|-------------|---------------|-------------|
| `utils.ts` | 4 (`cn`, `unixToDate`, `formatDate`, `getStatusBadgeClass`) | 4 | 0 | admin, storefront, core | ~70+ |
| `currency.ts` | 7 | 5 (`DEFAULT_CURRENCY`, `getDecimalPlaces`, `getCurrencySymbol`, `getCurrencyCode`, `formatPrice`) | 1 (`formatPriceShort` -- storefront only re-exports, unclear if used) | admin, storefront, api, core | ~15 |
| `price-utils.ts` | 6 | 5 | 1 (`calculatePercentageDiscount`) | storefront, api, core | ~10 |
| `customer-utils.ts` | 6 | 6 | 0 | admin, storefront, api, core | ~12 |
| `image-optimizer.ts` | 8 | 5 (`getOptimizedImageUrl`, `getOriginalImageUrl`, `getResponsiveSrcSet`, `ImagePresets`, types) | 2 (`getOptimizedImageProps`, `isR2Image`) | admin, storefront | ~15 |
| `media-url.ts` | 1 | 1 | 0 | storefront, image-optimizer | ~3 |
| `html-escape.ts` | 1 | 1 | 0 | storefront, core | ~5 |
| `cors-helper.ts` | 1 | 1 | 0 | api | 1 |
| `rate-limit.ts` | 2 | 2 | 0 | api | 2 |
| `layout-cache.ts` | 2 | 2 | 0 | admin, api | 3 |
| `storefront-url.ts` | 1 | 1 | 0 | core | 1 |
| `order-utils.ts` | 1 | 1 | 0 | admin, core | 3 |
| `barcode-utils.ts` | 3 | 1 (`generateEAN13`) | 2 (internally used) | admin | 2 |
| `barcode-svg.ts` | 2 | 1 (`generateBarcodeSvg`) | 0 | admin | 1 |
| `css-scope.ts` | 1 | 1 | 0 | storefront | 2 |
| `tag-parser.ts` | 7 | 2 (`parseTagBasedResponse`, `validateParsedWidget`) | 3 (`StreamingTagParser`, `getTagBasedExampleFormat`, types only) | admin | 4 |
| `json-repair.ts` | 5 | 2 (`parseJSONSafely`, `validateWidgetJSON`) | 1 (`aggressiveRepairJSON` -- only internal) | admin | 4 |
| `html-section-parser.ts` | 2 | 1 (`parseHtmlIntoSections`) | 1 (`reconstructWidgetFromSections`) | admin | 1 |
| `error-utils.ts` | 3 | 0 | 3 | (none) | 0 |

**Summary:** 57 total exports, ~42 actively consumed, ~15 dead or internal-only.

---

## Utility Quality (per file)

### `utils.ts` (109 lines) -- cn, dates, status badges

**Quality: 6/10**

- `cn()`: Perfect. Standard clsx + tailwind-merge pattern. 1 line.
- `unixToDate()`: Good null safety, handles seconds vs milliseconds auto-detection. Minor issue: the heuristic `< 10000000000` breaks for dates before Nov 2286 in milliseconds or after Nov 2286 in seconds. Practically fine.
- `formatDate()`: Delegates to `unixToDate`, good. Hardcodes `en-US` locale and specific format -- should accept locale as parameter for i18n.
- `getStatusBadgeClass()`: Returns `{ badgeClass: string }` when a plain `string` would be simpler. Switch indentation is wrong (0-indent instead of 2-space). Tailwind classes are hardcoded -- consider making this a lookup table object.

### `currency.ts` (101 lines) -- formatting with currency.js

**Quality: 8/10**

- Clean ISO 4217 lookup table covering all exception currencies.
- `formatPrice()` properly uses `currency.js` for precision.
- `formatPriceShort()` has fragile whole-number detection logic: `val.cents() % Math.pow(10, precision) === 0`. Should use `val.value === Math.floor(val.value)`.
- `getCurrencySymbol()`/`getCurrencyCode()` read from `window` globals with proper `typeof window` guards. Acceptable for client-side usage.
- `DEFAULT_CURRENCY` hardcodes `BDT` (Bangladeshi Taka) with `usdExchangeRate: 1` -- the exchange rate is clearly a placeholder, not meaningful.

### `price-utils.ts` (69 lines) -- float-safe arithmetic

**Quality: 9/10**

- All functions use `currency.js` correctly.
- `addPrices()` uses variadic `...amounts` with reduce -- clean API.
- `calculateDiscountedPrice()` treats `0` as falsy (line 60: `if (discountPercentage)`, line 65: `if (discountAmount)`). A 0% discount or $0 discount returns the original price, which is the correct result but via the wrong branch. Use `!= null && > 0` for clarity.
- No `any` types, all parameters typed.

### `customer-utils.ts` (96 lines) -- phone validation + customer stats

**Quality: 7/10**

- Phone functions are clean: `validateAndFormatPhone()`, `formatPhoneForDisplay()`, `formatPhoneForProvider()`.
- `phoneNumberSchema` is a Zod transform schema -- good for validation pipelines.
- `calculateCustomerStats()` is misplaced here. It has nothing to do with customers or phones -- it aggregates order totals. Belongs in `order-utils.ts`.
- `calculateCustomerStats().totalSpent` uses plain `+` addition without `currency.js`, creating potential float drift. The rest of the codebase uses `addPrices()` from `price-utils.ts` for money addition.

### `cors-helper.ts` (84 lines) -- CORS origin checking

**Quality: 7/10**

- Properly reads from KV with fallback to env.
- Wildcard pattern support via regex.
- Creates a new `RegExp` on every origin check (line 18). Should pre-compile.
- Returns `"*"` for no-origin requests (line 9). This prevents credentialed CORS requests from working in that path.
- The `CorsContext` interface uses `Record<string, unknown>` which is loose. Could type the expected env keys.

### `rate-limit.ts` (74 lines) -- KV-based rate limiter

**Quality: 9/10**

- Clean KV-based implementation with automatic TTL expiry. No `setInterval`, no in-memory state.
- `getClientIp()` correctly prefers `cf-connecting-ip` (not spoofable) with fallback.
- JSON parse wrapped in try/catch for corrupted entries.
- Properly calculates remaining TTL for KV put.
- Only issue: increments count even when limit is exceeded (optimistic counting). This means a burst of requests past the limit keeps incrementing, but the TTL-based reset handles this correctly.

### `html-escape.ts` (21 lines) -- HTML escaping

**Quality: 10/10**

- Simple, correct, complete. Covers all 5 HTML special characters.
- Uses pre-compiled regex and lookup map.
- Returns `""` for falsy input.

### `json-repair.ts` (190 lines) -- LLM JSON repair

**Quality: 6/10**

- `parseJSONSafely()` cascade of 4 strategies is sound.
- `repairJSON()` has good brace-balancing logic that properly skips quoted strings.
- `aggressiveRepairJSON()` blindly replaces all `\n`/`\r`/`\t` characters (line 92-94), which can corrupt JSON keys or values that legitimately contain tabs.
- `validateWidgetJSON()` creates a `normalized` copy (lines 180-183) but never returns it -- dead code within the function body.
- `extractAndParseJSON()` and `aggressiveRepairJSON()` are only called internally by `parseJSONSafely()` but are exported.

### `css-scope.ts` (222 lines) -- CSS selector scoping

**Quality: 8/10**

- Comprehensive CSS parser handling at-rules, comments, nested blocks, functional pseudo-selectors.
- `splitSelectors()` correctly handles parenthesized depth for `:is()`, `:where()`, etc.
- `prefixSelectors()` properly rewrites `body`/`html`/`*`/`:root` to the scope class.
- Does not handle CSS strings (e.g., `content: "{"` would confuse the brace matcher). Edge case but worth noting.
- No `any` types. Clean recursive `processBlock` approach.

### `barcode-svg.ts` (206 lines) -- Code 128B SVG barcode

**Quality: 8/10**

- Complete Code 128B implementation with checksum.
- Pure SVG output -- no DOM dependency.
- Has its own `escapeXml()` that duplicates `html-escape.ts` (missing `'` escape).
- `CODE128_BITS` array is 106 entries of 11-bit strings as a constant table -- correct per spec.
- Good options interface with sensible defaults.

### `barcode-utils.ts` (30 lines) -- EAN-13 generation

**Quality: 8/10**

- Correct EAN-13 check digit calculation per ISO standard.
- Uses `crypto.getRandomValues` for randomness.
- Minor bias: `byte % 10` for `Uint8Array` values (0-255) gives ~3.8% bias toward digits 0-5. Acceptable for internal barcodes.

### `html-section-parser.ts` (332 lines) -- DOM-based HTML section extraction

**Quality: 5/10**

- Requires `DOMParser` (browser-only) but lives in a Worker-friendly shared package.
- Has `/// <reference lib="dom" />` at the top, pulling DOM types into all consumers.
- 4-strategy cascade is thorough (staged widget -> semantic tags -> class patterns -> top-level elements -> single section fallback).
- `reconstructWidgetFromSections()` is exported but never imported anywhere.
- `ParsedSection` type name conflicts with the same name in `tag-parser.ts` (different shapes).
- Only consumed by `apps/admin/src/components/admin/widgets/WidgetForm.tsx`.

### `tag-parser.ts` (272 lines) -- XML-like tag extraction

**Quality: 7/10**

- 4-strategy cascade for LLM response parsing is well-designed.
- `StreamingTagParser` class is dead code (zero consumers).
- `getTagBasedExampleFormat()` returns a prompt template -- dead code (zero consumers).
- `ParsedSection` type conflicts with the one in `html-section-parser.ts`.
- Good regex patterns for tag extraction.

### `image-optimizer.ts` (320 lines) -- Cloudflare Image Resizing

**Quality: 7/10**

- Well-structured with options interface, presets, and context injection.
- `detectCdnBase()` and `detectIsDev()` are the main quality issue (CQ-3 above).
- 5 `as any` casts for env probing.
- `getOptimizedImageProps()` and `isR2Image()` are dead code.
- `ImagePresets` is a nice API -- used by storefront via wrapper.
- Correctly handles already-optimized URLs (`/cdn-cgi/image/` check).

### `layout-cache.ts` (40 lines) -- in-memory TTL cache

**Quality: 7/10**

- Simple and correct TTL-based cache using module-level `Map`.
- Stateful (not pure) -- contradicts package's "pure utilities" branding.
- `CACHE_KEYS` only has 2 entries -- suggests this should live closer to its consumers.
- Only used by admin app and one API settings route.

### `media-url.ts` (36 lines) -- URL resolution

**Quality: 10/10**

- Pure function, well-documented, handles all edge cases.
- Properly handles bare R2 keys, absolute URLs, CDN-optimized paths, local paths.
- No `any`, no side effects.

### `storefront-url.ts` (29 lines) -- URL construction

**Quality: 9/10**

- Pure, simple, well-documented.
- Properly normalizes slashes.
- Single consumer (`packages/core/src/modules/settings/settings.service.ts`).

### `order-utils.ts` (9 lines) -- order ID generation

**Quality: 9/10**

- Uses `crypto.getRandomValues` for randomness.
- `b % 36` for `Uint8Array` values (0-255) has slight bias (256 / 36 = 7.11, so values 0-3 have probability 8/256 vs 7/256 for values 4-35). Negligible for a 6-char ID.
- Very clean, single-purpose module.

### `error-utils.ts` (83 lines) -- error response helpers

**Quality: 3/10**

- All three exports are dead code (zero consumers in app code).
- Inconsistent response shapes (see CQ-5).
- Duplicates the API's `ApiError` system.
- Uses `as any` for env detection.
- Candidate for complete removal.

---

## Duplication & Overlap

### 1. `escapeXml` in barcode-svg.ts duplicates `escapeHtml` in html-escape.ts

`barcode-svg.ts` line 200 defines a private `escapeXml()` that is a strict subset of `escapeHtml()` (missing the `'` -> `&#39;` mapping). Should import from `html-escape.ts`.

### 2. `json-repair.ts` and `tag-parser.ts` overlap on markdown code block removal

Both files have nearly identical logic for stripping ` ```json ` / ` ``` ` wrappers:

```typescript
// json-repair.ts:11-12
cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "");

// tag-parser.ts:126-130
if (jsonString.startsWith('```json')) {
  jsonString = jsonString.replace(/^```json\s*/, '').replace(/```\s*$/, '');
}
```

Both are used by the same admin widget components. Could share a `stripMarkdownCodeBlock()` helper.

### 3. `error-utils.ts` duplicates API error handling

The entire module is redundant with `apps/api/src/utils/api-error.ts` + `apps/api/src/utils/api-response.ts`. The API has `ValidationError`, `NotFoundError`, etc. The shared package has `safeErrorResponse`, `zodErrorResponse`, `honoSafeError` -- none of which are used.

### 4. `calculateCustomerStats` in customer-utils.ts should be in order-utils.ts

This function aggregates order data (totalAmount, createdAt) into stats. It has zero relationship to phone validation or customer identity. Its only consumers are in `packages/core/src/modules/orders/orders.admin.ts`.

### 5. `ParsedSection` type defined in two files with different shapes

- `packages/shared/src/html-section-parser.ts` line 14: `{ index, html, css, description, id, timestamp }`
- `packages/shared/src/tag-parser.ts` line 20: `{ partNumber, html, css }`

If both are imported in the same file, the names would conflict.

---

## Performance

### P-1: CORS regex compilation per request

`packages/shared/src/cors-helper.ts` line 18 creates a new `RegExp` per wildcard origin per request. For N wildcard patterns, this is O(N) regex compilations on every CORS-checked request.

**Fix:** Pre-compile wildcard patterns into `RegExp` objects in `getAllowedCorsOrigins()` and return them alongside the string patterns.

### P-2: `json-repair.ts` brace-balancing iterates entire string

`repairJSON()` line 49-65 iterates the entire JSON string character-by-character for brace counting. This is O(n) per call, plus the function is called up to 2 times in the `parseJSONSafely` cascade. For large LLM responses this could be noticeable but is unlikely to be a bottleneck.

### P-3: `css-scope.ts` string concatenation via array join

The `processBlock` function builds output via `result.push()` then `result.join("")`. This is the idiomatic approach and performs well for typical CSS sizes. No issue.

### P-4: `barcode-svg.ts` builds SVG via string concatenation

Each bar is a string `<rect .../>` concatenated in a loop. For a typical 6-character barcode (67 bits in Code 128B), this is ~67 iterations -- negligible.

**Overall performance assessment:** No significant performance issues. The package is well-suited for its use case.

---

## LLM-Friendliness

### Score: 7.5/10

**Strengths:**
- Self-documenting function names: `validateAndFormatPhone`, `calculateDiscountedPrice`, `getOptimizedImageUrl`, `buildStorefrontPath`
- Consistent options-object pattern with defaults: `BarcodeSvgOptions`, `ImageOptimizationOptions`, `ImageContext`
- Good JSDoc on most public functions with `@param` and `@returns` documentation
- Clean module boundaries -- each file has a single concern (with exceptions noted below)
- Typed interfaces for all options and return values
- No deep nesting or complex class hierarchies
- No circular dependencies

**Weaknesses:**
- `layout-cache.ts` and `rate-limit.ts` have mutable state that is not obvious from function signatures
- `image-optimizer.ts` silently falls back to environment detection, making behavior context-dependent
- `getStatusBadgeClass` returning `{ badgeClass }` breaks the pattern of every other function returning a direct value
- `customer-utils.ts` mixes phone validation + order stats -- hard to predict file contents
- `error-utils.ts` has three functions with three different response shapes
- Dead exports make it unclear which functions are the "right" ones to use
- Two files define `ParsedSection` with different shapes -- namespace collision risk

---

## Recommended Changes

### Priority 1 -- Fix Now (zero-risk cleanup)

1. **Delete `error-utils.ts` entirely.** Zero consumers in app code. The API's `ApiError` system is the canonical error pattern. If `safeErrorResponse` is needed for Astro API routes, reintroduce as a focused single function later.

2. **Remove dead exports from `tag-parser.ts`:** Delete `StreamingTagParser` class and `getTagBasedExampleFormat()`. Zero consumers.

3. **Remove `reconstructWidgetFromSections` from `html-section-parser.ts`.** Zero consumers.

4. **Replace `escapeXml` in `barcode-svg.ts`** with `import { escapeHtml } from "./html-escape"`.

5. **Fix `getStatusBadgeClass` in `utils.ts`:** Return `string` instead of `{ badgeClass: string }`. Fix indentation. Update all ~2 consumer sites.

### Priority 2 -- Fix Soon (correctness improvements)

6. **Fix `formatPriceShort` in `currency.ts`:** Replace `val.cents() % Math.pow(10, precision) === 0` with `val.value === Math.floor(val.value)`.

7. **Fix `calculateDiscountedPrice` in `price-utils.ts`:** Change `if (discountPercentage)` to `if (discountPercentage != null && discountPercentage > 0)`. Same for `discountAmount`.

8. **Fix `calculateCustomerStats` in `customer-utils.ts`:** Use `addPrices()` from `price-utils.ts` for `totalSpent` calculation instead of plain `+` operator.

9. **Remove `detectCdnBase()` and `detectIsDev()` from `image-optimizer.ts`.** Make `ctx` required or default `isDev` to `false` and `cdnBase` to `""`.

10. **Remove `console.error` from `unixToDate()` and `formatDate()` in `utils.ts`.** They already return safe fallback values.

11. **Pre-compile CORS wildcard patterns** in `cors-helper.ts` to avoid per-request regex construction.

### Priority 3 -- Improve Later (structural improvements)

12. **Move `calculateCustomerStats` from `customer-utils.ts` to `order-utils.ts`** where it semantically belongs.

13. **Move `html-section-parser.ts` to `apps/admin/src/lib/`** since it requires DOM and is only consumed by admin WidgetForm.

14. **Move `layout-cache.ts` to `apps/admin/src/lib/`** since admin is the primary consumer (API settings route can use its own cache or import from admin).

15. **Rename `ParsedSection` in one of the two files** (`html-section-parser.ts` or `tag-parser.ts`) to avoid namespace collision. Suggestion: `TagParsedSection` in `tag-parser.ts`.

16. **Add `locale` parameter to `formatDate()` in `utils.ts`** instead of hardcoding `en-US`.

17. **Fix `validateWidgetJSON` in `json-repair.ts`** to return the normalized data object, or remove the dead normalization code (lines 180-183).
