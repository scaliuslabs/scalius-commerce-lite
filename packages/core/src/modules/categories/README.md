# Categories

Category records, their publication rules, revision-guarded admin writes and the category tree. Read this before you change a category write, the tree or a public category read. A category's product listing is `catalog`'s `getStorefrontCategoryProducts`.

## Entries and layer

- `browser.ts` exports `categories.validation.ts` (create, update, status, move and revision-claim schemas, `CATEGORY_BATCH_LIMIT` 90). `index.ts` exports everything in `browser.ts`, plus `categories.service.ts`, `categories.storefront.ts`, `categories.publication.ts`, `categories.revision.ts` and `categories.tree.ts`.
- Layer L4. The domain imports `custom-fields`, `media-references` and `products`. `catalog`, `navigation`, `storefront` and `store-transfer` import `categories`.

## Owns

| Table | Key columns and constraints |
|-------|-----------------------------|
| `categories` | `id` (prefix `cat_`), `slug` (unique across live and trashed rows), `status` (`draft`, `published`, `internal`), `revision` (at least 1), `parent_id` (`ON DELETE RESTRICT`), `depth` (0 to 3), `path`, `listing_template`, SEO fields (`canonical_path`, `no_index`, `exclude_from_sitemap`), `deleted_at` |
| `category_closure` | Every `(ancestor_id, descendant_id)` pair with `depth`, each category included with itself at depth 0 |

Admin list search uses the `categories_fts` full-text index. The domain declares no settings document.

DVC: `category_closure` advances `c:` keys and `lm:cat:<ancestorId>`, so a move advances the listings of the old and new ancestors. Public readers declare `deps.anyCategory()`; the sitemap read also declares `deps.discoveryMembership()`.

## Routes

Admin routes are in `apps/api/src/routes/admin/categories.ts` under `/api/v1/admin/categories`. Permissions are in `packages/core/src/auth/rbac/route-permissions/catalog.ts` (`categories.view`, `create`, `edit`, `delete`, `restore`, `permanent_delete`). The admin lists use page and limit paging, not cursors.

| Method and path | Note |
|-----------------|------|
| `GET /`, `GET /summaries` | List (limit at most 500); bounded agent summaries (at most 50) |
| `GET /form-options`, `GET /children` | Picker data; one tree level under `parentId` |
| `GET /{id}`, `/{id}/sections/{section}`, `/{id}/publish-readiness`, `/{id}/ancestors` | One category, bounded text sections, readiness, breadcrumb |
| `POST /`, `PUT /{id}`, `PATCH /{id}/status`, `PATCH /{id}/parent` | Create, edit, status, move |
| `DELETE /{id}`, `POST /{id}/restore`, `DELETE /{id}/permanent` | Trash, restore, permanent delete |
| `POST /bulk-delete`, `POST /bulk-restore` | At most 90 `{ id, expectedRevision }` claims |

Public routes are in `apps/api/src/routes/categories.ts` under `/api/v1/categories`: `GET /`, `/summaries`, `/sitemap`, `/tree`, `/{slug}`, `/{slug}/children`, `/{slug}/breadcrumb`, `/{slug}/sections/{section}`, `/{slug}/products` and `/{slug}/product-summaries`.

## Rules

- **Status.** `published` categories alone own public metadata, filters, navigation, discovery and dynamic collection membership. A draft or internal assignment never hides a public product; the product shows without its category identity.
- **Revision guard.** Edit, status change, move, trash, restore and permanent delete claim `expectedRevision` and advance it by one. A stale claim is `CATEGORY_REVISION_CONFLICT` (409); the wrong lifecycle state is `CATEGORY_STATE_CONFLICT` (409). Bulk writes apply all or none.
- **Trash and restore force `draft`.** A permanent delete works only from trash.
- **Slugs.** A typed taken slug is a conflict (trash counts). An omitted slug derives from the name and gets `-2`, `-3` until free.
- **Canonical path** is `/categories/<current slug>` or blank.
- **Publishing** needs no products. `getCategoryPublishReadiness` returns a blocker when no buyer-resolvable product exists and warnings for a missing image or descriptions; it only informs.
- **Reverse-reference guards.** A status other than `published`, and trash, are refused while an active dynamic collection uses the category. A category with assigned products cannot be trashed. A permanent delete bumps each affected product's `aggregate_revision` and strips the id from every collection `config` in the same batch.
- **Media.** A create or edit that references a file in deleting state is refused (`media-references` guard).
- **`listing_template`** is a listing template id from the theme document or NULL (the theme's default). Collections and brands carry the same field.

## The tree

Write only `parent_id`. Triggers keep `depth`, `path` (`/root/child/`) and `category_closure` exact. They refuse cycles, a fifth level and trashed or missing parents.

- `categoryPlacementRefusal` runs the same checks first, so the service can explain a refusal. A refusal only the trigger sees (a race) becomes the same `CATEGORY_PLACEMENT_REFUSED` error (`reason`: `cycle`, `too_deep`, `parent_unavailable`).
- `moveCategory` moves a whole subtree under the revision. A move to the current parent changes nothing and keeps the revision.
- Trash rules: a category with live children cannot be trashed unless they go in the same selection. A category whose parent is in trash cannot be restored unless the parent is restored with it. A permanent delete must include every child and deletes deepest first. A trashed category keeps its place.
- Public reads are bounded. `getPublicCategoryTree` returns at most 150 published nodes whose ancestors are all published (`CATEGORY_TREE_LINK_LIMIT`). `getPublicCategoryChildren` returns at most 100. `getPublicCategoryBreadcrumb` returns at most 4 rows from one closure read. `publicCategorySubtreeCondition` selects a category and its published descendants for listings.
