# Product Editor UX Contract

Last reviewed: 2026-07-12

This is the current product create/edit contract. It supersedes every earlier
two-axis, bulk-generator, spreadsheet-mode, and option-image-mapping design.

## Scope and protected surface

- The admin product workflow may be redesigned and refactored end to end.
- The storefront product-page visual layout is owner-designed and protected.
  Correctness, generic option behavior, direct SKU media, accessibility, and
  cache behavior may change there; large visual redesigns require approval.
- Products are merchandising containers. A persisted `product_variants` row is
  the sellable and inventory identity. A simple product has one protected
  default SKU; an optioned product has normalized customer-option SKUs.

## Design direction

The subject is a high-frequency commerce authoring workspace for merchants. Its
single job is to let a merchant create or correct a sellable catalog without
losing context or data.

- Palette: existing Scalius canvas, surface, ink, muted ink, border, and primary
  action tokens. No imported competitor branding.
- Type: existing compact sans interface; tabular/monospace treatment is limited
  to SKU, barcode, counts, and other operational identities.
- Layout: one readable document scroll; compact product facts and settings use a
  2/3 + 1/3 grid; the operational SKU matrix receives the full workspace width.
- Signature: the option equation (`3 Size × 2 Finish = 6 SKUs`) connects buyer
  choices to inventory identities and is always visible before topology changes.
- Density comes from adjacency, concise copy, 28–36px controls, and progressive
  disclosure. It never comes from removing labels or hiding state.

The comparison research used Shopify for mature workflow patterns, Medusa for
domain boundaries, Figma for hierarchy/consistency, and Notion for compact
progressive disclosure. Scalius does not copy their chrome.

## Page composition

1. Details: title, primary description, and additional rich-content sections.
2. Media: compact gallery and `Add media`; the first image is the product primary.
3. Pricing: primary price first; secondary discount facts disclose compactly.
4. Attributes: product facts independent of customer-choice topology.
5. Right rail: status, organization/category, URL, and a visible search/discovery
   preview. Collapsing search details must not hide the preview outcome.
6. Product options and SKU matrix: full-width operational section below the
   compact product grid.
7. Persistent action bar: discard, create/save, unsaved state, and conflict state.

Media must never reserve an empty mapping/caption region. Cards do not nest
another titled card for the same concept.

## One option model

There is no separate `Option names` feature and no Basic/Advanced mode.

- An option is an ordered merchant-defined buyer choice: Size, Color, Shape,
  2InOne, Format, Duration, License, Pack, Finish, or any other clear name.
- An option owns ordered values. The Cartesian product of all active values is
  the exact set of active sellable SKUs.
- Up to five axes and 150 combinations are supported. These limits come from
  `@scalius/shared/product-options` and are enforced by UI, core, API, and D1.
- Size/color/material/pattern are optional discovery mappings. A mapping helps
  feeds and structured data; it never constrains the merchant-facing name.
- Each option axis is one compact row: name and discovery mapping share the
  leading control group, values compose inline, and reorder/remove actions stay
  at the row edge. Do not restore stacked nested cards or a second summary card.
- A non-`none` standard mapping may be used by only one option per product.
- Option names and values are unique after trim and case normalization while
  preserving the merchant's first display spelling.
- Option and value IDs survive rename and reorder. Removed definitions/values
  soft-retire so historical SKU meaning remains intelligible.

## Topology workflow

Option edits are staged. They never regenerate the matrix on each keystroke.

1. Merchant edits names, ordered values, mappings, or axis order.
2. The equation and `Changes pending` state update immediately.
3. `Update combinations` materializes the proposed matrix.
4. Exact rows retain their SKU facts.
5. Expansion copies descriptive defaults but allocates an old row's stock only
   once; it never clones stock into every child.
6. Contraction merges physical stock totals. Conflicting descriptive facts fall
   back to an explicit neutral/default value rather than guessing.
7. A simple-to-optioned transition allocates tracked default-SKU stock exactly
   once. Committed/preorder stock blocks conversion until released.
8. A topology replacement must preserve the tracked total. New stock can be
   adjusted after the topology is saved through ledger-backed inventory writes.
9. Retirement is blocked by committed/preorder stock or open orders.

Removing the final option is not an implicit conversion to a simple product.
That requires a separate inventory-aware operation and remains intentionally
blocked in this editor.

## SKU matrix

The matrix replaces the old generator dialog and separate spreadsheet mode.

