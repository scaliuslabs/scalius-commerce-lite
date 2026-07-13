import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./InventoryManager.tsx", import.meta.url),
  "utf8",
);

const mobileListStart = source.indexOf("function InventoryVariantMobileList");
const adjustButtonStart = source.indexOf("function InventoryAdjustButton");
const mobileListSource = source.slice(mobileListStart, adjustButtonStart);

describe("InventoryManager responsive variants workflow", () => {
  it("uses exclusive desktop-table and mobile-list layouts", () => {
    expect(mobileListStart).toBeGreaterThan(-1);
    expect(adjustButtonStart).toBeGreaterThan(mobileListStart);
    expect(source).toContain(
      'data-inventory-layout="desktop" className="relative hidden overflow-hidden rounded-md border md:block"',
    );
    expect(source).toContain(
      'data-inventory-layout="mobile" className="relative md:hidden"',
    );
    expect(mobileListSource).not.toContain("<Table");
  });

  it("preserves SKU identity, option labels, stock truth, and status on mobile", () => {
    expect(mobileListSource).toContain('aria-label="Inventory variants"');
    expect(mobileListSource).toContain("variant.productId");
    expect(mobileListSource).toContain("variant.productName");
    expect(mobileListSource).toContain("variant.sku");
    expect(mobileListSource).toContain("variant.optionLabel");
    expect(mobileListSource).toContain(">On hand</dt>");
    expect(mobileListSource).toContain(">Committed</dt>");
    expect(mobileListSource).toContain(">Available</dt>");
    expect(mobileListSource).toContain("getStockBadge(variant.available, variant.lowStockThreshold)");
  });

  it("shares query results, sort state, and the accessible Adjust action", () => {
    expect(source).toContain("<InventoryVariantMobileList");
    expect(source).toContain("variants={variants}");
    expect(source).toContain("onAdjust={setAdjustingVariant}");
    expect(source).toContain('aria-label="Sort inventory variants"');
    expect(source).toContain("handleSortSelection");
    expect(source).toContain('value="available:asc"');
    expect(source).toContain('value="productName:asc"');
    expect(source).toContain('value="sku:asc"');
    expect(mobileListSource).toContain("<InventoryAdjustButton");
    expect(source).toContain("aria-label={`Adjust stock for ${productName}, SKU ${variant.sku}`}");
    expect(mobileListSource).not.toContain("useQuery(");
    expect(mobileListSource).not.toContain("inventoryQueryOptions(");
  });
});
