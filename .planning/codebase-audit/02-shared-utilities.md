# Shared Utilities Audit

**Package:** `packages/shared/` (`@scalius/shared`)
**Files reviewed:** 17 source files in `src/`
**Date:** 2026-03-20

## Summary

The shared package provides ~850 lines of utility code across 17 modules spanning currency formatting, image optimization, barcode generation, phone validation, error handling, CORS, rate limiting, and LLM response parsing. Most modules are well-structured pure functions with clean interfaces. The package is actively consumed by all three apps (admin, API, storefront) and by `@scalius/core`. The main concerns are: a phantom `drizzle-orm` dependency, stateful modules in a package branded as "pure utilities," an `import.meta.env` fallback path that contradicts the project's stated convention, and a handful of correctness edge cases in currency/barcode/rate-limit code.

## Strengths

1. **Clean dependency direction.** Zero imports from `@scalius/core`, `@scalius/database`, or any other workspace package. Only two intra-package imports (`image-optimizer` -> `media-url`, `price-utils` -> `currency`). Dependency graph is leaf-level as intended.

2. **JIT-friendly, no build step.** The wildcard export map (`"./*": "./src/*.ts"`) means consumers import individual modules by name -- good tree-shaking and no barrel-file bloat.

3. **Comprehensive currency precision.** Using `currency.js` throughout `currency.ts` and `price-utils.ts` eliminates IEEE 754 floating-point drift. The ISO 4217 decimal-places lookup covers all zero-decimal and three-decimal currencies.

4. **Good null safety.** `resolveMediaUrl`, `getOptimizedImageUrl`, `getOriginalImageUrl`, `unixToDate`, `formatDate` all accept `null | undefined` and return safe defaults. This matches the Drizzle row shape where nullable columns are common.

5. **Robust LLM parsing.** `tag-parser.ts` uses a 4-strategy cascade (tag extraction -> JSON parse -> code block extraction) with `StreamingTagParser` for progressive updates. `json-repair.ts` similarly cascades through 4 repair strategies. Both return typed result objects rather than throwing.

6. **Self-documenting exports.** Function names like `validateAndFormatPhone`, `calculatePercentageDiscount`, `buildStorefrontPath`, `getOptimizedImageUrl` clearly communicate intent.

7. **Barcode generation is dependency-free.** `barcode-svg.ts` ships a complete Code 128B encoder producing raw SVG strings without any runtime dependencies.

## Issues Found

### Critical

*None.*

### Major

**M1. Phantom `drizzle-orm` dependency** (package.json)
`drizzle-orm` is listed in `dependencies` but no file in `packages/shared/src/` imports it. This pulls a heavy ORM into a utilities package that consumers (especially storefront) should not need. It likely leaked in during a refactor.
- **File:** `packages/shared/package.json`, line 19
- **Fix:** Remove `"drizzle-orm": "^0.45.1"` from dependencies.

**M2. `import.meta.env` fallback in image-optimizer violates project convention** (image-optimizer.ts:81-112)
The CLAUDE.md states: *"Never use `import.meta.env` for secrets."* While `R2_PUBLIC_URL` and `CDN_DOMAIN_URL` are not secrets, the `detectCdnBase()` and `detectIsDev()` functions read `import.meta.env` as a silent fallback when no `ctx` is passed. This creates a hidden coupling between the "pure" shared package and Vite/Astro build-time variables, and risks baking `.dev.vars` values into production bundles for any consumer that does not pass `ctx` explicitly.
- **File:** `packages/shared/src/image-optimizer.ts`, lines 81-112
- **Risk:** If a caller forgets to pass `ctx`, the function silently reads build-time env vars. In production Cloudflare Workers, `import.meta.env` may resolve to empty or stale values baked at build time.
- **Fix:** Remove `detectIsDev()` and `detectCdnBase()`. Make `ctx` required, or at minimum log a warning when falling back.

