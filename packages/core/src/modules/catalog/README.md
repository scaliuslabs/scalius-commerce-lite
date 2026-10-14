# Catalog

The buyer-facing catalogue reads: listings, facets, the product page, comparison, site search, product feeds, sitemaps, recommendations, collection pages, homepage product lists and the dashboard feed tools. Read this before you change a public catalogue read or its cache dependencies. The product rules these reads use (public eligibility, buyer pricing, media) are in [`../products`](../products/README.md).

## Entries and layer

`index.ts` is the only entry. There is no `browser.ts`. It exports the read modules (listing, compare, product page, search, site search, feed, sitemap, recommendations, feed diagnostics, collections, cards, home lists) and parts of `facets`, `product-reviews` and `home-brands`. `shared.ts`, `buyer-state.ts`, `declare-deps.ts`, `search-correction.ts` and `search-relevance.ts` stay internal.

Layer L5. The domain imports `brands`, `categories`, `collections`, `custom-fields`, `markets`, `products`, `promotions` and `settings`. `navigation` and `storefront` import `catalog`. Collection reads and site search live here; the collection records live in `collections`.

## Owns

The domain declares no settings document. It writes `product_recommendations` (stored top 24 per product) and `product_sales_stats` (units sold in 30 days) in `recommendation-refresh.ts`. It reads the projections that `products/catalog-projections.ts` writes in the batch of every product, SKU and stock write: `product_buyer_state` (one row per product: `is_public`, card SKU, price range in minor units, `availability_band`, category, brand; every listing, count and sitemap read starts here) and `product_facet_values` (one row per attribute value and per option value on a live SKU).

Readers declare DVC dependencies through `declare-deps.ts` (see [`cache-deps`](../../cache-deps/README.md)): a card its product and image keys, a listing the keys of its scope plus the order, filter and facet keys it used.

## Routes

All paths are under `/api/v1` and public except the last two (admin).

| Path | Note |
|------|------|
| `GET /products` | Shop listing. |
| `GET /products/{slug}`, `/{slug}/sections/{section}` | Product page; section text in chunks of 12,000 characters, 60 KiB result cap. |
| `GET /products/search` | Legacy search with SKUs, page paging, never cached. |
| `GET /products/compare?ids=` | 1 to 4 public products. |
| `GET /products/recommendations` | Up to 20 source ids, limit 1 to 12 (default 8). |
| `GET /products/feed`, `/products/sitemap` | Feed and sitemap sources. |
| `GET /products/{id}/reviews` | Keyset pages of 10 (max 20). |
| `GET /search` | Products, pages and categories in one batch. |
| `GET /categories/{slug}/products`, `/brands/{slug}/products` | Scoped listings. |
| `GET /collections`, `/collections/directory`, `/collections/sitemap`, `/collections/{id}` | Collection catalogue, directory, sitemap entries. |
| `GET /attributes/category/{categoryId}`, `/category-slug/{categorySlug}`, `/search-filters` | Facets for agents and tools. |
| `GET /admin/settings/seo/feed-diagnostics`, `/seo/feed-row-preview/{productId}` | Feed tools (admin). |
| `GET /admin/collections/product-options` | Collection product picker (admin). |

## Rules

### Listings and facets

