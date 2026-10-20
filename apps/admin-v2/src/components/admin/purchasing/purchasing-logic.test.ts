import { describe, expect, it } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { PurchaseOrder } from "~/lib/api-query-options/purchasing";
import { documentTotals, lineTotal } from "./document-math";
import { createOperationKeys, newOperationKey, receiptFingerprint } from "./operation-key";
import { draftBody, draftFromOrder, draftFingerprint, validateDraft } from "./purchase-order-draft";
import { readPurchasingProblem } from "./purchasing-problem";
import { isOpenPurchaseOrder, isOpenTransfer, purchaseOrderStatus, transferStatus } from "./purchasing-status";
import { readReceipt, receiveEverything, type ReceivableLine } from "./ReceiveLines";
import { applyScan, type ScanLine } from "./scan";
import { validateTransferDraft } from "./transfer-draft";

describe("purchase order money", () => {
  it("works line totals, subtotal and total in paisa without float drift", () => {
    // 3 × 12.35 is 37.050000000000004 in floating point.
    expect(lineTotal(3, 12.35, 2)).toBe(37.05);
    expect(lineTotal(7, 0.1, 2)).toBe(0.7);
    const totals = documentTotals(
      [{ quantity: 3, unitCost: 12.35 }, { quantity: 7, unitCost: 0.1 }, { quantity: 1, unitCost: 1999.99 }],
      [50.5, null, 7.25],
      2,
    );
    expect(totals).toEqual({ units: 11, subtotal: 2037.74, total: 2095.49, complete: true });
  });

  it("counts only usable lines and says the totals are incomplete otherwise", () => {
    const totals = documentTotals(
      [{ quantity: 2, unitCost: 10 }, { quantity: null, unitCost: 5 }, { quantity: 1, unitCost: Number.NaN }, { quantity: 1, unitCost: -1 }],
      [Number.NaN],
      2,
    );
    expect(totals).toEqual({ units: 2, subtotal: 20, total: 20, complete: false });
    expect(lineTotal(2, null, 2)).toBeNull();
    expect(lineTotal(1.5, 10, 2)).toBeNull();
  });
});

describe("status badges", () => {
  it("maps every purchase order status to its DESIGN.md badge", () => {
    expect(purchaseOrderStatus("draft")).toEqual({ badge: "attention", label: "status_draft" });
    expect(purchaseOrderStatus("ordered")).toEqual({ badge: "info", label: "status_ordered" });
    expect(purchaseOrderStatus("partially_received")).toEqual({ badge: "warning", label: "status_partially_received" });
    expect(purchaseOrderStatus("received")).toEqual({ badge: "success", label: "status_received" });
    expect(purchaseOrderStatus("cancelled")).toEqual({ badge: "secondary", label: "status_cancelled" });
  });

  it("maps every transfer status the same way", () => {
    expect(transferStatus("draft").badge).toBe("attention");
    expect(transferStatus("in_transit")).toEqual({ badge: "info", label: "status_in_transit" });
    expect(transferStatus("partially_received").badge).toBe("warning");
    expect(transferStatus("received").badge).toBe("success");
    expect(transferStatus("cancelled").badge).toBe("secondary");
  });

  it("treats only what is still coming as open", () => {
    expect(["draft", "ordered", "partially_received", "received", "cancelled"].filter((status) => isOpenPurchaseOrder(status as never)))
      .toEqual(["ordered", "partially_received"]);
    expect(["draft", "in_transit", "partially_received", "received", "cancelled"].filter((status) => isOpenTransfer(status as never)))
      .toEqual(["in_transit", "partially_received"]);
  });
});

describe("barcode scans", () => {
  const lines: ScanLine[] = [
    { id: "l1", sku: "PANJABI-L", barcode: "8901234567890", max: 2 },
    { id: "l2", sku: "TEE-M", barcode: null, max: 5 },
  ];

  it("counts one unit per scan of a SKU or barcode, case-insensitive and trimmed", () => {
    let step = applyScan(lines, {}, "  panjabi-l ");
    expect(step.outcome).toEqual({ kind: "counted", lineId: "l1", quantity: 1 });
    step = applyScan(lines, step.quantities, "8901234567890\n");
    expect(step.outcome).toEqual({ kind: "counted", lineId: "l1", quantity: 2 });
    step = applyScan(lines, step.quantities, "TEE-M");
    expect(step.quantities).toEqual({ l1: 2, l2: 1 });
  });

  it("never counts past what is still to come", () => {
    const step = applyScan(lines, { l1: 2 }, "PANJABI-L");
    expect(step.outcome).toEqual({ kind: "full", lineId: "l1" });
    expect(step.quantities).toEqual({ l1: 2 });
  });

  it("reports a code that is not on the document", () => {
    const step = applyScan(lines, { l2: 1 }, " UNKNOWN-1 ");
    expect(step.outcome).toEqual({ kind: "unknown", code: "UNKNOWN-1" });
    expect(step.quantities).toEqual({ l2: 1 });
  });
});