**M3. `error-utils.ts` has two dead exports** (error-utils.ts:59, 74)
`honoSafeError` is only referenced in its own definition and README -- zero actual call sites. `zodErrorResponse` is also only referenced in its own file and README -- never called anywhere in the codebase. The API layer uses `ApiError` classes and Hono's own error handler instead. These are dead code that misleads developers about the error-handling pattern.
- **File:** `packages/shared/src/error-utils.ts`
- **Fix:** Remove `honoSafeError` and `zodErrorResponse`. If needed in future, they can be reintroduced.

**M4. `rate-limit.ts` uses `setInterval` in a Cloudflare Worker** (rate-limit.ts:33)
Cloudflare Workers do not support long-running `setInterval` -- each request runs in an isolate that may be evicted. The cleanup interval is scheduled on first call and never cleared, leaking a timer handle. The `ipHitMap` is also module-level mutable state, so it resets on isolate restart, making the rate limiter unreliable.
- **File:** `packages/shared/src/rate-limit.ts`, line 33
- **Impact:** The rate limiter is only used in `apps/api/src/routes/search.ts`. In practice it provides minimal protection because Worker isolate lifetime is unpredictable.
- **Fix:** Document the limitation clearly. For production correctness, this should migrate to KV-based tracking (noted in CLAUDE.md backlog).

**M5. `layout-cache.ts` is stateful, not a pure utility** (layout-cache.ts)
The module maintains a module-level `Map`. This is fine behavior for a singleton cache, but it contradicts the README description ("Pure utility functions") and the package's role as the bottom of the dependency graph. It means any consumer that imports this module shares the same mutable state.
- **File:** `packages/shared/src/layout-cache.ts`
- **Risk:** Low in practice (only admin app uses it). But semantically, a stateful cache belongs in `@scalius/core` or in the consuming app, not in `@scalius/shared`.
- **Fix:** Consider relocating to `apps/admin/src/lib/` since admin is the only consumer. Or keep it here but document clearly that it is an intentional exception to the "pure" rule.

### Minor

**m1. `generateEAN13` has biased digit distribution** (barcode-utils.ts:9-12)
`b % 10` for a `Uint8Array` value (0-255) is not uniformly distributed: digits 0-5 have probability 26/256 while digits 6-9 have probability 25/256. This is a ~3.8% bias. For internal barcodes this is acceptable, but worth documenting.
- **File:** `packages/shared/src/barcode-utils.ts`, line 11

**m2. `formatPriceShort` zero-check logic is wrong for 3-decimal currencies** (currency.ts:97)
`val.cents()` returns the value in the smallest unit. `val.cents() % Math.pow(10, precision) === 0` checks if the cents value is divisible by 10^precision, which is always true for a correctly-constructed `Currency` value (cents are already the smallest unit). For example, `Currency(5.00, { precision: 2 }).cents()` returns `500`, and `500 % 100 === 0` is true. But `Currency(5.10, { precision: 2 }).cents()` returns `510`, and `510 % 100 === 10`, so it works for that case. The real issue: for precision=0 currencies (JPY), `Math.pow(10, 0) === 1`, and `any % 1 === 0` is always true, so it will always drop decimals for zero-decimal currencies -- which is correct but coincidental. The logic is fragile and hard to reason about.
- **File:** `packages/shared/src/currency.ts`, line 97
- **Fix:** Replace with: `val.value === Math.floor(val.value)` -- simpler and correct for all precisions.

**m3. `cors-helper.ts` creates a new `RegExp` on every origin check** (cors-helper.ts:18)
For wildcard patterns, a new `RegExp` is constructed per-origin per-request. With many allowed origins, this is O(n) regex compilations on every request.
- **File:** `packages/shared/src/cors-helper.ts`, line 18
- **Fix:** Pre-compile wildcard patterns into RegExp objects once in `getAllowedCorsOrigins`.

**m4. `cors-helper.ts` returns `"*"` for no-origin requests** (cors-helper.ts:9)
When the `Origin` header is absent, the function returns `"*"`. This is correct for curl/mobile, but `Access-Control-Allow-Origin: *` prevents credentialed requests (cookies/auth). If CORS middleware uses this value for credentialed endpoints, browsers will reject the response.
- **File:** `packages/shared/src/cors-helper.ts`, line 9
- **Impact:** Depends on how the Hono CORS middleware consumes this value. Needs verification.

