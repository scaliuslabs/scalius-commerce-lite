# Product Editor UX Contract

Last reviewed: 2026-07-12

This document owns the merchant-facing product create/edit workflow. It is not a visual redesign brief. The editor must preserve Scalius's compact identity while matching the operational guarantees and expert speed of leading commerce tools.

## Non-negotiable outcomes

- A stale editor never overwrites a newer saved product aggregate.
- A conflict preserves every local draft until the merchant explicitly reloads.
- Product, media, option, barcode, discovery, and attribute state use one understandable save/conflict grammar.
- A duplicated option begins as an unsaved draft and cannot persist the same normalized option combination or barcode.
- Inventory authority remains separate from merchandising edits: order/scanner stock changes use `stockVersion`; product composition uses `aggregateRevision`.
- The storefront product-page visual design is outside this document's scope and remains protected.

## Live interface audit

Authenticated production inspection at 1440×686 and an emulated 390×844 viewport found:

### What already works

- Desktop uses an efficient two-thirds content / one-third settings layout with 12–14 px utility copy and a persistent bottom action bar.
- Status, organization, pricing, discovery, attributes, and media have clear card boundaries without decorative noise.
- Mobile collapses to one column with no document-level horizontal overflow.
- The action vocabulary is direct: Edit Product, Save Product, Discard, New Product.
- Variant media mapping is visible beside the gallery without changing the buyer-facing product layout.

### P1 workflow defects resolved in batch 5

- Product and SKU-composition writes now use one mandatory aggregate compare-and-swap revision and return its successor.
- The admin transport preserves typed conflict details and the editor keeps the submitted draft intact.
- Product fields, option rows, media mappings, and tax classification share the product revision boundary.
- The route force-fetches a current product before constructing the editor snapshot; later background refetches cannot replace it.
- ProductForm and VariantManager consume one editor-owned SKU snapshot. Same-editor successful SKU changes update it; only explicit Reload latest replaces the whole editor.
- Duplicate option is an unsaved identity-safe draft with blank SKU/barcode and zero stock.

### P2 interaction defects

- The action bar has only dirty/clean state; it cannot show `Out of date · Draft kept` or turn Save into Review conflict.
- Mobile rich-text controls wrap to roughly three rows before the content surface. A later pass should expose the common formatting set directly and place secondary tools behind one labelled More formatting control or a horizontal toolbar with an explicit affordance.
- The long editor has no compact section navigator or keyboard jump model. Add this only after each destination has a stable heading/focus contract; do not add decorative tabs that merely scroll unpredictably.
- Product publication is a boolean without an aggregate readiness summary. A later pass should explain blocking versus advisory readiness for price, SKU topology, media, inventory policy, discovery, and feed eligibility.
- The option editor sits below the product form and can be missed on a short viewport. Its state must be represented in the page-level save/conflict grammar before changing the layout.

## Batch 5 conflict interaction

Use the existing neutral palette and component library. Spend emphasis only on the conflict state.

1. The editor loads a positive `aggregateRevision` and sends it as mandatory `expectedAggregateRevision` on every product-owned mutation.
2. A successful mutation returns the new aggregate revision and the open editor advances to it without remounting or losing drafts.
3. `PRODUCT_REVISION_CONFLICT` preserves the dirty form and opens one compact alert dialog.
4. Copy:
   - Title: `This product changed elsewhere`
   - Body: `Your draft is still here, but it can't be saved over the newer version.`
   - Actions: `Keep draft` and `Reload latest`
5. Keep draft closes only the dialog. The action bar persists `Out of date · Draft kept`; Save becomes `Review conflict` and never repeats the stale request.
6. Reload latest explicitly replaces the product-form draft with the authoritative aggregate, advances the revision, and returns focus to the page heading. Reload failure remains inline and retryable.
   If the product was permanently deleted, the dialog offers `Return to products` instead of an impossible reload.
7. Do not offer blind overwrite or a fake field merge. Images, rich text, attributes, mappings, and option topology are aggregate replacements and need a future real comparison model before merge is safe.

## Design references translated into rules

- Figma UI3: preserve expert ergonomics while clearing interface weight and "simplifying without simplifying what you can do." For Scalius, new state belongs in the existing action surface, not a new dashboard-within-the-editor. Source: <https://www.figma.com/blog/behind-our-redesign-ui3/>
- Notion: important workflows remain operable without a mouse. Dialog actions, editor sections, tables, and row actions need stable focus order and visible focus. Source: <https://www.notion.com/help/keyboard-shortcuts>
- Shopify: inventory overrides detect concurrent changes and present a conflict dialog rather than silently replacing current state. Product-option duplication is an edit-before-save workflow and an exact duplicate cannot be saved. Sources: <https://help.shopify.com/en/manual/products/inventory/adjusting-inventory/bulk-editing-inventory> and <https://help.shopify.com/en/manual/products/variants/add-variants>
- Medusa: product composition and inventory are separate modules/authorities. Scalius keeps that boundary through aggregate revision versus stock version instead of coupling order traffic to product-form conflicts. Source: <https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory>

## Verification contract

- Two loaded editors at revision N: the first save returns N+1; the second receives typed 409 and retains its draft.
- A successful second save from the first editor uses N+1 and returns N+2.
- A successful option mutation advances the shared editor revision exactly once.
- External query refetch never remounts or resets a dirty ProductForm.
- Only explicit Reload latest replaces the draft and moves focus to the editor heading.
- Generic slug, SKU, stock, and validation conflicts never render as revision conflicts.
- Active editor writes cannot mutate trashed products; restore and permanent delete cannot operate on live products.
- SKU delete is always a soft retirement. Reservation, open-order, lifecycle, and final-option predicates execute inside the same D1 batch before any write.
- Duplicate option creates no server row until a unique option/SKU draft passes validation; barcode starts blank.
- Dialog keyboard focus, accessible name/description, pending state, inline reload failure, and Escape/Keep draft behavior have automated coverage.
- Desktop and 390×844 browser checks show no horizontal overflow or obscured primary action.

## Batch 5 local evidence

- Full repository tests: 447 files / 3,325 tests passed.
- Full workspace typecheck and lint passed; storefront Astro reported zero diagnostics across 290 files.
- Production builds, Worker environment parity, admin performance checks, distribution secret scan, SDK regeneration, and `git diff --check` passed.
- Deployment and live two-editor/browser evidence are recorded in `PROGRESS.md` after rollout; local evidence alone does not claim the release is live.

## Later editor passes

1. Mobile toolbar compression and section navigation.
2. Publication/readiness summary with direct links to blocking sections.
3. Product-level change comparison built from a real server snapshot, not field guesses.
4. Keyboard-continuous option spreadsheet: cell movement, range selection, fill, validation summary, and before/after review.
5. Media upload progress, failed-file recovery, alt-text workflow, and per-image usage/association visibility.
