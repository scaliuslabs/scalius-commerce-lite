# Products

Product CRUD, variant management, image handling, barcode support, and storefront queries.

## Files

- `index.ts` -- barrel exports
- `products.service.ts` -- `getProducts()`, `getProductDetails()`, `getProductStats()`, `getCategoryStats()`, `createProduct()`, `updateProduct()`, `deleteProduct()`, `restoreProduct()`, `permanentDeleteProduct()`, `bulkDeleteProducts()`, `bulkUpdateVariants()`, `getStorefrontProducts()`, `getStorefrontProductBySlug()`, `lookupByBarcode()`, `getProductVariants()`, `createVariant()`, `updateVariant()`, `deleteVariant()`, `duplicateVariant()`, `bulkCreateVariants()`, `bulkDeleteVariants()`, `getVariantSortOrder()`, `updateVariantSortOrder()`, `searchStorefrontProducts()`
- `products.validation.ts` -- `CreateProductInput`, `UpdateProductInput`, `createVariantSchema`, `updateVariantSchema`, `bulkVariantSchema`, `updateSortOrderSchema`

## Key patterns

- Variants support `barcode` and `barcodeType` fields (ean13, upc, isbn, gtin, custom)
- `lookupByBarcode()` finds variant + product by exact barcode match
- Search auto-detects barcode patterns (all digits, 8-13 chars) and searches by barcode OR FTS

## Dependencies

- `@scalius/database` -- `products`, `productVariants`, `productImages`, `productRichContent`, `productAttributes`, `productAttributeValues`, `categories`, `orderItems`
- `@scalius/core/search` -- FTS5
