import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./products.admin.ts", import.meta.url)),
  "utf8",
);

describe("admin order catalog product search", () => {
  it("can require active products without changing the general catalog default", () => {
    expect(source).toContain("activeOnly?: boolean");
    expect(source).toContain("activeOnly = false");
    expect(source).toContain("if (activeOnly)");
    expect(source).toContain("whereConditions.push(eq(products.isActive, true))");
  });

  it("does not surface a product because a retired SKU still matches FTS", () => {
    const searchBlock = source.split("const ftsCondition")[1]?.split("if (barcodeKey)")[0] ?? "";
    expect(searchBlock).toContain("productVariants.deletedAt");
    expect(searchBlock).toContain("IS NULL");
    expect(searchBlock).toContain("product_variants_fts MATCH");
  });
});