- Public products are the `product_buyer_state` rows with `is_public = 1` (it includes the online store's publication). Live cart and checkout validation stay authoritative.
- The listing routes take `page` or `cursor`. A cursor continues `newest`, `price-asc` and `price-desc` only. Other orders (relevance, name, discount, rating) page by number. A numbered page past `planLimits().lists.maxOffset` (1,000 on Free, 10,000 on Paid) is empty. The total stops at `lists.countCap`.
- A search with no hit is retried once with the closest catalogue words. The response carries `correctedQuery`.
- Relevance search selects the ordered page IDs before loading card SKU, rating and translation fields, within the same statement; counts and facets still cover the full matching set.
- A category listing includes its published descendants. A draft or internal descendant's products stay out of the parent.
- Public variants carry `availabilityBand`, never an exact stock count (`maskPublicBuyerAvailability`).
- Facet filters come from the query string: `?<attribute slug>=<value>` (repeat for OR within a facet, AND across facets), `?<slug>.min=` and `.max=` for number attributes, `?option.<axis>=<value>` (matched on one live SKU) and `?brand=<slug>` (published brands). A request carries at most 90 filter values. Unknown slugs and values are dropped.
- One statement counts every facet. Each value counts the products that match every other facet's selection. Caps: 50 attribute facets, 100 values per facet, 500 for brands.
- The same SQL runs on D1, Turso and PostgreSQL. The scope is read once through the listing's own index. Attribute and option values are counted from the scoped products' own facet rows only while the scope holds at most 5,000 products (`FACET_SCOPE_PRODUCT_LIMIT`). A larger scope keeps its brand, category and rating facets.
- The plain shop-all page (no scope, no selection) reads attribute and option counts from `product_facet_public_counts` at any catalogue size. Each value's label, order and sample SKU come from its first public facet row. Shop-all with a selection counts live only within the same 5,000-product limit.
- Scoped listings reuse that statement's matching set for their exact total and price range, outside the facet caps. A selected price bound still reads its unpriced range separately; shop-all remains count-first.
- Rating thresholds share one aggregate over the matching products; expand that aggregate into choices afterward, preserving zero counts and the selected threshold for empty scopes.
- The category-tree facet (`kind: "category"`) holds links, never a filter. A category's effective attribute set (see `attributes`) orders and restricts its facets.

### Feeds and sitemaps

- `GET /products/feed` is cursor-paged (`feed-v1.` cursor), newest first, at most 100 per page. A `page` other than 1 is refused.
- A product enters the feed when it is public with a buyer SKU, has a live physical SKU, has a real primary image and is published to the feed's sales channel (`?channel=`: `sc_google` by default, `sc_meta`, `sc_agents` for UCP) while that channel is active. Gift cards and products with service or digital SKUs stay out. Leaving a feed's channel does not hide or noindex the product page; leaving the online store does (see [`products`](../products/README.md)).
- `projectCatalogFeedRows` (`packages/shared/src/catalog-feed-row.ts`) builds the rows. The storefront renders them as XML (`apps/storefront/src/pages/api/product-feed.xml.ts`, `facebook-feed.xml.ts`).
  - Availability: Google `in_stock` and `out_of_stock`; Meta `in stock` and `out of stock`.
  - Brand comes only from the published brand record. GTIN comes only from a variant barcode of type `ean13`, `upc`, `isbn` or `gtin`. Condition comes only from `products.product_condition`. Taxonomy categories come only from the explicit slug mapping. A missing fact is omitted, never invented.
  - A row whose original or current price is not positive is omitted (`non_positive_price`). `<g:sale_price>` appears only when it is lower than `<g:price>`.
  - The default strategy is one row per SKU (`variants`). The feed policy can switch it to one row per product. An empty catalogue gives a valid empty feed.
- `feed-diagnostics.ts` scans the 500 most recently updated products and returns counts per skip reason with 5 samples each (at most 50). `feed-row-preview.ts` returns at most 10 rows per call within a 46 KiB budget. Both are read-only and follow the XML feed's policy.
- `getStorefrontSitemapProducts` filters `noIndex` and `excludeFromSitemap` in the query, before paging. `getPublicCollectionSitemapEntries` does the same for active, live collections, with a limit of 5,000.

### Recommendations, cards and homepage

- A product page reads its stored list (filtered to products still public). The live ranking runs for a product never computed, for several source products (cart, order) and for none (404, search dead end). A live result declares `recommendation-signals` and the next order-window boundary.
- Live ranking scores a bounded pool: co-buy peers of the source products' latest 1,000 real orders, the 200 newest public products of each source and collection-rule category, manual collection members, the first 200 products sharing each source attribute value, and the `limit` most popular and newest eligible products. The price band lifts related products only, so the unrelated tail (popularity, then newest) is exact. Popularity counts distinct buyers among the latest 5,000 order/product pairs of the last 30 days. Ranking and cache expiry share one statement, including an expiry result when nothing ranks. Order timestamps, not line timestamps, define the windows.
- `reason` is `also_bought` only when at least two distinct buyers co-bought for at least half the list. Otherwise it is `similar`, `popular` or `new_arrivals`.
- Stored lists stay fresh three ways (`apps/api/src/background/catalog.ts`, `apps/api/src/scheduled/catalog-projections.ts`). A product write recomputes, right after the response, the product, the products that list it and its newest category peers, up to `planLimits().background.recommendationProductsAfterWrite`. The rotation recomputes the next public products in id order after a `system_kv` cursor (`catalog:recommendations:rotation-cursor`, `recommendationRotationBatch`): a lap visits every public product once, and the next lap starts a day after this one started. The nightly tick (02:00 store time) refreshes `product_sales_stats` and the lists of products sold that day (`recentlySoldPublicProducts`).
- Card facts (`card-facts.ts`: published brand, up to 4 key specs, option axes, units sold from 10, pack size, cheapest delivery rate) come from stored data and are omitted when missing. One statement serves a page of cards inside a batch the page already runs.
- `planHomeProductLists` (newest, on sale, popular, category), `planHomeBrands` and `planCollectionProducts` return statements that `storefront` puts in the homepage's second D1 batch. Each product statement is scoped to its own rows and brings a media statement for the same rows. The on-sale list reads two partial indexes of discounted rows, and its query repeats the index predicates word for word.
- `getPublicCollectionCatalog` lists a collection's products: its picked ids (manual) or the public products of its published categories (dynamic).
