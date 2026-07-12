import { describe, expect, it } from "vitest";
import {
  approveOrderReturnSchema,
  createOrderReturnSchema,
  receiveOrderReturnSchema,
} from "./order-returns.validation";

describe("item-level return command validation", () => {
  it("requires positive bounded item quantities and an explicit idempotency key", () => {
    expect(createOrderReturnSchema.safeParse({
      commandKey: "short",
      expectedOrderVersion: 1,
      reason: "wrong size",
      lines: [{ orderItemId: "item_1", quantity: 0 }],
    }).success).toBe(false);
  });

  it("requires approval to express both approved and rejected quantities", () => {
    expect(approveOrderReturnSchema.safeParse({
      commandKey: "approve-command-1",
      expectedVersion: 1,
      lines: [{ lineId: "line_1", approvedQuantity: 1, rejectedQuantity: 1 }],
    }).success).toBe(true);
  });

  it("requires every received unit to have an explicit warehouse disposition", () => {
    const base = {
      commandKey: "receive-command-1",
      expectedVersion: 2,
      lines: [{
        lineId: "line_1",
        receivedQuantity: 2,
        restockQuantity: 1,
        damagedQuantity: 0,
      }],
    };
    expect(receiveOrderReturnSchema.safeParse(base).success).toBe(false);
    expect(receiveOrderReturnSchema.safeParse({
      ...base,
      lines: [{ ...base.lines[0], damagedQuantity: 1 }],
    }).success).toBe(true);
  });
});
