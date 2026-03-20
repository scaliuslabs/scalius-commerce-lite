# Products Domain Audit

## Summary

The Products domain is the largest and most feature-rich domain in the codebase, spanning 7 core service files, 2 API route files, 50+ admin UI components, and storefront pages with a vanilla JS product controller. The code is generally well-structured with good separation of concerns, consistent use of conventions, and thorough validation. However, there are several data bugs (missing fields in `getProductDetails`), performance issues (sequential queries in sort order updates, un-batched detail queries), and meaningful type safety gaps (dynamic imports, `as any` casts, `z.any()` in OpenAPI schemas).

## Critical Issues

### C1. `getProductDetails` omits `discountType` and `discountAmount` columns

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 266-288

The explicit `.select()` in `getProductDetails` includes `discountPercentage` but omits `discountType` and `discountAmount`. The admin edit page loader (`apps/admin/src/loaders/admin/products.ts` line 76) falls back to `"percentage"` and `0` respectively, masking the bug. But any product with a `flat` discount type will have its discount type silently reset to `"percentage"` when loaded for editing, and its `discountAmount` zeroed out.

```typescript
// Missing from the .select() at line 266:
discountType: products.discountType,     // MISSING
discountAmount: products.discountAmount, // MISSING
```

The `ProductWithDetails` type (`products.types.ts` line 78) extends `Product` which includes both fields, so TypeScript does not catch this because the return is cast `as ProductWithDetails`.

**Impact:** Product-level flat discounts silently revert to percentage discounts when admin views/edits the product. Data corruption on save.

**Fix:** Add `discountType: products.discountType` and `discountAmount: products.discountAmount` to the `.select()` call in `getProductDetails`.

### C2. `bulkDeleteProducts` (permanent) does not clean up `productAttributeValues` or `productRichContent`

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 692-696

When permanently deleting products in bulk, the batch deletes `productVariants`, `productImages`, and `products` -- but skips `productAttributeValues` and `productRichContent`. Compare with the single-product `permanentlyDeleteProduct` (lines 656-664) which correctly deletes all five tables.

```typescript
// bulkDeleteProducts permanent path (line 692-696):
await db.batch([
    db.delete(productVariants).where(inArray(productVariants.productId, productIds)),
    db.delete(productImages).where(inArray(productImages.productId, productIds)),
    db.delete(products).where(inArray(products.id, productIds)),
    // MISSING: productAttributeValues
    // MISSING: productRichContent
]);
```

**Impact:** Orphaned `productAttributeValues` and `productRichContent` rows accumulate in the database after bulk permanent deletes. The cascade foreign key on `products.id` should handle this at the DB level (both tables have `onDelete: "cascade"`), so this is not data corruption, but the explicit delete is inconsistent with `permanentlyDeleteProduct` and the cascade relies on D1 honoring FK constraints which requires `PRAGMA foreign_keys = ON`.

**Fix:** Add `db.delete(productAttributeValues).where(inArray(...))` and `db.delete(productRichContent).where(inArray(...))` to the batch.

### C3. Storefront fake variant for variantless products uses hardcoded `stock: 100`

**Files:** `packages/core/src/modules/products/products.storefront.ts` lines 392-405

When a product has no variants, `getStorefrontProductBySlug` fabricates a fake "default" variant with `stock: 100`. This means a product without variants always appears as having 100 units in stock on the storefront, regardless of reality. The storefront cart validation uses this stock value.

```typescript
: [{
    id: "default",
    ...
    stock: 100,  // Hardcoded, not reflecting actual availability
    ...
}];
```

**Impact:** Customers can add up to 100 of a variantless product to their cart even if the merchant intended it to be out of stock or limited. There is no way for a merchant to control stock for variantless products through the storefront.

## Code Quality Issues

### Q1. Triple-defined `ProductListItem` type

**Files:**
- `packages/core/src/modules/products/products.types.ts` lines 86-104
- `apps/admin/src/types/api-responses.ts` lines 184-202
- `apps/admin/src/components/admin/product-list/hooks/useProductList.ts` lines 8-27

The `ProductListItem` interface is defined in three places with slight differences:
- Core types: `discountPercentage: number | null` only (missing `discountType` and `discountAmount`)
- Admin api-responses: includes `discountType`, `discountAmount`, and uses `Date | string | number` for timestamps
- useProductList hook: includes `discountType`, `discountAmount`, uses `Date` for timestamps

