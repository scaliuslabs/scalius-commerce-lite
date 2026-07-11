# Catalog Domain and Data Audit

Last reviewed: 2026-07-12

## P1 inventory integrity

1. **Resolved in batch 1: preorder expiry restores its source pool.** Expired preorder reservations return `preorderStock` and release `reservedStock`; regular reservations remain regular-pool changes.
2. **Resolved in batch 1: inventory quantities are positive finite integers at mutation boundaries.** Relative adjustment remains the only signed quantity input.
3. **Production callers have migrated off the legacy deduction/release paths.** Order, payment, fulfillment, stale-checkout, manual-edit, and trash-restore workflows now use deterministic movement claims plus stock CAS batches. The sequential exports remain isolated compatibility surfaces with no production caller; do not introduce new callers.
4. **Resolved in batch 4: expiry reconciles outstanding quantities per pool and reservation generation.** Partial releases/deductions no longer hide the remaining orphaned reservation.
5. **Resolved for new writes in batch 4: ledger v2 has one CAS-ordered edge per SKU mutation.** It records pool/generation identity and before/after/delta values for physical, reserved, and preorder counters. Legacy v1 rows remain an explicit non-foldable history boundary.
6. **Resolved in batch 1: stock changes reconcile low-stock alerts in both directions.** Restocks and no-op corrections clear stale alerts when the configured threshold is no longer breached.
7. **Resolved in batch 1: dashboard low-stock truth matches alert policy.** Only an explicit positive threshold enables low-stock state.

## P1 product/variant integrity

- Application writes reject duplicate normalized option combinations and inconsistent option-axis shapes. A database unique index remains blocked by the documented legacy duplicate product.
- Production preflight on 2026-07-12 found one legacy product (`prod_DgYZ43wj5zcNoug7gEdUL`) with four active `s / Red` SKUs. None currently has order or inventory movement history, but choosing the canonical SKU is a merchant data decision. Application writes now reject new normalized duplicates and allow incremental repair; a database unique index remains blocked until that legacy row set is resolved deliberately.
- Resolved in batches 2–3: bulk creates and mixed create/update spreadsheet plans commit in one D1 transaction; duplicate update IDs and normalized conflicts fail before writes.
- Resolved in batch 5: product composition has mandatory `aggregateRevision` CAS across product, SKU, sort, and tax-classification writes. Category/attribute/tax cascades bump affected products atomically; typed 409 responses carry expected/current revisions.
- Resolved at the application boundary in batch 5: barcode/type pairs are trimmed and validated, standard formats require valid checksums, normalized global duplicates are rejected, and lookups read at most two rows and fail closed. The normalized database unique index lands with the verified production repair migration.
- Resolved in batch 5: SKU removal always soft-retires identity. Transactional guards recheck reservations, open orders, final-option topology, lifecycle, and stock version before any affected batch writes.
- Resolved in batch 5: permanent product deletion is trash-only and rechecks order, discount, and inventory-history absence inside the deletion transaction.
- Product aggregate image/attribute/rich-content writes and list enrichment can exceed D1’s 100-parameter limit. Bound/chunk at 90 or use per-row batch statements.
- Catalog money uses SQLite `REAL`; long-term price storage should use currency-aware minor units or a rigorously shared decimal representation.
- Stable image-ID associations support SKU or normalized option-value targets. The remaining marker fallback and marker rows are scheduled for immediate removal in the production repair release; no permanent compatibility path is accepted.

## P1 attributes and collections

- Resolved in batch 2: attribute value search/pagination and preset reconciliation use authoritative global/search totals and complete D1-safe used-value lookups.
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
