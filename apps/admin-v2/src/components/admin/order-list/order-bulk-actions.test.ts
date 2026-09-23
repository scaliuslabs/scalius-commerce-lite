import { describe, expect, it } from "vitest";
import {
  failedBulkShipSummary,
  findOrderActionBlock,
  getOrderRefreshPause,
  summarizeBulkShip,
} from "./order-bulk-actions";

type Order = Parameters<typeof findOrderActionBlock>[0][number];

function order(overrides: Partial<Order> = {}): Order {
  return {
    status: "completed",
    activeRefundOperation: null,
    paymentRecovery: { state: "none", activeProcessing: false } as Order["paymentRecovery"],
    shipmentRecovery: { state: "none", activeLock: false } as Order["shipmentRecovery"],
    ...overrides,
  };
}

const refunding = { active: true } as Order["activeRefundOperation"];
const shipmentLocked = { state: "creating", activeLock: true } as Order["shipmentRecovery"];
const paymentStarting = { state: "processing", activeProcessing: true } as Order["paymentRecovery"];
const awaitingPayment = { state: "awaiting_payment", activeProcessing: false } as Order["paymentRecovery"];

describe("order bulk action blocks", () => {
  it("allows finished orders to be archived", () => {
    expect(findOrderActionBlock([order(), order({ status: "cancelled" })], "archive")).toBeNull();
  });

  it("blocks archive for unfinished orders, refunds, courier checks and payment setup, in that order", () => {
    expect(findOrderActionBlock([order({ status: "pending" }), order({ activeRefundOperation: refunding })], "archive"))
      .toEqual({ reason: "status", count: 1 });
    expect(findOrderActionBlock([order({ activeRefundOperation: refunding }), order({ activeRefundOperation: refunding })], "archive"))
      .toEqual({ reason: "refund", count: 2 });
    expect(findOrderActionBlock([order({ shipmentRecovery: shipmentLocked })], "archive"))
      .toEqual({ reason: "shipment", count: 1 });
    expect(findOrderActionBlock([order({ paymentRecovery: paymentStarting })], "archive"))
      .toEqual({ reason: "paymentSetup", count: 1 });
  });

  it("blocks shipping while online payment, refund or courier booking is unsettled", () => {
    expect(findOrderActionBlock([order({ status: "pending" })], "ship")).toBeNull();
    expect(findOrderActionBlock([order({ paymentRecovery: paymentStarting })], "ship"))
      .toEqual({ reason: "paymentSetup", count: 1 });
    expect(findOrderActionBlock([order({ paymentRecovery: awaitingPayment })], "ship"))
      .toEqual({ reason: "paymentRecovery", count: 1 });
    expect(findOrderActionBlock([order({ activeRefundOperation: refunding })], "ship"))
      .toEqual({ reason: "refund", count: 1 });
    expect(findOrderActionBlock([order({ shipmentRecovery: shipmentLocked })], "ship"))
      .toEqual({ reason: "shipment", count: 1 });
  });
});

describe("bulk ship summaries", () => {
  it("keeps only failed orders with a short, single-line error", () => {
    const summary = summarizeBulkShip(
      {
        totalProcessed: 3,
        successCount: 1,
        failureCount: 2,
        results: [
          { orderId: "A1", success: true },
          { orderId: "B2", success: false, error: `Courier\n  said ${"x".repeat(200)}` },
          { orderId: "C3", success: false },
        ],
      } as unknown as Parameters<typeof summarizeBulkShip>[0],
      "fallback",
    );
    expect(summary.failures.map((failure) => failure.orderId)).toEqual(["B2", "C3"]);
    expect(summary.failures[0]!.error.startsWith("Courier said")).toBe(true);
    expect(summary.failures[0]!.error.length).toBe(160);
    expect(summary.failures[1]!.error).toBe("fallback");
    expect(failedBulkShipSummary(["A1", "B2"], "down")).toEqual({
      totalProcessed: 2,
      successCount: 0,
      failureCount: 2,
      failures: [{ orderId: "A1", error: "down" }, { orderId: "B2", error: "down" }],
    });
  });
});

describe("auto-refresh pause", () => {
  it("pauses while orders are selected, an action is open or saving", () => {
    const idle = { selectedCount: 0, actionDialogOpen: false, mutationInFlight: false };
    expect(getOrderRefreshPause(idle)).toBeNull();
    expect(getOrderRefreshPause({ ...idle, selectedCount: 2, actionDialogOpen: true })).toBe("selected");
    expect(getOrderRefreshPause({ ...idle, actionDialogOpen: true })).toBe("dialog");
    expect(getOrderRefreshPause({ ...idle, mutationInFlight: true })).toBe("saving");
  });
});
