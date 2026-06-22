import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PRODUCT_VIEW_SOURCE = fileURLToPath(
  new URL("./ProductView.tsx", import.meta.url),
);

describe("ProductView inventory presentation boundaries", () => {
  it("does not render untracked simple SKUs as zero available stock", () => {
    const source = readFileSync(PRODUCT_VIEW_SOURCE, "utf8");

    expect(source).toContain("trackInventory?: boolean | null");
    expect(source).toContain("v.trackInventory !== false");
    expect(source).toContain("Product SKU");
    expect(source).not.toContain("Simple product SKU");
    expect(source).toContain("No stock limit");
    expect(source).toContain("available === null");
    expect(source).not.toContain("const available = v.stock - v.reservedStock");
  });
});
