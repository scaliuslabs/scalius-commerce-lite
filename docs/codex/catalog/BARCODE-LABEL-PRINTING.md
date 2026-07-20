# Barcode label printing

Last reviewed: 2026-07-20

## Decision

Barcode generation, label composition, and printing are separate operations.
New Scalius SKUs may receive a platform-owned Code 128 identity, but creating a
barcode value must never silently print it or overwrite a merchant-supplied
retail identifier.

The merchant interface is one URL-addressable **Barcode labels** workspace,
not a blocking multi-page wizard and not only an isolated row icon. Small entry
points open the same workspace:

- a printer action on one exact SKU starts with one label;
- Inventory row selection opens a batch with the selected SKUs;
- the product SKU matrix may open a batch for its selected persisted SKUs;
- opening the workspace directly provides a searchable SKU picker.

The individual printer icon must not send output immediately. It is a compact
entry point, not a destructive shortcut: it opens the same workspace with the
exact persisted SKU selected, quantity `1`, the workstation's last-used stock,
and a real preview. This retains the speed of a row action while still letting
the merchant catch the wrong paper, an unsafe symbol fit, stale stock-based
quantity, or a partially used sheet before opening the native print dialog.

This also replaces the manual office workflow of downloading one symbol,
placing copies on an A4 design canvas, aligning them by eye, exporting the
canvas, and cutting the sheet. A standalone symbol download may eventually be
useful to a packaging designer, but it is not the primary printing workflow and
must not compete with the composed sheet/roll job. The normal merchant outcome
is a physically sized page or roll rendered from exact saved SKUs.

Do not replace the workspace with a linear wizard. Format choice changes symbol
fit, content changes the physical artwork, the starting cell changes pagination,
and quantity changes page count. Keeping selection, output controls, diagnostics,
and preview in one responsive view makes those dependencies observable and lets
experienced merchants finish without repeatedly moving forward and backward.

Do not make a freeform drag canvas the default either. Lightspeed's advanced
label editor is useful when a retailer owns supported hardware and maintains
bespoke templates, but position/resize controls create accidental clipping and
quiet-zone risk for ordinary merchants. Scalius keeps safe, physically defined
presets and restrained content toggles in the primary path. A future named
template editor may sit behind advanced disclosure, but it must preserve the
same symbol-fit validation and never be required for A4/plain-paper or standard
thermal output.

The workspace keeps three layers visible on desktop: selected SKUs and label
counts, format/content controls, and a sticky live paper preview. On narrow
screens those layers stack into one responsive workspace. Exact SKU selection
is reload-safe in the URL; quantities and partially used-sheet position are
intentionally job-local so a later print run cannot silently reuse an old stock
count or skip fresh labels. A returning merchant with a saved device
format/content preference can reach the browser print dialog after one review;
a first-time merchant can see every decision before printing.

Multi-page jobs can be reviewed one physical page at a time before printing.
Only page one remains interactive for choosing the partially-used-sheet start
cell; later pages are read-only previews so browsing a batch cannot silently
change pagination.

If the chosen stock is physically too narrow for any active barcode, printing
stays blocked and the warning offers the first compatible standard format as a
one-click recovery. The recommendation keeps thermal jobs on thermal media when
another supported roll fits; it falls back to wider A4 stock only when no
supported roll can preserve the symbol and its quiet zones.

## Competitive evidence

The first-party platform evidence was rechecked on 2026-07-20 after the
merchant-printing question was raised again. Shopify still routes product-list
selection into its separately installed Retail Barcode Labels app, then asks
for a template, exact per-variant quantities, printer settings, and final
Print/Save as PDF; it still limits custom stock and does not replace an
ordinary office merchant's partially used A4 workflow. Square still provides
the strongest operational reference: custom/category/purchase-order sources,
SKU-or-GTIN choice, preview, test print, PDF, and managed printer-queue retry.
Medusa still exposes SKU, EAN, UPC, and barcode on the exact variant without a
core label composer; Vendure and Saleor remain extension boundaries rather
than comparable operator workflows. This renewed check does not change the
decision below: one-SKU and multi-SKU actions must enter the same non-blocking,
physically previewed job workspace. A row icon alone is insufficient, while a
linear wizard would hide interdependent quantity, paper, fit, and used-sheet
decisions and slow the common reprint-one-label path.

