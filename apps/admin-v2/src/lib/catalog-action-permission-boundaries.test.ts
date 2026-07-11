import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const productsRoute = readSource("../routes/admin/products/index.tsx");
const categoriesRoute = readSource("../routes/admin/categories/index.tsx");
const attributesRoute = readSource("../routes/admin/attributes.tsx");
const collectionsRoute = readSource("../routes/admin/collections/index.tsx");
const productView = readSource("../components/admin/ProductView.tsx");
const inventory = readSource("../components/admin/InventoryManager.tsx");
const catalogColumns = [
  "../components/admin/data-table/columns/product-columns.tsx",
  "../components/admin/data-table/columns/category-columns.tsx",
  "../components/admin/data-table/columns/attribute-columns.tsx",
  "../components/admin/data-table/columns/collection-columns.tsx",
].map(readSource);

describe("catalog action permission boundaries", () => {
  it("gates product create/edit/delete/restore/bulk controls", () => {
    expect(productsRoute).toContain("productActions.canCreate");
    expect(productsRoute).toContain("productActions.canEdit");
    expect(productsRoute).toContain("productActions.canDelete");
    expect(productsRoute).toContain("productActions.canRestore");
    expect(productsRoute).toContain("productActions.canPermanentDelete");
    expect(productsRoute).toContain("productActions.canBulkDelete");
    expect(productView).toContain("productActions.canEdit &&");
  });

  it("gates category and attribute mutations while preserving view surfaces", () => {
    for (const [source, actions] of [
      [categoriesRoute, "categoryActions"],
      [attributesRoute, "attributeActions"],
    ] as const) {
      expect(source).toContain(`${actions}.canCreate`);
      expect(source).toContain(`${actions}.canEdit`);
      expect(source).toContain(`${actions}.canDelete`);
      expect(source).toContain(`${actions}.canRestore`);
      expect(source).toContain(`${actions}.canPermanentDelete`);
      expect(source).toContain(`${actions}.canBulkDelete`);
    }
    expect(attributesRoute).toContain("<AttributeValuesViewer");
  });

  it("gates collection reorder/status and inventory stock adjustment", () => {
    expect(collectionsRoute).toContain("collectionActions.canToggleStatus");
    expect(collectionsRoute).toContain("collectionActions.canReorder");
    expect(collectionsRoute).toContain("collectionActions.canCreate");
    expect(collectionsRoute).toContain("collectionActions.canDelete");
    expect(inventory).toContain("inventoryActions.canAdjustStock &&");
  });

  it("removes row selection and mutation menu items when unavailable", () => {
    for (const source of catalogColumns) {
      expect(source).toContain("...(opts.canSelect");
      expect(source).toContain("onDelete: opts.canDelete");
      expect(source).toContain("onRestore: opts.canRestore");
      expect(source).toContain("opts.canPermanentDelete");
    }
    expect(catalogColumns[1]).toContain("const canShowActions");
    expect(catalogColumns[2]).toContain("const canShowActions");
    expect(catalogColumns[3]).toContain("const canShowActions");
  });
});
