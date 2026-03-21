# Categories

Product category CRUD with FTS5 search, soft-delete, storefront queries, and collection config cleanup.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service, storefront, validation) |
| `categories.validation.ts` | Zod schemas: `createCategorySchema`, `updateCategorySchema`, image sub-schema |
| `categories.service.ts` | Admin DB queries and mutations (9 exported functions) |
| `categories.storefront.ts` | Public/storefront queries (4 exported functions) |

## Schema (Zod)

**`createCategorySchema` / `updateCategorySchema`** (identical):
- `name`: string, 3-100 chars
- `description`: string | null
- `slug`: string, 3-100 chars, regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
- `metaTitle`: string | null
- `metaDescription`: string | null
- `image`: `{ id, url, filename, size, createdAt }` | null

**Exported types:** `CreateCategoryInput`, `UpdateCategoryInput`

## Admin Service (`categories.service.ts`)

### Queries

| Function | Signature | Notes |
|----------|-----------|-------|
| `listCategories` | `(db, { page?, limit?, search?, showTrashed?, sort?, order? })` | Paginated, FTS5 search via `ftsMatch("categories_fts", "categories", search)`, sortable by name/createdAt/updatedAt, batched with product counts via `db.batch()` |
| `getCategoryBySlug` | `(db, slug)` | Single active category by slug (excludes soft-deleted) |
| `getCategoryById` | `(db, id)` | Single category by ID (includes updatedAt, does not filter on deletedAt) |

### Mutations

| Function | Signature | Notes |
|----------|-----------|-------|
| `createCategory` | `(db, data)` | Slug uniqueness check among non-deleted. ID format: `cat_{nanoid}`. Returns `{ id }`. |
| `updateCategory` | `(db, id, data)` | Slug conflict check. Throws `NotFoundError` if missing. |
| `deleteCategory` | `(db, id)` | Soft-delete. Rejects if products assigned (up to 5 shown). Throws `ValidationError` with suggestion + affected product list. |
| `bulkDeleteCategories` | `(db, categoryIds, permanent?)` | Checks for products first. Permanent mode cleans collection configs (strips deleted category IDs from `config.categoryIds` JSON). |
| `restoreCategories` | `(db, categoryIds)` | Sets `deletedAt = null`. |
| `permanentlyDeleteCategory` | `(db, id)` | Hard delete. Checks for products first. Throws `ConflictError` with count. |

## Storefront Queries (`categories.storefront.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `getPublicCategories` | `(db)` | All active categories ordered by name. Formats timestamps to ISO strings. No pagination. |
| `getPublicCategoryBySlug` | `(db, slug)` | Single active category by slug. Returns null if not found or soft-deleted. Formats timestamps. |
| `getPublicCategoryById` | `(db, id)` | Single active category by ID. Filters out soft-deleted. |
| `getPublicCategoryTree` | `(db)` | Delegates to `getPublicCategories()`. Named for nav use, extensible for future hierarchy. |

## Features

- **FTS5 search**: Admin list uses `ftsMatch("categories_fts", "categories", search)`
- **Soft-delete with guards**: Cannot soft-delete if products still assigned (throws `ValidationError`)
- **Permanent delete with collection cleanup**: `bulkDeleteCategories()` with `permanent=true` strips deleted category IDs from collection JSON configs
- **Slug uniqueness**: Enforced at create and update time (only among non-deleted)
- **Product count**: Admin list enriches results with per-category product count
- **Batch queries**: `listCategories()` uses `db.batch()` for count + results + product counts
- **Unix timestamp formatting**: Stored as Unix epochs; converted to ISO strings for API responses

## Dependencies

- `@scalius/database` -- `categories`, `products`, `collections` tables
- `@scalius/core/search` -- FTS5 (`ftsMatch`)
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`, `ValidationError`
- `nanoid` -- ID generation (`cat_` prefix)
