import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const variantSource = readFileSync(
  new URL("./products.variants.ts", import.meta.url),
  "utf8",
);

describe("product-editor low-stock reconciliation boundaries", () => {
  it("reconciles alerts after every single-variant stock transition", () => {
    expect(variantSource).toContain("await checkAndAlertLowStock(db, variantId)");
    expect(variantSource).not.toContain("if (delta < 0)");
  });

  it("reconciles alerts after every successful bulk stock transition", () => {
    expect(variantSource).toContain("reconcileVariantLowStockAlerts(db, stockChangedVariantIds)");
    expect(variantSource).toContain("LOW_STOCK_RECONCILIATION_WAVE_SIZE = 5");
    expect(variantSource).toContain("checkAndAlertLowStock(db, variantId)");
  });
});
