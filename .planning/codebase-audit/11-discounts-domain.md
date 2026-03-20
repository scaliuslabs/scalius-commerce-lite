# Audit 11 -- Discounts Domain

## 1. Architecture Overview

The discounts domain spans all layers of the monorepo:

| Layer | Files | Responsibility |
|-------|-------|---------------|
| Schema | `packages/database/src/schema/marketing.ts` | 4 tables: `discounts`, `discountProducts`, `discountCollections`, `discountUsage` |
| Enums | `packages/database/src/schema/enums.ts` | `DiscountType` (3 variants), `DiscountValueType` (3 variants) |
| Validation | `packages/core/src/modules/discounts/discounts.validation.ts` | Zod schemas for create/update |
| Service | `packages/core/src/modules/discounts/discounts.service.ts` | CRUD, listing, soft/hard delete, bulk ops |
| Eligibility | `packages/core/src/modules/discounts/discounts.eligibility.ts` | Validation + calculation engine |
| Admin API | `apps/api/src/routes/admin/discounts.ts` | 8 admin endpoints (CRUD, toggle, bulk, restore) |
| Public API | `apps/api/src/routes/discounts.ts` | 1 endpoint: GET `/discounts/validate` |
| Admin UI | `apps/admin/src/components/admin/discount/` | 3 form variants, list with filters, delete dialogs |
| Loaders | `apps/admin/src/loaders/admin/discounts.ts` | SSR data loading |
| Storefront | `apps/storefront/src/lib/api/discounts.ts` | Client-side validation + usage recording |
| Queue | `packages/core/src/modules/orders/orders.queue.ts` | Discount usage insert during order ingest |

### Discount Types

- **amount_off_products** -- Percentage or fixed amount off specific products/collections
- **amount_off_order** -- Percentage or fixed amount off entire order subtotal
- **free_shipping** -- Waives shipping fees entirely

### Value Types

- **percentage** -- e.g., 15% off
- **fixed_amount** -- e.g., $500 off
- **free** -- Used exclusively by free_shipping type (value=100)

### Data Flow

1. Admin creates discount via form -> admin API route -> `createDiscount()` service
2. Customer enters code at checkout -> storefront calls `validateDiscount()` -> public API `/discounts/validate` -> `isDiscountValid()` + `calculateDiscountAmount()`
3. Order placed -> order ingest queue -> `discountUsage` row inserted atomically with order

---

## 2. Eligibility Engine

### Validation Checks (in order)

The `isDiscountValid()` function performs these checks sequentially:

1. **Code lookup** -- Active, non-deleted, within date range (start <= now, end > now OR null)
2. **Min purchase amount** -- Cart total must meet threshold
3. **Min quantity** -- Total item count must meet threshold
4. **Max total uses** -- COUNT of `discountUsage` rows checked against `maxUses`
5. **Per-customer limit** -- JOIN `discountUsage` with `orders` on `customerPhone` to check prior usage
6. **Product applicability** -- For `AMOUNT_OFF_PRODUCTS`, expand linked products + collections and verify cart intersection

### Calculation Engine

`calculateDiscountAmount()` handles three types:

- **FREE_SHIPPING**: Returns the full `shippingCost`
- **AMOUNT_OFF_ORDER**: Applies percentage or fixed amount to `subtotal` (total - shippingCost), capped at subtotal
- **AMOUNT_OFF_PRODUCTS**: Queries applicable product IDs, sums applicable item totals, applies discount. Falls back to full subtotal if no products matched.

### Stacking Rules

The schema has `combineWith*` flags on each discount. The public API route computes a `combinable` object with derived logic:

```
withProductDiscounts: type === FREE_SHIPPING || combineWithProductDiscounts
withOrderDiscounts:   type === AMOUNT_OFF_PRODUCTS || combineWithOrderDiscounts
withShippingDiscounts: type === AMOUNT_OFF_ORDER || type === AMOUNT_OFF_PRODUCTS || combineWithShippingDiscounts
```

**However:** As documented in the schema comment, the system only supports ONE discount code per order currently. The `combineWith*` flags are reserved for future multi-discount support and are NOT enforced at checkout. The stacking logic in the public route is informational only.

---

## 3. Issues

### CRITICAL -- Race Condition in Usage Counting

**File:** `discounts.eligibility.ts:162-183`

The `maxUses` check does a SELECT COUNT then compares -- classic TOCTOU race condition. Two concurrent requests could both see count=99 with maxUses=100 and both pass validation. The queue consumer has a secondary check for per-customer limits (Phase 1b in `orders.queue.ts:246-274`) but NOT for global `maxUses`.

