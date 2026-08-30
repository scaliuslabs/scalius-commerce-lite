import { describe, expect, it } from "vitest";
import { OrderStatus } from "@scalius/database/schema";
import {
  assertGenericAdminOrderStatusTransition,
  isGenericAdminOrderStatusTransitionAllowed,
} from "./admin-status-policy";

describe("generic admin order status policy", () => {
  it("keeps workflow-owned return and refund states out of the generic editor", () => {
    for (const target of [
      OrderStatus.RETURNED,
      OrderStatus.REFUNDED,
      OrderStatus.PARTIALLY_REFUNDED,
    ]) {
      expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.DELIVERED, target)).toBe(false);
      expect(() => assertGenericAdminOrderStatusTransition(OrderStatus.DELIVERED, target))
        .toThrow("dedicated item-level workflow");
    }
  });

  it("does not let a generic edit move shipped work backwards or cancel courier evidence", () => {
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.SHIPPED, OrderStatus.CONFIRMED)).toBe(false);
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.SHIPPED, OrderStatus.CANCELLED)).toBe(false);
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.SHIPPED, OrderStatus.DELIVERED)).toBe(true);
  });

  it("allows only the intentionally narrow forward and pre-shipment cancellation graph", () => {
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.PENDING, OrderStatus.CONFIRMED)).toBe(true);
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.CONFIRMED, OrderStatus.CANCELLED)).toBe(true);
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.DELIVERED, OrderStatus.COMPLETED)).toBe(true);
  });

  it("does not reopen a cancelled order through the generic editor", () => {
    for (const target of [OrderStatus.PENDING, OrderStatus.CONFIRMED]) {
      expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.CANCELLED, target)).toBe(false);
      expect(() => assertGenericAdminOrderStatusTransition(OrderStatus.CANCELLED, target))
        .toThrow("cannot move an order from cancelled");
    }
  });
});
