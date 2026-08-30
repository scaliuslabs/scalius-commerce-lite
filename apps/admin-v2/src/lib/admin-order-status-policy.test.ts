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
});
