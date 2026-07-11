import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./InventoryManager.tsx", import.meta.url),
  "utf8",
);

describe("InventoryManager boundaries", () => {
  it("renders explicit retry states for both inventory queries", () => {
    expect(source).toContain("variantsQuery.isError");
    expect(source).toContain("void variantsQuery.refetch()");
    expect(source).toContain("movementsQuery.isError");
    expect(source).toContain("void movementsQuery.refetch()");
  });

  it("reports truthful physical, reserved, and preorder counter transitions", () => {
    expect(source).toContain("getMovementCounterChanges");
    expect(source).toContain("Reserved");
    expect(source).toContain("Preorder");
  });

  it("exposes tab and adjustment controls to assistive technology", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain('htmlFor="inventory-adjustment-amount"');
    expect(source).toContain('aria-label="Decrease adjustment by one"');
    expect(source).toContain('aria-label="Increase adjustment by one"');
  });
});
