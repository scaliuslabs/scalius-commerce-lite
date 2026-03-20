# Products Domain Audit

**Date:** 2026-03-20
**Scope:** Products module end-to-end -- core service, API routes, admin components, storefront display
**Files reviewed:** 40+

---

## Summary

The Products domain is the largest and most feature-rich in the codebase. It spans 6 core service files, 2 API route files, 20+ admin components (form, list, variants), 10+ storefront components, loaders, and a storefront API client. The architecture follows the project's layered conventions well: DB schema -> core service -> API route -> UI. Variant handling is comprehensive with bulk CRUD, sort ordering, barcode lookup, CSV import/export, and a full pricing engine on the storefront side.

The domain is generally solid but has several issues worth addressing: duplicate error-mapping logic at the API layer, a phantom default variant injected for variantless products on the storefront, a discount filter that ignores flat-amount discounts, sequential queries where batch would work, and two parallel discount calculation implementations (shared utility vs storefront pricing engine).

---

## Strengths

1. **Clean layer separation.** Core services are pure DB functions accepting `db` as first param. API routes are thin HTTP handlers that delegate immediately. Admin components consume the API via fetch. Storefront consumes via service binding. No layer violations detected.

2. **Atomic write operations.** `createProduct`, `updateProduct`, `permanentlyDeleteProduct`, and `bulkDeleteProducts` all use `db.batch()` for multi-table writes. This prevents partial-write states on D1.

3. **Comprehensive variant management.** Single CRUD, bulk create/update/delete, duplicate, barcode lookup, color/size sort ordering, CSV import/export, SKU templates, and a bulk generator. The variant module is well-decomposed into `products.variants.ts` (core) and a deep admin component tree under `variants/`.

4. **Storefront pricing engine.** `apps/storefront/src/components/product/lib/pricing-engine.ts` is a clean, well-documented module with clear priority rules (variant discount > product discount > base price). It handles edge cases (null values, zero prices, negative results).

5. **FTS5 search integration.** Both admin (`sanitizeFtsQuery` with raw SQL) and storefront (`ftsMatch` helper) properly use SQLite FTS5 for product search. Admin also supports barcode search as a fallback when the query looks numeric.

6. **Optimistic UI in VariantManager.** Deletes and bulk operations update local state immediately, then rollback on API failure. Good UX pattern.

7. **Edge caching on storefront.** Product list and detail reads are wrapped in `withEdgeCache` with appropriate TTLs (LONG for single product, MEDIUM for paginated lists).

8. **Storefront config system.** `config.ts` externalizes all UI constants (spacings, colors, breakpoints) into a single config object. This makes theme adjustments easy without touching component markup.

9. **Validation schema reuse.** `products.validation.ts` defines `createProductSchema` and `updateProductSchema` once. Both the API route and the admin form reference compatible Zod schemas, keeping validation consistent.

10. **Proper soft-delete model.** Products have `deletedAt` for soft delete, with separate restore and permanent-delete flows. Permanent delete checks order and discount references before proceeding.

---

## Issues

### Critical

**None identified.** No data-loss, security, or crash-level bugs found in the products domain.

### Major

#### M1. Storefront `hasDiscount` filter ignores flat-amount discounts

**File:** `packages/core/src/modules/products/products.storefront.ts`, line 73-74

```typescript
if (hasDiscount === "true") conditions.push(sql`${products.discountPercentage} > 0`);
else if (hasDiscount === "false") conditions.push(sql`${products.discountPercentage} = 0 OR ${products.discountPercentage} IS NULL`);
```

This only checks `discountPercentage`. Products with `discountType = "flat"` and a nonzero `discountAmount` but zero `discountPercentage` will be excluded from "has discount" results.

**Fix:** Check both discount types:
```sql
(discount_percentage > 0 OR (discount_type = 'flat' AND discount_amount > 0))
```

#### M2. Storefront `price-asc`/`price-desc` sort only considers percentage discounts

**File:** `packages/core/src/modules/products/products.storefront.ts`, lines 82-84

```typescript
orderBy = sql`CASE WHEN ${products.discountPercentage} > 0 THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100)) ELSE ${products.price} END`;
```

When `discountType = "flat"`, the sort expression ignores the flat discount entirely. A product priced at 1000 with a 500 flat discount will sort at 1000 instead of 500.

