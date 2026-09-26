# Catalog Module

Buyer-facing catalogue reads. Every read here is bounded (chunked id enrichment at 90 or fewer, sequential waves) and uses the product rules from [`../products`](../products/README.md): public eligibility, buyer pricing and availability bands, media resolution. Category, collection, attribute and (future) brand records keep their own domains beside this one; this module reads them.

Public entry: `index.ts`.

## Files

| Path | Exports | Purpose |
|------|---------|---------|
| `listing.ts` | `getStorefrontProducts()`, `getStorefrontCategoryProducts()`, `getStorefrontBrandProducts()`, `getStorefrontCollectionProducts()`, `storefrontCollectionVisibleCountQuery()`, `SHOP_ALL_LIVE_FACET_PRODUCT_LIMIT` | Shop, category, brand and collection listings over the stored buyer state (`product_buyer_state` indexes: newest, price, category, brand). Shop-all facet counts run live only up to 2,000 public products |
| `buyer-state.ts` | -- | The public buyer set and card pricing columns read from `product_buyer_state` (kept by `products/catalog-projections.ts`); not exported |
| `facets.ts` | `resolvePublicAttributeFilters()`, `getPublicCategoryFacets()`, `getPublicSearchFacets()`, `PublicProductFacet` | Typed facet filters and counts over `product_buyer_state` ⋈ `product_facet_values`: attribute values and number ranges, option axes on one SKU, the brand entity. One statement counts every facet (see "Facets" below) |
| `compare.ts` | `getStorefrontProductComparison()`, `loadProductSpecGroups()`, `MAX_COMPARE_PRODUCTS` | Up to 4 public products side by side with specs grouped by attribute group; `loadProductSpecGroups` is the grouped spec-table read the product page reuses |
| `product-page.ts` | `getStorefrontProductBySlug()` | The product page read |
| `search.ts` | `searchStorefrontProducts()` | Storefront product search |
| `feed.ts` | `getStorefrontFeedProducts()`, `getEligibleStorefrontFeedProductById()`, `getFeedProjectionDiagnosticById()` | Google/Base and Meta catalogue feed rows |
| `sitemap.ts` | `getStorefrontSitemapProducts()` | Product sitemap rows from the buyer state's newest index (noIndex and sitemap exclusions filtered before paging) |
| `recommendations.ts` | `getStorefrontProductRecommendations()`, `rankRecommendationRows()` | One product's stored top 24, filtered by the current buyer state; the live ranking (buyer state only) for carts, pages without a source and products never computed |
| `recommendation-refresh.ts` | `refreshProductRecommendations()`, `recommendationRefreshTargets()`, `nightlyRecommendationRefreshCandidates()`, `refreshProductSalesStats()` | Off-request refresh of `product_recommendations` (queue `catalog.recommendations.refresh`, 20 products a message) and `product_sales_stats` (nightly) |
| `storefront-sections.ts` | homepage/section product resolution | Storefront sections |
| `home-lists.ts` | `planHomeProductLists()` | Homepage section product lists (newest, on sale, popular, a category) planned into the homepage's second D1 batch, each scoped to its own products and paired with the media statement of exactly those rows. On sale reads its window from two partial indexes of discounted rows (migration 0087; the queries repeat the index predicates word for word); popular walks `product_sales_stats` (units sold in 30 days, refreshed nightly) by its popularity index, public products only. At 30k products: on sale 7k rows (1.8k with ten old sales). Newest and category lists take their members from the buyer-state newest indexes (`lm:all`, `lm:cat:<id>`). Each list also returns the ids its selection read (members, or the on-sale candidate window) as one more statement and declares every one's `p:`, shown or not; on sale adds `lo:sale:all` (any write to a discount-marked product or live SKU) |
| `home-brands.ts` | `planHomeBrands()` | Brand-wall catalog selection: public brands with buyer-resolvable public products, using shared brand publication/logo rules in the homepage's second batch |
| `cards.ts` | `buildCollectionProductSelect()`, `resolveProductCards()` | Buyer cards for curated lists (homepage collections and section lists) |
| `card-facts.ts` | `selectProductCardFactRows()`, `resolveProductCardFacts()`, `loadCatalogCardData()` | What a card can say beyond title and price, from stored data only: the published brand, up to four key specs in spec-table order, option axes with two or more values on live SKUs (colour swatches from a swatch attribute), units sold in 30 days from 10, a pack-size attribute, and the cheapest active delivery rate. One four-term statement (D1 allows five) per page of cards, batched with the card media in listings and put in the batch homepage and collection plans already run: no page gains a round trip |
| `feed-diagnostics.ts`, `feed-row-preview.ts` | bounded read-only feed diagnostics and row preview | Dashboard feed tools, same policy as the XML feed |
| `shared.ts` | -- | Helpers shared by the reads (not exported) |
| `declare-deps.ts` | `declareProductCards()`, `declareRequestedProducts()` | Cache dependency declarations (`CACHE-DESIGN.md` §6.5): a card is `p:` plus the `m:` rows its images come from (primary and hover photo, never the rest of the gallery); a listing is `lm:`/`lo:price:` of its scope plus the order, filter and facet keys it used. Every read here declares where it loads; `apps/api/src/cache-deps-catalogue.test.ts` renders each public catalogue route in a strict scope and `cache-deps-scale.local.test.ts` checks coverage and the 256-key budget at 30k products |