**Impact:** Discounts can be used beyond their `maxUses` limit under concurrent load.

**Fix:** The queue consumer's Phase 1b should also re-check global `maxUses` before writing the batch. Alternatively, use a unique constraint or CAS-style check in the batch insert. Since D1/SQLite is single-writer, the queue approach reduces but does not eliminate the window.

### CRITICAL -- Ghost Endpoint: POST `/discounts/usage`

**File:** `apps/storefront/src/lib/api/discounts.ts:75-114`

The storefront has a `recordDiscountUsage()` function that POSTs to `/discounts/usage`, but this endpoint does NOT exist in the API routes. The `apps/api/src/routes/discounts.ts` only has a GET `/validate` endpoint. Discount usage is actually recorded in the order ingest queue (`orders.queue.ts`), making this function dead code.

**Impact:** If any storefront code calls `recordDiscountUsage()`, it silently fails (the function returns `false`). No data loss because the queue handles it, but the dead code is misleading and could mask bugs if someone relies on it.

**Fix:** Delete `recordDiscountUsage()` from storefront or add the endpoint if double-recording is intended.

### HIGH -- Per-Customer Check Uses Phone, Queue Uses customerId

**File:** `discounts.eligibility.ts:187-225` vs `orders.queue.ts:259-274`

The eligibility engine checks per-customer limits by joining `discountUsage` -> `orders` on `customerPhone`. The queue consumer's Phase 1b re-check uses `discountUsage.customerId` directly. These are different identifiers -- a customer could have multiple phone numbers, or a guest checkout could have no customerId but have a phone.

**Impact:** Per-customer limit enforcement is inconsistent. A customer could bypass the limit if their `customerId` does not match or if they use a different phone number.

**Fix:** Both checks should use the same identifier. Since `discountUsage` has a `customerId` column AND the queue writes it, the eligibility engine should also check `discountUsage.customerId` when available, falling back to phone-based lookup only for guest checkouts.

### HIGH -- Service Uses `Record<string, unknown>` Instead of Typed Input

**Files:** `discounts.service.ts:153`, `discounts.service.ts:213`

Both `createDiscount()` and `updateDiscount()` accept `data: Record<string, unknown>` and cast every field individually:

```ts
code: data.code as string,
type: data.type as typeof discounts.$inferInsert.type,
discountValue: data.discountValue as number,
```

This defeats type safety entirely. The Zod schemas (`CreateDiscountInput`, `UpdateDiscountInput`) exist and are used in the API routes, but the validated output is passed as an untyped record.

**Fix:** Change signatures to accept the validated Zod types:
```ts
export async function createDiscount(db: Database, data: CreateDiscountInput)
export async function updateDiscount(db: Database, id: string, data: UpdateDiscountInput)
```

### MEDIUM -- `customerSegment` Field Is Never Enforced

**Files:** schema `marketing.ts:43`, service `discounts.service.ts:196,269`, validation `discounts.validation.ts:21`

The `customerSegment` column exists in the schema, is accepted in validation, stored in the database, displayed in the discount row tooltip -- but the eligibility engine never checks it. No customer is ever filtered by segment during validation.

**Impact:** An admin could configure a segment-restricted discount thinking it is enforced, but any customer would be able to use it.

**Fix:** Either implement segment checking in `isDiscountValid()` or remove the field to avoid confusion.

### MEDIUM -- Deleted Codes Not Excluded From Uniqueness Check on Create

**File:** `discounts.service.ts:154-158`

The create uniqueness check filters `isNull(discounts.deletedAt)`:

```ts
.where(and(eq(discounts.code, data.code as string), isNull(discounts.deletedAt)))
```

This means a soft-deleted discount's code CAN be reused. When the soft-deleted discount is restored, you now have two active discounts with the same code. The eligibility engine queries by code and picks the first match, so behavior is nondeterministic.

**Fix:** The restore operation should check for code conflicts, or the uniqueness check should include soft-deleted records.

### MEDIUM -- Fallback to Full Subtotal When No Products Match

**File:** `discounts.eligibility.ts:370-372`

```ts
if (applicableProductsTotal === 0 || applicableProductIds.size === 0) {
    applicableProductsTotal = subTotal;
}
```

For `AMOUNT_OFF_PRODUCTS` discounts, if no applicable products were found (or total is 0), it silently applies the discount to the entire subtotal. This means a product-specific discount with no matching products in the cart still gets applied as an order-wide discount.

**Impact:** Over-discounting. A discount meant for specific products applies universally when those products are not in the cart.

