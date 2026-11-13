// Statements over the CTE-expansion bound today (packages/core/src/testing/statement-size.ts),
// owned by the catalog, storefront and cache data layers and scheduled as
// their own work: `route | statement` to [CTE cursors, CTE references], most
// at risk first. An entry may only shrink (both numbers); it fails once its
// statement fits, so it is removed then. Any other statement over the bound fails.
//
// SQLite 3.54.1 (workerd 1.20261110.1) refused the price-filtered listing's
// facets and the recommendation ranking; it accepted the others.
export const PENDING: Readonly<Record<string, readonly [cteCursors: number, cteReferences: number]>> = {
  "/api/v1/products?page=1&limit=20&minPrice=1000&maxPrice=3000 | with facet_scope": [197, 10],
  "/api/v1/products?ids=p_linen,p_silk,p_bag | with facet_scope": [108, 14],
  "/api/v1/admin/notifications | with allowed": [108, 5],
  "/api/v1/products?page=1&limit=20&search=panjabi | with facet_scope": [94, 11],
  // The same listing statement as search=panjabi, for the cache gate's search-only word (one entry to restructure).
  "/api/v1/products?page=1&limit=20&search=velquar | with facet_scope": [94, 11],
  "/api/v1/products?page=1&limit=20&search=silk&sort=relevance | with facet_scope": [94, 11],
  "/api/v1/storefront/batch?r=%2Fapi%2Fv1%2Fstorefront%2Flayout&r=%2Fapi%2Fv1%2Fproducts%3Fpage%3D1%26limit%3D20%26sort%3Drelevance%26search%3Dlinen | with facet_scope": [94, 11],
  "/api/v1/products?page=1&limit=20&category=panjabi&sort=newest | with facet_scope": [69, 11],
  "/api/v1/categories/panjabi/product-summaries?page=1&limit=20 | with facet_scope": [62, 5],
  "/api/v1/products?page=1&limit=20&minPrice=1000&maxPrice=3000 | select products": [62, 1],
};

/** Statements over the bound that writes and maintenance prepare (budget cases, the cache harness), by flow and statement. */
export const PENDING_WRITES: Readonly<Record<string, readonly [cteCursors: number, cteReferences: number]>> = {
  "nightly catalog projection check (catalog-projections.ts) | with drift_live_rows": [132, 8],
};
