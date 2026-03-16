# Categories

Product category CRUD with FTS5 search and bulk operations.

## Files

- `index.ts` -- barrel exports
- `categories.service.ts` -- `listCategories()`, `listPublicCategories()`, `getCategoryBySlug()`, `getCategoryById()`, `createCategory()`, `updateCategory()`, `deleteCategory()`, `bulkDeleteCategories()`, `restoreCategories()`
- `categories.schema.ts` -- `CreateCategoryInput`, `UpdateCategoryInput`, Zod schemas

## Dependencies

- `@scalius/database` -- `categories`, `products`, `collections`
- `@scalius/core/search` -- FTS5
