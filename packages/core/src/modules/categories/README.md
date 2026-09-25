# Categories

Product category CRUD with explicit publication authority, revision-guarded writes, FTS5 search, soft-delete, storefront queries, and collection config cleanup.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Barrel exports (re-exports service, storefront, validation) |
| `categories.validation.ts` | Zod schemas for create/update/status and revision claims |
| `categories.publication.ts` | Public predicate and publish readiness (informational: an empty published category is allowed) |
| `categories.revision.ts` | Single/bulk revision guards and typed conflicts |
| `categories.service.ts` | Admin DB queries and mutations (9 exported functions) |
| `categories.storefront.ts` | Public/storefront queries; the category page read carries its children and breadcrumb in the same batch |
| `categories.tree.ts` | The tree: placement pre-check, move, trash rules, admin and storefront tree reads |

## Schema (Zod)

Create accepts category content and always persists `draft` revision 1. Update
also requires `expectedRevision` and `status`; status-only writes use the same
revision claim. Canonical statuses are `draft | published | internal`.

Shared content fields:
- `name`: string, 3-100 chars
- `description`: trimmed string | null, max 100,000 characters
- `slug`: string, 3-100 chars, regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. Optional on create: omitted, it is derived from the name (`@scalius/shared/handle`, Bangla transliterated) and a taken one gets `-2`, `-3`…; a typed taken slug is still a conflict.
- `metaTitle`: trimmed string | null, max 70 characters
- `metaDescription`: trimmed string | null, max 200 characters
- `image`: `{ id, url, filename, size, createdAt }` | null

**Exported types:** `CreateCategoryInput`, `UpdateCategoryInput`,
`UpdateCategoryStatusInput`, `CategoryRevisionClaim`

## Admin Service (`categories.service.ts`)

### Queries

| Function | Signature | Notes |
|----------|-----------|-------|
| `listCategories` | `(db, { page?, limit?, search?, status?, showTrashed?, sort?, order? })` | Paginated FTS5 list with status, revision, parent, depth, product count, and publish readiness |
| `getCategoryBySlug` | `(db, slug)` | Single active category by slug (excludes soft-deleted) |
| `getCategoryById` | `(db, id)` | Single category by ID (includes updatedAt, does not filter on deletedAt) |

### Mutations

| Function | Signature | Notes |
|----------|-----------|-------|
| `createCategory` | `(db, data)` | Creates revision 1 with the chosen status (default draft) and returns `{ id, revision, status }` |
| `updateCategory` | `(db, id, data)` | CAS edit/status write; unpublish guard for active automatic collections; advances revision and affected product revisions |
| `updateCategoryStatus` | `(db, id, { expectedRevision, status })` | CAS status workflow with the same unpublish guard |
| `deleteCategory` | `(db, id, expectedRevision)` | CAS soft-delete, forces draft, rejects assigned products |
| `bulkDeleteCategories` | `(db, claims, permanent?)` | Up to 90 `{id, expectedRevision}` claims; soft trash is one all-or-none guarded `UPDATE … RETURNING`, while hard delete preserves transactional collection cleanup |
| `restoreCategories` | `(db, claims)` | CAS restore to draft; advances category and affected product revisions |
| `permanentlyDeleteCategory` | `(db, id, expectedRevision)` | Trash-only hard delete with final transactional claim guard |

## Storefront Queries (`categories.storefront.ts`)

| Function | Signature | Notes |
|----------|-----------|-------|
| `getPublicCategories` | `(db)` | Published, non-trashed categories ordered by name |
| `getPublicCategoryBySlug` | `(db, slug)` | Published category by slug; draft/internal/deleted return null |
| `getPublicCategoryById` | `(db, id)` | Published category by ID; draft/internal/deleted return null |

## Tree (migration 0090)

The application writes only `categories.parent_id` (and the revision).
Triggers keep `depth` (0-3), the id `path` (`/root/child/`) and
`category_closure` exact, and refuse cycles, a fifth level and trashed or
missing parents: they are the authority. `categoryPlacementRefusal` runs the
same checks first (one indexed read) so the service can explain a refusal;
a refusal that only the trigger sees (a race) is translated to the same
`CATEGORY_PLACEMENT_REFUSED` error (`reason`: `cycle`, `too_deep`,
`parent_unavailable`).

- **Parent picker writes:** `parentId` on create and edit (omitted keeps the
  current parent); `moveCategory` moves a whole subtree under the revision.
- **Trash rules (service):** a category with live children cannot be trashed
  unless they are trashed in the same selection; a category whose parent is in
  trash cannot be restored unless the parent is restored with it; a permanent
  delete must include every child (live or trashed), and deletes deepest first
  because `parent_id` is ON DELETE RESTRICT. A trashed category keeps its place.
- **Reads:** `listCategoryChildren` and `getCategoryAncestors` (dashboard);
  `getPublicCategoryTree` (≤ 150 published nodes whose every ancestor is
  published, top levels first, flat with `parentId`, for automatic menus),
  `getPublicCategoryChildren`, `getPublicCategoryBreadcrumb` (≤ 4 rows, one
  closure read), and `publicCategorySubtreeCondition` (a category plus its
  published descendants, for listings).
- **`listingTemplate`:** a theme listing template id or null (theme default).

## Features

- **FTS5 search**: Admin list uses `ftsMatch("categories_fts", "categories", search)`
- **Soft-delete with guards**: Cannot soft-delete if products still assigned (throws `ValidationError`)
- **Permanent delete with collection cleanup**: `bulkDeleteCategories()` with `permanent=true` strips deleted category IDs from collection JSON configs
- **Slug uniqueness**: Enforced globally across active and trashed categories; database races become typed conflicts
- **Publication authority**: only `published` categories can drive public metadata, filters, navigation, discovery, or dynamic collections
- **Reverse-reference guard**: active dynamic collections block category unpublish/trash until membership is removed or the collection is deactivated
- **Product independence**: draft/internal assignment never hides a public product; category metadata is omitted instead
- **Optimistic concurrency**: category writes require a monotonic revision claim and advance once
- **Product count**: Admin list uses an indexed per-row count of all non-trashed assigned products, matching deletion truth
- **Batch queries**: `listCategories()` batches only total count + the requested page; it does not group-scan every product row
- **Unix timestamp formatting**: Stored as Unix epochs; converted to ISO strings for API responses

## Dependencies

- `@scalius/database` -- `categories`, `products`, `collections` tables
- `@scalius/core/search` -- FTS5 (`ftsMatch`)
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`, `ValidationError`
- `nanoid` -- ID generation (`cat_` prefix)
