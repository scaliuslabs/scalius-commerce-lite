import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_FUNCTIONS_SOURCE = fileURLToPath(
  new URL("./api-functions/products.ts", import.meta.url),
);
const API_MUTATIONS_SOURCE = fileURLToPath(
  new URL("./api-mutations/products.ts", import.meta.url),
);
const PRODUCT_ROUTE_SOURCE = fileURLToPath(
  new URL("../routes/admin/products/index.tsx", import.meta.url),
);
const PRODUCT_COLUMNS_SOURCE = fileURLToPath(
  new URL(
    "../components/admin/data-table/columns/product-columns.tsx",
    import.meta.url,
  ),
);
const TAX_API_FUNCTIONS_SOURCE = fileURLToPath(
  new URL("./api-functions/taxes.ts", import.meta.url),
);
const TAX_CLASSIFICATIONS_SOURCE = fileURLToPath(
  new URL("../components/admin/taxes/TaxClassificationsPanel.tsx", import.meta.url),
);

describe("admin product aggregate revision mutation boundaries", () => {
  it("requires a revision claim for every product CRUD mutation", () => {
    const functions = readFileSync(API_FUNCTIONS_SOURCE, "utf8");
    const mutations = readFileSync(API_MUTATIONS_SOURCE, "utf8");

    expect(functions).toContain("interface ProductAggregateRevisionClaim");
    expect(functions).toContain(
      "?expectedAggregateRevision=${data.expectedAggregateRevision}",
    );
    expect(functions).toContain("products: ProductAggregateRevisionClaim[]");
    expect(functions).toContain("Promise<ProductAggregateRevisionResult>");
    expect(mutations).toContain("data: ProductAggregateRevisionClaim");
    expect(mutations).toContain("data: BulkDeleteProductsInput");
  });

  it("builds single and bulk claims from the authoritative list rows", () => {
    const route = readFileSync(PRODUCT_ROUTE_SOURCE, "utf8");
    const columns = readFileSync(PRODUCT_COLUMNS_SOURCE, "utf8");

    expect(columns).toContain("aggregateRevision: number");
    expect(route).toContain(
      "expectedAggregateRevision: productToDelete.aggregateRevision",
    );
    expect(route).toMatch(/table\s*\.getSelectedRowModel\(\)/);
    expect(route).toContain(
      "expectedAggregateRevision: product.aggregateRevision",
    );
    expect(route).not.toContain("{ productIds: selectedIds");
  });

  it("has no persisted option duplicate client or mutation", () => {
    const functions = readFileSync(API_FUNCTIONS_SOURCE, "utf8");
    const mutations = readFileSync(API_MUTATIONS_SOURCE, "utf8");

    expect(functions).not.toContain("duplicateProductVariant");
    expect(functions).not.toContain("/duplicate");
    expect(mutations).not.toContain("useDuplicateProductVariant");
  });

  it("guards product and SKU tax classification writes with the product revision", () => {
    const functions = readFileSync(TAX_API_FUNCTIONS_SOURCE, "utf8");
    const panel = readFileSync(TAX_CLASSIFICATIONS_SOURCE, "utf8");

    expect(functions).toContain("aggregateRevision: number");
    expect(functions).toContain("expectedAggregateRevision: number");
    expect(functions).toContain(
      "expectedAggregateRevision: data.expectedAggregateRevision",
    );
    expect(panel).toContain(
      "expectedAggregateRevision: input.item.aggregateRevision",
    );
    expect(panel).toContain(
      "queryClient.invalidateQueries({ queryKey: queryKeys.products.all })",
    );
  });
});