**Fix:** Return 0 when `applicableProductsTotal === 0` for product-specific discounts, rather than falling back to the full subtotal. The `isDiscountValid()` check upstream catches this case with an error message, but if a caller uses `calculateDiscountAmount()` independently (e.g., during order processing), it would over-discount.

### MEDIUM -- Inconsistent Timestamp Handling Between Create and Update

**Files:** `discounts.service.ts:197-198` (create) vs `discounts.service.ts:230-236,271` (update)

Create uses `sql`unixepoch(${startDate.toISOString()})`` which passes through SQLite's `unixepoch()` function with a string arg. Update manually calculates `Math.floor(date.getTime() / 1000)` in JS. Both should produce the same result, but the inconsistency makes the code harder to reason about and could introduce subtle timezone issues.

### MEDIUM -- No Authorization Check on Toggle/Restore

**File:** `apps/api/src/routes/admin/discounts.ts:257-265, 282-287`

The toggle-status and restore routes don't verify the discount isn't permanently deleted or that the user has appropriate permissions beyond being an admin. Toggle status calls `getDiscountById()` (good), but restore does not check if the discount was actually soft-deleted first.

### LOW -- Verbose Console Logging in Eligibility Engine

**File:** `discounts.eligibility.ts:171-172, 189, 209-210, 215, 221-224`

Multiple `console.log` calls with customer phone numbers and discount codes in the eligibility engine:

```ts
console.log(`Checking one-use-per-customer for phone: ${customerPhone}`);
console.log(`Found previous usage for ${customerPhone} for discount ${discount.code}`);
```

These leak PII (phone numbers) into Cloudflare Worker logs. In production, these should be removed or use structured logging with PII redaction.

### LOW -- Admin UI Schema Drift From Backend

The admin form schemas (in-component Zod) differ from the backend validation schema (`discounts.validation.ts`). Examples:

- `AmountOffOrderForm` has `code` regex validation (`/^[a-zA-Z0-9_-]+$/`) that the backend schema lacks
- `AmountOffProductsForm` schema requires `code.min(1)`, backend requires `code.min(3)`
- FreeShippingForm schema does not use `z.coerce` for numbers, while AmountOffOrderForm does

These drift risks mean forms could accept values the API rejects (or vice versa).

### LOW -- Collection Name Not Resolved on Edit

**File:** `apps/admin/src/loaders/admin/discounts.ts:48-53`

When loading a discount for editing, collection IDs are mapped to objects with `name: colId` (the ID as the name):

```ts
const selectedCollections = allCollectionIds.map((colId: string) => ({
    id: colId,
    name: colId,  // <-- displays ID instead of collection name
    description: null,
    slug: "",
}));
```

The admin edit form will show collection IDs instead of human-readable names in the selector badges.

### LOW -- Error Swallowing in Eligibility Checks

**File:** `discounts.eligibility.ts:181-183, 218-219`

Usage checks catch errors and continue silently:

```ts
} catch (error: unknown) {
    console.error("Error checking discount usage count:", error);
}
```

If the usage count query fails, the discount passes validation even if it exceeded its limit. This is a fail-open design that could allow over-usage when the database has transient errors.

---

## 4. Admin UI Analysis

### Component Architecture

Three separate form components for three discount types:

| Component | Type | LOC | Architecture |
|-----------|------|-----|-------------|
| `AmountOffOrderForm.tsx` | amount_off_order | ~730 | Monolithic single file |
| `FreeShippingForm.tsx` | free_shipping | ~595 | Monolithic single file |
| `AmountOffProductsContainer.tsx` | amount_off_products | ~237 | Split into 7 sub-components |

The AmountOffProducts form is properly decomposed (DiscountDetailsSection, AppliesToSection, MinimumRequirementsSection, UsageLimitsSection, CombinationsSection, ActiveDatesSection, SummaryCard). The other two forms are monolithic.

### Form Loading Pattern

The `discount-form-loader.ts` uses a vanilla DOM-based lazy loading pattern with `CustomEvent` dispatch. This is the Astro island pattern -- React components are mounted into DOM containers using `createRoot`. It works but is fragile:

- Event listener cleanup on page transitions via `astro:page-load`
- Manual DOM manipulation (`classList.add/remove("hidden")`)
- No props passing to lazily loaded forms (they mount with no defaultValues)

### List Component

`DiscountListContainer.tsx` + `useDiscountListFilters.ts` is well-structured:

