# Product Editor UX Contract

Last reviewed: 2026-07-12

This document owns the merchant-facing product create/edit workflow and its visual-density contract. The editor must preserve Scalius's identity while matching the operational guarantees and expert speed of leading commerce tools.

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

### Comparative creation-flow inspection — 2026-07-12

The authenticated Shopify product-creation page was inspected beside the live
Scalius editor at the same desktop viewport. This is interaction research, not
a request to reproduce Shopify's branding or component styling.

Observed Shopify structure:

- The main column owns title/description, media, category, price, inventory,
  shipping, variants, metafields, and the search listing. The narrow rail owns
  status, publishing, and product organization.
- The save surface stays visible while the page scrolls. Cards are compact, but
  optional fields such as SKU, barcode, cost, unit price, customs data, and
  search copy use progressive disclosure instead of disappearing from the
  workflow.
- A simple product becomes an optioned product from the same Variants section.
  The merchant enters an arbitrary option name and its values, can add another
  option, and sees combinations generated from that definition. There is no
  separate conceptual "advanced product" mode to discover.
- Physical-versus-non-physical is a fulfillment fact. Turning off physical
  shipping is independent from whether a product has options.
- Product defaults supply price, inventory, and shipping data until option SKUs
  take ownership of those facts.

### Visual-density correction — authenticated side-by-side inspection

The first Scalius refactor corrected card ownership and removed the structural
Media gap, but it did not meet the requested visual or workflow bar. The live
editor and Shopify create page were inspected again at the same desktop scale,
including Shopify's collapsed/expanded price controls and arbitrary-option
creation through its generated inline variant table.

What the comparison exposed:

- Shopify constrains the authoring canvas and keeps a stable readable main/rail
  ratio. Scalius expands nearly every surface and input across the available
  viewport, so more pixels produce longer scan lines instead of more useful
  information.
- Shopify's card padding is visually about one control-height, headings are
  small and local, and adjacent facts share a row. Scalius uses larger card
  padding, larger inter-section gaps, and one full-width control per fact.
- Shopify's Media empty state is a shallow drop target. With media present, the
  section becomes a compact thumbnail grid. Scalius gives the picker a full-width
  button row and renders mapping controls as permanent primary chrome, making
  six images consume much more height than the catalog work requires.
- Shopify keeps only the primary price field open. Compare-at price, unit price,
  tax, and cost appear as compact disclosure chips and expand into a dense grid.
  Scalius renders discount type and value as separate full-width rows even when
  the merchant is not changing them.
- Shopify treats inventory, shipping, and variants as separate compact cards
  with inline boolean state and secondary disclosures. Scalius mixes topology,
  pricing, discount, image mapping, and stock affordances across distant areas,
  increasing scroll and context switching.
- Shopify option creation happens in place: an arbitrary option name changes
  the value placeholder, values are entered in one small editor, and `Done`
  immediately reveals an editable row table with image, price, available
  quantity, and publishing state. Scalius's separate generator dialog is more
  powerful, but the normal one/two-axis path feels heavier and the resulting
  table is separated from option-name/value authoring.
- Shopify spends borders and shadows on section boundaries, not on every nested
  control. Scalius has cards inside cards, full-width outlined inputs, and tall
  accordions competing for attention. The result is technically organized but
  visually exhausting.

Visual implementation contract:

1. Constrain the desktop editor workspace; extra viewport width becomes outer
   breathing room, not wider forms. Keep the main column around two thirds and
   the rail around one third, with a single document scroll.
2. Standard card anatomy is a 44–48px compact header only when actions require
   it, 16–20px body padding, 12–16px row gaps, and no redundant nested card for
   content that already belongs to the section.
3. Labels stay 12–13px and close to controls. Body controls use a consistent
   compact height. A number, unit, short enum, or toggle must not occupy a full
   row merely because space exists.
4. The primary path remains visible; secondary fields use truthful disclosure
   rows that summarize their saved state. Hidden fields with validation errors
   automatically expand and receive focus.
5. Price is one compact primary control plus a secondary pricing row. Discount
   type/value, compare-at behavior, cost/margin, tax, and future unit pricing
   belong in an expandable two/three-column grid, with computed outcomes shown
   beside inputs rather than below the card.
6. Media prioritizes the grid. `Add media` is a compact toolbar action and the
   empty state is shallow. Mapping is an optional mode in the section toolbar;
   its axis and help appear only while enabled. Image captions reserve one short
   line and blank captions do not create empty vertical space.
7. Product options combine definition and result: compact ordered option rows
   show name plus value chips, expand inline for editing, and sit directly above
   the generated SKU table. The advanced combination generator remains an
   acceleration tool, not the only understandable path.
