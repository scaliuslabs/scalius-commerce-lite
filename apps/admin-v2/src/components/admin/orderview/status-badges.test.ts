import { describe, expect, it } from "vitest";
import { orderBadgeVisibility, statusBadgeVariant } from "./status-badges";

describe("order status badges", () => {
  it("hides payment and fulfillment badges once an order is closed", () => {
    expect(orderBadgeVisibility({ status: "cancelled" })).toEqual({ payment: false, fulfillment: false });
    expect(orderBadgeVisibility({ status: "Returned" })).toEqual({ payment: false, fulfillment: false });
    expect(orderBadgeVisibility({ status: "shipped" })).toEqual({ payment: true, fulfillment: true });
    expect(statusBadgeVariant("partially_refunded", "payment")).toBe("secondary");
  });

  it("follows the design-system tone table per kind", () => {
    expect(statusBadgeVariant("pending", "order")).toBe("attention");
    expect(statusBadgeVariant("delivered", "order")).toBe("success");
    expect(statusBadgeVariant("cancelled", "order")).toBe("secondary");
    expect(statusBadgeVariant("unpaid", "payment")).toBe("warning");
    expect(statusBadgeVariant("failed", "payment")).toBe("destructive");
    expect(statusBadgeVariant("paid", "payment")).toBe("secondary");
    expect(statusBadgeVariant("pending", "fulfillment")).toBe("attention");
    expect(statusBadgeVariant("complete", "fulfillment")).toBe("secondary");
  });
});
