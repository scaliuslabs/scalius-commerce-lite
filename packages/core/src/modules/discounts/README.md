# Discounts

Discount codes with multiple types: amount off products, order-level, shipping, buy-X-get-Y.

## Files

- `index.ts` -- barrel exports
- `discounts.service.ts` -- `DiscountService` (list, getById, create, update, delete, bulkDelete, restore)
- `discounts.schema.ts` -- Zod validation schemas

## Dependencies

- `@scalius/database` -- `discounts`, `discountProducts`, `discountCollections`, `discountUsage`
- `@scalius/core/search` -- FTS5
