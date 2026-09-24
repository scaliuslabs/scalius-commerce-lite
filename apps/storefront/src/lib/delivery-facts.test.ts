import { describe, expect, it } from "vitest";
import type { CheckoutConfig } from "./api/checkout";
import type { ShippingMethod } from "./api/types";
import { buildDeliveryFacts } from "./delivery-facts";

const formatMoney = (amount: number) => `৳${amount}`;

function method(
  name: string,
  fee: number,
  sortOrder: number,
  isActive = true,
  extra: Partial<ShippingMethod> = {},
): ShippingMethod {
  return { id: name, name, fee, description: null, isActive, sortOrder, createdAt: null, updatedAt: null, kind: "delivery", everywhereElse: true, ...extra };
}
const zoneRate = (name: string, fee: number, sortOrder: number, extra: Partial<ShippingMethod> = {}) =>
  method(name, fee, sortOrder, true, { everywhereElse: false, ...extra });
const pickupRate = method("Pick up at our shop", 0, 9, true, { kind: "pickup", pickupAddress: "House 1, Banani" });

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

  it("leaves free delivery to the product's own badge instead of repeating it", () => {
    const [fact] = buildDeliveryFacts({
      shippingMethods: [method("Standard", 80, 0)],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
      freeDelivery: true,
    });
    expect(fact).toBeUndefined();
  });

  it("never states one range across delivery zones: lowest fee, depends on area, pickup", () => {
    const [fact] = buildDeliveryFacts({
      shippingMethods: [
        zoneRate("Inside Dhaka", 60, 0, { freeOver: 2000 }),
        method("Outside Dhaka", 120, 1, true, { freeOver: 3000 }),
        pickupRate,
      ],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    });
    expect(fact).toEqual({
      kind: "delivery",
      title: "Delivery from ৳60",
      detail: "Price depends on your area · Free over ৳3000 · Pickup available",
    });
  });

  it("omits a free-over claim that does not hold for every zone", () => {
    const [fact] = buildDeliveryFacts({
      shippingMethods: [zoneRate("Inside Dhaka", 60, 0, { freeOver: 2000 }), method("Outside Dhaka", 120, 1)],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    });
    expect(fact?.detail).toBe("Price depends on your area");
  });

  it("lists the store-wide rates with their free-over thresholds when there are no zones", () => {
    const [fact] = buildDeliveryFacts({
      shippingMethods: [method("Standard", 80, 0, true, { freeOver: 2500 }), method("Express", 150, 1), pickupRate],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    });
    expect(fact).toEqual({
      kind: "delivery",
      title: "Delivery ৳80–৳150",
      detail: "Standard ৳80, free over ৳2500 · Express ৳150 · Pickup available",
    });
  });

  it("states a single rate once, adding only its free-over threshold", () => {
    const [fact] = buildDeliveryFacts({
      shippingMethods: [method("OPS006 Standard Delivery", 80, 0, true, { freeOver: 2000 })],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    });
    expect(fact).toEqual({ kind: "delivery", title: "Delivery ৳80", detail: "Free over ৳2000" });
  });

  it("offers pickup alone when there is no delivery rate", () => {
    const [fact] = buildDeliveryFacts({ shippingMethods: [pickupRate], checkoutConfig: null, returnPolicy: null, formatMoney });
    expect(fact).toEqual({ kind: "delivery", title: "Pickup available", detail: "House 1, Banani" });
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
