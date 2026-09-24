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

  it("states free delivery instead of dropping the row (R3-SB-03: optioned products were all free-delivery)", () => {
    const settings = {
      shippingMethods: [method("Standard Delivery", 110, 0), method("Express Delivery", 200, 1)],
      checkoutConfig: codConfig,
      returnPolicy: null,
      formatMoney,
    };
    // The product page builds its facts from product-level data only, so a
    // product with options and a simple product with the same delivery
    // setting show the same rows.
    const optioned = { hasVariants: true, freeDelivery: true };
    const simple = { hasVariants: false, freeDelivery: true };
    const optionedFacts = buildDeliveryFacts({ ...settings, freeDelivery: optioned.freeDelivery });
    expect(optionedFacts).toEqual(buildDeliveryFacts({ ...settings, freeDelivery: simple.freeDelivery }));
    expect(optionedFacts.map((fact) => fact.kind)).toEqual(["delivery", "cod"]);
    expect(optionedFacts[0]).toEqual({
      kind: "delivery",
      title: "Free delivery",
      detail: "Delivery is free on any order with this item.",
    });
    expect(buildDeliveryFacts({ ...settings, freeDelivery: false })[0]).toEqual({
      kind: "delivery",
      title: "Delivery ৳110–৳200",
      detail: "Standard Delivery ৳110 · Express Delivery ৳200",
    });
  });

  it("never states one range across delivery zones: lowest fee, depends on area", () => {
    const facts = buildDeliveryFacts({
      shippingMethods: [
        zoneRate("Inside Dhaka", 60, 0, { freeOver: 2000 }),
        method("Outside Dhaka", 120, 1, true, { freeOver: 3000 }),
        pickupRate,
      ],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    });
    expect(facts).toEqual([
      { kind: "delivery", title: "Delivery from ৳60", detail: "Price depends on your area · Free over ৳3000" },
      { kind: "pickup", title: "Pickup available", detail: "House 1, Banani" },
    ]);
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
      shippingMethods: [method("Standard", 80, 0, true, { freeOver: 2500 }), method("Express", 150, 1)],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    });
    expect(fact).toEqual({
      kind: "delivery",
      title: "Delivery ৳80–৳150",
      detail: "Standard ৳80, free over ৳2500 · Express ৳150",
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
    const facts = buildDeliveryFacts({ shippingMethods: [pickupRate], checkoutConfig: null, returnPolicy: null, formatMoney });
    expect(facts).toEqual([{ kind: "pickup", title: "Pickup available", detail: "House 1, Banani" }]);
  });

  it("keeps a paid pickup out of the delivery price and states it on its own line (R3-MOB-06)", () => {
    const collectionPoint = method("Collection Point", 50, 1, true, { kind: "pickup", pickupAddress: "Gulshan 1 kiosk" });
    const shippingMethods = [method("Standard Delivery", 110, 0), collectionPoint, method("Express Delivery", 200, 2)];
    expect(buildDeliveryFacts({ shippingMethods, checkoutConfig: null, returnPolicy: null, formatMoney })).toEqual([
      { kind: "delivery", title: "Delivery ৳110–৳200", detail: "Standard Delivery ৳110 · Express Delivery ৳200" },
      { kind: "pickup", title: "Pickup available · ৳50", detail: "Gulshan 1 kiosk" },
    ]);
    // A free-delivery product waives the pickup fee as well.
    expect(buildDeliveryFacts({ shippingMethods, checkoutConfig: null, returnPolicy: null, formatMoney, freeDelivery: true })[1])
      .toEqual({ kind: "pickup", title: "Pickup available", detail: "Gulshan 1 kiosk" });
    // Several pickup points with different fees give the lowest.
    expect(buildDeliveryFacts({
      shippingMethods: [collectionPoint, method("Shop counter", 30, 3, true, { kind: "pickup", pickupAddress: "Banani" })],
      checkoutConfig: null,
      returnPolicy: null,
      formatMoney,
    })).toEqual([{ kind: "pickup", title: "Pickup available · from ৳30", detail: "2 pickup points" }]);
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
