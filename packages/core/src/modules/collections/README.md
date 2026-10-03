# Collections

Collection records: curated product groups with manual or dynamic membership, version-guarded admin writes and ordering. Read this before you change a collection write or the `config` JSON. Buyer reads (collection pages, directory, sitemap, the homepage resolvers) and the dashboard product picker are in `catalog` (`catalog/collections.ts`).

## Entries and layer

| Entry | Exports |
|-------|---------|
| `index.ts` | Everything in `browser.ts`, plus `collections.service.ts` and `collections.validation.ts` |
| `browser.ts` | `collection-config.ts`: `normalizeCollectionConfig`, `stringifyCollectionConfig`, `publicCollectionConfig`, `collectionMembershipForConfig`, `collectionProductIdsForLookup`, `COLLECTION_CONFIG_ID_LIMIT` |

Layer L0: the domain imports no other domain. `analytics`, `catalog`, `checkout`, `promotions` and `storefront` import it.

## Owns

| Table | Key columns and constraints |
|-------|-----------------------------|
| `collections` | `id` (bare nanoid), `name`, `presentation` (`grid`, `carousel`), `config` (JSON text), `sort_order`, `is_active`, `version` (CAS token, at least 1), `description`, `content`, SEO fields (`meta_title`, `meta_description`, `canonical_path`, `no_index`, `exclude_from_sitemap`), `listing_template`, `deleted_at` |

DVC: the registry maps `collections` to `col:<collectionId>` and `lm:seo` (sitemap lastmod). The domain declares no settings document and no `deps.*` reads; the buyer readers in `catalog` declare them.

## The `config` column

Every read and write goes through `normalizeCollectionConfig()` or `stringifyCollectionConfig()`. Code never calls `JSON.parse` on `config` itself.

| Field | Rule |
|-------|------|
| `source` | `manual` (ordered `productIds`) or `dynamic` (products of the `categoryIds`). Anything else normalizes to `manual` |
| `categoryIds`, `productIds` | Trimmed, unique, at most 90 each (`COLLECTION_CONFIG_ID_LIMIT`) |
| `featuredProductId` | Optional product shown first |
| `maxProducts` | 1 to 24, default 8 |
| `title`, `subtitle` | Optional homepage text, at most 120 and 240 characters |

- Only the selected source is buyer-visible. The other source's ids stay for reversible admin switching and never reach the storefront.
- `publicCollectionConfig()` returns only `maxProducts`, `title` and `subtitle`. Membership ids stay server-side.
- Presentation does not decide membership or placement. Homepage placement comes from a `collections` section in the published theme, which names collection ids.

## Routes

Admin routes are in `apps/api/src/routes/admin/collections.ts` under `/api/v1/admin/collections`. Permissions are in `packages/core/src/auth/rbac/route-permissions/catalog.ts` (`collections.view`, `create`, `edit`, `delete`, `restore`, `toggle_status`). The list uses page and limit paging (limit at most 100), not cursors.

| Method and path | Purpose |
|-----------------|---------|
| `GET /`, `GET /by-ids`, `GET /form-options`, `GET /category-options`, `GET /product-options` | Lists and picker data (`by-ids` takes at most 90 ids) |
| `GET /{id}`, `GET /{id}/sections/{section}` | One collection; bounded text sections of the two long text fields |
| `POST /`, `PUT /{id}` | Create; update with `expectedVersion` |
| `POST /{id}/products` | Add or remove products of a manual collection, with `expectedVersion` |
| `DELETE /{id}`, `POST /{id}/restore`, `DELETE /{id}/permanent` | Trash, restore, permanent delete |
| `POST /bulk-delete`, `/bulk-activate`, `/bulk-deactivate`, `/bulk-restore` | At most 90 ids |
| `POST /reorder` | Complete list with contiguous positions from 0 and each `expectedVersion` |

The public routes (`apps/api/src/routes/collections.ts`, `/api/v1/collections`) are served from `catalog`: `GET /`, `/directory`, `/sitemap`, `/{id}`.

## Rules

- **Version guard.** `updateCollection`, `updateCollectionProducts`, bulk activate, bulk restore and `reorderCollections` compare the stored `version` and advance it by one. A stale write throws `COLLECTION_REVISION_CONFLICT` (409). Reorder needs the full current list or it conflicts.
- **Publish readiness.** An active manual collection needs at least one product. An active dynamic collection needs at least one category. On create, on activation and on a `config` change, the members of an active collection and any featured product must exist, and the categories of an active collection must be published.
- **`is_active`** publishes the collection page only. It does not place the collection on the homepage.
- **Canonical path** is `/collections/<collectionId>` or blank. Create refuses a canonical path because the id does not exist yet. Update accepts only the collection's own id route. The collection id is the route, not a slug.
- **Soft delete** sets `deleted_at` and advances `version`. Restore appends the collection at the end of the order. Permanent delete works only from trash.
- **Cross-domain guards live in `categories`.** A category cannot be unpublished or trashed while an active dynamic collection uses it. A permanent category delete strips the id from every `config` in the same batch.
- Every statement binds at most 90 ids.

## Where to look

`collection-config.ts` (the `config` parser and stringifier), `collections.validation.ts` (`createCollectionSchema`, `updateCollectionSchema`, `updateCollectionProductsSchema`), `collections.service.ts` (list, sections, version-guarded writes, bulk actions, reorder, `CollectionRevisionConflictError`). Tests sit beside the code: `collection-config.test.ts`, `collections.service.test.ts`, `collections.membership-d1.test.ts`.