## API Endpoints

### Storefront Products (`/api/storefront/products`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | `getStorefrontProducts` | Paginated list with category, search, price range, freeDelivery, hasDiscount, inStock (the stored `available_for_sale`), attribute filters, sort, `hasVariants`, and SKU-aware `availableForSale` |
| GET | `/feed` | `getStorefrontFeedProducts` | Dedicated feed projection with description, primary image, category summary, filterable attributes, SKU-aware availability, and buyer-safe variants bulk-read for the current page |
| GET | `/search` | `searchStorefrontProducts` | Lightweight search with variants for cart/checkout |
| GET | `/recommendations` | `getStorefrontProductRecommendations` | Ranked buyable products for up to 20 source ids (cart, order) or, without ids, popular/newest. `reason` (`also_bought` only with ≥2 distinct co-buyers for at least half the list, `similar`, `popular`, `new_arrivals`) drives an honest title. One ranking statement plus one media read; cached by store cache generation, so order-based ranking refreshes with the next buyer-visible write or the one-day ceiling. |
| GET | `/{slug}` | `getStorefrontProductBySlug` | Full product detail with variants, images, attributes, additionalInfo, recommendations |

### Storefront Category Products (`/api/v1/categories`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/{slug}/products` | `getStorefrontCategoryProducts` | Category-scoped product list using shared public list filtering/sort helpers, preserving the category-products response shape |

### Storefront Attributes (`/api/v1/attributes`)
Facet definitions outside a listing (agents, tools); storefront pages read the facets of their listing response instead. `GET /attributes/filterable` was removed (F20: 1.65M rows, no caller).
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/category/{categoryId}` | `getPublicCategoryFacets` | Typed facets of a category and its published sub-categories (≤ 20 attribute facets, 30 values) |
| GET | `/category-slug/{categorySlug}` | `getPublicCategoryFacets` | The same by slug |
| GET | `/search-filters?q=X&categoryId=Y` | `getPublicSearchFacets` | Typed facets of a search's public hits |

### Product comparison
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/products/compare?ids=a,b,c,d` | `getStorefrontProductComparison` | 1-4 product ids; non-public ids are left out; one wave of three statements |

## Facets

URL contract (`resolvePublicAttributeFilters`, one statement; none for option-only filters):

- `?<attribute slug>=<value>`: repeatable, OR within a facet, AND across facets. Values are normalised: text and enum values lowercased and trimmed (an enum value must exist), numbers canonical (`15.6`), booleans `1`/`0`.
- `?<slug>.min=` / `?<slug>.max=`: inclusive range on a number attribute's `value_number`.
- `?option.<axis>=<value>`: merchant option axes, matched on one live SKU (a Chalk 42 SKU for Chalk + 42).
- `?brand=<brand slug>`: published brands (`product_buyer_state.brand_id`). A legacy attribute whose slug is `brand` is neither filterable nor offered.

Counts (`buildCatalogFacetCountQuery`): the listing scope (public set, category or subtree, search, price, collection, brand page) is read once through its own index and materialized with each product's match flags; attribute rows are probed by primary key (owner = product) and option rows through `product_facet_values_product_idx`, in a fixed `CROSS JOIN` order. Each value counts products matching every other facet's selection. Readers join only live, filterable attribute definitions, so definition writes (filterable, display, unit, order, trash) need no projection refresh. A category's effective attribute set (its own and its ancestors', root first) orders and restricts its attribute facets. The same statement counts the category-tree facet (`kind: "category"`, values are category slugs to link to, never a filter): a subtree listing counts each published child of the category over its subtree (closure rows by descendant), and search, collection, brand and shop-all listings count the published category each product sits in; one category is no choice, so the facet needs two values. Caps: 50 attribute facets, 100 values per facet and 500 for brands (most common first, selected values always kept); range facets return their bounds instead of values. A subtree listing's rows also carry `subcategoryId`, the child whose subtree holds the product (shelves group by it), from the categories read the page already makes. Shop-all counts stay live only up to 2,000 public products.

Measured on the 30k-product seed after typing it (`facets-scale.local.test.ts`, which also proves every count, range and total equal to a brute-force count from the source tables): the 3.3k-product Laptop page reads 128k D1 rows in 123 ms (the facet statement 110k rows, 55 ms), 155k with two enum filters, 246k with two option axes, a small leaf 3.3k rows.