- Proper SSR pattern: server loads data, client handles interactions
- URL-based filtering/sorting/pagination (no client-side state drift)
- Optimistic UI updates (local state updates before page reload)
- Good use of `React.memo` on `DiscountRow`
- Proper confirmation dialogs for destructive actions

### UX Observations

- All three forms have live "Discount Summary" cards showing current values
- Random code generation via `generateDiscountCode()` excludes ambiguous chars (good)
- Date pickers properly constrain end date >= start date
- The AmountOffOrderForm correctly disables submit when form is pristine (`!form.formState.isDirty`)
- ProductSelector has pagination ("Load More") for large catalogs
- CollectionSelector uses debounced search

---

## 5. Storefront Integration

### Validation Flow

The storefront's `validateDiscount()` function:

1. Builds query params (code, total, items as JSON, shippingCost, customerPhone)
2. Calls GET `/discounts/validate` via `fetchWithRetry` (2 retries, 8s timeout)
3. Unwraps `{ success, data }` envelope
4. Returns `DiscountValidationResponse` with `valid`, `error`, `discount`, `discountAmount`

The cart items are JSON-stringified into a query parameter, which works but has URL length limitations for large carts.

### Usage Recording

Discount usage is recorded in the order ingest queue, NOT by the storefront calling back. The storefront's `recordDiscountUsage()` function targets a nonexistent endpoint (see issue above).

### Type Alignment

The storefront's `DiscountValidationResponse` type (`apps/storefront/src/lib/api/types.ts`) matches the structure returned by the public API route. The `Discount` sub-type includes `combineWith*` fields. The `combinable` derived object from the API response is NOT reflected in the type definition -- it would be available at runtime but not type-checked.

---

## 6. Schema Assessment

### Table Design

- `discounts` -- Main table with 17 columns. Code indexed. DeletedAt indexed for soft-delete filtering. No unique constraint on `code` (allows duplicate codes for soft-deleted records, but creates restore conflicts).
- `discountProducts` -- Junction table for product-specific discounts. FK indexed. `applicationType` column only allows "get" (remnant of a possible buy-X-get-Y feature that was simplified).
- `discountCollections` -- Junction table for collection-based discounts. FK on `discountId` not indexed (only `collectionId` has an index).
- `discountUsage` -- Tracks each discount redemption. Composite index on `(discountId, customerId)` is good for per-customer limit checks.

### Missing Indexes

- `discountCollections` lacks an index on `discountId`. The `listDiscounts` and eligibility queries filter by `discountId`, so this column should be indexed.

### Schema Observations

- `applicationType` enum is locked to `["get"]` in both junction tables. The buy/get pattern was likely planned for BOGO discounts but never implemented.
- `discountUsage.customerId` is nullable -- guest checkouts have no customer ID, relying on phone-based matching in eligibility.
- The `startDate` column uses `{ mode: "timestamp" }` (Drizzle reads it as a Date), but the service code treats it as a raw unix integer. This inconsistency is managed by manual conversions throughout.

---

## 7. Validation Assessment

### Backend Schema (`discounts.validation.ts`)

The Zod schema is comprehensive:

- `code`: 3-50 chars, string
- `discountValue`: positive number
- `startDate`: accepts Date, string, or number (auto-converts to Date with epoch heuristic for seconds vs milliseconds)
- `.refine()` ensures percentage <= 100
- `appliesToProducts/appliesToCollections`: optional string arrays

The epoch heuristic (`val < 10000000000 ? val * 1000 : val`) is pragmatic but arbitrary -- it would break for dates before 1970 or after ~2286.

### Frontend Schemas

Each form has its own Zod schema. They are close but not identical to the backend schema:

- `AmountOffOrderForm`: adds regex for code format, uses `z.coerce` for numbers
- `AmountOffProductsForm` (`types.ts`): `code.min(1)` vs backend's `code.min(3)`, has `appliesTo` compound validation
- `FreeShippingForm`: no `z.coerce`, plain `z.number()` fields

There is no shared schema between frontend and backend.

---

## 8. LLM-Friendliness

### Strengths

- Clear file naming: `discounts.service.ts`, `discounts.eligibility.ts`, `discounts.validation.ts`
- Comment at top of eligibility: "Discount validation and calculation logic -- pure business rules"
- Enum constants (`DiscountType`, `DiscountValueType`) are readable string literals
- The `expandCollectionsToProductIds()` helper is well-named and self-contained
- Summary card components make discount configuration visible at a glance

### Weaknesses