**m5. `getStatusBadgeClass` has inconsistent indentation** (utils.ts:73-109)
The `switch` body uses 0-indentation (aligned with `switch`) instead of the codebase's standard 2-space indentation inside the case blocks. This is a formatting issue only.
- **File:** `packages/shared/src/utils.ts`, lines 73-109

**m6. `getStatusBadgeClass` returns `{ badgeClass }` instead of `string`** (utils.ts:108)
It wraps the result in an object for no clear reason. Every consumer must destructure `{ badgeClass }` when a plain string return would be simpler and more consistent with every other function in the package.
- **File:** `packages/shared/src/utils.ts`, line 108

**m7. `calculateCustomerStats` is in `customer-utils.ts` alongside phone validation** (customer-utils.ts:74-96)
This function has nothing to do with phone numbers or customer identity -- it is order-statistics aggregation. It should live in `order-utils.ts` or its own file.
- **File:** `packages/shared/src/customer-utils.ts`, lines 74-96

**m8. `validateWidgetJSON` normalizes data but returns void** (json-repair.ts:161-165)
The function creates a `normalized` copy with `htmljs` mapped to `html`, but never returns it. The caller has no way to access the normalized result. This is dead code inside the function body.
- **File:** `packages/shared/src/json-repair.ts`, lines 161-165

**m9. `safeErrorResponse` response body does not include `success: false`** (error-utils.ts:16-44)
The function returns `{ status: "error", timestamp, message }` but the project's response envelope convention is `{ success: boolean, ... }`. The only consumer (`apps/admin/src/pages/health.ts`) likely does not hit this inconsistency, but it is a latent mismatch.
- **File:** `packages/shared/src/error-utils.ts`, lines 16-44

**m10. `aggressiveRepairJSON` blindly replaces all newlines** (json-repair.ts:73-75)
Replacing all `\n`, `\r`, `\t` characters globally -- including those inside JSON keys -- can corrupt data. For example, a JSON key containing a literal tab character would be replaced.
- **File:** `packages/shared/src/json-repair.ts`, lines 73-75
- **Impact:** Low, since this is a last-resort fallback for malformed LLM output.

**m11. `html-section-parser.ts` requires DOM but lives in a Worker-friendly package** (html-section-parser.ts)
This module depends on `DOMParser`, which is only available in browsers. It has a server-side fallback, but the entire 290-line module is dead weight in API/Worker bundles. Consider co-locating with the admin widget components that actually use it.
- **File:** `packages/shared/src/html-section-parser.ts`

**m12. `calculateDiscountedPrice` treats `0` as no discount** (price-utils.ts:60, 65)
`if (discountPercentage)` and `if (discountAmount)` are falsy for `0`, which is semantically valid (0% discount or $0 discount). While the result is the same (original price returned), the early-return path is misleading for readers.
- **File:** `packages/shared/src/price-utils.ts`, lines 60, 65
- **Fix:** Use explicit null/undefined checks: `discountPercentage != null && discountPercentage > 0`.

## Pattern Analysis

### Module Categorization

| Category | Modules | Pure? |
|---|---|---|
| **Currency/Price** | `currency.ts`, `price-utils.ts` | Yes (window globals are read-only fallback) |
| **Image/Media** | `image-optimizer.ts`, `media-url.ts` | Yes (with env fallback caveat in M2) |
| **Phone/Customer** | `customer-utils.ts` | Yes |
| **Order** | `order-utils.ts` | Yes |
| **Error Handling** | `error-utils.ts` | Yes |
| **CORS** | `cors-helper.ts` | Yes (async but no side effects) |
| **Barcode** | `barcode-utils.ts`, `barcode-svg.ts` | Yes |
| **URL** | `storefront-url.ts` | Yes |
| **UI** | `utils.ts` (cn, formatDate, getStatusBadgeClass) | Yes |
| **LLM Parsing** | `tag-parser.ts`, `json-repair.ts`, `html-section-parser.ts` | Yes (DOM dependency in html-section-parser) |
| **Stateful** | `layout-cache.ts`, `rate-limit.ts` | **No** -- mutable module-level state |

