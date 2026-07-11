# Catalog Domain and Data Audit

Last reviewed: 2026-07-12

## P1 inventory integrity

1. **Preorder stock is lost on reservation expiry.** `inventory/expiry.ts` releases `reservedStock` but does not restore `preorderStock` for expired `preorder_reserved` movements.
2. **Inventory mutation boundaries do not consistently require positive finite integers.** The validator exists but is unused by several reserve/deduct/release paths; negative or fractional values can reverse counter semantics.
3. **Legacy deduction/release paths are not replay-safe and remain used by order workflows.** They can repeat stock changes and record movements separately from state. Move all order callers to deterministic claim plus CAS batches.
4. **Expiry treats any terminal movement as fully terminal.** Partial releases and re-reservation generations can leave outstanding quantities permanently stranded.
5. **The movement ledger contract is contradictory.** Schema comments define signed physical deltas, while reserve/deduct/release use different action semantics; the table lacks pool and before/after reserved/preorder counters. A ledger cannot be reliably folded back to SKU state.
6. **Positive restocks do not resolve low-stock alerts.** Alert reconciliation runs only for negative changes in some paths.
7. **Dashboard low-stock calculation contradicts alert policy.** Null threshold disables alerts but list stats substitute a threshold of five.

## P1 product/variant integrity

- Duplicate normalized option combinations are allowed under different SKUs, making buyer selection ambiguous. Add normalized product/option uniqueness for active non-default variants.
- Bulk variant creation commits in chunks; a later conflict leaves earlier chunks persisted. Use one atomic D1 batch or an explicit durable import job with row results.
- Duplicate IDs in bulk update can partially commit before a conflict is reported. Reject duplicates before reads and make claims fail atomically.
- General variant `version` exists but metadata updates neither compare nor increment it; product aggregate updates also lack a revision. Add CAS and 409 merge/reload UX.
- Barcodes are indexed but not unique; lookup uses `.get()` and duplication copies barcodes. Define normalized uniqueness or an explicit duplicate-code policy.
- Product aggregate image/attribute/rich-content writes and list enrichment can exceed D1’s 100-parameter limit. Bound/chunk at 90 or use per-row batch statements.
- Catalog money uses SQLite `REAL`; long-term price storage should use currency-aware minor units or a rigorously shared decimal representation.

## P1 attributes and collections

- Attribute preset merging is page-local and duplicates used values across pages.
- Public attribute-filter resolution accepts deleted/non-filterable keys and is not capped below the D1 parameter limit.
- Search facets derive from categories containing hits instead of the matching product set, so offered values can produce zero results.
- Attribute deletion paths are inconsistent; bulk can bypass single-delete usage protections.
- One `(product_id, attribute_id)` value cannot model legitimate multi-valued attributes without delimiter hacks.
- Collection detail and homepage resolvers use different category ordering/limits and can return different products for the same collection.
- Collection `type` is largely cosmetic, config arrays are unbounded, category reads can become one query per category, and product IDs override categories regardless of copy.
- Collection ordering is not a validated unique permutation; concurrent creates and partial reorder payloads can duplicate ranks.

## Currency decision boundary

- Orders already keep immutable currency and precision snapshots; preserve that safeguard.
- Products and variants do not carry currency. A global code change reinterprets all live prices.
- Until a transactional migration with preview, rounding, audit, and rollback exists, lock base currency once catalog or order money-bearing rows exist. Symbol and positive exchange-rate corrections may remain editable.
- Currency code, symbol, and rate must validate before any write and commit atomically.

## Existing safeguards to preserve

- One protected active default SKU per product.
- Hard product delete blocked when SKU inventory history exists; movement FK uses `ON DELETE RESTRICT`.
- Shared buyer-resolvable SKU eligibility separates visibility from availability.
- Strict reservation batches use sellability checks, `stockVersion` CAS, deterministic movement claims, and rollback handling.
- Stock writes invalidate product/list/search, feed, sitemap, exact product HTML, and shortcode targets.
- Dedicated feed and sitemap projections remain separate from ordinary product listing reads.

## Required invariant tests

- Zero, negative, fractional, `NaN`, overflow quantities at every exported inventory mutation boundary.
- Duplicate delivery/replay for reserve, deduct, release, restore, and preorder paths.
- Expired and partial preorder reservation restoration, mixed pools, and re-reservation generations.
- Ledger reconciliation from movements to all SKU counters.
- Duplicate/case/whitespace option combinations and concurrent create.
- Chunk-two variant import failure leaves zero partial rows.
- Two editors save the same product revision: one wins, one receives actionable 409.
- 100+ IDs/images/attributes remain within D1 limits.
