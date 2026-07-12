import { describe, expect, it, vi } from "vitest";
import type { OrderItem } from "@/components/admin/orderview/types";
import {
  StableReturnCommandKey,
  getOutstandingReceiptQuantity,
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "./order-return-workflow";

const item = (overrides: Partial<OrderItem> = {}): OrderItem => ({
  id: "item_1",
  productId: "product_1",
  variantId: "variant_1",
  quantity: 5,
  price: 100,
  productName: "T-shirt",
  productImage: null,
  variantLabel: "Black / M",
  fulfillmentStatus: "delivered",
  ...overrides,
});

const returnCase = (
  status: OrderReturnDto["status"],
  requestedQuantity: number,
  approvedQuantity: number,
): OrderReturnDto => ({
  id: `return_${status}`,
  orderId: "order_1",
  status,
  reason: "Wrong size",
  notes: null,
  actorType: "admin",
  actorId: "admin_1",
  source: "admin",
  sourceReferenceId: null,
  version: 1,
  requestedAt: "2026-07-12T00:00:00.000Z",
  approvedAt: null,
  receivingStartedAt: null,
  completedAt: null,
  rejectedAt: null,
  cancelledAt: null,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  receiptRecovery: null,
  receipts: [],
  lines: [{
    id: `line_${status}`,
    orderItemId: "item_1",
    variantId: "variant_1",
    inventoryTracked: true,
    requestedQuantity,
    approvedQuantity,
    receivedQuantity: 0,
    restockQuantity: 0,
    damagedQuantity: 0,
    rejectedQuantity: requestedQuantity - approvedQuantity,
    remainingReturnableQuantity: 0,
    reason: null,
    notes: null,
  }],
});

describe("order return workflow helpers", () => {
  it("counts requested and approved quantities but releases rejected and cancelled cases", () => {
    const remaining = getRemainingReturnableQuantities(
      [item(), item({ id: "item_2", fulfillmentStatus: "pending" })],
      [
        returnCase("requested", 2, 0),
        returnCase("completed", 2, 1),
        returnCase("rejected", 1, 0),
        returnCase("cancelled", 1, 1),
      ],
    );

    expect(remaining.get("item_1")).toBe(2);
    expect(remaining.get("item_2")).toBe(0);
  });

  it("never reports a negative outstanding receipt quantity", () => {
    const line = returnCase("receiving", 3, 2).lines[0]!;
    expect(getOutstandingReceiptQuantity({ ...line, receivedQuantity: 1 })).toBe(1);
    expect(getOutstandingReceiptQuantity({ ...line, receivedQuantity: 4 })).toBe(0);
  });

  it("reuses a command key only while action and canonical intent are unchanged", () => {
    const createKey = vi.fn((action: string) => `${action}-${createKey.mock.calls.length}`);
    const cache = new StableReturnCommandKey(createKey);
    const first = cache.get("receive", { version: 2, lines: [{ id: "a", quantity: 1 }] });
    const retry = cache.get("receive", { lines: [{ quantity: 1, id: "a" }], version: 2 });
    const changed = cache.get("receive", { version: 3, lines: [{ id: "a", quantity: 1 }] });

    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
    expect(createKey).toHaveBeenCalledTimes(2);
  });
});
