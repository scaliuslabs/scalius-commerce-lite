# Variant section concept evaluation

Status: awaiting merchant selection. No prototype is wired into production.

## 01 — Table-first operations

- Smallest desktop footprint and fastest cross-SKU scanning.
- Axis definitions and combination coverage remain visible above the table.
- SKU and price are directly editable; selection reveals contextual bulk work.
- Best fit for experienced catalog operators and large matrices.
- Tradeoff: the wide desktop table asks the merchant to understand SKU concepts
  early, so first-time option creation needs an excellent guided empty state.

## 02 — Option-builder first

- Makes the relationship `axis → values → combinations → sellable SKUs`
  explicit, including the Cartesian-product count and a safe limit.
- Supports arbitrary ordered axes and non-destructive matrix regeneration.
- Dense cells expose the most common SKU facts without opening another editor.
- Best fit for first-time clarity and product setup.
- Tradeoff: mobile becomes long when every SKU field is permanently open, and
  the builder occupies more vertical space after setup is complete.

## 03 — Progressive workbench

- Keeps the list highly scannable and expands exactly one SKU into a complete
  inline editor.
- Separates merchandise edits from auditable inventory movements and shows
  on-hand, committed, and available quantities together.
- Adds keyboard navigation, attention filtering, and contextual bulk actions.
- Best balance for mixed first-time and expert workflows.
- Tradeoff: editing several different fields across many rows is slower than
  the always-editable table unless a dedicated bulk mode is also supplied.

## Implementation recommendation after selection

Use the selected concept as the primary interaction model, then borrow only the
following compatible strengths rather than averaging all three into a crowded
hybrid:

- the explicit combination equation and non-destructive regeneration contract
  from 02;
- the inventory truth and one-expanded-row rule from 03;
- the compact toolbar and bulk-selection grammar from 01.

The production implementation must use the existing React/shadcn component
system. Tailwind CDN and prototype-only JavaScript stay isolated here.
