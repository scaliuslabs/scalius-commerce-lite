# Brands

Brand records and their pages: revision-guarded dashboard writes and the buyer reads (brand page, brand list, brand sitemap). Read this before you change a brand write or read. A brand's product listing is not here: `catalog` owns it (`getStorefrontBrandProducts`).

## Entries and layer

| Entry | Exports |
|-------|---------|
| `index.ts` | Everything in `browser.ts`, plus `brands.service.ts` (admin reads and writes, `BRAND_REVISION_CONFLICT`, error classes) and `brands.storefront.ts` (buyer reads, `publicBrandJoinCondition`, logo helpers) |
| `browser.ts` | `brands.validation.ts`: write schemas, `BRAND_BATCH_LIMIT` (90) |

Layer L3. The only domain import is `custom-fields` (the brand page's storefront-visible custom fields). `catalog` and `store-transfer` import `brands`.

## Owns

| Table | Key columns and constraints |
|-------|-----------------------------|
| `brands` | `id` (prefix `brd_`), `name`, `slug` (unique across live and trashed rows), `description`, `logo_media_id` (FK `media`, `restrict`), `status` (`draft`, `published`), `sort_order`, SEO fields (`meta_title`, `meta_description`, `canonical_path`, `no_index`, `exclude_from_sitemap`), `listing_template`, `revision`, `deleted_at` |

`products.brand_id` references `brands.id` with `ON DELETE SET NULL`. The record rules (id, name, slug, statuses) are in `@scalius/shared/catalog-brand`.

DVC: the registry maps `brands` to `b:<brandId>` and `lm:seo` (sitemap lastmod). Buyer reads declare `deps.brand(id)`, `deps.anyBrand()` and `deps.media(logoId)`. The domain declares no settings document.

## Routes

| Surface | Path and file |
|---------|---------------|
| Admin | `/api/v1/admin/brands` in `apps/api/src/routes/admin/brands.ts`: `GET /`, `GET /form-options`, `GET /{id}`, `POST /`, `PUT /{id}`, `PATCH /{id}/status`, `POST /trash`, `POST /restore`, `POST /delete-permanently` |
| Public | `/api/v1/brands` in `apps/api/src/routes/brands.ts`: `GET /`, `GET /sitemap`, `GET /{slug}`, `GET /{slug}/products` |

Brand permissions reuse the category permissions (`packages/core/src/auth/rbac/route-permissions/brands.ts`): `categories.view` to read, `create`, `edit`, `delete`, `restore` and `permanent_delete` to write. `form-options` also admits `products.view`. The admin list uses page and limit paging (limit at most 100), not cursors. `GET /{slug}/products` accepts `page` or `cursor` (see `catalog`).

## Rules

- **Public means published and live.** A draft or trashed brand shows nowhere. Its products keep `brand_id` but show no brand line, feed `<g:brand>` or JSON-LD `brand`. Brand identity comes only from this record: a free-text "Brand" attribute is never promoted, and a missing brand is omitted, never a placeholder.
- **Revision guard.** Edit, status change, trash, restore and permanent delete claim `expectedRevision`. A stale claim is `BRAND_REVISION_CONFLICT` (409). The wrong lifecycle state is `BRAND_STATE_CONFLICT` (409). Bulk writes take at most 90 claims and apply all or none.
- **Slugs.** A typed taken slug is a conflict. An omitted slug derives from the name (`HP` becomes `hp`) and gets `-2`, `-3` until free.
- **Logo.** A newly chosen logo must be a `ready` image; the check runs inside the write. Files lists the brand as a usage of its logo (`media.usage.ts`, kind `brand`), and the FK is `restrict`, so a used logo cannot be deleted.
- **Trash** forces `draft`. **Restore** returns a draft. **Permanent delete** works only from trash. It advances each affected product's aggregate revision and clears `product_buyer_state.brand_id` in the same batch.
- **Canonical path** is `/brands/<current slug>` or blank.
- **Bounds.** `listPublicBrands` returns at most 100 per page, sorted by `sort_order` then name. `getPublicBrandSitemapEntries` returns at most 5,000 published, live brands without `noIndex` or `excludeFromSitemap`, filtered before the limit. `listBrandOptions` (the product form picker) returns at most 50.

## Where to look

`brands.service.ts` (writes and admin reads), `brands.storefront.ts` (buyer reads), `brands.validation.ts` (schemas). Test: `brands.d1.test.ts`.
