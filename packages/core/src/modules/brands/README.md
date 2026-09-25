# Brands

Brand records (migration 0090 `brands`): name, slug, optional logo from Files,
description, merchant sort order, SEO fields, listing template, `draft |
published` status, revision and soft delete. `products.brand_id` points here
(ON DELETE SET NULL). Brand pages live at `/brands/<slug>`.

## Files

| File | Purpose |
|------|---------|
| `brands.validation.ts` | Browser-safe write schemas (create, edit, status, revision claims); record rules come from `@scalius/shared/catalog-brand` |
| `brands.service.ts` | Dashboard/agent reads and revision-guarded writes |
| `brands.storefront.ts` | Buyer reads (brand page, brand list, brand sitemap) and the public-brand join used by `catalog` |
| `index.ts` / `browser.ts` | Server entry / browser entry (validation only) |

## Rules

- **Public means published and live.** A draft or trashed brand shows nowhere.
  Its products keep `brand_id` but show no brand line, feed `<g:brand>` or
  JSON-LD `brand`. Brand identity comes only from this record: a free-text
  "Brand" attribute is never promoted to a brand, and a missing brand is
  omitted, never a placeholder such as "Generic".
- **Revision CAS.** Every edit, status change, trash, restore and permanent
  delete claims `expectedRevision`; a stale claim is `BRAND_REVISION_CONFLICT`
  (409), the wrong lifecycle state `BRAND_STATE_CONFLICT` (409).
- **Slugs.** Unique across live and trashed brands. Omitted on create, the slug
  is derived from the name (`HP` → `hp`, Bangla transliterated) and suffixed
  `-2`, `-3`… until free; a typed taken slug is a conflict.
- **Logo.** A newly chosen logo must be a `ready` image; the check runs inside
  the write. The FK is `restrict`, and Files lists the brand under "Used in"
  (`media.usage.ts`, kind `brand`), so a logo in use cannot be deleted.
- **Trash** forces `draft`; **restore** returns a draft; **permanent delete**
  only from trash, advancing each affected product's editor revision in the
  same batch while the FK clears `products.brand_id`.
- **Cache generation.** Every write is buyer-visible: the API route calls
  `bumpCacheGeneration(c)` after it commits.
- **Canonical path** is `/brands/<current slug>` or blank.

## Reads

| Function | Bound | Index |
|----------|-------|-------|
| `getPublicBrandBySlug` | one row | `brands_slug_unique` |
| `listPublicBrands` | ≤ 100 per page | `brands_public_idx` |
| `getPublicBrandSitemapEntries` | ≤ 5,000 | `brands_public_idx` |
| `listBrands` (admin) | ≤ 100 per page, product counts per row | `products_public_brand_newest_idx` |
| `listBrandOptions` (picker) | ≤ 50 | — |

A brand's product listing is `catalog`'s `getStorefrontBrandProducts` (the
storefront catalogue scoped by `products.brand_id`).

## Dependencies

`@scalius/database` (`brands`, `media`, `products`), `@scalius/shared`
(`catalog-brand`, `catalog-tree`, `handle`, `seo-canonical`), the core media URL
helper. No other domain: `catalog` depends on `brands` (public brand join), never
the reverse.
