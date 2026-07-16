# Barcode label printing

Last reviewed: 2026-07-17

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

The workspace keeps three layers visible on desktop: selected SKUs and label
counts, format/content controls, and a sticky live paper preview. On narrow
screens those layers stack into one responsive workspace. Exact SKU selection
is reload-safe in the URL; quantities and partially used-sheet position are
intentionally job-local so a later print run cannot silently reuse an old stock
count or skip fresh labels. A returning merchant with a saved device
format/content preference can reach the browser print dialog after one review;
a first-time merchant can see every decision before printing.

## Competitive evidence

- [Shopify Retail Barcode Labels](https://help.shopify.com/en/manual/sell-in-person/hardware/barcode-printer/retail-barcode-labels)
  uses product-list selection as an entry point, then asks for a template,
  per-variant quantities, print settings, and final Print. The browser print
  dialog also provides Save as PDF. It supports named Dymo, Avery, and Zebra
  media, but label printing remains a separately installed app.
- [Square barcode labels](https://squareup.com/help/us/en/article/6093-create-and-print-bar-code-labels-with-square-for-retail)
  can start from a custom item set, category, or purchase order; offers SKU or
  GTIN selection, label preview, test printing, PDF download, and per-item
  quantities. Receiving is a valuable future source when Scalius has purchase
  order authority.
- [Odoo printable delivery PDFs](https://www.odoo.com/documentation/17.0/applications/inventory_and_mrp/inventory/shipping_receiving/setup_configuration/print_on_validation.html)
  provides dense 2x7 and 4x12 page grids, one-per-unit quantities, PDF, and ZPL.
  Those outputs are operationally capable but expose format choices more than
  most small merchants need on every run.
- Vendure's current ProductVariant core model exposes SKU but no first-class
  barcode or label-printing workspace; its extension points are the intended
  route for such a feature. Medusa stores searchable variant barcode/EAN/UPC
  values and imports them by CSV, but its current admin guide does not provide a
  core label composer. Searches of Saleor's current core and dashboard sources
  found no first-class barcode or label-printing workflow. These platforms are
  architecture references, not a UX bar for this feature.
- [Avery print guidance](https://www.avery.com/help/article/practice-test-sheet?page=1)
  requires an initial plain-paper alignment test and Actual Size/100% scale.
  [GS1 guidance](https://www.gs1.org/standards/barcodes/10-steps-to-barcode-your-product/english)
  requires the correct symbol, human-readable digits, contrast, and quiet
  zones. Scalius must not shrink a barcode merely to make a crowded template
  look tidy.

## Scalius workflow

### Select

- Search is server-backed by product, SKU, or exact barcode.
- Selection is exact persisted SKU identity. Draft SKUs must be saved before a
  printable barcode exists.
- Each selected row shows product, merchant option label, SKU, barcode type,
  barcode value, stock, and label quantity.
- Quantity shortcuts are `One each`, `On hand`, and `Available`; every SKU also
  has an exact editable quantity. Zero is allowed and removes that SKU from the
  print count without losing it from the batch.
- A job is bounded to 150 SKUs and 1,000 rendered labels. The UI calculates
  page count before rendering and blocks an excessive job instead of freezing
  the browser.

### Design

Primary presets:

1. **A4 cut sheet — 3 x 8.** Plain office paper, 24 labels per page, visible
   crop marks, safe printer margins. This replaces manual A4 canvas assembly.
2. **A4 compact — 4 x 10.** Plain paper or unbranded adhesive stock, 40 labels
   per page; shorter names and smaller but still valid symbols.
3. **A4 adhesive — 2 x 7.** Fourteen larger labels with no crop marks.
4. **Thermal 50 x 25 mm.** One label per page for common roll printers.
5. **Thermal 40 x 30 mm.** One label per page for compact retail labels.
6. **Custom.** Page size, rows, columns, symmetric margins, gaps, and cut guides
   remain advanced disclosure, not the default screen. The derived label cell
   must remain at least 20 x 15 mm.

Label content is restrained: barcode symbol and human-readable value are
mandatory; product name, variant, SKU, and price are optional. The
preview reports when the chosen media cannot hold the selected symbology at a
safe size. Truncating descriptive text is allowed; truncating, horizontally
scaling, or clipping the symbol or quiet zones is not.

For partially used multi-label sheets, `Start at cell` skips the already-used
slots. The scaled page preview is also an interactive cell picker, while the
numeric field remains the compact keyboard/mobile fallback. This offset is
applied to the real print page and test page, but is never persisted into the
next job.

### Print

- The primary action is **Print or save PDF** and opens the native browser
  dialog. SVG symbols remain vector output; the UI does not rasterize them into
  screenshots.
- **Test page** prints the real first symbol in the chosen starting cell, all
  stock outlines, cell numbers, and the Actual Size/100% plus browser
  header/footer instruction before a full batch.
- The screen shows page size, labels per page, total labels, and total pages
  beside the action. It never guesses printer connection or readiness.
- Device-local last-used format/content preferences are appropriate because
  printer and paper choice belong to the workstation. Shared named templates
  can be added later without making the initial workflow depend on a new D1
  settings surface.
- ZPL is a later explicit output target. It must not be simulated by sending a
  PDF to a Zebra printer and claiming native integration.

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
- Production authenticated smoke: direct SKU load, second-SKU selection,
  reload-safe URL state, `On hand` quantity expansion, A4 2 x 7 recovery for a
  legacy long Code 128 value, custom-stock bounds and print blocking,
  numeric/interactive start-cell selection, 390 px responsive layout, no
  horizontal overflow, and no browser console warning/error.
- Production API smoke: health, four readiness samples, 295-route OpenAPI, and
  current Worker deployment all passed on 2026-07-17.
- Existing long Scalius Code 128 values are preserved because changing a
  printed identity would invalidate physical stock labels. They may require the
  wider A4 preset. Newly generated internal identities are compact 14-digit
  numeric Code 128 values that use Code Set C and fit the thermal presets.

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
