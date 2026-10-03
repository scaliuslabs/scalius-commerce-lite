# Catalog

The buyer-facing catalogue reads: listings, facets, the product page, comparison, site search, product feeds, sitemaps, recommendations, collection pages, homepage product lists and the dashboard feed tools. Read this before you change a public catalogue read or its cache dependencies. The product rules these reads use (public eligibility, buyer pricing, media) are in [`../products`](../products/README.md).

## Entries and layer

`index.ts` is the only entry. There is no `browser.ts`. It exports `listing`, `compare`, `product-page`, `search`, `site-search`, `feed`, `sitemap`, `recommendations`, `feed-diagnostics`, `feed-row-preview`, `storefront-sections`, `cards`, `card-facts`, `home-lists`, `recommendation-refresh` and `collections`, and parts of `facets`, `product-reviews` and `home-brands`. `shared.ts`, `buyer-state.ts`, `declare-deps.ts`, `search-correction.ts` and `search-relevance.ts` stay internal.

Layer L4. The domain imports `brands`, `categories`, `collections`, `custom-fields`, `products`, `promotions` and `settings`. `navigation` and `storefront` import `catalog`. Collection reads and site search live here; the collection records live in `collections`.

## Owns

The domain writes two projection tables and reads the others.

| Table | Content | Written by |
|-------|---------|------------|
| `product_buyer_state` | One row per product: `is_public`, card SKU, price range in minor units, `availability_band`, category, brand. Every listing, count and sitemap read starts here | `products/catalog-projections.ts`, in the batch of every product, SKU and stock write |
| `product_facet_values` | One row per attribute value (owner is the product) and per option value on a live SKU (owner is the SKU) | `products/catalog-projections.ts` |
| `product_recommendations` | Stored top 24 recommendations per product | `recommendation-refresh.ts` |
| `product_sales_stats` | Units sold in 30 days | `recommendation-refresh.ts` (nightly) |

The domain declares no settings document. Readers declare DVC dependencies through `declare-deps.ts` (`deps.*` from `packages/core/src/cache-deps`; keys and triggers in `packages/shared/src/cache-deps.ts`). A card declares `p:<productId>` and the `m:` rows of its images. A listing declares the `lm:`, `lo:` and `lf:` keys of its scope plus the order, filter and facet keys it used. `apps/api/src/cache-deps-catalogue.test.ts` renders each public route in a strict scope. `cache-deps-scale.local.test.ts` checks coverage and the 256-key budget.

## Routes

All paths are under `/api/v1`. The last two rows are admin routes.

| Path | Function |
|------|----------|
| `GET /products` | `getStorefrontProducts`: shop listing |
| `GET /products/{slug}`, `/{slug}/sections/{section}` | `getStorefrontProductBySlug`; `getStorefrontProductSection` (text chunks of 12,000 characters, 60 KiB result cap) |
| `GET /products/search` | `searchStorefrontProducts`: legacy search with SKUs, page paging, never cached |
| `GET /products/compare?ids=` | `getStorefrontProductComparison`: 1 to 4 public products |
| `GET /products/recommendations` | `getStorefrontProductRecommendations`: up to 20 source ids, limit 1 to 12 (default 8) |
| `GET /products/feed`, `/products/sitemap` | `getStorefrontFeedProducts`; `getStorefrontSitemapProducts` |
| `GET /products/{id}/reviews` | `getPublicProductReviews`: keyset pages of 10 (max 20) |
| `GET /search` | `search`: products, pages and categories in one batch |
| `GET /categories/{slug}/products`, `/brands/{slug}/products` | `getStorefrontCategoryProducts`, `getStorefrontBrandProducts` |
| `GET /collections`, `/collections/directory`, `/collections/sitemap`, `/collections/{id}` | `getPublicCollectionCatalog`, `listPublicCollectionDirectory`, `getPublicCollectionSitemapEntries` |
| `GET /attributes/category/{categoryId}`, `/category-slug/{categorySlug}`, `/search-filters` | `getPublicCategoryFacets`, `getPublicSearchFacets`, for agents and tools |
| `GET /admin/settings/seo/feed-diagnostics`, `/seo/feed-row-preview/{productId}` | `getProductFeedDiagnostics`, `executeProductFeedRowPreview` |
| `GET /admin/collections/product-options` | `listCollectionProductOptions` |

## Rules

### Listings and facets

