# Variant and option image review

Last reviewed: 2026-07-12

This review exists because partial variant imagery is normal: a merchant may
have a distinct image for one SKU, one color family, or only a few combinations.
No product option UI or persistence change should be made from a screenshot
alone; the entire media lifecycle must remain predictable.

## Current authority (verified in code)

- Migration 0007 removed the former product-level variant-image switches and
  `product_variant_image_mappings` inheritance table.
- `product_variants.image_id` is now one nullable, same-product image reference
  with `ON DELETE SET NULL`. Every saved mapping is therefore exact to one SKU.
- `null` means “use the product primary image.” It is valid for any subset of
  the matrix; a SKU is not required to have distinct media.
- The matrix picker already writes an exact image ID or `null`. Selecting rows
  and assigning an image materializes the same exact ID onto those SKUs rather
  than saving an option-value rule.
- Storefront product selection and product shortcodes resolve the exact selected
  SKU image first and the product primary image otherwise. They do not infer by
  option position, label, or sibling combination.
- Removing a product image clears affected SKU references through the foreign
  key. Reordering or replacing the primary image naturally changes the fallback
  for every unmapped SKU without rewriting those SKUs.

This is already the simpler model proposed in the design discussion. Do not
reintroduce option-value inheritance or a second serialized mapping system.

## Partial-assignment examples

| SKU | Saved `image_id` | Buyer image |
| --- | --- | --- |
| White / 1 kg | White image | White image |
| White / 5 kg | `null` | Product primary |
| Black / 1 kg | Black image | Black image |
| Black / 5 kg | `null` | Product primary |

Bulk convenience should remain a UI operation: select the White rows and apply
the White image. The result is still ordinary exact SKU state, so later option
renames and axis changes do not depend on normalized display text.

## Lifecycle decisions

- Renaming an option or value keeps the SKU image because identity is attached
  to the stable SKU, not the display label.
- A newly generated combination may start with `null`; it must visibly show the
  primary fallback until the merchant assigns something else.
- When topology expansion deliberately copies a shared draft into projected
  SKUs, copied image IDs become explicit SKU assignments in the draft. The UI
  must not present them as hidden inheritance.
- Omitting and restoring a staged combination should restore that draft's exact
  image. Retiring a persisted SKU preserves its audit identity; a newly created
  different combination does not inherit its image by position.
- Clearing one SKU image affects only that SKU. Clearing selected rows is a
  bounded bulk edit and must not alter product media order.
- Product media deletion, matrix save, and aggregate conflict handling must fail
  or recover explicitly; no stale image ID may be silently redirected to a
  different image.

## UI issues to resolve after design approval

The architecture is simple, but the matrix does not communicate it clearly:

1. An unmapped row shows a generic image icon instead of the effective primary
   thumbnail, so partial assignments look unfinished rather than intentional.
2. The picker copy says “Use primary image,” but the collapsed cell has no
   `Primary`/fallback indicator or tooltip.
3. Bulk image selection mutates selected drafts immediately while bulk price and
   stock wait for an `Apply` button. One toolbar should not have two save
   semantics.
4. There is no explicit “Clear SKU image for selected” action even though
   choosing the primary fallback is a valid bulk operation.

The compact target is: show the effective thumbnail in every row, mark fallback
rows with a quiet `P`/Primary tooltip, keep the picker choice named “Product
primary (fallback),” and make bulk image application/clearing use one explicit
action contract. Do not add an option-axis image editor.

## Required regression coverage before UI changes

- mixed exact/null SKU mappings save and reload unchanged;
- exact selected SKU image and null-to-primary fallback on the protected product
  page, shortcode, quick-buy/cart snapshot, feed rows, and schema projection;
- remove assigned image -> FK clears -> primary fallback;
- replace/reorder primary while null-mapped SKUs follow it;
- option rename, axis expansion, new value, omit/restore, and SKU retirement;
- bulk assign and bulk clear with aggregate-revision conflict recovery;
- desktop/mobile matrix labels, keyboard operation, empty-media state, and
  accessible image names.
