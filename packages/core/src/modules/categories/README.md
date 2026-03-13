# Categories

CRUD and query logic for product categories, used by both admin and storefront.

## Exports

- `listCategories()` — paginated, searchable admin category list with product counts
- `listPublicCategories()` — all active categories for the storefront
- `getCategoryBySlug()` / `getCategoryById()` — single category lookup
- `createCategory()` / `updateCategory()` / `deleteCategory()` — admin mutations
- `bulkDeleteCategories()` / `restoreCategories()` — bulk operations with soft/permanent delete
- `CreateCategoryInput` / `UpdateCategoryInput` — Zod-validated input types

## Dependencies

- `@scalius/database` — `categories`, `products`, `collections` tables
- `@scalius/core/search` — FTS5 full-text search

## API Routes

- `GET /api/v1/categories` — list categories (admin, paginated)
- `POST /api/v1/categories` — create category
- `PUT /api/v1/categories/:id` — update category
- `DELETE /api/v1/categories/:id` — soft-delete category
