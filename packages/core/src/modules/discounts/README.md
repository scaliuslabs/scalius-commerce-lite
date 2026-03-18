# Discounts

Admin CRUD service for discount codes. Handles creation, update, listing, soft-delete, restore, permanent delete, and bulk operations. Does NOT handle storefront validation or usage recording -- those live in the API routes layer and orders queue respectively.

## Discount Types

Three types defined in `@scalius/database/schema/enums.ts`:

| Type | Enum Value | Description |
|------|-----------|-------------|
| Amount Off Products | `amount_off_products` | Discount applied to specific products or collections |
| Amount Off Order | `amount_off_order` | Discount applied to the entire order subtotal |
| Free Shipping | `free_shipping` | Waives shipping cost entirely |

## Value Types

| Value Type | Enum Value | Description |
|------------|-----------|-------------|
| Percentage | `percentage` | Percentage off (e.g., 15% off). Capped at 100% via schema validation. |
| Fixed Amount | `fixed_amount` | Fixed currency amount off (dynamic symbol from store settings) |
| Free | `free` | Used exclusively by `free_shipping` type (value field is ignored) |

## Schema

Four tables in `packages/database/src/schema/marketing.ts`:

- **`discounts`** -- Main table. Fields: code, type, valueType, discountValue, minPurchaseAmount, minQuantity, maxUsesPerOrder, maxUses, limitOnePerCustomer, combineWith* flags, customerSegment, startDate, endDate, isActive, timestamps, deletedAt (soft-delete). Indexed on code and deletedAt.
- **`discountProducts`** -- Join table linking discounts to specific products. Has `applicationType` column (only `"get"` is used; `"buy"` is in the type but never written).
- **`discountCollections`** -- Join table linking discounts to specific collections. Same `applicationType` pattern as products.
- **`discountUsage`** -- Records each use of a discount code: discountId, orderId, customerId, amountDiscounted. Indexed on (discountId, customerId) for per-customer limit checks.

## DiscountService API

All methods accept a `db: Database` instance (no module-level singleton).

| Method | Signature | Description |
|--------|-----------|-------------|
| `list` | `(db, { page, limit, search, showTrashed, sort, order })` | Paginated list with FTS5 search on code. Joins discountProducts, discountCollections, and discountUsage to return relatedProducts, relatedCollections, usageCount, totalDiscountAmount per discount. |
| `getById` | `(db, id)` | Single discount with relatedProducts and relatedCollections. Returns null if not found. |
| `create` | `(db, data)` | Validates unique code (among non-deleted). Uses `db.batch()` to atomically insert discount + product/collection associations. Only creates associations for `amount_off_products` type. Returns `{ id }`. |
| `update` | `(db, id, data)` | Validates existence and unique code. Uses `db.batch()` to atomically update discount, delete old associations, and insert new ones. Returns `{ success: true }`. |
| `delete` | `(db, id)` | Soft-delete: sets `deletedAt = unixepoch()`. |
| `bulkDelete` | `(db, discountIds, permanent?)` | Soft-delete or permanent delete array of IDs. |
| `restore` | `(db, discountIds)` | Sets `deletedAt = null` for array of IDs. |
| `permanentlyDelete` | `(db, id)` | Hard-deletes from DB (cascades to products/collections/usage via FK). |

## Validation Schema

`discounts.schema.ts` defines Zod schemas:

- **`createDiscountSchema`** -- Validates all discount fields. Date handling is flexible: accepts Date, string, or unix timestamp (auto-detects seconds vs milliseconds). `appliesToProducts` and `appliesToCollections` are optional string arrays. Includes a refine check: percentage discounts cannot exceed 100%.
- **`updateDiscountSchema`** -- Extends create schema with required `id` field. Same percentage cap validation.

## FTS5 Search

Full-text search on the `code` field via `discounts_fts` virtual table. Created in migration `0016_fts5_search.sql`. Auto-maintained by SQLite triggers on insert/update/delete.

