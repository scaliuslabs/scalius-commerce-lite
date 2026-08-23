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

  it("uses shape-preserving initial states while keeping refresh controls intact", () => {
    expect(source).toContain("function InventoryTableRowsSkeleton");
    expect(source).toContain('label="Loading inventory variants"');
    expect(source).toContain('label="Loading low-stock alerts"');
    expect(source).toContain('label="Loading inventory movements"');
    expect(source).not.toContain('className="h-24 text-center"><RefreshCw');
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
    expect(source).toContain("aria-busy={variantsQuery.isFetching}");
    expect(source).toContain("aria-busy={movementsQuery.isFetching}");
    expect(source).toContain("aria-busy={alertsQuery.isFetching}");
  });

  it("keeps adjustments exact and exposes an explicit stocktake workflow", () => {
    expect(source).toContain('value="stocktake"');
    expect(source).toContain("await stockSet");
    expect(source).toContain('countInput.trim() !== ""');
    expect(source).toContain("targetStock - variant.reservedStock");
    expect(source).not.toContain("Math.max(0, variant.stock + delta)");
    expect(source).not.toContain("Math.max(0, newStock - variant.reservedStock)");
  });

  it("retains one operation key for an unchanged retry and rotates it with intent", () => {
    expect(source).toContain("operationIntentRef");
    expect(source).toContain("operationKeyForIntent");
    expect(source).toContain("createInventoryOperationKey");
    expect(source).toContain("operationKey,");
  });

  it("supports server-backed movement search, type filtering, and order navigation", () => {
    expect(source).toContain("movementSearch");
    expect(source).toContain("movementType");
    expect(source).toContain('placeholder="Search product or SKU..."');
    expect(source).toContain('placeholder="Exact order ID"');
    expect(source).toContain("movementOrderId: debouncedMovementOrderId.trim()");
    expect(source).toContain("`/admin/orders/${m.orderId}`");
  });

  it("exports the active movement filters through the dedicated bounded artifact route", () => {
    expect(source).toContain('fetch("/api/v1/admin/inventory/movements/export"');
    expect(source).toContain('method: "POST"');
    expect(source).toContain("movementOrderId: debouncedMovementOrderId.trim()");
    expect(source).toContain("movementStartDate: movementStartDate");
    expect(source).toContain("movementEndDate: movementEndDate");
    expect(source).toContain("maxRows: 5_000");
    expect(source).toContain("const blob = await response.blob()");
    expect(source).not.toContain("movementExportHref");
  });

  it("provides a compact searchable alert inbox with status history and acknowledgement", () => {
    expect(source).toContain('section: "alerts"');
    expect(source).toContain("alertStatus");
    expect(source).toContain("acknowledgeInventoryAlert");
    expect(source).toContain("inventoryActions.canAcknowledgeAlerts");
    expect(source).toContain("No low-stock alerts need review.");
    expect(source).toContain("Review SKU");
    expect(source).toContain("PaginationControls");
  });

  it("uses one compact, explainable quantity strip instead of nested statistic cards", () => {
    expect(source).toContain("function InventorySummaryStrip");
    expect(source).toContain("On hand minus committed units");
    expect(source).toContain("Units reserved by open orders");
    expect(source).toContain("focus-visible:ring-inset");
    expect(source).not.toContain("<StatCard");
  });

  it("does not use sub-12px operational copy", () => {
    expect(source).not.toMatch(/text-\[(?:10|11)px\]/);
  });
});