**Fix:** Extend the CASE to handle both discount types, mirroring `calculateDiscountedPrice` logic.

#### M3. Phantom default variant for variantless products

**File:** `packages/core/src/modules/products/products.storefront.ts`, lines 382-395

When a product has no variants, the storefront service fabricates a synthetic variant with hardcoded `stock: 100` and `sku: "SKU-{productId}"`. This phantom variant:
- Reports `stock: 100` regardless of actual availability, potentially allowing orders for products that have no real inventory.
- Creates a fake SKU that does not exist in the database.
- Would confuse any downstream inventory check that validates variant IDs.

**Fix:** Either require at least one variant per product (enforce at creation), or return an empty variants array and let the storefront UI handle the "no variants" case explicitly.

#### M4. Duplicate error mapping in API routes -- core errors re-caught and re-thrown

**File:** `apps/api/src/routes/admin/products.ts`, lines 128-133, 155-162, 209-218, 283-291

The core service already throws typed errors (`ConflictError`, `NotFoundError`, `ValidationError` from `@scalius/core/errors`). But the API route catches generic `Error` instances and re-throws API-layer error classes by matching on `error.message` string content:

```typescript
if (error instanceof Error && error.message?.includes("slug")) {
    throw new ValidationError(error.message);
}
```

This is fragile -- if the core error message changes wording, the mapping breaks silently. The pattern also exists for "SKU", "delete", and "Product not found" strings.

**Fix:** Either (a) use the core error classes directly in the API error handler middleware (map `core.NotFoundError` -> `api.NotFoundError` centrally), or (b) have the routes check `error instanceof CoreNotFoundError` instead of matching on message strings.

#### M5. `getProductDetails` runs 4 sequential queries instead of batching

**File:** `packages/core/src/modules/products/products.admin.ts`, lines 292-316

After fetching the base product, the function runs 4 separate queries (variants, images, richContent, attributeValues) sequentially. These have no dependency on each other and could be batched:

```typescript
const [variants, images, richContent, attributeValues] = await db.batch([...]);
```

This would reduce D1 round-trips from 5 to 2.

#### M6. `getProductStats` runs 4 sequential queries instead of batching

**File:** `packages/core/src/modules/products/products.admin.ts`, lines 344-383

Four independent count queries run sequentially. Should use `db.batch()`.

#### M7. `updateVariantSortOrder` runs N+M sequential queries

**File:** `packages/core/src/modules/products/products.variants.ts`, lines 362-396

Each color and size sort order update runs as a separate query in a `for...of` loop. With 10 colors and 10 sizes, this is 20 sequential D1 calls. Should batch all updates into a single `db.batch()` call.

### Minor

#### m1. `searchStorefrontProducts` has redundant dynamic imports

**File:** `packages/core/src/modules/products/products.storefront.ts`, lines 441-442

```typescript
const { ftsMatch } = await import("../../search/fts5");
const { eq, and, isNull, desc, inArray, sql } = await import("drizzle-orm");
```

Both `ftsMatch` and the drizzle-orm operators are already imported at the top of the file (lines 15-16). These dynamic imports are dead weight -- they re-import what is already in scope.

#### m2. `ProductListItem` type in `products.types.ts` is not used by the service

**File:** `packages/core/src/modules/products/products.types.ts`, lines 86-104

The `ProductListItem` interface defines `createdAt`/`updatedAt` as `Date`, but `listProducts` returns them as `Date` objects constructed inline. The return type of `listProducts` is inferred, not typed against `ProductListItem`. This means the interface exists but does not actually constrain the service function.

#### m3. `additionalInfo` schema in form lacks `sortOrder`

**File:** `apps/admin/src/components/admin/product-form/types.ts`, line 63-67

The form schema for `additionalInfo` items has `id`, `title`, `content` but no `sortOrder`. However, `formatFormValuesForSubmission` in `utils.ts` (line 94-97) adds `sortOrder` based on array index before submission. The API validation schema in `products.validation.ts` (line 29-34) expects `sortOrder`. This works in practice because the util injects it, but the form schema is incomplete relative to the API contract.

#### m4. `bulkDeleteProducts` does not clean up `productAttributeValues` or `productRichContent`

**File:** `packages/core/src/modules/products/products.admin.ts`, lines 692-695

