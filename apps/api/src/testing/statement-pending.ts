// Statements over the CTE-expansion bound today (packages/core/src/testing/statement-size.ts),
// owned by the catalog, storefront and cache data layers and scheduled as
// their own work: `route | statement` to [CTE cursors, CTE references], most
// at risk first. An entry may only shrink (both numbers); it fails once its
// statement fits, so it is removed then. Any other statement over the bound fails.
//
// SQLite 3.54.1 (workerd 1.20261110.1) refused the price-filtered listing's
// facets (now one pass with no CTE), the recommendation ranking and the
// narrowed shop-all summary (its plan is now a derived table); it accepted
// the others. The collections directory's card facts became visible when
// the census's store gained collections: its card ids CTE is a public
// product query read by four terms (card-facts.ts), accepted there.
export const PENDING: Readonly<Record<string, readonly [cteCursors: number, cteReferences: number]>> = {
  "/api/v1/admin/notifications | with allowed": [108, 5],
  "/api/v1/categories/panjabi/product-summaries?page=1&limit=20 | with facet_scope": [62, 5],
  "/api/v1/collections/directory | select (with card_ids)": [109, 4],
};

/** Statements over the bound that writes and maintenance prepare (budget cases, the cache harness), by flow and statement. */
export const PENDING_WRITES: Readonly<Record<string, readonly [cteCursors: number, cteReferences: number]>> = {
  "nightly catalog projection check (catalog-projections.ts) | with drift_live_rows": [132, 8],
};