The core type is stale -- it does not include `discountType` or `discountAmount` even though the `listProducts` function returns them.

### Q2. `as any` casts for Drizzle D1 batch typing

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 504, 607, 664, 733

Four occurrences of `as any` to work around Drizzle D1 batch typing limitations. All are documented with eslint-disable comments. This is a known framework limitation, not a code quality issue per se, but reduces type safety at write-operation boundaries.

### Q3. `z.any()` in storefront OpenAPI route schemas

**Files:** `apps/api/src/routes/products.ts` lines 121, 152-156

The storefront product routes use `z.any()` for variant arrays, product objects, category, images, and related products in their OpenAPI response schemas. This defeats the purpose of typed OpenAPI documentation.

```typescript
// Line 152-156:
product: z.any(),
category: z.any().nullable(),
images: z.array(z.any()),
variants: z.array(z.any()),
relatedProducts: z.array(z.any()),
```

### Q4. Dynamic imports inside `searchStorefrontProducts`

**Files:** `packages/core/src/modules/products/products.storefront.ts` lines 451-452

The function dynamically imports `ftsMatch` and drizzle-orm operators that are already imported at the top of the file (line 15 and line 14). This is dead code from a refactor -- the static imports at the top of the file are sufficient.

```typescript
// Line 451-452 -- unnecessary dynamic imports:
const { ftsMatch } = await import("../../search/fts5");
const { eq, and, isNull, desc, inArray, sql } = await import("drizzle-orm");
```

### Q5. Excessive inline type annotations in storefront service

**Files:** `packages/core/src/modules/products/products.storefront.ts` lines 180, 273, 298, 380-383

The storefront service has very long inline type annotations on `.map()` callbacks and intermediate variables, making lines exceed 200+ characters. These types should be extracted into named interfaces or inferred.

### Q6. Unused `z` import in `products.variants.ts`

**Files:** `packages/core/src/modules/products/products.variants.ts` line 11

`z` is imported from Zod but never used directly in this file. The Zod schemas are imported from `products.types.ts` and used via `z.infer<typeof ...>` in function signatures.

## Pattern Violations

### P1. Error handling inconsistency in API route layer

**Files:** `apps/api/src/routes/admin/products.ts`

The route layer wraps core service calls in try/catch and re-throws as API errors based on string matching on error messages:

```typescript
// Line 179: String matching on error message
if (error instanceof Error && error.message?.includes("slug")) {
    throw new ValidationError(error.message);
}
```

But the core services already throw typed errors (`ConflictError`, `NotFoundError`, `ValidationError` from `@scalius/core/errors`). The route layer then catches these typed errors and re-throws them as _different_ typed errors from `apps/api/src/utils/api-error.ts`. This double-conversion is fragile and unnecessary -- the global error handler should map core errors to HTTP responses directly.

The inconsistency: `createProduct` and `updateProduct` do message-string matching, while `deleteVariant`, `duplicateVariant`, etc. check `error.message === "Variant not found"` exactly.

### P2. `getProductStats` and `getCategoryStats` use 4-5 sequential queries instead of batch

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 344-413

These functions run 4-5 independent count queries sequentially (each `await`ed individually). They should use `db.batch()` like `listProducts` does.

### P3. Admin proxy convention not consistently used

**Files:** `apps/admin/src/components/admin/product-form/hooks/useProductSubmit.ts` line 38

The submit hook constructs API URLs as `/api/v1/admin/products/${values.id}`. Per CLAUDE.md, the admin communicates with the API via service binding (`env.API`). In dev mode, Vite proxies these requests. The pattern is correct but the URL construction is duplicated across multiple hooks (`useProductSubmit`, `useProductVariants`, `useVariantOperations`, `useProductList`). There is no shared constant or utility for product API paths.

## Maintainability Concerns

### M1. Variant images encoded in `metaDescription` via HTML comments

**Files:**
- `apps/admin/src/components/admin/product-form/utils.ts` lines 26-58
- `apps/storefront/src/pages/products/[slug].astro` lines 26-32