When permanently bulk-deleting, the batch only deletes `productVariants`, `productImages`, and `products`. It misses `productAttributeValues` and `productRichContent`. These have CASCADE foreign keys so SQLite will handle them, but it is inconsistent with `permanentlyDeleteProduct` (line 657-661) which explicitly deletes all 5 tables.

#### m5. `Category` type duplicated in two files

The `Category` interface (`{ id: string; name: string }`) is defined in both:
- `apps/admin/src/components/admin/product-form/types.ts` (line 4-7)
- `apps/admin/src/components/admin/product-form/OrganizationCard.tsx` (line 34-37)

These are identical but independent declarations.

#### m6. Admin `product-actions.ts` is partly redundant with `useProductSubmit`

**File:** `apps/admin/src/lib/client/product-actions.ts`

The `initProductNewPage` function sets up `window.handleProductSubmit` for creating products. But `useProductSubmit.ts` already handles product creation via the same endpoint. The `product-actions.ts` file appears to be a legacy artifact from before the React form was in place.

#### m7. `discountType` defaults inconsistent

In `products.admin.ts` (line 449, 570): `discountType: data.discountType || "percentage"`
In `products.variants.ts` (line 146, 189): `discountType: data.discountType || "percentage"`
DB schema default (line 30): `.default("percentage")`

These all default to "percentage", which is correct, but the `|| "percentage"` guards are only needed because the Zod schema marks `discountType` as `.optional()`. If the schema defaulted it, the service code could be simpler.

#### m8. Storefront `getStorefrontProductBySlug` returns `product.freeDelivery || false`

**File:** `packages/core/src/modules/products/products.storefront.ts`, line 407

`freeDelivery` is `NOT NULL DEFAULT false` in the schema, so it can never be null. The `|| false` is redundant.

---

## Pattern Analysis

### Layer Separation

```
DB Schema (packages/database/src/schema/products.ts)
    |
Core Services (packages/core/src/modules/products/*.ts)
    |
API Routes (apps/api/src/routes/admin/products.ts, apps/api/src/routes/products.ts)
    |
    +-- Admin (apps/admin/) -- loaders -> components -> hooks -> fetch to API
    +-- Storefront (apps/storefront/) -- API client -> Astro components -> client scripts
```

The separation is clean. No layer skip detected (e.g., admin components never import core services directly).

### Validation Consistency

| Layer | Schema Source | Consistent? |
|-------|-------------|-------------|
| API (admin products) | `createProductSchema` / `updateProductSchema` from `products.validation.ts` | Yes |
| Admin form | `productFormSchema` in `types.ts` | Mostly -- same fields/rules, but minor differences (form has `slugEdited`, `id` is optional vs required in update) |
| API (storefront) | `productFilterSchema` inline in route | Yes -- matches `StorefrontProductFilterInput` type |
| Variant create | `createVariantSchema` from `products.types.ts` | Yes -- shared between route and service |

The admin form schema (`productFormSchema`) and the API schema (`createProductSchema`) are manually synchronized rather than being the same object. They match in practice but could drift.

### Type Flow

```
DB Schema types (InferSelectModel<typeof products>)
    -> Product, ProductVariant, ProductImage, etc.
    -> Used in ProductWithDetails, ProductListItem
    -> API routes return these via ok(c, data)
    -> Envelope: { success: true, data: T }
    -> Admin proxy unwraps to { success: true, ...T }
    -> Admin components use local types + @scalius/api-client types
    -> Storefront uses own types from @/lib/api/types
```

There is no single source of truth for the "product" type across admin and storefront. The admin uses types from `@/types/api-responses`, and the storefront defines its own `Product` type in `@/lib/api/types`. Both should ideally derive from the API client SDK, but the SDK is stale (known backlog item).

### Query Patterns

| Function | Approach | N+1 risk? |
|----------|----------|-----------|
| `listProducts` | batch(count + products), then batch(variants, images, primaryImages, skus) | No -- 2 batch calls |
| `getProductDetails` | 1 query + 4 sequential | Could batch |
| `getStorefrontProducts` | 1 main query + 2 follow-up (images, categories) + 1 count | Acceptable -- follow-ups use IN clause |
| `getStorefrontProductBySlug` | 1 query + Promise.all(images, variants, richContent, attributes, category, relatedProducts) | Good -- parallel execution |
| `searchStorefrontProducts` | Promise.all(results, count) + Promise.all(images, variants) | Good |

