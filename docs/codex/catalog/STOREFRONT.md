# Storefront Catalog Audit

Last reviewed: 2026-07-12

The storefront product page’s visual design is owner-protected. Do not redesign it. Correctness and non-visual accessibility/cache fixes must preserve its layout and interaction character.

## P1 correctness and discovery

1. **Resolved in batch 1: variant-selected HTML bypasses shared cache.** Base and tracking-only product URLs remain cacheable; `size`/`color` requests are private/no-store and cannot poison another selection.
2. **Resolved in batch 3 for current buyer-card surfaces: listing price/filter/sort is SKU truth.** Category, search, collection/home modules, related cards, feed-backed UCP filtering, and command-palette search use one buyer projection with purchasable-SKU preference, exact interval matching, discount inheritance, availability, dynamic bounds, sold-out state, and price-variation semantics.
3. **Canonical overrides can point to dead or different resources.** Shape-only validation accepts another slug/ID even though routes resolve only the saved resource handle. Until alias routing exists, require canonical segment equality; long-term add a unique URL-handle/redirect table.
4. **Resolved in batches 1 and 4: backend failures no longer become cached-looking 404s.** Product and collection clients return `found | not_found | unavailable`; only an authoritative 404 becomes a storefront 404, while operational failures become no-store 503 responses.
5. **Resolved in batch 4: collection detail is a paginated catalog projection.** The public collection response preserves its merchandising metadata and featured product while returning truthful pagination, dynamic price bounds, result-scoped facets, and the shared buyer-resolvable SKU card projection. Explicit products are deduplicated and ordered first; category-derived members follow under the requested/default product sort.
6. **Quick-buy reimplements pricing.** It uses truthy price checks, `Math.round`, and custom discount logic instead of the precision-aware cart authority. Reuse one shared pricing primitive.
7. **`filterable` controls attribute existence.** Detail/feed/schema lose truthful non-facet facts such as Brand or Material. Separate filterable, buyer-visible, public/exportable, and schema/feed mappings.
8. **UCP pagination metadata is false after eligibility filtering.** Paginate the eligible projection or use a bounded cursor and require the exact protocol version.
9. **Feed pagination scans from page one.** High page numbers cause unbounded work. Move expansion/filtering into a cursor projection with bounded work.
10. **Resolved in batches 4 and 6: variant media uses only stable explicit associations.** Product enable/axis settings and image-ID mappings replace positional SEO metadata. Migration 0006 strips the retired markers, blocks reintroduction, and all API/admin/storefront positional readers are removed.

## P2 category/search and accessibility

- Resolved in batch 3: product cards expose truthful sold-out and “From” state from buyer-resolvable SKU pricing.
- Resolved in batch 3: category/search price controls derive live effective SKU bounds and 50,000 is no longer a magic omission/cap.
- Resolved in batch 4: category, search, and collection facets are result-scoped multi-select controls with counts, selected chips, and zero-result disabling.
- Resolved in the categories/attributes slice: the dedicated search-filter projection derives values from exact FTS hits, optional category scope, active/filterable attribute definitions, and buyer-resolvable products rather than every product in a matching category.
- Category filter drawer needs dialog semantics, focus trap/restoration, and a labelled close control.
- Disabled pagination must not remain focusable `href="#"`; chevrons need accessible names.
- Resolved in batch 3: search palette has dialog/combobox/listbox semantics, keyboard-focusable options, focus containment/restoration, and retryable failure distinct from no results.
- Category and search pages duplicate listing/filter/pagination behavior; extract one `CatalogListingPage` boundary before broad iteration.

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