The "variant images enabled" feature flag is stored as an HTML comment `<!--variant_images:enabled-->` inside the product's `metaDescription` field. This is a hack that:
- Pollutes SEO metadata with non-SEO data
- Requires parsing/cleaning on every read
- Is invisible and confusing to anyone reading the database directly
- Could break if meta description is truncated or sanitized

This should be a proper boolean column on the `products` table.

### M2. VariantManager uses `window.dispatchEvent(new CustomEvent("variantChanged"))` for cross-component communication

**Files:** `apps/admin/src/components/admin/product-form/variants/VariantManager.tsx` lines 133, 141, 198, 224, 247, 258, 269, 278, 303

The VariantManager dispatches a custom DOM event `variantChanged` as a fallback when no `onVariantChange` callback is provided. The ProductForm listens for this event to refresh variant color options. This is fragile because:
- No typed payload
- Global event that could collide
- No cleanup guarantee
- The pattern is used 9 times in one file

### M3. Large hook file (`useProductList.ts` at 629 lines)

**Files:** `apps/admin/src/components/admin/product-list/hooks/useProductList.ts`

This single hook manages all product list state, pagination, sorting, search debouncing, selection, URL sync, bulk operations, and formatting. It returns 30+ values. Consider splitting into focused hooks (`useProductSearch`, `useProductSelection`, `useProductPagination`).

### M4. `additionalInfo.sortOrder` not in the admin form schema

**Files:** `apps/admin/src/components/admin/product-form/types.ts` lines 62-68

The `additionalInfo` array in the form schema does not include a `sortOrder` field, but the `formatFormValuesForSubmission` utility (`utils.ts` line 94) injects `sortOrder: index`. The core validation schema (`products.validation.ts` line 33) requires `sortOrder: z.number()`. This works because the formatter adds it, but the form schema and API schema are misaligned.

## Performance & Scalability

### S1. `getProductDetails` runs 4 sequential queries instead of batching

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 292-316

After fetching the product, four additional queries run sequentially:
1. variants
2. images
3. richContent
4. attributeValues

These are independent and could be batched with `db.batch()` or `Promise.all()`. The storefront equivalent (`getStorefrontProductBySlug`) correctly uses `Promise.all()`.

### S2. `updateVariantSortOrder` runs N+M sequential queries

**Files:** `packages/core/src/modules/products/products.variants.ts` lines 362-396

For each unique color value and each unique size value, a separate `UPDATE` query is executed sequentially. With 10 colors and 10 sizes, this is 20 individual queries. Should use `db.batch()`.

### S3. `duplicateVariant` has unbounded SKU uniqueness loop

**Files:** `packages/core/src/modules/products/products.variants.ts` lines 228-239

The SKU deduplication loop runs a separate DB query per iteration. With many duplicates (e.g., someone duplicating the same variant repeatedly), this could result in N queries. Consider generating a unique suffix upfront (e.g., appending a nanoid).

### S4. Storefront product list count query runs separately from main query

**Files:** `packages/core/src/modules/products/products.storefront.ts` lines 194-220

The count query for pagination is run after the main product query completes, rather than in parallel or batched. This adds an extra DB round-trip per page load.

### S5. `getProductStats` and `getCategoryStats` run 4-5 individual count queries

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 344-413

Each stat (total products, active products, products with images, categories count) is a separate sequential query. These could be combined into a single query using conditional aggregation or at minimum batched.

## Robustness Gaps

### R1. Slug uniqueness check is not atomic with insert in `createProduct`

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 425-506

The slug uniqueness check (line 425-433) and the insert (line 504) are not in the same transaction. Under concurrent requests, two products with the same slug could pass the check simultaneously. The unique index on `products.slug` provides a DB-level guard, but the error would be an unhandled constraint violation rather than the friendly `ConflictError`.

### R2. `deleteProduct` does not verify product exists before soft-deleting

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 613-618

The soft-delete function does not check if the product exists. If called with a non-existent ID, it silently succeeds (updates 0 rows). The API route does not check the result either. Compare with `restoreProduct` which has the same issue.

### R3. `bulkUpdateVariants` does not verify variant ownership

**Files:** `packages/core/src/modules/products/products.admin.ts` lines 708-735

The function uses `eq(productVariants.productId, productId)` in the WHERE clause (line 724), which correctly scopes updates to the given product. However, there is no pre-check that the variant IDs actually belong to the product. If a variant ID from another product is provided, the update silently does nothing. This is not a security issue (the WHERE prevents cross-product modification) but could mask bugs.