- Desktop columns: select, combination/disclosure, direct image, SKU, price,
  on hand, and SKU discount.
- Each row can disclose barcode type/value, weight, and track-stock policy.
- Mobile shows visible labels for SKU, price, on hand, and discount.
- Search covers option values, SKU, and barcode.
- Selection supports bulk price, on-hand stock, and direct image assignment.
- Thirty rows render per page so a 150-row product does not mount two full
  responsive control trees at once.
- Zero stock is valid and buyer-facing as sold out.
- On-hand remains the only permanent quantity in the editable grid. When a SKU
  has commitments, a focusable inline indicator exposes `available to sell`
  and the exact `on hand - committed` calculation in a tooltip; never make one
  row taller with permanent reservation prose. On hand cannot be edited below
  committed stock.
- Blank numeric editing never coerces to zero. Invalid/blank drafts revert or
  remain explicitly invalid; they do not perform a destructive stocktake.
- Every SKU and barcode is globally unique under trimmed case-insensitive
  identity. Barcode and barcode type are supplied together.
- Flat discount cannot exceed SKU price. Percentage is bounded to 0–100.

## Media ownership

- `product_media` owns the ordered image/video gallery and featured association; global `media` owns the retained asset and poster lifecycle.
- `product_variants.image_id` optionally selects one image belonging to the same
  product. Null means use the product primary image.
- The matrix picker is the only SKU-image assignment surface.
- Positional serialization, SEO markers, product axis mapping, option-value
  mapping, and `product_variant_image_mappings` are deleted concepts.
- Removing an image clears its SKU links through the FK. The editor removes a
  deleted image from live pickers and requires affected rows to be resolved.
- Newly added edit-page media becomes assignable after the product media save
  returns its persisted product-image identity. Initial create maps temporary
  media IDs inside the same atomic create batch.

## Create, edit, save, and conflict grammar

- Initial create may include metadata, media, normalized options, option values,
  all SKUs, assignments, direct images, discounts, and initial ledger movements
  in one D1 batch.
- Invalid or incomplete option work is never silently omitted. It participates
  in the product form dirty guard and blocks create/save with a specific issue.
- On edit, metadata and matrix writes share `aggregateRevision`. If both are
  dirty, metadata saves first and the matrix immediately saves against the
  returned revision; concurrent writes cannot overlap silently.
- Every visible save control uses that same coordinator. The matrix card never
  calls its endpoint directly while product composition is dirty: newly
  attached `pmed_...` IDs and pending media removals are persisted first, then
  the matrix saves against the returned aggregate revision. A matrix-only save
  is available only when the product form is already clean.
- Inventory stock changes additionally use `stockVersion` and ledger claims.
- A typed revision conflict preserves all local form/matrix state and opens the
  existing Reload latest / Keep draft dialog. There is no blind overwrite.
- Enter inside matrix controls never submits the outer product form. Enter/comma
  inside the value composer intentionally adds values.
- Navigation/discard protection includes product-form and matrix dirtiness.

## Additional content and selectors

- Adding an additional rich-content section expands both title and editor.
  Previously edited sections collapse to title-only.
- Shared Radix popper selectors prefer space below and collision-flip above.
  Component code must not replace primitive positioning with fixed geometry.
- Search/discovery stays in the right rail and always exposes its result preview,
  even while advanced editing controls are collapsed.

## Edge-case release checklist

- Empty simple product; zero-price/digital-style product; untracked SKU.
- One to five arbitrary axes; Unicode and `2InOne` names; pasted duplicates.
- Exactly 150 combinations; attempt 151+.
- Rename/reorder without identity loss; add/remove value; add/remove axis.
- Expansion/contraction preserves total stock and never duplicates it.
- Default stock allocation, committed-stock block, open-order retirement block.
- Global SKU/barcode collision and within-draft case-insensitive collision.
- SKU/barcode swaps in one transaction.
- Direct image use, primary fallback, image removal, cross-product image rejection.
- Percentage/flat discounts including zero and boundary values.
- Stale aggregate and stale stock revisions preserve the local draft.
- 390px, 1024px, and wide desktop; keyboard-only; visible focus; no document
  horizontal overflow; matrix-local overflow only when semantically necessary.
- Storefront generic option selection, variant query identity, cart/checkout,
  feeds, UCP, JSON-LD, scanner, inventory, orders, and receipts.

See `NORMALIZED-OPTION-MATRIX.md` for storage and service invariants.
