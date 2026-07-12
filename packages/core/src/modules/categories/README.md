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
- `description`: trimmed string | null, max 100,000 characters
- `slug`: string, 3-100 chars, regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
- `metaTitle`: trimmed string | null, max 70 characters
- `metaDescription`: trimmed string | null, max 200 characters
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
| `createCategory` | `(db, data)` | Global active/trash slug uniqueness with typed race conflicts. ID format: `cat_{nanoid}`. Returns `{ id }`. |
| `updateCategory` | `(db, id, data)` | Rejects trash edits, enforces global slug authority, and atomically bumps affected product revisions. |
| `deleteCategory` | `(db, id)` | Soft-delete. Rejects if products assigned (up to 5 shown). Throws `ValidationError` with suggestion + affected product list. |
| `bulkDeleteCategories` | `(db, categoryIds, permanent?)` | Caps 90 IDs and atomically rechecks products. Permanent mode is trash-only, cleans active/trashed collection configs, and refuses to orphan an active dynamic collection. |
| `restoreCategories` | `(db, categoryIds)` | Caps 90 IDs, restores timestamps, and bumps affected product revisions. |
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
- **Slug uniqueness**: Enforced globally across active and trashed categories; database races become typed conflicts
- **Product count**: Admin list uses an indexed per-row count of all non-trashed assigned products, matching deletion truth
- **Batch queries**: `listCategories()` batches only total count + the requested page; it does not group-scan every product row
- **Unix timestamp formatting**: Stored as Unix epochs; converted to ISO strings for API responses

## Dependencies

- `@scalius/database` -- `categories`, `products`, `collections` tables
- `@scalius/core/search` -- FTS5 (`ftsMatch`)
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`, `ValidationError`
- `nanoid` -- ID generation (`cat_` prefix)
