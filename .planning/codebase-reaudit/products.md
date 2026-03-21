# Products Domain Re-Audit

## Quality Score: 7/10 (previous: 6/10)

The fix session addressed the most critical data bug (C1 -- missing discount fields in `getProductDetails`) and improved the bulk permanent delete (C2). The storefront fake variant stock was changed from `100` to `999999` with a comment, which is a deliberate design choice rather than a bug. Several code quality and performance issues remain open. The domain is materially better but still has meaningful optimization and cleanup opportunities.

## Previous Findings Status

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| C1 | `getProductDetails` omits `discountType` and `discountAmount` | **FIXED** | Both fields now present at `products.admin.ts:281-282` in the `.select()` call |
| C2 | `bulkDeleteProducts` missing `productAttributeValues`/`productRichContent` cleanup | **FIXED** | Both tables now deleted at `products.admin.ts:697-698` in the batch |
| C3 | Storefront fake variant hardcoded `stock: 100` | **PARTIALLY FIXED** | Changed to `stock: 999999` with comment "Not inventory-managed -- always available for purchase" at `products.storefront.ts:398`. Intentional design choice for variantless products, though still not merchant-configurable. |
| Q1 | Triple-defined `ProductListItem` type | **STILL OPEN** | Still three definitions: `products.types.ts:86-104` (core -- still missing `discountType`/`discountAmount`), `apps/admin/src/types/api-responses.ts:184-202` (includes them), `useProductList.ts:7-27` (includes them). Core type remains stale. |
| Q2 | `as any` casts for Drizzle D1 batch typing | **STILL OPEN** | Now 5 occurrences (was 4) at `products.admin.ts:506,609,666,700,737`. The new one at line 700 is from the C2 fix adding the extra batch operations. All documented with eslint-disable comments. Known Drizzle limitation. |
| Q3 | `z.any()` in storefront OpenAPI route schemas | **FIXED** | The storefront route `apps/api/src/routes/products.ts` now uses proper typed schemas: `storefrontProductSchema` (lines 51-67), `z.record(z.string(), z.unknown())` for flexible objects (lines 152-156), and a typed search response schema (lines 114-124). No `z.any()` calls remain. |
| Q4 | Dynamic imports inside `searchStorefrontProducts` | **STILL OPEN** | Lines `products.storefront.ts:451-452` still have redundant dynamic imports of `ftsMatch` and drizzle-orm operators. Static imports exist at lines 14-15. Dead code from a refactor. |
| Q5 | Excessive inline type annotations in storefront service | **STILL OPEN** | Long inline type annotations remain at `products.storefront.ts:180`, `273`, `298`, `333`, `380-383`. Lines exceed 200+ characters with full interface definitions inline on `.map()` callbacks and `.then()` handlers. |
| Q6 | Unused `z` import in `products.variants.ts` | **STILL OPEN** | `z` imported at line 11 but only used for `z.infer<typeof ...>` in function signatures, which is valid usage. On re-examination this is NOT unused -- `z.infer` is used at lines 122, 157, 265, 362. Reclassified as **NOT AN ISSUE**. |
| P1 | Error handling inconsistency -- double error re-throwing in API routes | **STILL OPEN** | `apps/api/src/routes/admin/products.ts` still catches core typed errors and re-throws different typed errors from `api-error.ts`. String matching on error messages at lines 179, 209, 272-273, 351, 387, 450-451, 480, 516, 602. The core services already throw `NotFoundError`, `ConflictError`, `ValidationError` from `@scalius/core/errors`, but the route layer catches and re-throws as different error classes from `apps/api/src/utils/api-error.ts`. |
| P2 | `getProductStats`/`getCategoryStats` sequential queries | **STILL OPEN** | `products.admin.ts:346-415` -- still 4 sequential awaits in `getProductStats` and 3 in `getCategoryStats`. Not batched. |
| P3 | Admin proxy convention -- duplicated URL construction | **STILL OPEN** | API paths still constructed inline across `useProductSubmit.ts:38`, `useProductList.ts:137,368,407,443,483`, `useVariantOperations.ts`. No shared path constants. This is a codebase-wide pattern, not specific to products. |
| M1 | Variant images encoded in `metaDescription` via HTML comments | **STILL OPEN** | `apps/admin/src/components/admin/product-form/utils.ts:26-58` still uses `<!--variant_images:enabled-->` marker. `apps/storefront/src/pages/products/[slug].astro:26-32` still parses it. Should be a proper boolean column. |
| M2 | VariantManager uses `window.dispatchEvent(new CustomEvent("variantChanged"))` | **STILL OPEN** | `VariantManager.tsx` still uses this pattern at lines 133, 141, 198, 224, 247, 258, 269, 278, 303. The `onVariantChange ? onVariantChange() : window.dispatchEvent(...)` ternary is at least guarded now, but the fallback global event pattern persists. |
| M3 | Large `useProductList.ts` hook (629 lines) | **STILL OPEN** | File is now 630 lines. Returns 28 values. Still combines search, selection, pagination, sorting, URL sync, and bulk operations in one hook. |
| M4 | `additionalInfo.sortOrder` not in admin form schema | **STILL OPEN** | `types.ts:60-68` still defines `additionalInfo` without `sortOrder`. The `formatFormValuesForSubmission` at `utils.ts:94-97` injects `sortOrder: index`. Misalignment between form schema and API schema persists but works functionally. |
| S1 | `getProductDetails` runs 4 sequential queries | **STILL OPEN** | `products.admin.ts:294-318` -- four sequential awaits for variants, images, richContent, attributeValues. Not batched or parallelized. The storefront equivalent uses `Promise.all()`. |
| S2 | `updateVariantSortOrder` runs N+M sequential queries | **STILL OPEN** | `products.variants.ts:362-396` -- two `for` loops with individual `await` per color and per size. No batching. |
| S3 | `duplicateVariant` unbounded SKU uniqueness loop | **STILL OPEN** | `products.variants.ts:228-239` -- still a `while(true)` loop with one DB query per iteration. |
| S4 | Storefront product list count query runs after main query | **PARTIALLY FIXED** | `products.storefront.ts:156-220` -- the count query runs after the main product list query, not in parallel. However, the `searchStorefrontProducts` function at `products.storefront.ts:461-483` correctly uses `Promise.all()` for its count + results. |
| S5 | `getProductStats`/`getCategoryStats` sequential count queries | **STILL OPEN** | Same as P2. |
| R1 | Slug uniqueness check not atomic with insert | **STILL OPEN** | `products.admin.ts:427-506` -- check at line 427, insert in batch at line 506. Unique index provides DB-level guard but error message would be an unhandled constraint violation. |
| R2 | `deleteProduct`/`restoreProduct` no existence check | **STILL OPEN** | `products.admin.ts:615-633` -- both silently succeed if ID doesn't exist (update 0 rows). |
| R3 | `bulkUpdateVariants` no ownership verification | **STILL OPEN** | `products.admin.ts:712-738` -- WHERE clause correctly scopes by productId but no pre-check that variant IDs belong to the product. Silent no-op if wrong IDs sent. |
| R4 | No upper limit on `listProducts` page size | **STILL OPEN** | `apps/api/src/routes/admin/products.ts:121` -- `limit: z.coerce.number().default(10)` with no `.max()`. Client can request any page size. |

