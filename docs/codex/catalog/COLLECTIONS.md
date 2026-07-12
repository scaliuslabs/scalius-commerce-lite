# Collections audit and decisions

Last reviewed: 2026-07-12

This is the durable end-to-end contract for collection administration,
membership, homepage presentation, public collection pages, discovery, and
cache invalidation. Source, focused tests, generated contracts, and fresh
runtime evidence remain authoritative.

## Product model

A collection has two independent axes:

- `config.source`: `manual` preserves an explicitly ordered product list;
  `dynamic` derives membership from one or more categories.
- `presentation`: `grid` or `carousel` controls only the homepage component.

The public collection page is always the stable ID route
`/collections/<collectionId>`. `config.maxProducts` limits only the homepage
section; the public collection page remains filterable and paginated.

Inactive collections are drafts. Active collections must have membership for
their selected source. Stale selections from the inactive source may remain in
saved config so source switching is reversible, but they never affect public
membership or cache dependency matching.

## Verified strengths

- Config parsing is canonical and bounded to 90 product/category IDs, below
  D1's 100-bound-parameter ceiling.
- Manual order is preserved. Dynamic category order is preserved for category
  metadata while product results are de-duplicated.
- Buyer product projections use public product eligibility, SKU-derived price,
  availability, media, and option truth rather than admin product rows.
- Public detail supports search, price, delivery, discount, attribute filters,
  facets, pagination, canonical/noindex policy, CollectionPage schema, and
  BreadcrumbList schema.
- Product/category writes resolve dependent active collections and invalidate
  API detail/query variants, storefront data prefixes, rendered HTML paths,
  homepage/layout groups, and collection sitemap discovery.
- Admin product lookup is paginated, debounced, cache-keyed by filters, and
  distinguishes lookup errors from empty results.

## Landed in the 2026-07-12 hardening slice

- Collection rows now carry a positive monotonic `version`. Form edits, inline
  name/status edits, activation, restore, and full-set reorder use or advance
  that token; stale edits fail with a conflict instead of silently overwriting.
- Active saves and activation validate the selected membership references;
  every configured lead product is also checked for a real non-trashed row.
- Reorder requires the complete non-trashed set, unique contiguous positions,
  matching versions, and no more than 90 rows. Restore appends selected rows in
  request order after the current live tail.
- Public collection and homepage payloads now expose only display config.
  Membership and lead-product IDs remain internal after server-side resolution.
- Both homepage presentations link to the stable collection ID route. Grid
  presentation places the configured lead product first, de-duplicates it, and
  still respects the homepage item limit.
- The public page uses authoritative pagination total. Its mobile filter toggle
  now exposes dialog/control state, and carousel autoplay respects reduced
  motion.
- The lead-product picker ignores hidden stale dynamic-category filters after
  switching the collection back to manual membership.
- Migration `0015_salty_stepford_cuckoos.sql` seeds existing rows at version 1.
  Its focused SQLite smoke protects both row preservation and the positive
  version constraint.

## Remaining scale and workflow gaps

1. Dynamic homepage resolution still creates one statement per unique category
   in a single D1 batch. The per-config ID bound does not bound the aggregate
   across many active collections; replace this with bounded waves or a set-based
   projection before very large multi-category catalogs.
2. New collection sort allocation (`max + 1`) is not serialized. Concurrent
   creates can temporarily share a sort position; full reorder repairs it, but a
   database-backed allocation strategy is still needed if high-rate concurrent
   collection creation becomes a real workload.
3. Bulk deactivate and soft-delete advance versions but do not accept client
   expected versions. They are explicit operator actions rather than editor
   saves, but they can still race another write and should eventually use a
   command-level revision contract.

## Accepted implementation decisions

- Add a monotonic collection `version`; editor and inline single-row edits carry
  `expectedVersion`, updates with `WHERE id/version/deleted_at`, and returns 409
  on conflict. Successful writes invalidate the list/detail queries so the next
  mutation starts from the committed version.
- Validate configured active membership against real non-trashed resources in
  the core service. Drafts may retain unresolved IDs for repair, but publishing
  and bulk activation fail with concrete missing IDs. Any configured featured
  product must exist before save because it is a direct reference, not a rule.
- Reorder is a full-set permutation of all non-trashed collections, uses unique
  contiguous positions `0..n-1`, rejects missing/extra IDs, and advances every
  touched row version. Admin drag is disabled when the complete set is not
  loaded or exceeds the endpoint's 90-row contract.
- Restored collections append to the current non-trashed order rather than
  reviving an obsolete position.
- Public APIs expose a display-only config projection. Membership IDs stay in
  D1/admin contracts and resolved categories/products remain explicit public
  fields.
- Homepage "view collection" always targets the collection ID route. Category
  pills remain secondary navigation. The grid-only lead product is rendered
  first and de-duplicated; carousel keeps no lead-product control.
- Keep the admin aesthetic quiet and dense: existing typography/theme tokens,
  one compact membership-readiness strip, predictable cards, visible counts,
  keyboard-complete controls, and specific empty/error copy. Do not introduce a
  new visual language or generic dashboard decoration.

## Verification bar

- Schema/migration metadata and collection package/API/admin/storefront
  typechecks pass.
- Focused tests cover CAS replay/conflict, missing membership references,
  reorder full-set invariants, restore ordering, public config redaction,
  collection-page total copy, CTA route truth, source-switch picker behavior,
  cache invalidation, sitemap/noindex behavior, and empty/error states.
- Regenerate the SDK after API contract changes.
- Browser verification should cover list, create draft, publish failure, edit
  conflict, manual ordering, dynamic categories, featured product, homepage
  CTA, public empty/filter/pagination state, and mobile filter dialog.
