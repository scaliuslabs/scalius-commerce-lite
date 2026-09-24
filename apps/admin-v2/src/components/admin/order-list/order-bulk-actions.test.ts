import { describe, expect, it } from "vitest";
import {
  chunk,
  getOrderRefreshPause,
  planOrderBulkAction,
  summarizeBulkResults,
} from "./order-bulk-actions";

type Order = Parameters<typeof planOrderBulkAction>[0][number] & { id: string };

function order(id: string, overrides: Partial<Order> = {}): Order {
  return {
    id,
    status: "pending",
    activeRefundOperation: null,
    paymentRecovery: { state: "none", activeProcessing: false } as Order["paymentRecovery"],
    shipmentRecovery: { state: "none", activeLock: false } as Order["shipmentRecovery"],
    ...overrides,
  };
}

const refunding = { active: true } as Order["activeRefundOperation"];
const shipmentLocked = { state: "creating", activeLock: true } as Order["shipmentRecovery"];
const awaitingPayment = { state: "awaiting_payment", activeProcessing: false } as Order["paymentRecovery"];
const ids = (orders: Order[]) => orders.map((item) => item.id);

describe("bulk action eligibility", () => {
  it("confirms only new orders and groups the rest by status", () => {
    const plan = planOrderBulkAction(
      [
        order("a"),
        order("b", { status: "processing" }),
        order("c", { status: "cancelled" }),
        order("d", { status: "shipped" }),
        order("e", { status: "cancelled" }),
      ],
      "confirm",
    );
    expect(ids(plan.eligible)).toEqual(["a", "b"]);
    expect(plan.skipped).toEqual([
      { kind: "status", status: "cancelled", count: 2 },
      { kind: "status", status: "shipped", count: 1 },
    ]);
  });

  it("sends and books couriers only for confirmed orders without unsettled work", () => {
    const orders = [
      order("a", { status: "confirmed" }),
      order("b", { status: "pending" }),
      order("c", { status: "confirmed", paymentRecovery: awaitingPayment }),
      order("d", { status: "confirmed", shipmentRecovery: shipmentLocked }),
    ];
    for (const action of ["send", "ship"] as const) {
      const plan = planOrderBulkAction(orders, action);
      expect(ids(plan.eligible)).toEqual(["a"]);
      expect(plan.skipped).toEqual([
        { kind: "status", status: "pending", count: 1 },
        { kind: "block", reason: "paymentRecovery", count: 1 },
        { kind: "block", reason: "shipment", count: 1 },
      ]);
    }
  });

  it("archives only finished orders that have no refund in progress", () => {
    const plan = planOrderBulkAction(
      [
        order("a", { status: "completed" }),
        order("b", { status: "cancelled" }),
        order("c", { status: "pending" }),
        order("d", { status: "returned", activeRefundOperation: refunding }),
        order("e", { status: "delivered" }),
      ],
      "archive",
    );
    expect(ids(plan.eligible)).toEqual(["a", "b", "e"]);
    expect(plan.skipped).toEqual([
      { kind: "status", status: "pending", count: 1 },
      { kind: "block", reason: "refund", count: 1 },
    ]);
  });
});

describe("bulk runs", () => {
  it("splits requests into the server's 90-order batches", () => {
    const batches = chunk(Array.from({ length: 181 }, (_, index) => index));
    expect(batches.map((batch) => batch.length)).toEqual([90, 90, 1]);
  });

  it("keeps each failure with a short single-line reason", () => {
    const outcome = summarizeBulkResults(
      [
        { orderId: "A1", success: true },
        { orderId: "B2", success: false, error: `Only new orders\n  can be confirmed. ${"x".repeat(200)}` },
        { orderId: "C3", success: false },
      ],
      "fallback",
    );
    expect(outcome.succeeded).toEqual(["A1"]);
    expect(outcome.failures.map((failure) => failure.orderId)).toEqual(["B2", "C3"]);
    expect(outcome.failures[0]!.error.startsWith("Only new orders can be confirmed.")).toBe(true);
    expect(outcome.failures[0]!.error.length).toBe(160);
    expect(outcome.failures[1]!.error).toBe("fallback");
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
