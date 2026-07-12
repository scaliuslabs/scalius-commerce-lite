import {
  deliveryShipments,
  orderSupportRequests,
  orders,
  settings,
} from "@scalius/database/schema";
import { describe, expect, it, vi } from "vitest";

vi.mock("../payments/refund-attempt-visibility", () => ({
  listOrderRefundAttempts: vi.fn(() => Promise.resolve([])),
  summarizeActiveRefundOperation: vi.fn(() => null),
}));

import { createCustomerOrderSupportRequest } from "./order-support-requests";

function createReadQuery(rowsForTable: (table: unknown) => unknown[]) {
  let source: unknown;
  const query = {
    from: vi.fn((table: unknown) => {
      source = table;
      return query;
    }),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    get: vi.fn(() => Promise.resolve(rowsForTable(source)[0])),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rowsForTable(source)).then(resolve, reject),
  };
  return query;
}

describe("customer request mutation policy", () => {
  it("rejects a merchant-disabled action even when eligible-only visibility hides it", async () => {
    const rowsForTable = (table: unknown): unknown[] => {
      if (table === orders) {
        return [{
          id: "ord_1",
          customerId: "cus_1",
          status: "pending",
          paymentStatus: "unpaid",
          fulfillmentStatus: "pending",
          paidAmount: 0,
        }];
      }
      if (table === settings) {
        return [{
          value: JSON.stringify({
            cancellationEnabled: false,
            returnEnabled: true,
            refundEnabled: true,
            visibility: "eligible_only",
            introText: null,
          }),
        }];
      }
      if (table === deliveryShipments || table === orderSupportRequests) return [];
      return [];
    };
    const db = {
      select: vi.fn(() => createReadQuery(rowsForTable)),
      batch: vi.fn(),
    };

    await expect(createCustomerOrderSupportRequest(
      db as never,
      "cus_1",
      "ord_1",
      {
        type: "cancel_pre_shipment",
        reason: "I ordered the wrong item",
      },
    )).rejects.toThrow("This store does not accept cancellation requests online.");
    expect(db.batch).not.toHaveBeenCalled();
  });
});
