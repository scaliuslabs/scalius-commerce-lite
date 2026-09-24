import { describe, expect, it } from "vitest";
import {
  getAdminOrderStatusOptions,
  getAdminOrderStatusTransitions,
  isAdminOrderStatus,
} from "./admin-order-status-policy";

describe("admin order status policy", () => {
  it("rejects values outside the reviewed order status contract", () => {
    expect(isAdminOrderStatus("pending")).toBe(true);
    expect(isAdminOrderStatus("arbitrary-provider-status")).toBe(false);
    expect(getAdminOrderStatusTransitions("arbitrary-provider-status")).toEqual([]);
  });
  it("keeps refund and return states out of generic status changes", () => {
    for (const status of ["returned", "refunded"]) {
      expect(getAdminOrderStatusTransitions(status)).toEqual([]);
    }
    expect(getAdminOrderStatusTransitions("pending")).not.toContain("returned");
    expect(getAdminOrderStatusTransitions("pending")).not.toContain("refunded");
  });

  it("never offers a fulfilment status: those come from sending, collecting and returns (R3-ORD-01)", () => {
    for (const status of ["incomplete", "pending", "processing", "confirmed", "shipped", "delivered"]) {
      const next = getAdminOrderStatusTransitions(status, { paymentStatus: "unpaid", paidAmount: 0 });
      expect(next).not.toContain("shipped");
      expect(next).not.toContain("delivered");
      expect(next).not.toContain("processing");
    }
    expect(getAdminOrderStatusTransitions("confirmed", { paymentStatus: "unpaid", paidAmount: 0 })).toEqual(["cancelled"]);
    expect(getAdminOrderStatusTransitions("delivered")).toEqual(["completed"]);
  });

  it("offers Cancelled on a Shipped order only when nothing is with the courier", () => {
    const options = (units: number) => getAdminOrderStatusOptions("shipped", { paymentStatus: "unpaid", paidAmount: 0, unitsWithCourier: units });
    expect(options(0)).toEqual([{ status: "cancelled", block: null }]);
    expect(options(2)).toEqual([{ status: "cancelled", block: { code: "with_courier", units: 2 } }]);
  });

  it("treats cancelled orders as terminal", () => {
    expect(getAdminOrderStatusTransitions("cancelled")).toEqual([]);
  });

  it.each([
    { paymentStatus: "paid", paidAmount: 100 },
    { paymentStatus: "partial", paidAmount: 40 },
    { paymentStatus: "unpaid", paidAmount: 1 },
    { paymentStatus: "unpaid", paidAmount: null },
    { paymentStatus: "unpaid", paidAmount: -1 },
  ])("removes generic cancellation when payment value exists or is uncertain %#", (payment) => {
    expect(getAdminOrderStatusTransitions("pending", payment)).toEqual(["confirmed"]);
  });

  it("keeps cancellation for an unpaid zero-paid order", () => {
    expect(getAdminOrderStatusTransitions("pending", {
      paymentStatus: "unpaid",
      paidAmount: 0,
    })).toContain("cancelled");
  });
});