- `Record<string, unknown>` in service functions obscures the actual data shape
- The eligibility engine mixes validation and calculation in one file but at least separates them with clear section headers
- `applicationType` always being "get" with no "buy" counterpart is confusing without context
- The `combinable` derivation in the public route has implicit type-based logic that is hard to follow
- Multiple date formats flowing through the system (Date objects, ISO strings, unix timestamps) make data flow hard to trace

---

## 9. Recommendations

### Priority 1 (Fix Now)

1. **Remove or gate the subtotal fallback** in `calculateDiscountAmount()` for `AMOUNT_OFF_PRODUCTS` -- return 0 when no applicable products match instead of applying to full subtotal
2. **Delete `recordDiscountUsage()`** from `apps/storefront/src/lib/api/discounts.ts` -- it calls a nonexistent endpoint
3. **Add global `maxUses` re-check** in the queue consumer's Phase 1b, alongside the existing per-customer check

### Priority 2 (Fix Soon)

4. **Type the service functions** -- accept `CreateDiscountInput` / `UpdateDiscountInput` instead of `Record<string, unknown>`
5. **Unify per-customer identity** -- use `customerId` in eligibility when available, phone as fallback for guests only
6. **Add code conflict check on restore** -- when restoring a soft-deleted discount, verify no active discount has the same code
7. **Remove PII from logs** -- strip phone numbers from eligibility console.log statements
8. **Add `discountCollections_discount_id_idx`** index to `discountCollections` table

### Priority 3 (Improve Later)

9. **Implement `customerSegment` enforcement** or remove the field entirely
10. **Extract shared Zod schema** between frontend forms and backend validation to prevent drift
11. **Refactor AmountOffOrderForm and FreeShippingForm** into the same decomposed pattern as AmountOffProducts
12. **Resolve collection names on edit** -- fetch collection details instead of using IDs as display names
13. **Change fail-open error handling** to fail-closed in eligibility usage checks (reject discount if usage query fails)
14. **Consider moving cart items from query param to POST body** for the validate endpoint to avoid URL length limits

---

## 10. Files Reviewed

```
packages/database/src/schema/marketing.ts
packages/database/src/schema/enums.ts
packages/core/src/modules/discounts/discounts.service.ts
packages/core/src/modules/discounts/discounts.eligibility.ts
packages/core/src/modules/discounts/discounts.validation.ts
packages/core/src/modules/discounts/index.ts
packages/core/src/modules/orders/orders.queue.ts (discount usage sections)
packages/core/src/modules/orders/orders.storefront.ts (discount usage sections)
apps/api/src/routes/admin/discounts.ts
apps/api/src/routes/discounts.ts
apps/admin/src/components/admin/discount/AmountOffOrderForm.tsx
apps/admin/src/components/admin/discount/FreeShippingForm.tsx
apps/admin/src/components/admin/discount/DiscountTypeSelector.tsx
apps/admin/src/components/admin/discount/CollectionSelector.tsx
apps/admin/src/components/admin/discount/ProductSelector.tsx
apps/admin/src/components/admin/discount/utils.ts
apps/admin/src/components/admin/discount/amount-off-products/AmountOffProductsContainer.tsx
apps/admin/src/components/admin/discount/amount-off-products/types.ts
apps/admin/src/components/admin/discount/amount-off-products/index.ts
apps/admin/src/components/admin/discount/amount-off-products/DiscountDetailsSection.tsx
apps/admin/src/components/admin/discount/amount-off-products/AppliesToSection.tsx
apps/admin/src/components/admin/discount/amount-off-products/MinimumRequirementsSection.tsx
apps/admin/src/components/admin/discount/amount-off-products/UsageLimitsSection.tsx
apps/admin/src/components/admin/discount/amount-off-products/CombinationsSection.tsx
apps/admin/src/components/admin/discount/amount-off-products/ActiveDatesSection.tsx
apps/admin/src/components/admin/discount/amount-off-products/SummaryCard.tsx
apps/admin/src/components/admin/discount/discount-list/DiscountListContainer.tsx
apps/admin/src/components/admin/discount/discount-list/DiscountRow.tsx
apps/admin/src/components/admin/discount/discount-list/DiscountStatusBadge.tsx
apps/admin/src/components/admin/discount/discount-list/DiscountDeleteDialogs.tsx
apps/admin/src/components/admin/discount/discount-list/hooks/useDiscountListFilters.ts
apps/admin/src/components/admin/discount/discount-list/index.ts
apps/admin/src/loaders/admin/discounts.ts
apps/admin/src/lib/client/discount-form-loader.ts
apps/storefront/src/lib/api/discounts.ts
apps/storefront/src/lib/api/types.ts
```
