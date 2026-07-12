# Discounts

Discount code CRUD, eligibility validation, and discount amount calculation. Supports three discount types with product/collection scoping, usage limits, and combination flags.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service, validation, eligibility) |
| `discounts.service.ts` | Standalone functions for admin CRUD: list, get, create, update, delete, bulk operations, restore |
| `discounts.eligibility.ts` | Standalone functions for discount validation (`isDiscountValid`) and amount calculation (`calculateDiscountAmount`) |
| `discounts.validation.ts` | Zod schemas: `createDiscountSchema`, `updateDiscountSchema` with percentage cap refine |

## Discount Types

Three types defined in `@scalius/database/schema`:

| Type | Enum Value | Description |
|------|-----------|-------------|
| Amount Off Products | `amount_off_products` | Discount applied to specific products or collections |
| Amount Off Order | `amount_off_order` | Discount applied to the entire order subtotal |
| Free Shipping | `free_shipping` | Waives shipping cost entirely |

## Value Types

| Value Type | Enum Value | Description |
|------------|-----------|-------------|
| Percentage | `percentage` | Percentage off (capped at 100% via schema validation) |
| Fixed Amount | `fixed_amount` | Fixed currency amount off |
| Free | `free` | Used exclusively by `free_shipping` type |

## Service Functions (`discounts.service.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `listDiscounts` | `(db, { page, limit, search, showTrashed, sort, order, type? })` | Paginated with FTS5 search and optional discount-type filtering. Joins `discountProducts`, `discountCollections`, `discountUsage` to return `relatedProducts`, `relatedCollections`, `usageCount`, `totalDiscountAmount` per discount. Sortable by code/type/value/startDate/endDate/createdAt/updatedAt. |
| `getDiscountById` | `(db, id)` | Single discount with `relatedProducts` and `relatedCollections` (each `{ buy: string[], get: string[] }`). Returns null if not found. |
| `createDiscount` | `(db, data, authority?)` | Defaults inactive. Active create requires verified `discounts.toggle_status` authority. Validates unique code and atomically inserts discount + associations. |
| `updateDiscount` | `(db, id, data, authority?)` | Ordinary edit may preserve status but changing it requires verified `discounts.toggle_status` authority. Atomically updates the discount and associations. |
| `setDiscountActiveStatus` | `(db, id, isActive)` | Dedicated active/inactive command used only by the toggle-permission route. |
| `deleteDiscount` | `(db, id)` | Soft-delete: sets `deletedAt = unixepoch()`. |
| `bulkDeleteDiscounts` | `(db, discountIds, permanent?)` | Soft-delete deactivates; hard-delete is trash-only and blocks any usage history. |
| `restoreDiscounts` | `(db, discountIds)` | Restores trashed discounts as inactive drafts. Codes stay reserved in trash. |
| `permanentlyDeleteDiscount` | `(db, id)` | Trash-only hard-delete blocked when order usage history exists. |

## Eligibility Functions (`discounts.eligibility.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `isDiscountValid` | `(db, code, total?, cartItems?, customerPhone?, currencySymbol?, currencyCode?)` | Validates a discount code against cart context. Returns `{ valid, discount?, applicableProductIds?, error? }`. |
| `calculateDiscountAmount` | `(db, discount, total, cartItems, shippingCost?, precomputedProductIds?)` | Calculates the actual discount amount. Accepts optional `precomputedProductIds` to skip re-querying when called after `isDiscountValid`. |

### Validation Checks (`isDiscountValid`)

Checks performed in order:

1. Code exists, is active, not soft-deleted, within date window
2. Product/collection scope resolves fail-closed when any restriction exists
3. Minimum purchase amount met (merchandise subtotal; eligible lines only for product scope)
4. Minimum quantity met (eligible lines only for product scope)
5. Total usage limit not exceeded (`maxUses` vs `discountUsage` count; advisory before checkout commit)
6. Per-customer limit via immutable `discountCustomerRedemptions` phone claim (advisory before checkout commit)

Returns `applicableProductIds` set for downstream use by `calculateDiscountAmount`.

## Commit-Time Enforcement

Cart and API validation are buyer-friendly prechecks, not the concurrency authority. Final redemption is enforced when checkout inserts `discount_usage` in the synchronous order commit batch:

- `discount_usage_max_uses_guard` aborts the insert with `DISCOUNT_MAX_USES_EXCEEDED` when `maxUses` has already been reached.
- `discount_usage_one_per_customer_guard` aborts with `DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED` when the checkout phone proof already has an immutable redemption claim for that discount.
- `discount_customer_redemptions` stores the immutable per-customer claim as `phone:{checkoutPhone}` at redemption time, so later admin corrections to `orders.customerPhone` do not reopen a one-per-customer coupon.
- `commitStorefrontOrderPayload()` maps those trigger aborts back to normal checkout `ValidationError`s and releases reserved stock before returning the failure.

### Discount Calculation (`calculateDiscountAmount`)

| Type | Percentage | Fixed Amount |
|------|-----------|-------------|
| `free_shipping` | Returns full `shippingCost` | Returns full `shippingCost` |
| `amount_off_order` | `min(subtotal, subtotal * value / 100)` | `min(subtotal, fixedAmount)` |
| `amount_off_products` | Sums applicable product totals, then `min(total, total * value / 100)` | `min(applicableTotal, fixedAmount)` |

For `amount_off_products`, collection expansion resolves collections to product IDs by parsing each collection's `config` JSON (`categoryIds` and `productIds`). If no product/collection restrictions exist, falls back to full subtotal. If restrictions exist but no cart items match, returns 0.

Uses `roundPrice()` from `@scalius/shared/price-utils` for currency precision.

## Validation Schemas (`discounts.validation.ts`)

**`createDiscountSchema`**: Validates all discount fields and defaults `isActive` to false. Date handling accepts valid `Date`, string, or numeric seconds/milliseconds, requires end after start, and rejects invalid dates. Product/collection targets are deduplicated and bounded to 90 total. Type/value semantics must agree, percentage discounts cannot exceed 100%, and unsupported segments/combination behavior is rejected.

**`updateDiscountSchema`**: Same as create with required `id` field. Same percentage cap.

**Exported types:** `CreateDiscountInput`, `UpdateDiscountInput`

## Stacking / Combination Flags

Three legacy boolean columns remain on each discount:
- `combineWithProductDiscounts`
- `combineWithOrderDiscounts`
- `combineWithShippingDiscounts`

Checkout supports one discount code per order, so these flags are forced false and are not exposed as working admin/public controls. `maxUsesPerOrder` is likewise fixed to one. Multi-code support requires a separate allocation and concurrency design.

## Dependencies

- `@scalius/database` -- `discounts`, `discountProducts`, `discountCollections`, `discountUsage`, `discountCustomerRedemptions`, `collections`, `products` tables, `DiscountType`, `DiscountValueType` enums
- `@scalius/core/search` -- `ftsMatch()` for FTS5 search
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice()`
- `nanoid` -- ID generation (`disc_`, `dp_`, `dc_` prefixes)
