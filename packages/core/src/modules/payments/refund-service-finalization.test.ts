import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { OrderStatus, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  canTransitionTo: vi.fn(),
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../orders/order-state-machine", () => ({
  canTransitionTo: mocks.canTransitionTo,
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import { finalizeAcceptedRefundAttemptIds } from "./refund-service";

function createDbMock(selectResults: unknown[], returningResults: unknown[][] = [[{ id: "order_1" }]]) {
  const selectQueue = [...selectResults];
  const returningQueue = [...returningResults];
  const updateSets: Array<Record<string, unknown>> = [];

  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          get: async () => selectQueue.shift(),
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(selectQueue.shift()).then(resolve, reject),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updateSets.push(values);
        return {
          where: () => ({
            returning: async () => returningQueue.shift() ?? [],
            then: (resolve: (value?: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
          }),
        };
      },
    })),
  };

  return { db: db as unknown as Database, rawDb: db, updateSets };
}

describe("finalizeAcceptedRefundAttemptIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canTransitionTo.mockImplementation((_domain: string, _from: string, to: string) =>
      to === OrderStatus.CANCELLED
    );
  });

  it("recomputes ledger payment state and releases inventory for a full pre-fulfillment refund", async () => {
    const { db, updateSets } = createDbMock([
      [{
        id: "rfa_1",
        orderId: "order_1",
        refundPaymentId: "refund_1",
        providerRefundId: "re_1",
        amount: 100,
        currency: "BDT",
      }],
      {
        id: "order_1",
        totalAmount: 100,
        status: OrderStatus.PROCESSING,
        version: 7,
      },
      [
        {
          paymentType: "full",
          status: PaymentRecordStatus.SUCCEEDED,
          amount: 100,
        },
        {
          paymentType: "refund",
          status: PaymentRecordStatus.REFUNDED,
          amount: 100,
        },
      ],
    ]);

    const result = await finalizeAcceptedRefundAttemptIds(db, ["rfa_1"]);

    expect(result).toEqual({
      orderIds: ["order_1"],
      finalizedAttemptIds: ["rfa_1"],
      refundNotifications: [{
        orderId: "order_1",
        notificationType: "order_refunded",
        dedupeKey: "refund-reconcile:order_1:rfa_1:full",
        amount: 100,
        refundId: "re_1",
      }],
    });
    expect(updateSets[0]).toMatchObject({ status: PaymentRecordStatus.REFUNDED });
    expect(updateSets[1]).toMatchObject({
      paidAmount: 0,
      balanceDue: 100,
      paymentStatus: PaymentStatus.REFUNDED,
      status: OrderStatus.CANCELLED,
    });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.CANCELLED,
    );
    expect(updateSets[2]).toMatchObject({
      status: "refunded",
      providerStatus: "accepted",
      claimId: null,
      claimExpiresAt: null,
    });
  });
});
