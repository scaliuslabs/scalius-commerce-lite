# Storefront Catalog Audit

Last reviewed: 2026-07-12

The storefront product page’s visual design is owner-protected. Do not redesign it. Correctness and non-visual accessibility/cache fixes must preserve its layout and interaction character.

## P1 correctness and discovery

1. **Resolved in batch 1: variant-selected HTML bypasses shared cache.** Base and tracking-only product URLs remain cacheable; `size`/`color` requests are private/no-store and cannot poison another selection.
2. **Resolved in batch 3 for current buyer-card surfaces: listing price/filter/sort is SKU truth.** Category, search, collection/home modules, related cards, feed-backed UCP filtering, and command-palette search use one buyer projection with purchasable-SKU preference, exact interval matching, discount inheritance, availability, dynamic bounds, sold-out state, and price-variation semantics.
3. **Canonical overrides can point to dead or different resources.** Shape-only validation accepts another slug/ID even though routes resolve only the saved resource handle. Until alias routing exists, require canonical segment equality; long-term add a unique URL-handle/redirect table.
4. **Resolved in batches 1 and 4: backend failures no longer become cached-looking 404s.** Product and collection clients return `found | not_found | unavailable`; only an authoritative 404 becomes a storefront 404, while operational failures become no-store 503 responses.
5. **Resolved in batch 4: collection detail is a paginated catalog projection.** The public collection response preserves its merchandising metadata and featured product while returning truthful pagination, dynamic price bounds, result-scoped facets, and the shared buyer-resolvable SKU card projection. Explicit products are deduplicated and ordered first; category-derived members follow under the requested/default product sort.
6. **Resolved in the checkout-authority slice: quick-buy shares pricing and revalidates before cart creation.** It uses `calculateVariantPrice()` with the configured currency precision, submits that value to cart validation, and persists only the API's authoritative `unitPrice` after variant, availability, quantity, and price checks.
7. **Resolved in the attribute hardening slice: `filterable` now gates facets and accepted public filters only.** Assigned non-facet facts remain in product detail and feed projections. Explicit buyer-visibility/export/schema mappings remain a future model extension rather than being inferred from facet eligibility.
8. **Resolved in the feed/UCP authority slice: UCP pagination is based on the feed-eligible projection.** The feed query applies active public-product, buyer-resolvable SKU, and usable primary-discovery-image eligibility before continuation; UCP maps those rows and enforces the exact protocol version.
9. **Resolved in the cursor hardening slice: feed/UCP continuation is bounded keyset work.** The dedicated feed projection is newest-only with stable `created_at DESC, id DESC` order, opaque `feed-v1` cursors, and `limit + 1` lookahead. It no longer runs offset or total-count queries. Legacy page cursors and XML `?page=` requests fail explicitly instead of replaying from the beginning. Google/Meta XML limits product groups rather than splitting a product's SKU rows, follows at most `ceil(limit / 100)` API continuations, and publishes the next opaque cursor in an HTTP `Link` header.
10. **Resolved in migration 0007: variant media has one explicit authority.** A SKU's nullable `product_variants.image_id` selects an exact same-product image; an unmapped SKU falls back to the product primary image. The former enable/axis settings and mapping table are removed, and no positional or option-value inheritance remains.

## P2 category/search and accessibility

- Resolved in batch 3: product cards expose truthful sold-out and “From” state from buyer-resolvable SKU pricing.
- Resolved in batch 3: category/search price controls derive live effective SKU bounds and 50,000 is no longer a magic omission/cap.
- Resolved in batch 4: category, search, and collection facets are result-scoped multi-select controls with counts, selected chips, and zero-result disabling.
- Resolved in the categories/attributes slice: the dedicated search-filter projection derives values from exact FTS hits, optional category scope, active/filterable attribute definitions, and buyer-resolvable products rather than every product in a matching category.
- Resolved in the category accessibility slice: the mobile filter drawer has dialog semantics, focus containment/restoration, Escape/backdrop close, scroll lock, and a labelled close control.
- Disabled pagination must not remain focusable `href="#"`; chevrons need accessible names.
- Resolved in batch 3: search palette has dialog/combobox/listbox semantics, keyboard-focusable options, focus containment/restoration, and retryable failure distinct from no results.
- Category and search pages duplicate listing/filter/pagination behavior; extract one `CatalogListingPage` boundary before broad iteration.
- Resolved in the category authority slice: filtered category URLs suppress base-category `CollectionPage` JSON-LD, empty category and empty-filter recovery are distinct, and the category product cache namespace was advanced after live API range truth diverged from stale hydrated controls.