- Public products are the `product_buyer_state` rows with `is_public = 1`. Live cart and checkout validation stay authoritative.
- The listing routes (`/products`, `/categories/{slug}/products`, `/brands/{slug}/products`, `/collections/{id}`) take `page` or `cursor`. A cursor continues `newest`, `price-asc` and `price-desc` only. Other orders (relevance, name, discount, rating) page by number. A numbered page past `planLimits().lists.maxOffset` (1,000 on Free, 10,000 on Paid) is empty. The total stops at `lists.countCap`.
- A search with no hit is retried once with the closest catalogue words. The response carries `correctedQuery`.
- A category listing includes its published descendants. A draft or internal descendant's products stay out of the parent.
- Public variants carry `availabilityBand`, never an exact stock count (`maskPublicBuyerAvailability`).
- Every statement binds at most 90 ids. Wide id sets go in as one `json_each` JSON parameter.
- Facet filters come from the query string: `?<attribute slug>=<value>` (repeat for OR within a facet, AND across facets), `?<slug>.min=` and `.max=` for number attributes, `?option.<axis>=<value>` (matched on one live SKU) and `?brand=<slug>` (published brands). A request carries at most 90 filter values. Unknown slugs and values are dropped.
- One statement counts every facet. Each value counts the products that match every other facet's selection. Caps: 50 attribute facets, 100 values per facet, 500 for brands.
- The category-tree facet (`kind: "category"`) holds links, never a filter. A category's effective attribute set (see `attributes`) orders and restricts its facets.
- Shop-all facet counts run live only while the public catalogue has at most 2,000 products (`SHOP_ALL_LIVE_FACET_PRODUCT_LIMIT`).
- Readers join only live, filterable attribute definitions, so definition writes need no projection refresh.

### Feeds and sitemaps

- `GET /products/feed` is cursor-paged (`feed-v1.` cursor), newest first, at most 100 per page. A `page` other than 1 is refused.
- A product enters the feed when it is public with a buyer SKU, has a live physical SKU, has a real primary image and is not `exclude_from_product_feed`. Gift cards and products with service or digital SKUs stay out. Feed exclusion does not hide or noindex the product page.
- `projectCatalogFeedRows` (`packages/shared/src/catalog-feed-row.ts`) builds the rows. The storefront renders them as XML (`apps/storefront/src/pages/api/product-feed.xml.ts`, `facebook-feed.xml.ts`).
  - Availability: Google `in_stock` and `out_of_stock`; Meta `in stock` and `out of stock`.
  - Brand comes only from the published brand record. GTIN comes only from a variant barcode of type `ean13`, `upc`, `isbn` or `gtin`. Condition comes only from the saved `products.product_condition`. Taxonomy categories come only from the explicit slug mapping. A missing fact is omitted, never invented.
  - A row whose original or current price is not positive is omitted (`non_positive_price`). `<g:sale_price>` appears only when it is lower than `<g:price>`.
  - The default strategy is one row per SKU (`variants`). The feed policy can switch it to one row per product. An empty catalogue gives a valid empty feed.
- `feed-diagnostics.ts` scans the 500 most recently updated products. It returns counts per skip reason with 5 samples each (at most 50). `feed-row-preview.ts` returns at most 10 rows per call within a 46 KiB budget. Both are read-only and follow the XML feed's policy.
- `getStorefrontSitemapProducts` filters `noIndex` and `excludeFromSitemap` in the query, before paging. `getPublicCollectionSitemapEntries` does the same for active, live collections, with a limit of 5,000.

### Recommendations, cards and homepage

- A product page reads its stored list (`product_recommendations`, filtered to products still public). The live ranking runs for a product never computed, for several source products (cart, order) and for none (404, search dead end). A live result declares `recommendation-signals` and the next order-window boundary.
- `reason` is `also_bought` only when at least two distinct buyers co-bought for at least half the list. Otherwise it is `similar`, `popular` or `new_arrivals`.
- The API cron refreshes `product_sales_stats` nightly (the 20:00 UTC tick) and queues `catalog.recommendations.refresh` messages of at most 20 products (5 on the Free plan profile). Code: `apps/api/src/scheduled/catalog-projections.ts`, `apps/api/src/utils/catalog-jobs.ts`.
- Card facts (`card-facts.ts`) come from stored data and are omitted when missing: the published brand, up to 4 key specs, option axes with two or more values, units sold in 30 days from 10, a pack-size attribute and the cheapest active delivery rate. One statement serves a page of cards inside a batch the page already runs.
- `planHomeProductLists` (newest, on sale, popular, category), `planHomeBrands` and `planCollectionProducts` return statements. `storefront` puts them in the homepage's second D1 batch. Each product statement is scoped to its own rows and brings a media statement for the same rows.
- The on-sale list reads two partial indexes of discounted rows (migration 0087). Its query repeats the index predicates word for word.
- `getPublicCollectionCatalog` lists a collection's products: its picked ids (manual) or the public products of its published categories (dynamic).

## Where to look

Listings and facets: `listing.ts`, `facets.ts`, `shared.ts`, `buyer-state.ts`. Product page: `product-page.ts`, `product-reviews.ts`, `compare.ts`, `storefront-sections.ts`. Search: `site-search.ts`, `search.ts`, `search-relevance.ts`, `search-correction.ts`. Feeds: `feed.ts`, `feed-diagnostics.ts`, `feed-row-preview.ts`, `sitemap.ts`. Recommendations: `recommendations.ts`, `recommendation-refresh.ts`. Collections, cards and homepage plans: `collections.ts`, `cards.ts`, `card-facts.ts`, `home-lists.ts`, `home-brands.ts`. DVC declarations: `declare-deps.ts`.

Tests sit beside the code. `catalog-scale-plans.d1.test.ts` guards query plans. The opt-in local tests `facets-scale.local.test.ts` and `cache-deps-scale.local.test.ts` run on a 30,000-product seed (`scripts/catalog-scale-seed.mjs`); the first checks every facet count against a brute-force count.
