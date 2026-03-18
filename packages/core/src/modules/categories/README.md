# Categories

Product category CRUD with FTS5 search, soft-delete, and collection config cleanup.

## Overview

Categories group products for navigation and filtering. Each product belongs to exactly one category (via `products.categoryId` FK). The service layer provides admin queries (paginated, searchable, sortable), public storefront queries, and full mutation support including soft-delete with product-reference guards and permanent-delete with collection config cleanup.

## Features

- **FTS5 search**: Admin list uses `ftsMatch("categories_fts", "categories", search)` for full-text search
- **Soft-delete with guards**: Cannot soft-delete a category that still has products assigned (throws `ValidationError` with affected product names and a suggestion message)
- **Permanent delete with product check**: `permanentlyDeleteCategory()` checks for products and throws `ConflictError` if any still reference the category
- **Bulk permanent delete with cleanup**: `bulkDeleteCategories()` with `permanent=true` scans all active collections and strips deleted category IDs from their JSON `config.categoryIds` arrays
- **Slug uniqueness**: Enforced at create and update time (only among non-deleted categories)
- **Product count**: Admin list includes a per-category product count via a separate grouped query, batched with the main queries
- **Batch queries**: `listCategories()` uses `db.batch()` to run count, results, and product-count queries in parallel
- **Unix timestamp formatting**: Timestamps stored as Unix epochs; service converts to ISO strings for API consumers

## Data Flow

```
Admin UI (CategoryForm / CategoryList)
  --> fetch("/api/v1/admin/categories/...")        (client-side, Vite proxy in dev)
  --> apps/api/src/routes/admin/categories.ts      (OpenAPIHono routes)
  --> packages/core/src/modules/categories/        (service layer - this module)
  --> @scalius/database/schema (categories, products, collections tables)

Storefront
  --> apps/storefront/src/lib/api/categories.ts    (edge-cached fetch wrapper)
  --> apps/api/src/routes/categories.ts            (public OpenAPI routes, cache middleware)
  --> packages/core/src/modules/categories/        (service layer for public queries)
```

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service + schema) |
| `categories.schema.ts` | Zod schemas: `createCategorySchema`, `updateCategorySchema`, image sub-schema |
| `categories.service.ts` | All DB queries and mutations (9 exported functions) |

## Schema (Zod)

**`createCategorySchema` / `updateCategorySchema`** (identical):
- `name`: string, 3-100 chars
- `description`: string | null
- `slug`: string, 3-100 chars, regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
- `metaTitle`: string | null
- `metaDescription`: string | null
- `image`: `{ id, url, filename, size, createdAt }` | null

## DB Schema

Table `categories` in `packages/database/src/schema/products.ts`:
- `id` (text PK, format `cat_` + nanoid)
- `name`, `slug`, `description`, `imageUrl`, `metaTitle`, `metaDescription`
- `createdAt`, `updatedAt` (integer, unix timestamp, default `UNIX_NOW`)
- `deletedAt` (integer, nullable -- soft-delete)
- Indexes: `categories_slug_idx`, `categories_deleted_at_idx`

## Service Functions

### Admin Queries
| Function | Signature | Notes |
|----------|-----------|-------|
| `listCategories()` | `(db, { page, limit, search, showTrashed, sort, order })` | Paginated, FTS5 search, batched with product counts |
| `getCategoryById()` | `(db, id)` | Returns single category by ID (includes deleted) |

### Public Queries
| Function | Signature | Notes |
|----------|-----------|-------|
| `listPublicCategories()` | `(db)` | All active categories, ordered by name |
| `getCategoryBySlug()` | `(db, slug)` | Single active category by slug |

