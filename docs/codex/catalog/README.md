# Catalog Hardening Audit

Last reviewed: 2026-07-12

This is the durable working record for the Products, Categories, Attributes, Collections, Inventory, catalog settings, and storefront catalog hardening program. Source, tests, fresh runtime evidence, and deployed behavior remain authoritative. Update these files when a finding is disproved, fixed, or newly verified; do not let them become a parallel stale tracker.

## Scope and product direction

- Admin catalog workflows must be compact, keyboard-complete, permission-aware, explicit about save/error state, and fast at large catalog sizes.
- D1 remains authoritative for catalog, SKU, inventory, order, and money facts. Cache/KV rows are projections or hints.
- Products are merchandising containers; `product_variants` are the sellable and inventory identities, including one protected default SKU for simple products.
- Buyer-visible list, detail, checkout, feed, sitemap, UCP, and JSON-LD projections must resolve the same availability, pricing, option, media, and discovery truth.
- Storefront product-page visual design and interaction layout are owner-protected. Correctness, cache isolation, and narrowly scoped accessibility fixes are allowed; do not redesign that page.
- The existing admin visual direction is strong. The principal gap versus Shopify and Medusa is operational truth and interaction consistency, not decoration.

## Files

- [ADMIN.md](ADMIN.md) — admin routes, forms, tables, permissions, error states, destructive actions, and settings UX.
- [DOMAIN.md](DOMAIN.md) — schema, services, inventory ledger, variants, attributes, collections, currency, and D1 limits.
- [ATTRIBUTES.md](ATTRIBUTES.md) — attribute authority, admin assignment/value workflows, public facet versus fact semantics, verified defects, and release tests.
- [INVENTORY.md](INVENTORY.md) — inventory authority, adjustment/stocktake semantics, movement history, RBAC, currency boundary, and remaining scale gaps.
- [STOREFRONT.md](STOREFRONT.md) — buyer catalog, caching, pricing, discovery, feeds, UCP, category/search UX, and protected product-page boundaries.
- [PRODUCT-EDITOR-UX.md](PRODUCT-EDITOR-UX.md) — product create/edit interaction, conflict, keyboard, and responsive UX contract.
- [DECISIONS.md](DECISIONS.md) — accepted decisions, implementation order, verification requirements, and deferred model work.
- [PROGRESS.md](PROGRESS.md) — landed fixes, regression evidence, known remaining gaps, and the next implementation slice.

## Competitive principles adopted

- Shopify: bulk editing, explicit publication/readiness, variant-level inventory truth, conflict-safe inventory changes, and complete audit paths.
- Medusa: explicit product-option-variant-inventory relationships and clear separation between catalog collections and merchandising modules.
- Figma: speed is a feature; fixed, predictable work surfaces beat visually novel controls that slow expert workflows.
- Notion: dense tables work when search, filters, views, keyboard navigation, and row-to-detail transitions remain predictable.

## Live evidence sampled on 2026-07-12

- Production admin Products, Categories, Attributes, Collections, Inventory, General Settings/Currency, product detail, and create forms were inspected in authenticated Chrome.
- Production storefront product and category pages were inspected at desktop and 390x844 mobile viewport.
- No production mutation was performed.
- Confirmed visible defects included an impossible product-detail updated year, internal variant-image marker leakage into the admin SEO card, generic option labels on product detail, incomplete initial inventory loading truth, ambiguous inventory movement signs, inaccessible inventory adjustment controls, and a horizontally clipped mobile admin product table.

## Release stance

Do not describe the catalog as Shopify-class while any open P0/P1 below remains. Cosmetic redesign follows correctness, inventory replay safety, currency safety, cache isolation, and truthful catalog projections.