## New Issues Found

### N1. Storefront route handler uses `as any` cast

**Files:** `apps/api/src/routes/products.ts:164,170`

The `getProductBySlugRoute` handler is cast as `(async (c: any) => { ... }) as any`. This was introduced to work around Hono's OpenAPI type inference when the response schema uses `z.record()`. The `z.any()` calls from Q3 were fixed, but this workaround is needed because the flexible `z.record(z.string(), z.unknown())` schema doesn't match Hono's strict return type inference.

**Impact:** Low -- the handler works correctly, but the `as any` suppresses type checking on the route handler.

### N2. Dynamic imports inside `getAttributeFilters` helper

**Files:** `apps/api/src/routes/products.ts:182-183`

The `getAttributeFilters` function dynamically imports `productAttributes` from the schema and `inArray` from drizzle-orm, despite both being readily importable at module scope. Same pattern as Q4.

```typescript
const { productAttributes } = await import("@scalius/database/schema");
const { inArray } = await import("drizzle-orm");
```

**Impact:** Minor performance cost on every storefront product list request. Should be static imports.

### N3. Storefront `getStorefrontProducts` count query still sequential

**Files:** `packages/core/src/modules/products/products.storefront.ts:194-220`

The count query for pagination runs after the main product query and image/category lookups complete, not in parallel. This adds an extra DB round-trip per storefront product list page load. The `searchStorefrontProducts` function correctly uses `Promise.all()` for its count/results, making this inconsistent.