The current platform comparison is intentionally capability-based. A missing
core feature is not evidence that Scalius should omit it, and a supported
printer list is not evidence that Scalius should bind label composition to one
vendor:

| Platform | Core barcode identity | First-class label workflow | Useful pattern | Constraint Scalius should avoid |
| --- | --- | --- | --- | --- |
| Shopify | Variant barcode plus optional app-generated 8-digit value | Separate Retail Barcode Labels app | Product-list batch entry, named stock templates, per-variant counts, native Print/Save as PDF | Extra app, fixed supported media, no arbitrary custom size, and no iPad printing from the app |
| Square Retail | SKU or GTIN | Dashboard/POS label composer | Custom/category/purchase-order sources, location choice, test print, explicit PDF, and failed-job retry on managed POS hardware | Receiving/location shortcuts without authoritative receiving or location data |
| Vendure | SKU in core; GTIN is a documented custom-field extension | No core composer found | Exact ProductVariant identity and extension points | Treating an extension example as a merchant-ready workflow |
| Medusa | Variant SKU, barcode, EAN, and UPC | No core composer found | Exact variant identity and barcode-driven POS lookup | Confusing barcode storage or scanner lookup with physical label composition |
| Saleor | Variant identity and extensible dashboard/API | No core composer found | Extension boundary | Claiming feature parity from an extensible API without a usable operator workflow |

The resulting release bar is therefore higher than copying any one platform:
the quick one-SKU action, mixed-SKU batch entry, ordinary A4 paper, adhesive
sheets, thermal rolls, partial-sheet reuse, stock-derived counts, physical fit
validation, test output, and PDF/print review belong in one built-in workspace.
Purchase-order, location, and printer-queue entry points are added only when
Scalius owns those underlying facts or hardware jobs; they must not be mocked by
guessing from current stock.