### Variant Handling

The variant system is robust:
- **Core:** CRUD + bulk CRUD + barcode lookup + sort order management
- **Admin UI:** Full variant manager with inline editing, bulk edit mode, CSV import/export, bulk generator with SKU templates, sort modal, stats display
- **Storefront:** Variants serialized as JSON into the page, client-side state machine manages selection, pricing engine calculates per-variant prices

One concern: the variant form schema in the admin (`variantFormSchema` in `variants/types.ts`) has `sku: z.string().min(1)` while the core schema (`createVariantSchema` in `products.types.ts`) has `sku: z.string().min(3)`. The admin form allows shorter SKUs than the API will accept.

### Admin vs Storefront Separation

Properly separated:
- **Admin service** (`products.admin.ts`): includes `deletedAt` products, category stats, write operations
- **Storefront service** (`products.storefront.ts`): only active+non-deleted products, includes `discountedPrice` calculation, related products, feature extraction
- **No shared query code** between admin and storefront services -- each has its own queries tailored to its needs

### Error Handling

| Layer | Pattern |
|-------|---------|
| Core services | Throw `NotFoundError`, `ConflictError`, `ValidationError` from `@scalius/core/errors` |
| API routes | Catch + re-throw as API error classes (fragile string matching) |
| Admin UI | `useProductSubmit` checks `response.ok`, maps `data.error` string to form errors or toast |
| Storefront | Returns `null` for not-found, throws for server errors |

The weakest link is the API route error mapping (see M4).

### Code Duplication

1. **Discount calculation** exists in three places: `@scalius/shared/price-utils.ts` (used by storefront service), `pricing-engine.ts` (storefront client-side), and inline SQL CASE in storefront sort queries. The SQL CASE (M2) does not match the other two.

2. **Category type** duplicated (m5).

3. **Error string matching** duplicated across 6+ catch blocks in `admin/products.ts` route (M4).

---

## Recommendations

### Priority 1 (bugs/correctness)

1. **Fix `hasDiscount` filter** (M1) to check both `discountPercentage > 0` and `discountType = 'flat' AND discountAmount > 0`.
2. **Fix price sort SQL** (M2) to handle flat discounts, matching `calculateDiscountedPrice` logic.
3. **Remove phantom default variant** (M3). Return empty variants array; let storefront handle it.

### Priority 2 (performance/reliability)

4. **Batch `getProductDetails` queries** (M5) -- 5 queries to 2.
5. **Batch `getProductStats` queries** (M6) -- 4 queries to 1.
6. **Batch `updateVariantSortOrder`** (M7) -- N queries to 1.
7. **Remove redundant dynamic imports** in `searchStorefrontProducts` (m1).

### Priority 3 (maintainability)

8. **Centralize error mapping** (M4). Replace string-based `error.message.includes()` with `instanceof` checks for core error classes at the API middleware level.
9. **Align variant SKU minimum** between admin form (`min(1)`) and core validation (`min(3)`).
10. **Deduplicate Category interface** (m5).
11. **Audit `product-actions.ts`** (m6) for removal if `useProductSubmit` fully replaces it.

---

## LLM-Friendliness Score

**8/10**

### Positive signals
- File naming follows `{domain}.{audience}.ts` pattern (`products.admin.ts`, `products.storefront.ts`) making intent immediately clear
- Functions are well-named with JSDoc comments describing purpose
- Validation schemas are co-located with types in dedicated files
- Barrel exports via `index.ts` files
- Admin components decomposed into small, single-responsibility files (BasicInfoSection, PricingCard, StatusCard, etc.)
- Variant subsystem has its own `types.ts`, `hooks/`, and `utils/` directories

### Areas for improvement
- `products.storefront.ts` functions are long (100-200 lines each) with inline type annotations that reduce readability
- `getStorefrontProductBySlug` uses a Promise.all pattern with `.then(res => ({ type: "string", data: res }))` followed by `results.find(r => r.type === "images")` -- this stringly-typed result-matching pattern is fragile and hard for both humans and LLMs to follow
- The `VariantManager.tsx` at 429 lines is the largest single component; its state management is all local `useState` -- would benefit from a reducer
- Multiple Zod schemas for the "same" concept (product form vs API validation) require manual synchronization