describe("operation keys", () => {
  it("reuses the key while the intent repeats and retires it after success", () => {
    let next = 0;
    const keys = createOperationKeys(() => `invcmd_key-${String(++next).padStart(10, "0")}`);
    const first = keys.keyFor("receive:a");
    expect(keys.keyFor("receive:a")).toBe(first);
    const other = keys.keyFor("receive:b");
    expect(other).not.toBe(first);
    keys.reset();
    expect(keys.keyFor("receive:b")).not.toBe(other);
  });

  it("makes keys the API accepts", () => {
    const key = newOperationKey();
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  });

  it("fingerprints a receipt independent of line order", () => {
    expect(receiptFingerprint("po_1", [{ lineId: "b", quantity: 1 }, { lineId: "a", quantity: 2 }], { updateCost: true }))
      .toBe(receiptFingerprint("po_1", [{ lineId: "a", quantity: 2 }, { lineId: "b", quantity: 1 }], { updateCost: true }));
    expect(receiptFingerprint("po_1", [{ lineId: "a", quantity: 2 }], { updateCost: true }))
      .not.toBe(receiptFingerprint("po_1", [{ lineId: "a", quantity: 2 }], { updateCost: false }));
  });
});

describe("receipts", () => {
  const line = (id: string, open: number, retired = false): ReceivableLine => ({
    id, productId: "p", productName: "Panjabi", optionLabel: null, sku: id.toUpperCase(), barcode: null,
    open, received: 0, total: open, retired,
  });

  it("sends only lines with units and flags numbers it can't send", () => {
    const lines = [line("a", 5), line("b", 3), line("c", 2, true), line("d", 4)];
    const receipt = readReceipt(lines, { a: 5, b: 4, c: 1, d: 0 });
    expect(receipt.lines).toEqual([{ lineId: "a", quantity: 5 }]);
    expect([...receipt.invalid].sort()).toEqual(["b", "c"]);
    expect(receipt.units).toBe(5);
    expect(readReceipt(lines, { a: 1.5, b: -1, d: Number.NaN }).invalid.size).toBe(3);
  });

  it("receives everything still to come, skipping removed SKUs", () => {
    expect(receiveEverything([line("a", 5), line("c", 2, true)])).toEqual({ a: 5, c: 0 });
  });
});

describe("drafts", () => {
  const order = {
    id: "po_1", status: "draft", revision: 3, displayNumber: "PO1001", currencyCode: "BDT",
    supplier: { id: "sup_1", name: "Dhaka Textiles", status: "active", phone: null, email: null, contactName: null },
    destination: { id: "loc_1", name: "Gulshan", code: "GUL", status: "active" },
    expectedOn: "2026-10-31", reference: " INV-9 ", notes: null, shipping: 0, otherCosts: 12.5, tax: 0,
    lines: [{
      id: "pol_1", variantId: "var_1", productId: "prod_1", productName: "Panjabi", sku: "PANJABI-L", barcode: null,
      optionLabel: "L", retired: false, position: 0, quantity: 3, receivedQuantity: 0, openQuantity: 3,
      unitCost: 12.35, lineTotal: 37.05, currentCost: 12,
    }],
  } as unknown as PurchaseOrder;

  it("round-trips a saved draft into the same body", () => {
    const draft = draftFromOrder(order);
    expect(draftBody(draft)).toEqual({
      supplierId: "sup_1",
      destinationLocationId: "loc_1",
      expectedOn: "2026-10-31",
      reference: "INV-9",
      notes: null,
      shipping: 0,
      otherCosts: 12.5,
      tax: 0,
      lines: [{ variantId: "var_1", quantity: 3, unitCost: 12.35 }],
    });
    expect(draftFingerprint(draftFromOrder(order))).toBe(draftFingerprint(draft));
  });

  it("flags quantities and costs it can't send", () => {
    const draft = draftFromOrder(order);
    draft.lines[0] = { ...draft.lines[0]!, quantity: 0, unitCost: null };
    draft.tax = -1;
    const validation = validateDraft(draft, 2);
    expect(validation.valid).toBe(false);
    expect(validation.lines.get("var_1")).toEqual({ quantity: true, cost: true });
    expect(validation.extras.tax).toBe(true);
    expect(validateDraft(draftFromOrder(order), 2).valid).toBe(true);
  });

  it("refuses a transfer to the location it leaves", () => {
    const draft = { originId: "loc_1", destinationId: "loc_1", expectedOn: "", reference: "", notes: "", lines: [] };
    expect(validateTransferDraft(draft)).toMatchObject({ sameLocation: true, valid: false });
    expect(validateTransferDraft({ ...draft, destinationId: "loc_2" }).valid).toBe(true);
  });
});

describe("purchasing problems", () => {
  it("reads a conflict about a changed document as stale", () => {
    expect(readPurchasingProblem(new AdminApiResponseError("This purchase order changed. Reload to see the latest.", 409, "conflict")))
      .toEqual({ kind: "stale" });
    expect(readPurchasingProblem(new AdminApiResponseError("Stock changed while this was being saved. Reload and try again.", 409)))
      .toEqual({ kind: "stale" });
  });

  it("shows what the API refused in its own words", () => {
    const message = "SKU TEE-M has 2 units free to move: 1 of its 3 on hand are committed to orders.";
    expect(readPurchasingProblem(new AdminApiResponseError(message, 409, "inventory_location_shortfall")))
      .toEqual({ kind: "refused", message });
  });

  it("treats a dropped connection or a server fault as a failure to retry", () => {
    expect(readPurchasingProblem(new TypeError("Failed to fetch")).kind).toBe("failed");
    expect(readPurchasingProblem(new AdminApiResponseError("boom", 500)).kind).toBe("failed");
  });
});