### Dependency Counts (real consumers, excluding READMEs/docs)

| Module | Import Count | Consumers |
|---|---|---|
| `utils.ts` (cn, formatDate, unixToDate) | ~25+ | admin, storefront, core |
| `currency.ts` | ~8 | admin, storefront, api, core |
| `price-utils.ts` | ~6 | storefront, api, core |
| `customer-utils.ts` | ~8 | admin, storefront, api, core |
| `image-optimizer.ts` | ~3 | admin, storefront |
| `media-url.ts` | ~2 | storefront |
| `order-utils.ts` | ~2 | core |
| `layout-cache.ts` | ~3 | admin, api |
| `cors-helper.ts` | 1 | api |
| `rate-limit.ts` | 1 | api |
| `storefront-url.ts` | 1 | core |
| `barcode-utils.ts` | 2 | admin |
| `barcode-svg.ts` | 1 | admin |
| `tag-parser.ts` | 4 | admin |
| `json-repair.ts` | 4 | admin |
| `html-section-parser.ts` | 1 | admin |
| `error-utils.ts` | 1 | admin (only `safeErrorResponse`) |

### Overlap / Duplication

- `json-repair.ts` and `tag-parser.ts` both handle LLM response parsing with overlapping strategies (markdown code block removal, JSON fallback). They are used by different callers but could share a common extraction layer.
- `error-utils.ts` defines `honoSafeError` which parallels the `ApiError` pattern in `apps/api/src/utils/api-error.ts`. The API layer does not use the shared version.

## Recommendations

### Priority 1 (fix now)

1. **Remove `drizzle-orm` from `package.json` dependencies.** It is never imported. This is a zero-risk cleanup.

2. **Remove dead exports `honoSafeError` and `zodErrorResponse`** from `error-utils.ts`. They have zero consumers and conflict with the established `ApiError` pattern.

3. **Fix `formatPriceShort` whole-number check** to use `val.value === Math.floor(val.value)` instead of the fragile modulo logic.

### Priority 2 (fix soon)

4. **Remove `detectCdnBase()` and `detectIsDev()` fallbacks** from `image-optimizer.ts`. All existing callers already pass `ctx`. Remove the silent env-reading paths to enforce the convention.

5. **Relocate `calculateCustomerStats`** from `customer-utils.ts` to `order-utils.ts` where it semantically belongs.

6. **Simplify `getStatusBadgeClass`** to return a plain `string` instead of `{ badgeClass: string }`. Fix indentation.

7. **Pre-compile CORS wildcard patterns** in `cors-helper.ts` to avoid per-request regex construction.

### Priority 3 (improve later)

8. **Relocate `layout-cache.ts`** to `apps/admin/` since it is only consumed there (aside from one API settings route that could import from admin or use its own cache).

9. **Relocate `html-section-parser.ts`** to admin widget components. It requires DOM and is only used by admin's WidgetForm.

10. **Document `rate-limit.ts` limitations** in the module's JSDoc and consider KV migration (already in backlog).

11. **Return the normalized data from `validateWidgetJSON`** or remove the dead normalization code.

12. **Standardize `safeErrorResponse`** to include `success: false` in its response body, matching the project envelope convention.

## LLM-Friendliness Score: 7/10

**Positives:**
- Self-documenting function names
- Consistent parameter patterns (options objects with defaults)
- Good JSDoc on most public functions
- Clean module boundaries -- each file has a single concern
- Typed interfaces for options and return values
- No deep nesting or complex class hierarchies

**Areas to improve:**
- Two modules (`layout-cache.ts`, `rate-limit.ts`) have hidden mutable state that is not obvious from the function signatures
- `image-optimizer.ts` silently falls back to environment detection, making behavior context-dependent in a non-obvious way
- `getStatusBadgeClass` returning `{ badgeClass }` breaks the pattern of every other function returning a direct value
- `customer-utils.ts` mixes two unrelated concerns (phone validation + order stats), making it harder to predict what a file contains
- `error-utils.ts` exports three functions with different response shapes (`safeErrorResponse` uses `{ status, message }`, `honoSafeError` uses `{ success, error }`), which makes the correct error pattern ambiguous
