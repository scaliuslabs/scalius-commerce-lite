# Discounts

Manages discount codes with support for multiple types (amount off products, order-level, shipping, buy-X-get-Y).

## Exports

- `DiscountService.list()` — paginated discount list with usage stats and related products/collections
- `DiscountService.getById()` — single discount with relations
- `DiscountService.create()` / `DiscountService.update()` — create/update with product and collection links
- `DiscountService.delete()` / `DiscountService.bulkDelete()` / `DiscountService.restore()` — lifecycle ops
- `discountsSchema` — Zod validation schemas

## Dependencies

- `@scalius/database` — `discounts`, `discountProducts`, `discountCollections`, `discountUsage` tables
- `@scalius/core/search` — FTS5 full-text search

## API Routes

- `GET /api/v1/discounts` — list discounts (admin)
- `POST /api/v1/discounts` — create discount
- `PUT /api/v1/discounts/:id` — update discount
- `DELETE /api/v1/discounts/:id` — soft-delete discount