### R4. No upper limit on `listProducts` page size

**Files:** `packages/core/src/modules/products/products.admin.ts` line 46

The `limit` parameter defaults to 10 but has no maximum. A client could request `limit=10000` and retrieve the entire product catalog in one query. The API route (`apps/api/src/routes/admin/products.ts` line 121) also does not enforce a max.

### R5. Storefront search FTS type casting

**Files:** `packages/core/src/modules/products/products.storefront.ts` lines 454-459

In `searchStorefrontProducts`, conditions are typed as `Array<ReturnType<typeof eq>>` but `isNull()` returns a different type that is cast unsafely. The FTS match condition is also cast with `as ReturnType<typeof eq>`. This compiles but loses type information.

## LLM-Friendliness

**Overall: Good (7/10)**

Strengths:
- Clear file naming convention (`products.admin.ts`, `products.storefront.ts`, `products.variants.ts`, `products.validation.ts`, `products.types.ts`)
- Well-documented JSDoc on all public functions
- Consistent pattern: validation schemas in `.validation.ts`, types in `.types.ts`, admin ops in `.admin.ts`, storefront ops in `.storefront.ts`
- Barrel export via `index.ts`
- Admin UI follows clear directory structure (`product-form/`, `product-list/`, `variants/`)

Weaknesses:
- The inline type annotations in `products.storefront.ts` are extremely long and hard to parse
- The relationship between `products.types.ts` (core), `apps/admin/src/types/api-responses.ts`, and `apps/admin/src/components/admin/product-form/variants/types.ts` is confusing -- three different `ProductVariant` types exist
- The variant images HTML comment encoding in metaDescription is non-obvious
- The error handling pattern (core throws typed error -> route catches and re-throws different typed error) requires reading both files to understand

## Recommended Changes

### Priority 1 -- Data Bugs (fix immediately)

1. **Add missing `discountType`/`discountAmount` to `getProductDetails`** (C1) -- `packages/core/src/modules/products/products.admin.ts` line 280. Add two fields to the `.select()`.

2. **Add missing table cleanups to `bulkDeleteProducts`** (C2) -- `packages/core/src/modules/products/products.admin.ts` line 692. Add `productAttributeValues` and `productRichContent` deletes.

3. **Address fake variant `stock: 100`** (C3) -- `packages/core/src/modules/products/products.storefront.ts` line 398. Either remove the fake variant pattern or use a configurable value. At minimum, set stock to 0 to prevent overselling.

### Priority 2 -- Performance (batch before scale)

4. **Batch `getProductDetails` sub-queries** (S1) -- Use `db.batch()` or `Promise.all()` for the 4 independent queries.

5. **Batch `getProductStats` and `getCategoryStats`** (S2/P2) -- Combine into single `db.batch()` calls.

6. **Batch `updateVariantSortOrder`** (S2) -- Collect all UPDATE statements and execute via `db.batch()`.

7. **Add `limit` max to admin product list route** (R4) -- Clamp to e.g. 100 in the Zod schema.

### Priority 3 -- Code Quality (clean up for maintainability)

8. **Remove duplicate dynamic imports in `searchStorefrontProducts`** (Q4) -- Delete lines 451-452.

9. **Consolidate `ProductListItem` type to single source** (Q1) -- Keep in `apps/admin/src/types/api-responses.ts`, update core type, remove from hook file.

10. **Replace `z.any()` in storefront route schemas** (Q3) -- Define proper Zod schemas.

11. **Replace variant images HTML comment with proper DB column** (M1) -- Add `variantImagesEnabled` boolean to `products` table.

12. **Split `useProductList` hook** (M3) -- Extract search, selection, and pagination into separate hooks.

### Priority 4 -- Robustness (harden for production)

13. **Add existence check to `deleteProduct` and `restoreProduct`** (R2) -- Return appropriate error.

14. **Simplify error re-throwing in API routes** (P1) -- Let the global error handler map `@scalius/core/errors` classes to HTTP responses directly, or use a lightweight adapter rather than string-matching.

15. **Replace unbounded SKU loop in `duplicateVariant`** (S3) -- Use nanoid suffix instead.