### Mutations
| Function | Signature | Notes |
|----------|-----------|-------|
| `createCategory()` | `(db, data)` | Slug uniqueness check, returns `{ id }` |
| `updateCategory()` | `(db, id, data)` | Slug conflict check, throws `NotFoundError` |
| `deleteCategory()` | `(db, id)` | Soft-delete, rejects if products assigned (throws `ValidationError` with suggestion + affected product list) |
| `bulkDeleteCategories()` | `(db, categoryIds, permanent?)` | Soft or permanent; checks for products first; permanent cleans collection configs |
| `restoreCategories()` | `(db, categoryIds)` | Sets `deletedAt = null` |
| `permanentlyDeleteCategory()` | `(db, id)` | Hard delete, rejects if products assigned (throws `ConflictError` with count) |

## API Endpoints

### Admin (requires auth, mounted at `/api/v1/admin/categories`)
| Method | Path | Handler |
|--------|------|---------|
| GET | `/form-options` | Lightweight `{id, name}` list for dropdowns |
| GET | `/` | Paginated list with search, sort, trash filter |
| POST | `/` | Create category |
| POST | `/bulk-delete` | Bulk soft or permanent delete |
| POST | `/bulk-restore` | Bulk restore |
| PUT | `/{id}` | Update category |
| DELETE | `/{id}` | Soft-delete single category |
| DELETE | `/{id}/permanent` | Permanent delete single category |
| POST | `/{id}/restore` | Restore single category |

### Public (cached, mounted at `/api/v1/categories`)
| Method | Path | Handler |
|--------|------|---------|
| GET | `/` | List all active categories |
| GET | `/{slug}` | Get category by slug |
| GET | `/{slug}/products` | Products in category with filtering/pagination |

The public `/{slug}/products` endpoint supports: pagination, sort (newest/price-asc/price-desc/name-asc/name-desc/discount), search (FTS5), price range, free delivery filter, discount filter, and dynamic attribute filtering (any query param matching a known attribute slug).

## Admin UI Components

Located in `apps/admin/src/components/admin/categories/`:
- `CategoryListContainer.tsx` -- main list component with delete/restore dialogs
- `CategoryHeader.tsx` -- title, stats cards, trash toggle, add button
- `CategoryToolbar.tsx` -- search input (`/` keyboard shortcut), bulk action buttons
- `CategoryTable.tsx` -- sortable table with checkboxes, image preview, product count links, row actions
- `CategoryPagination.tsx` -- page nav with size selector
- `hooks/useCategoryList.ts` -- all state management, fetch, debounced search, CRUD handlers

The form component is at `apps/admin/src/components/admin/CategoryForm.tsx`:
- TipTap rich text editor for description (lazy-loaded)
- MediaManager for image upload
- Auto-slug generation from name (new categories only)
- Collapsible SEO section with character counters
- Storefront preview link (edit mode)

## Storefront Integration

- `apps/storefront/src/lib/api/categories.ts`: `getAllCategories()`, `getCategoryBySlug()` -- both edge-cached with `CACHE_TTL.LONG`
- `apps/storefront/src/pages/categories/[slug].astro`: Full category page with product grid, filters sidebar (mobile drawer), sort dropdown, pagination, breadcrumbs, analytics tracking (Meta ViewContent)
- `apps/storefront/src/pages/sitemap-categories.xml.ts`: Generates sitemap entries from all categories

## Dependencies

- `@scalius/database` -- `categories`, `products`, `collections` tables
- `@scalius/core/search` -- FTS5 (`ftsMatch`)
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`, `ValidationError`
- `nanoid` -- ID generation

## Known Gaps

- **No category hierarchy**: Categories are flat (no parent/child relationships)
- **Loader fetches all categories for edit**: `getCategoryEditData()` in `apps/admin/src/loaders/admin/catalog.ts` fetches up to 999 categories to find one by ID, instead of using `getCategoryById()` directly
- **No dedicated trash page**: Categories trash view reuses the index page with `?trashed=true` query param (collections has a separate `/trash` page)
- **Public routes use singleton `db`**: The public category routes in `apps/api/src/routes/categories.ts` import `db` directly from `@scalius/database/client` instead of using `c.get("db")` from context