### N4. Type assertions in `searchStorefrontProducts` cast to unknown then back

**Files:** `packages/core/src/modules/products/products.storefront.ts:454-456,478,486,496,516,521,528`

Multiple `as Promise<Array<...>>` and `as Array<...>` casts throughout the function. The pattern of typed `Promise.all` results cast to specific arrays loses compile-time safety. The function would benefit from extracted return types or Drizzle's inferred types.

## Remaining Technical Debt

### Performance -- Sequential Queries (P2/S1/S2/S5)

Four functions still run sequential independent queries instead of batching:
- `getProductDetails` at `products.admin.ts:294-318` (4 queries)
- `getProductStats` at `products.admin.ts:346-385` (4 queries)
- `getCategoryStats` at `products.admin.ts:389-414` (3 queries)
- `updateVariantSortOrder` at `products.variants.ts:362-396` (N+M queries)

All could use `db.batch()` or `Promise.all()`. Total potential savings: ~10 DB round-trips per admin product detail/stats page load.

### Architecture -- Variant Images Encoding (M1)

The `<!--variant_images:enabled-->` HTML comment in `metaDescription` is the single most surprising pattern in the domain. It exists in:
- `apps/admin/src/components/admin/product-form/utils.ts:26-58` (read/write helpers)
- `apps/storefront/src/pages/products/[slug].astro:26-32` (parsing)

Fix: Add a `variantImagesEnabled: boolean` column to the `products` schema.

### Architecture -- Error Re-throwing Pattern (P1)

Core services throw typed errors (`NotFoundError`, `ConflictError`, `ValidationError` from `@scalius/core/errors`). The API route layer catches these and re-throws as _different_ error classes with the same names from `apps/api/src/utils/api-error.ts`, using fragile string matching on `error.message`. The global error handler should map core errors directly to HTTP responses.

### Code Quality -- Triple ProductListItem Type (Q1)

Three definitions with subtle differences. The core type at `products.types.ts:86-104` is stale (missing `discountType`, `discountAmount`). Consolidation needed.

### Code Quality -- Redundant Dynamic Imports (Q4, N2)

Two locations import modules dynamically that are already imported at module scope:
- `products.storefront.ts:451-452`
- `apps/api/src/routes/products.ts:182-183`

### Robustness -- No Page Size Limit (R4)

Admin product list route accepts any `limit` value. Add `.max(100)` to the Zod schema.

## Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| Code Quality | 7/10 | Critical data bug fixed (C1). `z.any()` eliminated from routes (Q3). Stale types and redundant imports remain. |
| Pattern Consistency | 6/10 | Error handling pattern still inconsistent (core errors re-thrown as different types). Storefront uses `Promise.all()` in some functions but sequential queries in others. |
| Maintainability | 6/10 | The `metaDescription` HTML comment encoding (M1) and 630-line `useProductList` hook (M3) are the main maintainability drags. VariantManager custom event fallback persists. |
| Scalability | 6/10 | Sequential query pattern in admin functions limits scaling. 4 queries for product details, 4 for stats, N+M for sort order updates. No page size ceiling on list endpoint. |
| Performance | 6/10 | Major improvement: storefront `searchStorefrontProducts` properly parallelizes. But `getProductDetails`, `getProductStats`, `getCategoryStats`, and `getStorefrontProducts` count query still sequential. |
| Robustness | 7/10 | Bulk delete now cleans up all related tables (C2 fix). Slug uniqueness has DB index backup. `deleteProduct`/`restoreProduct` still silently succeed on missing IDs. No page size limit. |
| LLM-Friendliness | 7/10 | Clear file naming, JSDoc on public functions, consistent module pattern. Long inline type annotations in storefront service and the HTML comment encoding pattern reduce clarity. |
