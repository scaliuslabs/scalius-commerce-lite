# Discounts

Discount code CRUD, eligibility validation, and discount amount calculation. Supports three discount types with product/collection scoping and usage limits. Combination columns are legacy storage only and do not represent a working stacking feature.

## Current admin workflow

- The list names the customer outcome, code method, every eligibility minimum,
  lifecycle, schedule, and usage instead of relying on a code tooltip. Amount
  and quantity minimums are joined with an explicit “both required” statement.
  Codes whose total usage is exhausted say **Limit reached**, not **Active**.
- Persisted demo/legacy rules that checkout cannot honor (missing or ignored
  scope, mismatched value semantics, invalid schedule, segment/combination
  flags, or a multi-use-per-order promise) display a visible review marker.
  Editing and saving through the current builder normalizes those unsupported
  fields instead of continuing to advertise them.
- Create, edit, and duplicate use one `DiscountCodeBuilder` for all three
  supported outcomes. The builder keeps method, outcome, scope, requirements,
  schedule, limits, activation, readiness, and the natural-language rule in
  one model instead of three independently validated forms.
- Product discounts require at least one explicit product or collection.
  Order and delivery discounts reject stray product scope. This prevents a
  targetless product discount from silently becoming an order-wide discount.
- The builder states that the method is a checkout code and that it is used
  alone. Unsupported automatic and stacking controls are not rendered.
- Optional purchase amount and item-quantity requirements can be combined;
  product discounts count only eligible lines, while order and delivery codes
  count the complete merchandise cart.
- Native local-date inputs preserve the authored calendar day. Duplicates are
  always drafts, read failures remain retryable on the edit route, save errors
  preserve input, and dirty navigation uses the shared guard.
- Edit and activation commands claim the loaded positive `revision`. D1 checks
  that revision before any parent or scope statement, applies the complete
  rule mutation, and advances the revision once in the same batch. A stale tab
  receives `DISCOUNT_REVISION_CONFLICT` with the expected/current revisions;
  the builder preserves its input and requires an explicit reload instead of
  silently overwriting the newer rule.
- Mobile uses purpose-built cards with the same selection, edit, duplicate,
  activation, trash, restore, and permanent-delete actions as desktop.
- List failures remain visible and retryable; they must not be rendered as an
  empty discount library.
- The create entry point asks which checkout amount the code reduces. It does
  not expose automatic promotions or stacking until the typed promotion
  evaluator and allocation ledger exist.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service, validation, eligibility) |
| `discounts.service.ts` | Standalone functions for admin CRUD: list, get, create, revision-guarded update/status, delete, bulk operations, restore |
| `discounts.revision.ts` | Atomic D1 revision guard/bump and typed stale/state conflicts for rule mutations |
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
| `updateDiscount` | `(db, id, data, authority?)` | Requires `data.expectedRevision`. Ordinary edit may preserve status but changing it requires verified `discounts.toggle_status` authority. Atomically guards, updates the discount and associations, and advances the revision once. |
| `setDiscountActiveStatus` | `(db, id, isActive, expectedRevision)` | Dedicated revision-guarded active/inactive command used only by the toggle-permission route. |
| `deleteDiscount` | `(db, id)` | Soft-delete: sets `deletedAt = unixepoch()`. |
| `bulkDeleteDiscounts` | `(db, discountIds, permanent?)` | Soft-delete deactivates; hard-delete is trash-only and blocks any usage history. |
| `restoreDiscounts` | `(db, discountIds)` | Restores trashed discounts as inactive drafts. Codes stay reserved in trash. |
| `permanentlyDeleteDiscount` | `(db, id)` | Trash-only hard-delete blocked when order usage history exists. |

## Eligibility Functions (`discounts.eligibility.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `isDiscountValid` | `(db, code, total?, cartItems?, customerPhone?, currencySymbol?, currencyCode?)` | Validates a discount code against cart context. Returns `{ valid, discount?, applicableProductIds?, error? }`. |
| `calculateDiscountAmount` | `(db, discount, total, cartItems, shippingCost?, precomputedProductIds?, currencyCode?, precomputedHasProductRestrictions?)` | Calculates the actual discount amount. Accepts the validated product set and restriction fact to skip duplicate reads after `isDiscountValid`. Passing a product set also implies restricted scope and never enables subtotal fallback. |

### Validation Checks (`isDiscountValid`)

Checks performed in order:

1. Code exists, is active, not soft-deleted, and within its inclusive saved end timestamp
2. Product/collection scope resolves fail-closed when any restriction exists
3. Minimum purchase amount met (merchandise subtotal; eligible lines only for product scope)
4. Minimum quantity met (eligible lines only for product scope)
5. Total usage limit not exceeded (`maxUses` vs `discountUsage` count; advisory before checkout commit)
6. Per-customer limit via immutable `discountCustomerRedemptions` phone claim (advisory before checkout commit)

Returns `applicableProductIds` set for downstream use by `calculateDiscountAmount`.

The public validation endpoint is advisory. Final checkout calls the same
validator again with the server-resolved merchandise subtotal, exact persisted
SKU prices/quantities, canonical checkout phone, and resolved product scope. It
does not trust the browser's discount amount, shipping amount, or earlier quote.

## Commit-Time Enforcement

Cart and API validation are buyer-friendly prechecks, not the concurrency authority. Final redemption is enforced when checkout inserts `discount_usage` in the synchronous order commit batch:

- `discount_usage_max_uses_guard` aborts the insert with `DISCOUNT_MAX_USES_EXCEEDED` when `maxUses` has already been reached.
- `discount_usage_one_per_customer_guard` aborts with `DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED` when the checkout phone proof already has an immutable redemption claim for that discount.
- `discount_customer_redemptions` stores the immutable per-customer claim as `phone:{checkoutPhone}` at redemption time, so later admin corrections to `orders.customerPhone` do not reopen a one-per-customer coupon.
- `commitStorefrontOrderPayload()` maps those trigger aborts back to normal checkout `ValidationError`s and releases reserved stock before returning the failure.

The D1 triggers close concurrent total-usage and phone-redemption races. Other
rule edits (schedule, scope, and minimum changes between final validation and
the order batch) still require the planned revisioned promotion allocation
model; public validation is not represented as a durable reservation.

### Discount Calculation (`calculateDiscountAmount`)

| Type | Percentage | Fixed Amount |
|------|-----------|-------------|
| `free_shipping` | Returns full `shippingCost` | Returns full `shippingCost` |
| `amount_off_order` | `min(subtotal, subtotal * value / 100)` | `min(subtotal, fixedAmount)` |
| `amount_off_products` | Sums applicable product totals, then `min(total, total * value / 100)` | `min(applicableTotal, fixedAmount)` |

For `amount_off_products`, collection expansion resolves collections to product IDs by parsing each collection's `config` JSON (`categoryIds` and `productIds`). A missing, empty, inactive, deleted, or unreadable saved scope fails closed. It never falls back to the order subtotal. If no cart items match, calculation returns 0.

Uses `roundPrice()` from `@scalius/shared/price-utils` for currency precision.

## Validation Schemas (`discounts.validation.ts`)

**`createDiscountSchema`**: Validates all discount fields and defaults `isActive` to false. Date handling accepts valid `Date`, string, or numeric seconds/milliseconds, requires end after start, and rejects invalid dates. Product/collection targets are deduplicated and bounded to 90 total. Type/value semantics must agree, percentage discounts cannot exceed 100%, and unsupported segments/combination behavior is rejected.

**`updateDiscountSchema`**: Same as create with required `id` and positive
`expectedRevision` fields. Same percentage cap.

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
