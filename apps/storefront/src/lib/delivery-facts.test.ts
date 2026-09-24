import { describe, expect, it } from "vitest";
import type { CheckoutConfig } from "./api/checkout";
import type { ShippingMethod } from "./api/types";
import { buildDeliveryFacts } from "./delivery-facts";

const formatMoney = (amount: number) => `৳${amount}`;

function method(name: string, fee: number, sortOrder: number, isActive = true): ShippingMethod {
  return { id: name, name, fee, description: null, isActive, sortOrder, createdAt: null, updatedAt: null };
}

const codConfig: CheckoutConfig = { gateways: [{ id: "cod", name: "Cash on delivery", flow: "cod" }] };

describe("buildDeliveryFacts", () => {
  it("states the fee range, each method, cash on delivery and the return window", () => {
    const facts = buildDeliveryFacts({
      shippingMethods: [method("Outside Dhaka", 120, 2), method("Inside Dhaka", 60, 1), method("Old", 10, 0, false)],
      checkoutConfig: codConfig,
      returnPolicy: { enabled: true, category: "finite", returnWindowDays: 7, returnFees: "customer_responsibility", policyUrl: "/returns" },
      formatMoney,
    });
    expect(facts).toEqual([
      { kind: "delivery", title: "Delivery ৳60–৳120", detail: "Inside Dhaka ৳60 · Outside Dhaka ৳120" },
      { kind: "cod", title: "Cash on delivery", detail: "Pay when your order arrives." },
      { kind: "returns", title: "7-day returns", detail: "Return shipping is paid by the buyer.", href: "/returns" },
    ]);
  });

  it("says free delivery for a free-delivery product", () => {
    const [fact] = buildDeliveryFacts({
      shippingMethods: [method("Standard", 80, 0)],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
      freeDelivery: true,
    });
    expect(fact).toEqual({ kind: "delivery", title: "Free delivery", detail: "Standard" });
  });

  it("claims nothing it cannot prove", () => {
    expect(buildDeliveryFacts({
      shippingMethods: null,
      checkoutConfig: { ...codConfig, unavailable: true },
      returnPolicy: { enabled: false, category: "finite", returnWindowDays: 7 },
      formatMoney,
    })).toEqual([]);
    expect(buildDeliveryFacts({
      shippingMethods: [],
      checkoutConfig: { gateways: [{ id: "stripe", name: "Card", flow: "card" }] },
      returnPolicy: null,
      formatMoney,
    })).toEqual([]);
  });
});
