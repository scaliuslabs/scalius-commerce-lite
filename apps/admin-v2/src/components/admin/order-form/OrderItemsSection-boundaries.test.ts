import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const itemsSource = readFileSync(
  fileURLToPath(new URL("./OrderItemsSection.tsx", import.meta.url)),
  "utf8",
);
const searchSource = readFileSync(
  fileURLToPath(new URL("./ProductSearch.tsx", import.meta.url)),
  "utf8",
);
const itemSelectionSource = readFileSync(
  fileURLToPath(new URL("./ItemSelection.tsx", import.meta.url)),
  "utf8",
);
const querySource = readFileSync(
  fileURLToPath(new URL("../../../lib/api-query-options/orders.ts", import.meta.url)),
  "utf8",
);

describe("manual-order catalog boundaries", () => {
  it("uses one debounced, paginated server catalog for new and edit forms", () => {
    expect(itemsSource).toContain("useDebounce(");
    expect(itemsSource).toContain("useInfiniteQuery(");
    expect(itemsSource).toContain("orderCatalogProductsQueryOptions({");
    expect(itemsSource).toContain("productQuery.fetchNextPage()");
    expect(itemsSource).not.toContain("allProducts.filter");
    expect(itemsSource).not.toContain("initialProductsToShow");
    expect(querySource).toContain('getOrderCatalogProducts({ data: { page: pageParam, limit, search } })');
    expect(querySource).toContain("lastPage.pagination.page < lastPage.pagination.totalPages");
  });

  it("keeps loading, failure, empty, and retry states distinct", () => {
    expect(searchSource).toContain("Searching catalog...");
    expect(searchSource).toContain("The product catalog could not be loaded.");
    expect(searchSource).toContain("No active products match this search.");
    expect(searchSource).toContain("Retry loading more");
    expect(searchSource).toContain("Search product, SKU, or barcode...");
  });

  it("retains exact lazy-loaded product and SKU projections for staged rows", () => {
    expect(itemsSource).toContain("resolvedProductsById");
    expect(itemsSource).toContain("resolvedVariantsById");
    expect(itemsSource).toContain("[product.id]: product");
    expect(itemsSource).toContain("[variant.id]: variant");
  });

  it("keeps add-item quantity editing on the shared valid-draft control", () => {
    expect(itemSelectionSource).toContain("<OrderItemQuantityInput");
    expect(itemSelectionSource).toContain("onQuantityChange={setQuantity}");
    expect(itemSelectionSource).toContain("onEnter={() => {");
    expect(itemSelectionSource).not.toContain("parseInt(e.target.value) || 1");
  });
});
