import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../../auth/rbac/permissions";
import {
  canViewCosts,
  canViewLocationDetails,
  locationWithoutDetails,
  purchaseOrderReceiptWithoutCosts,
  purchaseOrderSummaryWithoutCosts,
  purchaseOrderWithoutCosts,
  withoutSkuCost,
} from "./cost-visibility";
import type { PurchaseOrderDetail, PurchaseOrderReceiptResult } from "./purchase-orders";

const order = {
  id: "po_1", number: 1001, displayNumber: "PO1001", status: "ordered", supplier: null,
  destination: { id: "loc_1", name: "Main", code: "MAIN", status: "active" }, expectedOn: null, reference: null,
  currencyCode: "BDT", lineCount: 1, quantity: 4, receivedQuantity: 1, subtotal: 2600, total: 2700, revision: 2,
  orderedAt: null, receivedAt: null, cancelledAt: null, createdAt: new Date(0), updatedAt: new Date(0),
  notes: null, shipping: 100, otherCosts: 0, tax: 0, createdBy: null,
  lines: [{
    id: "pol_1", variantId: "var_1", productId: "prod_1", productName: "Mug", sku: "MUG", barcode: null, optionLabel: null,
    retired: false, position: 0, quantity: 4, receivedQuantity: 1, openQuantity: 3, unitCost: 650, lineTotal: 2600, currentCost: 700,
  }],
  receipts: [{
    operationKey: "rk", createdAt: new Date(0), actorName: "Staff",
    lines: [{ lineId: "pol_1", variantId: "var_1", sku: "MUG", quantity: 1, unitCost: 650, costBefore: 700, costAfter: 690, costUpdated: true }],
  }],
} satisfies PurchaseOrderDetail;

describe("cost visibility", () => {
  it("follows View product costs, and location details follow inventory or store settings", () => {
    expect(canViewCosts(new Set([PERMISSIONS.PRODUCTS_VIEW]))).toBe(false);
    expect(canViewCosts(new Set([PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_VIEW_COSTS]))).toBe(true);
    expect(canViewCosts(undefined)).toBe(false);
    expect(canViewLocationDetails(new Set([PERMISSIONS.PRODUCTS_VIEW]))).toBe(false);
    expect(canViewLocationDetails(new Set([PERMISSIONS.INVENTORY_VIEW]))).toBe(true);
    expect(canViewLocationDetails(new Set([PERMISSIONS.SETTINGS_GENERAL_VIEW]))).toBe(true);
  });

  it("leaves every amount out of a purchase order and keeps its quantities", () => {
    const shown = purchaseOrderWithoutCosts(order);
    expect(JSON.stringify(shown)).not.toMatch(/"(subtotal|total|shipping|otherCosts|tax|unitCost|lineTotal|currentCost|costBefore|costAfter)"/);
    expect(shown).toMatchObject({ quantity: 4, receivedQuantity: 1, lines: [{ sku: "MUG", openQuantity: 3 }], receipts: [{ lines: [{ quantity: 1, costUpdated: true }] }] });
    expect(purchaseOrderSummaryWithoutCosts(order)).not.toHaveProperty("total");
    const receipt: PurchaseOrderReceiptResult = {
      purchaseOrderId: "po_1", displayNumber: "PO1001", status: "partially_received", revision: 3, locationId: "loc_1", costUpdated: false,
      lines: [{ lineId: "pol_1", variantId: "var_1", sku: "MUG", quantity: 1, movementId: "m1", unitCost: 650, costBefore: 700, costAfter: 700, stockAfter: 9 }],
    };
    expect(purchaseOrderReceiptWithoutCosts(receipt).lines[0]).toEqual({ lineId: "pol_1", variantId: "var_1", sku: "MUG", quantity: 1, movementId: "m1", stockAfter: 9 });
  });

  it("leaves a SKU's cost and a location's address out", () => {
    expect(withoutSkuCost({ id: "var_1", stock: 3, cost: 120, costMinor: 12000 })).toEqual({ id: "var_1", stock: 3 });
    expect(locationWithoutDetails({ id: "loc_1", name: "Main", addressLine1: "Road 1", addressLine2: null, city: "Dhaka", postalCode: "1207", phone: "+880" }))
      .toEqual({ id: "loc_1", name: "Main" });
  });
});