## Eligibility Rules (Enforced at Validation Time)

These rules are stored in the schema but enforced in `apps/api/src/routes/discounts.ts` (the public validation endpoint), NOT in this service:

- **Date window**: startDate <= now AND (endDate IS NULL OR endDate > now)
- **Active flag**: isActive must be true
- **Not soft-deleted**: deletedAt must be null
- **Minimum purchase amount**: Cart total must meet minPurchaseAmount
- **Minimum quantity**: Total cart item count must meet minQuantity
- **Total usage limit**: discountUsage count < maxUses
- **Per-customer limit**: When limitOnePerCustomer is true, checks discountUsage joined with orders by customerPhone
- **Product applicability**: For `amount_off_products`, cart must contain at least one product from linked products or collections

## Stacking / Combination Flags

Three boolean flags on each discount:
- `combineWithProductDiscounts`
- `combineWithOrderDiscounts`
- `combineWithShippingDiscounts`

**Current status**: These flags are stored and exposed to the storefront validation response with an `enhancedDiscount.combinable` object, but they are NOT enforced at checkout. The system supports only ONE discount code per order (single `discountCode` field on the checkout payload). The schema comment explicitly notes these are "reserved for future multi-discount support."

## Discount Amount Calculation

Performed in `apps/api/src/routes/discounts.ts` via `calculateDiscountAmount()`:

| Type | Percentage | Fixed Amount |
|------|-----------|-------------|
| `free_shipping` | Returns full shippingCost | Returns full shippingCost |
| `amount_off_order` | `min(subtotal, subtotal * value / 100)` | `min(subtotal, fixedAmount)` |
| `amount_off_products` | Sums applicable product totals, then `min(total, total * value / 100)` | `min(applicableTotal, fixedAmount)` |

For `amount_off_products`, collection expansion resolves collections to individual product IDs by parsing each collection's `config` JSON (categoryIds and productIds). If no applicable products match cart items but the discount has product/collection associations, the full subtotal is used as fallback.

## Usage Recording

Discount usage is NOT recorded by this service. It happens in two places:

1. **Queue processing** (`packages/core/src/modules/orders/orders.queue.ts`): When an order is ingested, the queue consumer inserts a `discountUsage` row in the same `db.batch()` as the order and order items. This is the primary path.
2. **Storefront fallback** (`apps/storefront/src/lib/api/discounts.ts`): `recordDiscountUsage()` calls `POST /discounts/usage`, but this endpoint does NOT exist in the API routes. The storefront `server.ts` calls this after order creation as a fallback, but the route is missing.

## Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel exports for schema and service |
| `discounts.service.ts` | `DiscountService` object with all CRUD methods |
| `discounts.schema.ts` | Zod validation schemas (createDiscountSchema, updateDiscountSchema) with percentage cap refine |

## Dependencies

- `@scalius/database` -- `discounts`, `discountProducts`, `discountCollections`, `discountUsage` tables, `DiscountType`, `DiscountValueType` enums
- `@scalius/core/search` -- `ftsMatch()` for FTS5 code search
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`
- `nanoid` -- ID generation with prefixes (`disc_`, `dp_`, `dc_`)

## Known Gaps

1. **`POST /discounts/usage` endpoint missing**: The storefront's `recordDiscountUsage()` calls this endpoint, but it does not exist in `apps/api/src/routes/discounts.ts`. Usage recording works via the queue path only.
2. **Combination flags not enforced**: combineWith* flags are stored and returned but never checked. Only one discount code per order is supported.
3. **`applicationType` always `"get"`**: The `discountProducts` and `discountCollections` tables have an `applicationType` enum with only `"get"`. The service always writes `"get"`. The list method casts to `'buy' | 'get'` and initializes both buckets, but `"buy"` is never written. This is a vestige of planned buy-X-get-Y support.
4. **`customerSegment` field unused**: The schema has a `customerSegment` text field. It's stored and passed through but never checked during validation or filtering.
