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
| `createDiscount` | `(db, data)` | Validates unique code among non-deleted. Uses `db.batch()` to atomically insert discount + product/collection associations. Only creates associations for `amount_off_products` type. ID format: `disc_{nanoid}`. Returns `{ id }`. |
| `updateDiscount` | `(db, id, data)` | Validates existence and unique code (excluding self). Uses `db.batch()` to atomically update discount, delete old associations, insert new ones. Handles date parsing (Date/string/number). Returns `{ id }`. Throws `NotFoundError`. |
| `deleteDiscount` | `(db, id)` | Soft-delete: sets `deletedAt = unixepoch()`. |
| `bulkDeleteDiscounts` | `(db, discountIds, permanent?)` | Soft-delete or hard-delete array of IDs. |
| `restoreDiscounts` | `(db, discountIds)` | Checks for code conflicts before restoring: throws `ConflictError` if an active discount already uses any of the codes being restored. Sets `deletedAt = null`. |
| `permanentlyDeleteDiscount` | `(db, id)` | Hard-delete from DB. |

## Eligibility Functions (`discounts.eligibility.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `isDiscountValid` | `(db, code, total?, cartItems?, customerPhone?, currencySymbol?)` | Validates a discount code against cart context. Returns `{ valid, discount?, applicableProductIds?, error? }`. |
| `calculateDiscountAmount` | `(db, discount, total, cartItems, shippingCost?, precomputedProductIds?)` | Calculates the actual discount amount. Accepts optional `precomputedProductIds` to skip re-querying when called after `isDiscountValid`. |

### Validation Checks (`isDiscountValid`)

Checks performed in order:

1. Code exists, is active, not soft-deleted, within date window
2. Minimum purchase amount met
3. Minimum quantity met (sum of cart item quantities)
4. Total usage limit not exceeded (`maxUses` vs `discountUsage` count; advisory before checkout commit)
5. Per-customer limit (`limitOnePerCustomer` via `discountUsage` joined with `orders.customerPhone`; advisory before checkout commit)
6. Product applicability: for `amount_off_products`, cart must contain at least one product from linked products or collections

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

**`createDiscountSchema`**: Validates all discount fields. Date handling accepts `Date`, `string`, or `number` (auto-detects seconds vs milliseconds). `appliesToProducts` and `appliesToCollections` are optional string arrays. Includes a refine check: percentage discounts cannot exceed 100%.

**`updateDiscountSchema`**: Same as create with required `id` field. Same percentage cap.

**Exported types:** `CreateDiscountInput`, `UpdateDiscountInput`

## Stacking / Combination Flags

Three boolean flags on each discount:
- `combineWithProductDiscounts`
- `combineWithOrderDiscounts`
- `combineWithShippingDiscounts`

These flags are stored and returned in validation responses but NOT enforced at checkout. Only one discount code per order is supported.

## Dependencies

- `@scalius/database` -- `discounts`, `discountProducts`, `discountCollections`, `discountUsage`, `discountCustomerRedemptions`, `orders`, `collections`, `products` tables, `DiscountType`, `DiscountValueType` enums
- `@scalius/core/search` -- `ftsMatch()` for FTS5 search
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`
- `@scalius/shared/price-utils` -- `roundPrice()`
- `nanoid` -- ID generation (`disc_`, `dp_`, `dc_` prefixes)