- [Shopify Retail Barcode Labels](https://help.shopify.com/en/manual/sell-in-person/hardware/barcode-printer/retail-barcode-labels)
  uses product-list selection as an entry point, then asks for a template,
  per-variant quantities, print settings, and final Print. The browser print
  dialog also provides Save as PDF. It supports named Dymo, Avery, and Zebra
  media, but label printing remains a separately installed app.
  Shopify's official limitations also include no arbitrary custom label size and
  manual per-variant quantity selection. Scalius should preserve custom
  millimetre stock and safe `On hand`/`Available` batch quantities instead of
  copying those constraints.
- Shopify's current workflow was rechecked on 2026-07-19. Its product-list
  action still enters a separate print job with a template, exact per-variant
  quantities, printer settings, and native Print/Save as PDF. This reinforces
  the shared-workspace decision: Scalius's row icon is an entry point into the
  job, not an immediate-print action, while A4/plain-paper users do not need a
  separate app or manual canvas.
- [Square barcode labels](https://squareup.com/help/us/en/article/6093-create-and-print-bar-code-labels-with-square-for-retail)
  can start from a custom item set, category, or purchase order; offers SKU or
  GTIN selection, label preview, test printing, PDF download, and per-item
  quantities. Receiving is a valuable future source when Scalius has purchase
  order authority.
- [Lightspeed Retail label printing](https://x-series-support.lightspeedhq.com/hc/en-us/articles/25533677279771-Printing-barcode-labels)
  keeps both single-product and bulk list entry points, can apply current
  available inventory as the quantity, and lets merchants return from preview
  to correct the job. This supports Scalius's shared workspace and explicit
  `Available` shortcut rather than separate single and batch composers.
- [Odoo printable delivery PDFs](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/shipping_receiving/setup_configuration/print_on_validation.html)
  provides dense 2x7 and 4x12 page grids, one-per-unit quantities, PDF, and ZPL.
  Those outputs are operationally capable but expose format choices more than
  most small merchants need on every run.
- Odoo 19's current inventory documentation was rechecked on 2026-07-19. It
  can trigger product-label PDF or ZPL output from a validated receipt,
  picking, or delivery operation. Scalius should adopt this only after it has
  an authoritative receiving/picking workflow: a label job must use exact
  received quantities, never infer them from stock movements or an order that
  may still change.
- [Vendure's current ProductVariant core model](https://docs.vendure.io/current/core/core-concepts/products)
  exposes SKU but no first-class barcode or label-printing workspace; its
  [custom-field guide](https://docs.vendure.io/current/core/developer-guide/custom-fields)
  explicitly uses GTIN as a variant extension example. Its extension points
  are therefore the intended route for such a feature.
  [Medusa's variant guide](https://docs.medusajs.com/user-guide/products/variants)
  exposes barcode, EAN, and UPC editing, and its
  [POS recipe](https://docs.medusajs.com/resources/recipes/pos) demonstrates
  barcode lookup/scanner integration, but the current core admin guide does not
  provide a label composer. Searches of [Saleor's current documentation](https://docs.saleor.io/)
  and dashboard sources found no first-class barcode or label-printing workflow.
  These platforms are architecture references, not a UX bar for this feature.
- [Avery print guidance](https://www.avery.com/help/article/practice-test-sheet?page=1)
  requires an initial plain-paper alignment test and Actual Size/100% scale.
  Avery's current troubleshooting guidance also recommends a small alignment
  adjustment when the entire sheet is uniformly displaced. Scalius therefore
  keeps device-local horizontal and vertical millimetre correction inside a
  collapsed advanced control; it never changes the saved template or SKU.
  [GS1 guidance](https://www.gs1.org/standards/barcodes/10-steps-to-barcode-your-product/english)
  requires the correct symbol, human-readable digits, contrast, and quiet
  zones. Scalius must not shrink a barcode merely to make a crowded template
  look tidy.
- [Avery's current print options](https://www.avery.com/help/article/printing-steps-and-options-in-design-and-print)
  explicitly support starting on a later label and printing only part of a
  sheet. That is why Scalius keeps `Start at cell` as part of the physical job
  instead of asking office-printer merchants to rebuild a partly used A4 sheet
  in a design canvas.
- [Brother P-touch database printing](https://support.brother.com/g/s/es/dev/en/print/database_editor/index.html?navi=offall)
  uses Excel or other tabular data as the merge source for specialist label
  templates. Scalius therefore offers a collapsed **External label software**
  export: a formula-safe UTF-8 CSV with one row per physical label, preserving
  the exact SKU quantities, output order, encoded symbol value, human-readable
  value, and automatic selling price already reviewed in the job. It is an
  advanced bridge, not a second composer or a requirement for ordinary A4 and
  thermal printing.

## Scalius workflow

### Select

- Search is server-backed by product, SKU, or exact barcode.
- Selection is exact persisted SKU identity. Draft SKUs must be saved before a
  printable barcode exists.
- Each selected row shows product, merchant option label, SKU, barcode type,
  barcode value, stock, and label quantity. When inventory is not tracked,
  `On hand` and `Available` preserve the merchant's manual count instead of
  silently replacing it with zero.
- Quantity shortcuts are `One each`, `On hand`, and `Available`; every SKU also
  has an exact editable quantity. Zero is allowed and removes that SKU from the
  print count without losing it from the batch. `Remove zero-count` clears those
  dormant rows when a stock-derived batch becomes noisy, while `Clear job`
  starts a fresh selection without changing any catalog or inventory fact.
- A job is bounded to 150 SKUs and 1,000 rendered labels. The UI calculates
  page count before rendering and blocks an excessive job instead of freezing
  the browser.

The entry point changes only the initial selection; it never creates a second
printing system:

| Merchant task | Fast entry | Initial quantity | Review before output |
| --- | --- | --- | --- |
| Reprint one damaged label | SKU row printer action | 1 | Exact SKU and physical preview |
| Label several chosen variants | Inventory or SKU-matrix selection | 1 each | Per-SKU counts and preview |
| Label current physical stock | Inventory selection | Explicit `On hand` action | Source stock remains visible |
| Label only uncommitted units | Inventory selection | Explicit `Available` action | On-hand and available stay visible |
| Use ordinary office paper | Direct workspace or any selection | Merchant-selected | A4 grid, start cell, test sheet, crop guides |
| Use a label/thermal printer | Direct workspace or any selection | Merchant-selected | Exact roll size, fit check, test label |

Purchase-order or receiving-document entry belongs here only after Scalius has
an authoritative receiving workflow. Do not imitate a purchase-order shortcut
by guessing quantities from inventory movements.

### Design

Primary presets:

1. **A4 cut sheet — 3 x 8.** Plain office paper, 24 labels per page, visible
   crop marks, safe printer margins. This replaces manual A4 canvas assembly.
2. **A4 compact — 4 x 10.** Plain paper or unbranded adhesive stock, 40 labels
   per page; shorter names and smaller but still valid symbols.
3. **A4 wide cut — 2 x 7.** Fourteen larger plain-paper labels with visible
   cut guides for moderately long symbols that cannot fit the denser A4 grids.
4. **A4 adhesive — 2 x 7.** Fourteen larger labels with no crop marks for
   pre-cut stock.
5. **A4 extra-wide cut — 1 x 10.** Ten full-width plain-paper labels with cut
   guides. This is the one-click recovery for preserved legacy Code 128 values
   that cannot safely fit a two-column sheet; the symbol is never shrunk below
   its safe module width.
6. **Thermal 50 x 25 mm.** One label per page for common roll printers.
7. **Thermal 40 x 30 mm.** One label per page for compact retail labels.
8. **Custom.** Page size, rows, columns, symmetric margins, gaps, and cut guides
   remain advanced disclosure, not the default screen. The derived label cell
   must remain at least 20 x 15 mm.

Label content is restrained: barcode symbol and human-readable value are
mandatory; product name, variant, SKU, and selling price are optional. Selling
price means the automatic buyer-effective catalog price: a positive SKU
discount wins, otherwise the product discount applies. It does not pretend to
include conditional checkout codes or customer-specific promotions. The
preview reports when the chosen media cannot hold the selected symbology at a
safe size. Truncating descriptive text is allowed; truncating, horizontally
scaling, or clipping the symbol or quiet zones is not.

Physical output may be arranged `As selected`, `Product and variant A-Z`, or
`SKU A-Z`. Arrangement is a workstation preference and affects only the copies
sent to the sheet or roll. It must not rewrite the URL selection, SKU identity,
catalog order, or inventory data. Shopify's fixed alphabetical output is not a
reason to remove merchant control from mixed shelf, cutting, or replenishment
batches.

For partially used multi-label sheets, `Start at cell` skips the already-used
slots. The scaled page preview is also an interactive cell picker, while the
numeric field remains the compact keyboard/mobile fallback. This offset is
applied to the real print page and test page, but is never persisted into the
next job.

A compact previous/next control reviews every generated page without adding a
second spreadsheet or preview mode. Preview navigation changes no job facts.

### Print

- The primary action is **Print or save PDF** and opens the native browser
  dialog. SVG symbols remain vector output; the UI does not rasterize them into
  screenshots.
- **Test page** prints the real first symbol in the chosen starting cell, all
  stock outlines, cell numbers, and the Actual Size/100% plus browser
  header/footer instruction before a full batch.
- A collapsed **Print alignment** control allows a bounded `-5` to `+5` mm
  horizontal or vertical correction after a test sheet. Positive values move
  right/down, the correction is saved only on that workstation, and Reset
  restores the physically defined template without changing job or catalog
  data.
- The screen shows page size, labels per page, total labels, and total pages
  beside the action. It never guesses printer connection or readiness.
- Plain-paper presets say so in the format picker. A merchant should not have
  to infer that `cut sheet` means the ordinary A4 paper-and-scissors workflow.
- A collapsed **External label software** control downloads one UTF-8 CSV row
  per physical label. It supports database-merge workflows without placing
  vendor-specific printer controls in the primary path; it does not claim a
  native printer queue, driver, or ZPL integration.
- Device-local last-used format/content preferences are appropriate because
  printer, paper, content, output order, and alignment belong to the workstation.
  Shared named templates can be added later without making the initial workflow
  depend on a new D1 settings surface.
- On narrow screens, a fixed compact action bar keeps the job summary, **Test**,
  and **Print / PDF** reachable while the merchant reviews format, warnings,
  and the physical page. The desktop header retains the same two actions; this
  is one workflow with responsive placement, not a second mobile mode.
- ZPL is a later explicit output target. It must not be simulated by sending a
  PDF to a Zebra printer and claiming native integration.

## Scope boundary

The release workspace deliberately solves SKU labels completely before growing
into a general warehouse-document designer.

**Release-now capabilities** are exact single-SKU and mixed-SKU entry points,
stock-aware quantities, safe A4/adhesive/thermal/custom media, partially used
sheets, fit diagnostics, a real first-label test, alignment correction, vector
browser printing, and Save as PDF. These cover the ordinary office-printer,
cut-sheet, adhesive-sheet, and label-printer workflows without requiring an
app, a design canvas, or special hardware.

The following additions have explicit authority gates:

- **Print received quantities** comes from a persisted receipt or purchase-order
  receiving result after Scalius owns that workflow. It must not guess from an
  order, inventory movement, or current on-hand count.
- **Shared named templates** arrive when a merchant needs store/location-level
  template ownership and permissions. Workstation preferences remain local;
  shared templates must never carry a partially used-sheet offset or job
  quantities.
- **Native ZPL** arrives with an explicit Zebra output target, dot-density and
  stock-size validation, downloadable output, and a real printer smoke. PDF is
  not relabelled as ZPL support.
- **Location, package, lot, and serial labels** arrive only when those are
  durable Scalius identities. They belong to the same print engine but use
  different selectors and artwork, not fake product variants.

A standalone SVG symbol download may remain an advanced packaging-design
action. It must not replace the composed page/roll job or revive the manual A4
canvas workflow.

## Barcode semantics

- `code128`: render as Code 128 with the saved value.
- `ean13`: render EAN-13 only after the existing checksum validation succeeds.
- `upc`: render UPC-A only after checksum validation succeeds.
- `gtin`: choose EAN-8, UPC-A, EAN-13, or ITF-14 from the saved length.
- `isbn`: ISBN-13 uses EAN-13; ISBN-10 is converted to its Bookland EAN-13
  symbol while retaining the saved ISBN in descriptive text.
- `custom`: render as Code 128 only when the value is printable ASCII and fits
  Code 128B. Otherwise the row remains visible but unprintable with a precise
  correction message. Do not silently change it to QR.

Internal Code 128 values are Scalius inventory identities. They are not
GS1-issued GTINs and must never be emitted as retail GTIN/EAN/UPC facts in
feeds, structured data, or external marketplaces.

## Architecture and safety

- Printing is a read-only projection. It does not mutate products, barcodes,
  inventory, or ledger rows and requires the existing `products.view`
  authority.
- A bounded label-preview API accepts exact variant IDs in a body, normalizes
  and deduplicates them, and reads product name, option label, SKU, barcode
  type/value, price, stock, reserved stock, and lifecycle state in one
  `json_each()` lookup. It preserves input order and never creates one query per
  SKU.
- The URL records the workspace and small entry context. A batch may encode at
  most 150 non-secret variant IDs; the API remains authoritative after reload
  and ignores missing, trashed, or retired identities with explicit diagnostics.
- Barcode SVG is created locally in the admin. Code 128 rendering already
  exists in `@scalius/shared`, but the label renderer must additionally support
  the saved retail symbologies. A retail value must never be printed using a
  different symbology merely because its digits fit.
- Scanner quiet zones are part of each rendered SVG, not accidental whitespace
  borrowed from the surrounding product text or label padding. EAN-13, EAN-8,
  UPC-A, ITF-14, and Code 128 keep their symbology-specific clear modules even
  when the artwork is centred or content toggles change.
- Print CSS owns physical millimetre dimensions and `@page`; preview scaling is
  screen-only. Print output hides the admin shell and preserves black bars,
  white background, quiet zones, and human-readable text.
- Focused tests cover symbology mapping, ISBN-10 conversion, custom-value
  rejection, physical fit diagnostics, quantity/page/start-cell math, custom
  stock bounds, job caps, exact-SKU ordering, missing-SKU diagnostics, the
  read-only API boundary, and the bounded `json_each()` projection.

## Implemented and live-verified

- Admin route: `/admin/inventory/labels?variants=<exact variant ids>`.
- Entry points: inventory row, inventory page selection, direct workspace, and
  persisted rows selected in the product SKU matrix.
- The 2026-07-20 merchant-printing review reconfirmed the hybrid interface:
  the individual row action opens one exact SKU at quantity one, while the
  same workspace handles mixed batches, ordinary A4 sheets, pre-cut stock,
  thermal rolls, partially used sheets, test output, and Print/Save as PDF.
  It must not regress into either an immediate-print icon or a blocking wizard.
  Current Shopify, Square, Medusa, and Vendure documentation plus GS1/Avery
  print guidance were rechecked before the live production run.
- That review also found and closed an API-contract drift: label artwork used
  the authoritative buyer-effective price returned by the inventory service,
  but the OpenAPI response schema omitted `effectivePrice`. The response
  contract and generated SDK now expose the same price fact the live label
  renderer consumes, guarded by a focused OpenAPI regression test.
- Production authenticated smoke: direct SKU load, second-SKU selection,
  reload-safe URL state, `On hand` quantity expansion, A4 2 x 7 recovery for a
  legacy long Code 128 value, custom-stock bounds and print blocking,
  numeric/interactive start-cell selection, 390 px responsive layout, no
  horizontal overflow, and no browser console warning/error.
- The deployed two-SKU mobile batch on admin version
  `89a8ad39-14c7-4092-a59b-09e0fda12602` expanded real on-hand quantities to
  12 labels on one A4 page at 390 x 844 px. Its fixed Test and Print/PDF action
  bar stayed visible and enabled without horizontal overflow. API version
  `ea1cfcec-34d2-4b10-9994-a50a1dd12cfb` published the corrected 321-path
  OpenAPI contract; production ops and the complete release smoke passed.
- The 2026-07-19 competitive re-audit used the current Shopify Retail Barcode
  Labels instructions, Shopify printer guidance, Square Retail label workflow,
  and current Vendure/Medusa/Saleor product/admin documentation. The live
  Scalius workspace then loaded its 177-SKU demo catalog, selected an exact
  persisted SKU, exposed its internal Code 128 identity and `8 on hand · 8
  available` source facts, and composed one truthful A4 adhesive label with a
  partial-sheet cell picker, test action, and Print/Save as PDF. No missing core
  workflow justified replacing the progressive workspace with a wizard or a
  direct-print row button.
- The selected-SKU row exposes the exact on-hand and available counts beside
  the scan identity. The batch shortcuts therefore have visible source facts;
  they are not unexplained transformations of the editable print quantity.
- Production API smoke: health, four readiness samples, 294-route OpenAPI, and
  current Worker deployment all passed on 2026-07-17.
- The authenticated production run on admin version
  `a406c31e-2f09-4522-9fbf-15c2e0831123` opened an individual QuietKey SKU
  from its inventory-row print action, resolved the saved internal Code 128
  value, and rendered one real label in the A4 adhesive 2 x 7 preview. Quantity,
  start-cell, test-page, and print/PDF actions were enabled without mutating
  inventory.
- Existing long Scalius Code 128 values are preserved because changing a
  printed identity would invalidate physical stock labels. They may require the
  wider A4 preset. The wide plain-paper preset keeps cut guides; the otherwise
  identical adhesive preset omits them for pre-cut stock. Newly generated
  internal identities are compact 14-digit numeric Code 128 values that use
  Code Set C and fit the thermal presets.
- Retail symbols are revalidated immediately before rendering. A legacy EAN,
  UPC, GTIN, or ISBN with an invalid checksum remains visible with a correction
  message but cannot be printed as a valid retail symbol. This is defense in
  depth beyond the product-write validator.
- Admin deployment `9c8ac2c1-8d09-4266-9981-05cc05b06f70` was re-verified on
  2026-07-17 at desktop and 390 px widths. An exact rich-demo SKU remained
  reload-safe in the URL, the physical preview and print actions were ready,
  no horizontal overflow was present, and singular job summaries rendered as
  `1 label · 1 page`.
- The 2026-07-19 correctness pass deployed API version
  `fca08a00-23ad-4b16-bc27-23fdfff153b8` and admin version
  `656a229c-1208-4a80-95bc-4baa945f146e`. Authenticated production checks
  proved an individual exact-SKU entry, a discounted SKU printing its truthful
  automatic selling price (`৳2,241` from `৳2,490` with 10% SKU discount), a
  two-SKU `On hand` batch of 20 labels, two-page pagination, start-at-cell 5 on
  a partially used A4 sheet, and the same usable workflow at 390 px. The final
  release check passed API readiness, dashboard auth, storefront, discovery,
  feeds, UCP, and a live product route.
- Admin version `a29a582a-ab51-410c-aa9a-9f2e5ba8eecb` clarified the ordinary
  A4/plain-paper presets and made an unsafe symbol fit recoverable in one click.
  Production proof selected a legacy long Code 128 SKU, blocked it on the A4
  3 × 8 grid, offered `Use A4 adhesive`, switched to the compatible 2 × 7
  format, and re-enabled both test printing and Print/Save as PDF. The
  sequential release check passed afterwards.
- Admin version `ecb63731-e127-4c44-8d74-512dc649290c` added bounded page-by-page
  review for multi-page jobs. Production proof loaded three exact rich-demo
  SKUs, expanded them to 18 on-hand labels across two A4 adhesive pages,
  navigated to page 2, and confirmed later-page cells are read-only while the
  first page remains the only partially-used-sheet start selector.
- Admin version `83123bba-fa3a-4930-9d50-44beb129d596` added bounded,
  workstation-local print alignment after renewed Shopify, Square, Lightspeed,
  Avery, and GS1 review. Production proof opened one exact rich-demo SKU,
  changed the hidden control to `1.5 mm right · 0.5 mm up`, reloaded to prove
  persistence, reset it to the physical template, and repeated the workspace
  at a real 390 × 844 viewport with no horizontal overflow. The print grid
  position and ±5 mm clamp are covered by the focused model suite.
- Admin version `f0bc4467-df7e-40a4-93e4-2fae9bf40231` added job-local label
  ordering plus bounded batch cleanup. Production proof cleared a prior job,
  selected a Dhara SKU before an Aster SKU, arranged output by product and
  variant, and confirmed the physical preview changed to Aster then Dhara while
  the exact URL selection identities remained intact. A zero-count Dhara row
  was then removed in one action, leaving the exact Aster SKU and a truthful
  `1 label · 1 page` summary. The chosen output order survived reload as a
  workstation preference. The focused model suite passed 17 tests, including
  stable selection order, product/SKU ordering, non-mutation, and zero-count
  detection.
- Admin version `74d6cbfa-41d7-46b8-a016-94723acbbf12` keeps one-off and batch
  printing in the same progressive workflow: exact-SKU row entry, selected-row
  batch entry, and the dedicated label workspace. At narrow widths a fixed
  action bar keeps the truthful label/page summary, Test, and Print/PDF actions
  reachable after a long SKU search or page preview; desktop retains the
  compact side rail. Production proof on 2026-07-19 loaded an exact rich-demo
  SKU, its saved Code 128 identity, on-hand/available facts, A4 adhesive 2 × 7
  preview, used-sheet start cell, Test, and Print/PDF. The full release check
  then passed dashboard auth, storefront, catalog discovery, UCP, and a live
  product route.
- Admin version `14fef837-9421-4f08-95e2-ebba601b430d` added the collapsed
  specialist-software bridge after rechecking the current Shopify, Square,
  Avery, Brother, Vendure, Medusa, and Saleor boundaries. Production proof
  loaded an exact Aster SKU, preserved its quantity and physical preview,
  opened **External label software**, and exposed an enabled **Download CSV**
  action without adding another primary workflow. The focused model suite now
  covers 18 cases, including repeated per-label rows, reviewed order, Unicode,
  symbol metadata, and formula-safe merchant text.
- Admin version `5bc2e086-59c8-4863-a086-7decf0bb7f66` made scanner quiet
  zones a renderer-owned invariant after the physical-output audit found that
  generic label padding could otherwise be mistaken for symbol whitespace.
  The focused model suite now covers 19 cases and fixes EAN-13, EAN-8, UPC-A,
  ITF-14, and Code 128 clear-module rules. Authenticated production proof
  reloaded an exact Aster SKU, found the expected internal 20-module Code 128
  clear area in the live SVG, kept the long legacy value blocked on narrow A4
  stock, and re-enabled Test and Print/PDF after the one-click A4 adhesive
  recovery.
- Admin version `56e81b0d-6b90-465e-9ac9-c8b828881c18` corrects the narrow
  selected-SKU card found during a fresh merchant run. Product/option, SKU,
  barcode, type, inventory, and the fit diagnostic now own the first row;
  quantity and removal sit in a separate compact action row instead of
  colliding with a long legacy identity. Full SKU/barcode values remain
  available through titles, picker checkboxes announce the exact add/remove
  action, and the fixed Test/Print bar remains visible. Production proof at
  390 x 844 retained zero horizontal overflow and exposed the long Code 128
  recovery without cramped or overlapping controls.
- Admin version `e9263d53-9b47-417a-87e0-6277905839bb` closes the ordinary
  office-paper gap in that recovery. A preserved long Code 128 value blocked
  the dense A4 grid, the live workspace offered **Use A4 wide cut**, and the
  resulting 2 x 7 job enabled Test and Print/PDF with fourteen visible cut
  guides. The real CSS-sized browser output rendered as one 210 x 297 mm A4
  page with vector symbols, exact SKU facts, no dashboard chrome, and no
  clipping. The same selected two-SKU job retained zero horizontal overflow at
  390 x 844. Pre-cut adhesive stock remains a separate guide-free preset.
- Admin version `b971379b-ddc9-4b31-b1e6-565f3e130f8e` keeps that recovery at
  the point of discovery instead of below the full paper preview. Production
  proof selected an Arka SKU whose preserved Code 128 value needs about 86 mm,
  showed the A4 3 x 8 blocker immediately beneath the selected-SKU card, and
  offered **Use A4 wide cut** before the searchable picker. The action switched
  to the 2 x 7 plain-paper format and enabled Test and Print/PDF on desktop and
  at 390 x 844, with zero horizontal overflow and no browser errors.
- Admin version `7c94a885-81e9-44f6-b50b-85af620a9892` closes the remaining
  preserved-identity fit gap found during the renewed 2026-07-20 live check.
  The exact Dock SKU's internal Code 128 identity needs about 115 mm of safe
  symbol width, while the previous two-column A4 recovery provides only 90 mm.
  The deployed workspace correctly blocked that unsafe job, offered **Use A4
  extra-wide cut**, switched to a 1 x 10 full-width plain-paper sheet, and
  enabled Test and Print/PDF without changing the saved barcode. The browser
  console remained free of warnings and errors.

## Product boundary and future extensions

The best interface is deliberately not a mandatory step-by-step wizard. A
wizard slows the common “print this SKU” action and hides the physical sheet
while quantities change. Scalius uses progressive disclosure instead:

1. A row-level **Print label** action opens one exact SKU with quantity one.
2. Inventory/product multi-select opens the same workspace with the selection
   preserved, where `One each`, `On hand`, and `Available` prepare common jobs.
3. The workspace exposes paper/roll, content, start-cell, alignment, preview,
   test, and final print/PDF in one reviewable state. Browser Print provides the
   universal Save as PDF path for office A4 workflows; thermal printers remain
   ordinary print destinations.

This matches the useful coverage of Shopify/Square-style template and batch
printing while avoiding a separate label app and adds the A4/manual-cut flow
that small merchants otherwise assemble by hand. The workspace already covers
exact single/batch SKUs, stock-derived quantities, A4/plain/adhesive/thermal/
custom formats, partially used sheets, physical fit, test pages, bounded
alignment, vector output, and browser PDF.

Receiving-derived quantities, team-shared templates, native ZPL, and location,
package, lot, or serial labels are later inventory/fulfilment capabilities and
must not be fabricated from the current SKU model. SVG download may be added as
an advanced export, never as the primary merchant workflow.

## Interface direction

The workspace inherits the existing Scalius neutral surfaces and typography.
Physical output, not decorative chrome, is the signature element.

- Ink `#09090B`, paper `#FFFFFF`, crop `#A1A1AA`, warning `#D97706`, ready
  `#059669`, and the existing admin accent form the compact palette.
- Existing admin sans handles controls and product names; the existing
  monospace utility handles SKU/barcode data. No new decorative font is added
  to an operational surface.
- The memorable element is the scaled physical sheet with real page edges,
  crop marks, label count, and exact millimetre dimensions.

```text
+---------------------------------------------------------------+
| Barcode labels                           48 labels · 2 pages   |
+--------------------------------------+------------------------+
| Find and select SKUs                 | Format                 |
| [ Search product, SKU, barcode... ]  | A4 cut sheet · 3 x 8  |
| Product / variant       Qty  [− 1 +] | [content toggles]      |
| ...                                  |                        |
|                                      |   live paper preview   |
|                                      |   ┌───────────────┐    |
|                                      |   │ ▥ ▥ ▥         │    |
|                                      |   │ ▥ ▥ ▥         │    |
+--------------------------------------+------------------------+
| Remove zero-count rows      Print test   Print or save PDF    |
+---------------------------------------------------------------+
```
