# Attributes: authority and hardening audit

Last reviewed: 2026-07-12

This is the durable implementation record for catalog attributes. Source, migrations, focused tests, and live behavior remain authoritative. Keep this file current when a finding is fixed, rejected, or superseded.

## Product and data contract

- An attribute definition is merchant-owned catalog vocabulary: `name`, stable URL-facing `slug`, optional ordered preset `options`, and a `filterable` flag.
- `filterable` means **eligible for buyer-facing filtering/facets only**. It must not hide an assigned fact from product detail, catalog feed, schema, or future exports. Those surfaces may apply their own explicit visibility or standards mapping, but must not infer visibility from `filterable`.
- A product assignment is currently exactly one string value per `(product_id, attribute_id)`. This is intentionally distinct from product options/variants: attributes describe or classify a product; option axes generate sellable SKUs.
- Attribute name/slug identity and preset/assigned value comparisons are normalized as `lower(trim(value))` at service boundaries. A merchant must not be able to create visually duplicate definitions or collapse one used value into another by case/whitespace-only differences.
- Active product composition may reference active attribute definitions only. Empty assignments, duplicate attribute IDs, and values longer than 100 characters fail validation before a database write.
- Trash is a lifecycle state, not an editable definition. Updating definitions or values in trash must fail. Restores require exact trash state and must fail closed on normalized name/slug collisions or concurrent lifecycle changes.
- Definition and assignment mutations invalidate attribute facets and all product projections that include attribute facts. Public facets continue to include only active, filterable definitions attached to buyer-resolvable products.

## Verified architecture and scale

- Definitions live in `product_attributes`; assignments live in `product_attribute_values` with a unique `(product_id, attribute_id)` constraint.
- Product create/edit rewrites the composition assignment set transactionally with the product aggregate revision. Attribute-wide rename/delete bumps every affected product aggregate revision in the same batch.
- Public listing/search filters use repeated slug values, OR values inside one attribute, AND distinct attributes, and cap the normalized request at 90 values.
- Attribute list counts, bulk IDs, preset reconciliation, and product-ID filter scopes use a bound `json_each()` set or a maximum of 90 IDs to stay below D1's 100-bound-parameter ceiling.
- Admin definition and value search is server-side and paginated. Product assignment pickers must also page/search the server; they must not preload or silently truncate a large definition/value catalog.

## Verified defects and decisions

### P0/P1 correctness

- **Accepted fix:** product detail and product-feed projections currently require `filterable = true`, which drops truthful non-facet facts such as Brand or Material. Remove that condition from fact projections; retain it only in facet/filter resolution.
- **Accepted fix:** product assignment validation currently permits blank, untrimmed, overlong, and duplicate attribute IDs. Add bounded canonical validation with a 90-assignment cap and normalized unique IDs.
- **Accepted fix:** definition update and value add/rename/delete currently locate trashed attributes. Require active lifecycle state for every edit.
- **Accepted fix:** restore is not atomic, bulk restore skips ID/lifecycle/conflict validation, and restore conflict checks are case-sensitive. Route single and bulk restore through one guarded primitive with the same 90-ID boundary as delete.
- **Accepted fix:** definition create/update conflicts are case-sensitive. Compare `lower(trim(name))` and `lower(trim(slug))` across active and trashed rows and keep the existing actionable trash conflict copy.
- **Accepted fix:** value rename checks preset collisions but not existing assigned values. Reject a rename when the normalized destination is already used or preset, except a case/whitespace normalization of the same source value.
- **Accepted fix:** value mutation schemas do not cap the value length even though presets do. Use one 100-character canonical value schema.

### Admin workflow and UX

- **Accepted fix:** the product form refetches all definitions whenever its own assignment callback updates the parent, can overwrite local edits with racing responses, and truncates definitions at 500. Stabilize prop synchronization and use debounced server search/pagination rather than a catalog-wide preload.
- **Accepted fix:** the value picker issues duplicate initial requests, has no stale-response protection, guesses `hasMore` from page length, swallows errors, and can append duplicates. Give it an explicit loading/error/retry state, request sequencing, authoritative `totalPages`, and deduplication.
- **Accepted fix:** assignment create/edit affordances are not permission-aware. Hide definition creation and preset creation when the corresponding catalog permissions are absent while retaining assignment of existing values for product editors.
- **Accepted fix:** an empty newly assigned value looks saved but is silently dropped. Keep the row visibly incomplete, announce that a value is required, and block product submission through shared validation.
- **Accepted fix:** icon-only remove/view controls need accessible names; value inspection must remain available when a definition has presets but zero product usage. Distinguish assigned-value count from preset availability in copy.
- **Accepted constraint:** do not replace generic shared selector/popover components in this slice. Attribute-specific controls may adopt the existing searchable, viewport-aware dropdown behavior. Any generic component change requires a separately reported cross-surface audit.

## Deferred model work

- Multi-valued product facts cannot be represented by the current unique `(product_id, attribute_id)` model. Do not use delimiters. A future migration should introduce stable value identities or a true assignment join model, then define filtering, feed/schema mapping, admin editing, and migration semantics together.
- Definition normalized uniqueness is presently enforced in services. A future migration should add database-level normalized unique indexes once the demo data is reconciled and the migration sequence is free; service checks and typed conflicts remain necessary for actionable UI errors.
- Public display/export/schema policy may eventually need explicit fields separate from `filterable` (for example `visible`, feed mapping, and schema mapping). Until then, assigned facts remain public facts and `filterable` only gates facets.

## Release regression bar

- Create/update/restore rejects normalized name or slug collisions, including collisions with trash, with typed conflict responses.
- Trashed definitions cannot be edited or have presets/used values mutated.
- Single/bulk restore accepts at most 90 unique IDs, requires every row to be in trash, and fails atomically on collision or concurrent state change.
- Rename cannot merge two normalized used values; case/whitespace normalization of one value remains possible and bumps every affected product revision once.
- Product assignment rejects blank/overlong/duplicate/inactive definitions before mutation; 90 assignments stay within D1 bounds.
- A non-filterable assigned fact is returned on product detail/feed data but never appears as a storefront facet or accepted filter key.
- Product definition/value pickers handle empty, loading, error, retry, pagination, search races, large catalogs, keyboard navigation, narrow viewports, and permission-restricted users without losing local assignments.
- Focused core/API/admin tests, affected package typechecks, generated SDK after contract changes, environment consistency, and release smoke remain green before deployment.
