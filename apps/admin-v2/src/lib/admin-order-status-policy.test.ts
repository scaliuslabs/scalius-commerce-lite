import { describe, expect, it } from "vitest";
import {
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
    for (const status of ["returned", "refunded", "partially_refunded"]) {
      expect(getAdminOrderStatusTransitions(status)).toEqual([]);
    }
    expect(getAdminOrderStatusTransitions("pending")).not.toContain("returned");
    expect(getAdminOrderStatusTransitions("pending")).not.toContain("refunded");
  });

  it("does not move shipped work backward or cancel it", () => {
    expect(getAdminOrderStatusTransitions("shipped")).toEqual(["delivered"]);
    expect(getAdminOrderStatusTransitions("delivered")).toEqual(["completed"]);
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
    expect(getAdminOrderStatusTransitions("pending", payment)).toEqual([
      "processing",
      "confirmed",
    ]);
  });

  it("keeps cancellation for an unpaid zero-paid order", () => {
    expect(getAdminOrderStatusTransitions("pending", {
      paymentStatus: "unpaid",
      paidAmount: 0,
    })).toContain("cancelled");
  });
});
