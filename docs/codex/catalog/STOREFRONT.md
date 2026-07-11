# Storefront Catalog Audit

Last reviewed: 2026-07-12

The storefront product page’s visual design is owner-protected. Do not redesign it. Correctness and non-visual accessibility/cache fixes must preserve its layout and interaction character.

## P1 correctness and discovery

1. **Variant query HTML cache poisoning.** Product HTML cache removes `size` and `color`, but SSR uses them for the selected SKU, price, availability notice, OG price, and Product/ProductGroup JSON-LD. A variant request can poison base/other variant HTML. Immediate fix: bypass shared HTML Cache API for product requests containing selection parameters; keep base product pages cached.
2. **Listing price/filter/sort is product-row truth, not SKU truth.** Category, search, collection, related, and typeahead cards use product price/discount while detail and checkout use SKU price/discount. Build one buyer-catalog pricing projection for minimum available effective price, price range, discount presence, and availability.
3. **Canonical overrides can point to dead or different resources.** Shape-only validation accepts another slug/ID even though routes resolve only the saved resource handle. Until alias routing exists, require canonical segment equality; long-term add a unique URL-handle/redirect table.
4. **Backend failures become cached-looking 404s.** Product and collection API clients collapse 404/500/timeout/malformed into `null`. Return `found | not_found | unavailable`; only authoritative 404 becomes 404, operational failure becomes no-store 503.
5. **Collection detail is a capped homepage module.** It truncates at 24, has no truthful total/pagination, and ignores `featuredProduct`. Separate catalog collections from homepage merchandising sections.
6. **Quick-buy reimplements pricing.** It uses truthy price checks, `Math.round`, and custom discount logic instead of the precision-aware cart authority. Reuse one shared pricing primitive.
7. **`filterable` controls attribute existence.** Detail/feed/schema lose truthful non-facet facts such as Brand or Material. Separate filterable, buyer-visible, public/exportable, and schema/feed mappings.
8. **UCP pagination metadata is false after eligibility filtering.** Paginate the eligible projection or use a bounded cursor and require the exact protocol version.
9. **Feed pagination scans from page one.** High page numbers cause unbounded work. Move expansion/filtering into a cursor projection with bounded work.
10. **Variant media is encoded in SEO and matched by position.** Move to stable explicit variant/option-value media associations.

## P2 category/search and accessibility

- Product cards need truthful sold-out state and “From”/range semantics based on buyer-resolvable SKUs.
- Price filter defaults to 0–50,000 BDT even though the live catalog contains higher prices; derive bounds from effective catalog prices.
- Facets need multi-select, counts, selected chips, zero-result disabling, and scoping to the current result set.
- Category filter drawer needs dialog semantics, focus trap/restoration, and a labelled close control.
- Disabled pagination must not remain focusable `href="#"`; chevrons need accessible names.
- Search palette needs dialog/combobox/listbox semantics, keyboard-focusable results, and a failure state distinct from no results.
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
