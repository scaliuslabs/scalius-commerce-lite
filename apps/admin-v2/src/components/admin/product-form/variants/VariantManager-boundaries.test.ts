import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VARIANT_MANAGER_SOURCE = fileURLToPath(
  new URL("./VariantManager.tsx", import.meta.url),
);
const SIMPLE_SKU_PANEL_SOURCE = fileURLToPath(
  new URL("./SimpleProductSkuPanel.tsx", import.meta.url),
);
const VARIANT_TOOLBAR_SOURCE = fileURLToPath(
  new URL("./VariantActionsToolbar.tsx", import.meta.url),
);
const VARIANT_TABLE_SOURCE = fileURLToPath(
  new URL("./VariantTable.tsx", import.meta.url),
);
const VARIANT_ROW_SOURCE = fileURLToPath(
  new URL("./VariantDisplayRow.tsx", import.meta.url),
);

describe("VariantManager product mode boundaries", () => {
  it("routes one protected no-option SKU to the simple inventory panel", () => {
    const source = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");

    expect(source).toContain("import { SimpleProductSkuPanel }");
    expect(source).toContain("getVariantManagementMode(localVariants)");
    expect(source).toContain('variantMode.mode === "simple" && !isAdding');
    expect(source).toContain("<SimpleProductSkuPanel");
    expect(source).toContain("variant={variantMode.variant}");
    expect(source).toContain("onAddOption=");
  });

  it("keeps protected simple SKUs out of the customer-option matrix", () => {
    const source = readFileSync(VARIANT_MANAGER_SOURCE, "utf8");

    expect(source).toContain("const matrixVariants = useMemo");
    expect(source).toContain('if (variantMode.mode === "optioned") return variantMode.variants;');
    expect(source).toContain('if (variantMode.mode === "simple" && isAdding) return [];');
    expect(source).toContain("const filtered = filterVariants(matrixVariants, filters)");
    expect(source).toContain("getVariantStats(matrixVariants)");
    expect(source).toContain("variants={matrixVariants}");
  });

  it("uses merchant-facing SKU language for simple products and option language for option tables", () => {
    const simpleSource = readFileSync(SIMPLE_SKU_PANEL_SOURCE, "utf8");
    const toolbarSource = readFileSync(VARIANT_TOOLBAR_SOURCE, "utf8");
    const tableSource = readFileSync(VARIANT_TABLE_SOURCE, "utf8");
    const rowSource = readFileSync(VARIANT_ROW_SOURCE, "utf8");

    expect(simpleSource).toContain("Inventory & SKU");
    expect(simpleSource).toContain("This product has one sellable SKU and no customer options.");
    expect(simpleSource).toContain("Add size/color option");
    expect(simpleSource).toContain("Price and discount stay in Pricing.");
    expect(simpleSource).not.toContain('name="price"');
    expect(simpleSource).not.toContain("Discount type");
    expect(toolbarSource).toContain("Search options...");
    expect(toolbarSource).toContain("Add Option");
    expect(tableSource).toContain("No options yet");
    expect(rowSource).toContain("Option actions");
    expect(rowSource).toContain("Edit Option");
    expect(rowSource).toContain("Delete Option");
  });
});