## Protected product-page changes allowed

- Bypass/correct cache identity for query-selected variants.
- Make backend failure semantics 404 versus 503 truthful.
- Reuse the authoritative pricing primitive behind quick-buy.
- Correct primary-image selection to honor `isPrimary`.
- Add missing ARIA relationships, focus containment, labelled controls, and reduced-motion support without changing layout.
- Keep purchase buttons behaviorally safe when no exact SKU is selected, but do not redesign their visual treatment.

## Product-page changes not allowed without owner approval

- New layout, typography, spacing system, gallery composition, option-control visual style, sticky purchase bar, tab visual design, or overall mobile composition.
- Replacing the existing interaction model merely to resemble Shopify/Medusa.

## Cache verification matrix

For an optioned product, request base, valid variant A, valid variant B, invalid combination, and sold-out variant in every cache-fill order. Verify page price, OG price, Product/ProductGroup JSON-LD, availability notice, canonical URL, and `X-Cache-Status` never cross-contaminate.

## Buyer catalog query contract

- Product, category, and collection listing endpoints accept `page`, `limit`, `search`, `sort`, `minPrice`, `maxPrice`, `freeDelivery`, `hasDiscount`, plus repeated attribute-slug query keys such as `color=Blue&color=Red`.
- Repeated values are ORed within one attribute; distinct attributes are ANDed. Only public, non-deleted, filterable attributes and assigned values are accepted. A request may contain at most 90 attribute values after normalization.
- Every listing response returns `products`, authoritative `pagination`, `priceRange`, and `facets`. Facet values are `{ value, count }`; counts exclude the facet's own current selections while retaining all other active filters, so merchants can broaden one axis without losing useful alternatives. Selected values remain removable even when their count is zero.
- `priceRange` retains search, boolean, attribute, category, and collection scope but deliberately excludes the request's own `minPrice`/`maxPrice` clamp. Product cards, totals, bounds, and facet counts all use the buyer-resolvable SKU pricing/availability projection.
- `GET /api/v1/collections/{id}` uses the same query contract and returns collection metadata, configured categories, optional `featuredProduct`, catalog products, pagination, price range, and facets. Missing/deleted/inactive collections return an authoritative 404; transport, server, or malformed-response failures remain `unavailable` at the storefront boundary.
- Collection membership follows canonical `config.source`: manual collections use only the saved ordered product IDs; dynamic collections use only selected categories and automatically admit newly eligible products. Runtime legacy inference is intentionally absent. Public list/detail, homepage resolution, sitemap, canonical, and structured-data visibility continue to require an active non-deleted collection.
- Resolved in the cross-domain cache slice: product and category catalog writes include collection projections, while stock/order availability writes resolve only active collections that depend on the affected product IDs, category IDs, or featured-product IDs. Those writes invalidate the affected `api:collections:/api/v1/collections/{id}` exact/query families, `collection_by_id_{id}::` storefront generation families, and `/collections/{id}` HTML paths without globally cooling unrelated collection detail caches. Product/order/variant subject lookups stay below D1's 100-binding ceiling, and collection config membership uses bound `json_each()` lookup sets rather than unbounded parameter lists.
- Storefront canonical URLs and HTML/L2 cache keys preserve repeated attribute values with stable ordering. The first server pass forwards plausible dynamic keys to obtain authoritative facets; the second pass drops unknown or unavailable values and redirects to the canonical URL.

## Feed and UCP continuation contract

- `GET /api/v1/products/feed` accepts `cursor`, `limit`, and the existing buyer/feed filters. It intentionally does not accept `page` or arbitrary sorting; feed identity is stable newest order only.
- A continuation cursor is opaque to callers and represents the last returned product's `(created_at, id)` keyset position. The API returns `pagination.limit`, `pagination.hasNextPage`, and `pagination.cursor` only when another product exists. Total count is deliberately omitted because computing it would reintroduce work proportional to the whole filtered catalog.
- XML `limit` counts product groups, not emitted `<item>` rows. Every selected product's eligible SKU rows remain adjacent and share stable `item_group_id`; a product is never split across two continuation documents.
- UCP catalog search passes the cursor through unchanged and returns it using protocol `pagination.cursor`/`has_next_page`. The retired `page:N` cursor shape is a recoverable `request_invalid` outcome. Lookup remains a bounded ID query and does not paginate.
