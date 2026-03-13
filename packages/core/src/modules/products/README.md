# Products

Product CRUD, variant management, image handling, and storefront queries. The largest service module.

## Exports

- `listProducts()` — paginated, searchable admin product list with images and variants
- `getProductById()` — full product with variants, images, rich content, and attributes
- `getProductBySlug()` — storefront product detail lookup
- `listStorefrontProducts()` — public product listing with filtering and sorting
- `createProduct()` / `updateProduct()` / `deleteProduct()` — admin mutations
- `createVariant()` / `updateVariant()` / `deleteVariant()` — variant management
- `bulkDeleteProducts()` / `restoreProducts()` — bulk operations
- `createVariantSchema` / `updateVariantSchema` — Zod validation schemas
- `CreateProductInput` / `UpdateProductInput` — validated input types

## Dependencies

- `@scalius/database` — `products`, `productVariants`, `productImages`, `productRichContent`, `productAttributes`, `productAttributeValues`, `categories`, `orderItems` tables
- `@scalius/core/search` — FTS5 full-text search

## API Routes

- `GET /api/v1/products` — list products (admin)
- `GET /api/v1/products/:id` — get product detail
- `POST /api/v1/products` — create product
- `PUT /api/v1/products/:id` — update product
- `DELETE /api/v1/products/:id` — soft-delete product
