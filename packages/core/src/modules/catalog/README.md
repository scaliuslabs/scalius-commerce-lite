# Catalog Module

Buyer-facing catalogue reads. Every read here is bounded (chunked id enrichment at 90 or fewer, sequential waves) and uses the product rules from [`../products`](../products/README.md): public eligibility, buyer pricing and availability bands, media resolution. Category, collection, attribute and (future) brand records keep their own domains beside this one; this module reads them.

Public entry: `index.ts`.

## Files

| Path | Exports | Purpose |
|------|---------|---------|
| `listing.ts` | `getStorefrontProducts()`, `getStorefrontCategoryProducts()`, `getStorefrontCollectionProducts()`, `storefrontCollectionVisibleCountQuery()` | Shop, category and collection listings |
| `facets.ts` | `OPTION_FACET_PREFIX`, `PublicProductFacet` | Attribute and option-axis filters and result-scoped facet counts (typed attributes extend this file) |
| `product-page.ts` | `getStorefrontProductBySlug()` | The product page read |
| `search.ts` | `searchStorefrontProducts()` | Storefront product search |
| `feed.ts` | `getStorefrontFeedProducts()`, `getEligibleStorefrontFeedProductById()`, `getFeedProjectionDiagnosticById()` | Google/Base and Meta catalogue feed rows |
| `sitemap.ts` | `getStorefrontSitemapProducts()` | Product sitemap rows (noIndex and sitemap exclusions filtered before paging) |
| `recommendations.ts` | `getStorefrontProductRecommendations()` | Ranked recommendations |
| `storefront-sections.ts` | homepage/section product resolution | Storefront sections |
| `home-lists.ts` | `planHomeProductLists()` | Homepage section product lists (newest, on sale, popular, a category) planned into the homepage's second D1 batch, each scoped to its own products and paired with the media statement of exactly those rows. On sale reads its window from two partial indexes of discounted rows (migration 0087; the queries repeat the index predicates word for word); popular aggregates the 30-day order window once per statement and checks eligibility on its top candidates only. At 30k products: on sale 7k rows (1.8k with ten old sales), popular 71k rows (grows with 30-day orders, not the catalogue) |
| `cards.ts` | `buildCollectionProductSelect()`, `resolveProductCards()` | Buyer cards for curated lists (homepage collections and section lists) |
| `feed-diagnostics.ts`, `feed-row-preview.ts` | bounded read-only feed diagnostics and row preview | Dashboard feed tools, same policy as the XML feed |
| `shared.ts` | -- | Helpers shared by the reads (not exported) |

## API Endpoints

### Storefront Products (`/api/storefront/products`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | `getStorefrontProducts` | Paginated list with category, search, price range, freeDelivery, hasDiscount, attribute filters, sort, `hasVariants`, and SKU-aware `availableForSale` |
| GET | `/feed` | `getStorefrontFeedProducts` | Dedicated feed projection with description, primary image, category summary, filterable attributes, SKU-aware availability, and buyer-safe variants bulk-read for the current page |
| GET | `/search` | `searchStorefrontProducts` | Lightweight search with variants for cart/checkout |
| GET | `/recommendations` | `getStorefrontProductRecommendations` | Ranked buyable products for up to 20 source ids (cart, order) or, without ids, popular/newest. `reason` (`also_bought` only with ≥2 distinct co-buyers for at least half the list, `similar`, `popular`, `new_arrivals`) drives an honest title. One ranking statement plus one media read; cached by store cache generation, so order-based ranking refreshes with the next buyer-visible write or the one-day ceiling. |
| GET | `/{slug}` | `getStorefrontProductBySlug` | Full product detail with variants, images, attributes, additionalInfo, recommendations |

### Storefront Category Products (`/api/v1/categories`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/{slug}/products` | `getStorefrontCategoryProducts` | Category-scoped product list using shared public list filtering/sort helpers, preserving the category-products response shape |

### Storefront Attributes (`/api/storefront/attributes`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/filterable` | inline | All filterable attributes with their unique values (1h cache) |
| GET | `/category/{categoryId}` | inline | Filterable attributes scoped to a category by ID (30m cache) |
| GET | `/category-slug/{categorySlug}` | inline | Filterable attributes scoped to a category by slug (30m cache) |
| GET | `/search-filters?q=X&categoryId=Y` | inline | Filterable attributes for search results (based on matching product categories) |
