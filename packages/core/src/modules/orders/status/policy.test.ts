import { describe, expect, it } from "vitest";
import { OrderStatus } from "@scalius/database/schema";
import {
  assertGenericAdminOrderStatusTransition,
  isGenericAdminOrderStatusTransitionAllowed,
} from "./policy";

describe("generic admin order status policy", () => {
  it("keeps fulfilment and money states out of the generic editor, naming the real action", () => {
    expect(() => assertGenericAdminOrderStatusTransition(OrderStatus.CONFIRMED, OrderStatus.SHIPPED))
      .toThrow("Use Mark as sent or Book courier");
    expect(() => assertGenericAdminOrderStatusTransition(OrderStatus.SHIPPED, OrderStatus.DELIVERED))
      .toThrow("Mark delivered");
    expect(() => assertGenericAdminOrderStatusTransition(OrderStatus.DELIVERED, OrderStatus.RETURNED))
      .toThrow("Mark returned");
    expect(() => assertGenericAdminOrderStatusTransition(OrderStatus.DELIVERED, OrderStatus.REFUNDED))
      .toThrow("Use Refund");
  });

  it("does not move shipped work backwards; cancelling is guarded by what's with the courier", () => {
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.SHIPPED, OrderStatus.CONFIRMED)).toBe(false);
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.SHIPPED, OrderStatus.CANCELLED)).toBe(true);
    expect(isGenericAdminOrderStatusTransitionAllowed(OrderStatus.PENDING, OrderStatus.PROCESSING)).toBe(false);
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
        .toThrow("This order is now cancelled, so it can't be marked");
    }
  });
});