8. The SKU table is the densest operational surface. Default view shows image,
   option identity, price, available/on-hand state, and one overflow action.
   Search, sort, import/export, bulk edit, and generation live in one compact
   toolbar with secondary actions grouped behind a menu on constrained widths.
9. Status and Organization remain in the rail, but long explanatory paragraphs
   become concise state summaries. The rail must not repeat facts already visible
   in the main workflow.
10. Density never removes semantics: every icon action has an accessible name,
    disclosure state is announced, keyboard order follows visual order, and
    390px mobile reflows to one column without horizontal document scrolling.

The target is not a visual copy. Scalius should retain stronger stock truth,
revision conflicts, media-to-option mapping, and atomic combination planning,
while making the common path feel lighter than Shopify's rather than visibly
heavier.

Authoritative behavior references:

- Shopify documents arbitrary per-product option names, up to three axes, exact
  combination uniqueness, and generated combinations from option values in
  [Adding variants](https://help.shopify.com/en/manual/products/variants/add-variants).
- Shopify documents the shift of price/inventory/shipping authority from the
  product form to individual variants in
  [Product details](https://help.shopify.com/en/manual/products/details).
- Shopify treats `Physical product` as the switch that controls shipping facts,
  while non-physical products avoid shipping charges; see
  [Product details page](https://help.shopify.com/en/manual/products/details/product-details-page)
  and [Selling services or digital products](https://help.shopify.com/en/manual/products/digital-service-product/selling-services-or-digital-products).
- Figma's design-system guidance makes hierarchy, progressive disclosure,
  consistency, accessibility, proximity, and alignment explicit interface
  principles; see
  [Seven essential UI design principles](https://www.figma.com/resource-library/ui-design-principles/).

### Newly confirmed Scalius defects

1. **The Media gap is architectural.** The main/rail grid waits for a rail that
   contains Status, Organization, Pricing, SEO, option mapping, and Attributes.
   The main column ends after Media, producing a large dead region above the
   action bar. Padding changes cannot fix this.
2. **The information architecture is inverted.** Pricing, option definition,
   attributes, and search listing are product-composition work and belong in
   the main column. Only status/publication and organization belong in the
   narrow rail.
3. **The simple-to-optioned transition hides the matrix generator.** `Set up
   options` enters a one-row editor and intentionally suppresses the toolbar,
   so the fastest path is unavailable at exactly the moment it is most useful.
4. **Option naming is separated from option creation.** Merchant-defined labels
   exist, but they are hidden in a collapsed `Catalog Option Mapping` card whose
   copy incorrectly says the labels affect feeds only. The storefront, admin,
   feed, and schema all consume these names.
5. **The generator is visually large but operationally shallow.** It requires a
   two-column desktop dialog, starts price and stock at zero, cannot edit the
   generated rows before submission, and buries common work among discount,
   weight, barcode, and SKU-template controls.
6. **Generated identities are unstable.** `{RANDOM}` SKUs and generated EAN-13
   values are recomputed whenever a dependency such as price or stock changes.
   A merchant can review one identity and submit another.
7. **Conflict detection is incomplete in the browser.** Existing SKU checks are
   exact-case only and do not detect normalized collisions or duplicate SKUs
   produced inside the preview. Option values are also deduplicated by exact
   spelling even though storage uniqueness is normalized.
8. **Initial product creation cannot define option SKUs.** The API always creates
   the protected default SKU, redirects to edit, and only then permits option
   creation. This adds an unnecessary save-and-redirect boundary and prevents a
   truthful single-review create workflow.
9. **Product fulfillment type is implicit.** Scalius cannot yet express that an
   item is digital or a service and does not require shipping. Weight alone is
   not a safe proxy.

## Product editor redesign decisions

These decisions are the implementation contract for later agents. Do not
replace them with a theme-only redesign.

### Page composition and scrolling

- Keep Scalius's compact two-column desktop shell and persistent bottom action
  bar. Do not copy another product's chrome.
- Main column order: Details → Media → Pricing → Product options → Attributes /
  additional information → Search and discovery. Edit pages place the SKU /
  option matrix directly after Product options.
- Narrow rail: Status/readiness and Organization only. It may become sticky when
  its measured height fits the viewport; never create an independently scrolling
  form rail.
- On mobile, preserve one document flow in the same semantic order. The primary
  action remains visible and no section receives its own hidden scroll region.
- Remove the dead Media gap by moving composition cards, not by adding a minimum
  height, spacer, negative margin, or viewport-specific magic number.

### Product type and fulfillment

- A product remains a merchandising container and every sellable identity
  remains a persisted SKU.
- `simple` versus `optioned` describes SKU topology only. It must never imply
  physical, digital, service, subscription, preorder, or made-to-order behavior.
- Add an explicit fulfillment fact in a focused domain migration before exposing
  digital/service UI. The preferred minimal authority is `requiresShipping`
  (default true) on the sellable SKU, with product-level defaults used only when
  creating SKUs. Do not infer it from weight, stock tracking, category, or the
  absence of delivery methods.
- Digital delivery and service booking require their own fulfillment contracts;
  a `Digital` label alone must not promise downloads or booking behavior that the
  order system cannot perform.

### Option definition and topology

- The merchant creates `option name + ordered values` together. Size and Color
  are examples, never fixed meanings. Rename the current mapping surface to
  `Option names` and make schema/feed mapping secondary progressive disclosure.
- The editor and storefront must read the same saved option labels. Unsaved label
  changes must be reflected in the open option editor without remounting it.
- The current two-axis storage model may be polished now, but a third axis must
  not be faked in JSON or overloaded into one string. Supporting more axes
  requires normalized option-definition, option-value, and SKU-combination
  tables plus a deliberate storefront/API migration.
- A topology transition keeps the protected default SKU for audit/history and
  creates only non-default customer-option SKUs. No option row may reuse the
  default SKU identity.

### Simple → optioned workflow

- Replace `Basic/Advanced` thinking with one `Product options` workflow.
- From a simple SKU, present two equally clear actions: `Add one option` and
  `Generate combinations`. Both save any dirty simple-SKU fields first or
  explicitly preserve them as generator defaults.
- `Generate combinations` must be available before the first option row exists.
  The protected simple SKU participates in normalized SKU/barcode conflict checks
  but never appears as a generated option row.
- Successful generation moves directly to the option table, announces how many
  rows were created, and leaves the product-level draft intact.

### Combination generator

- Use a compact three-part flow in one dialog: **Values**, **Defaults**, and
  **Review**. Values and the review count stay visible; secondary defaults use
  progressive disclosure.
- Seed price, track-stock policy, weight, discount, and SKU prefix from the
  current product/default SKU. Show existing on-hand stock as transition context,
  but never clone it into every generated combination: matrix rows start at zero
  and the merchant must allocate exactly the current tracked total before the
  first option topology can be created. The protected default row becomes a
  dormant audit/revert identity and must disappear from inventory, scanner, and
  low-stock projections while customer-option SKUs exist. A one-row transition
  may prefill the current total because it is an unambiguous allocation.
- Accept Enter, comma, newline, and pasted spreadsheet columns. Trim and
  case-fold for duplicate detection while preserving the first display spelling.
- Show the Cartesian count before materializing rows. Use one core-exported,
  server-enforced atomic-plan limit; do not invent a UI-only limit. The current
  ceiling is 150 total creates/updates: a worst-case stock edit consumes three
  atomic statements and up to three low-stock lifecycle queries per row, which
  stays below D1's 1,000-query paid-plan invocation limit with preflight
  headroom. Recalculate this ceiling whenever the mutation or alert plan changes;
  see [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Generated SKU and barcode identities are stable for the lifetime of the draft.
  Editing price, stock, weight, or discount must not change them. Regeneration is
  an explicit action.
- Detect normalized conflicts against existing SKUs/barcodes, within the preview,
  and against existing normalized option combinations. Explain the exact rows
  blocking creation.
- Review rows are editable before submission and can be individually excluded.
  Provide intentional bulk operations for price, stock policy, stock, weight,
  discount, barcode generation, and SKU pattern instead of forcing repetitive
  row edits.
- Presets describe value sets (`Apparel sizes`, `Pack quantities`, `Finishes`),
  not hard-coded axis semantics. A preset never renames a merchant's option.
- Keep CSV import/export as a separate large-catalog path. The generator is for
  understandable combinations, not an unbounded substitute for import.
- The final action says exactly what happens: `Create N options`. Errors remain
  inside the dialog; a failed request never closes it or discards the draft.

### Initial product creation target

- The target create contract is one atomic `createProductAggregate` request that
  accepts either one protected default SKU or a validated option topology plus
  its SKU rows, media associations, attributes, and product fields.
- Do not emulate this with a product create followed by hidden client-side variant
  requests: a partial failure would leave a product different from the reviewed
  draft.
- Until that contract lands, the create page must state the save boundary
  honestly and make the post-create option action immediate. This remains an
  open architecture item after the current edit-flow release.

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
