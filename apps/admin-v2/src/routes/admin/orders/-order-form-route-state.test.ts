import { describe, expect, it } from "vitest";
import { orderFormMessages } from "~/i18n/order-form";
import { editLockMessageKey, orderEditState, savedDeliveryMethod } from "./-order-form-route-state";

const allowed = { allowed: true, reason: null };
const locked = (reason: string | null) => ({ allowed: false, reason });

describe("edit order state", () => {
  it("edits the items whenever the server allows it", () => {
    expect(orderEditState({ items: allowed, details: allowed })).toEqual({ mode: "amend" });
  });

  it("explains a discount lock and points to the details edit on the order page", () => {
    expect(orderEditState({ items: locked("discount"), details: allowed }))
      .toEqual({ mode: "locked", message: "lockDiscount", canEditDetails: true });
  });

  it("does not offer the details edit after shipment", () => {
    expect(orderEditState({ items: locked("shipped"), details: locked("shipped") }))
      .toEqual({ mode: "locked", message: "lockShipped", canEditDetails: false });
  });

  it("has a plain sentence for every server reason and a fallback for unknown ones", () => {
    for (const reason of [
      "shipped", "closed", "paid", "online_payment", "discount",
      "history", "inventory", "archived", "busy", "unavailable",
    ]) {
      const key = editLockMessageKey(reason);
      expect(key).not.toBe("lockUnknown");
      expect(orderFormMessages.en[key]).not.toMatch(/snapshot|immutable|_/);
      expect(orderFormMessages.bn[key]).toBeTruthy();
    }
    expect(editLockMessageKey("something_new")).toBe("lockUnknown");
    expect(editLockMessageKey(null)).toBe("lockUnknown");
  });
});

describe("edit order delivery method", () => {
  it("preselects the method the order was placed with", () => {
    expect(savedDeliveryMethod({ shippingMethodId: "rate_ops006", shippingMethodName: "OPS006 Standard Delivery" })).toEqual({
      shippingMethodId: "rate_ops006",
      savedShippingMethod: { id: "rate_ops006", name: "OPS006 Standard Delivery" },
    });
  });

  it("keeps a custom charge custom", () => {
    expect(savedDeliveryMethod({ shippingMethodId: null, shippingMethodName: null }))
      .toEqual({ shippingMethodId: null, savedShippingMethod: null });
  });
});
