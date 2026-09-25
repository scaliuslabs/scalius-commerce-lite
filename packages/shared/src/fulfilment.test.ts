import { describe, expect, it } from "vitest";

import {
  AUTO_FULFILLMENT_TYPES,
  blocksDelivered,
  FULFILLMENT_TYPES,
  isFulfillmentKind,
  isFulfillmentType,
  isReturnableFulfillmentType,
  MANUAL_FULFILLMENT_TYPES,
  resolveCheckoutFulfilment,
  resolveLineFulfillmentType,
  type DeliveryMethodKind,
  type FulfilmentLineSource,
} from "./fulfilment";

const physical: FulfilmentLineSource = { fulfillmentKind: "physical", isGiftCard: false };
const digital: FulfilmentLineSource = { fulfillmentKind: "digital", isGiftCard: false };
const service: FulfilmentLineSource = { fulfillmentKind: "service", isGiftCard: false };
const giftCard: FulfilmentLineSource = { fulfillmentKind: "digital", isGiftCard: true };

describe("line fulfilment type resolution (§2.1)", () => {
  it.each<[string, FulfilmentLineSource, DeliveryMethodKind | null, string | null]>([
    ["gift card, delivery chosen", giftCard, "delivery", "gift_card"],
    ["gift card flag wins over a physical kind", { fulfillmentKind: "physical", isGiftCard: true }, "pickup", "gift_card"],
    ["gift card, no method", giftCard, null, "gift_card"],
    ["digital, delivery chosen", digital, "delivery", "digital"],
    ["digital, no method", digital, null, "digital"],
    ["service, pickup chosen", service, "pickup", "service"],
    ["service, no method", service, null, "service"],
    ["physical, delivery rate", physical, "delivery", "ship"],
    ["physical, pickup rate", physical, "pickup", "pickup"],
    ["physical, no method", physical, null, null],
  ])("%s", (_label, line, method, expected) => {
    expect(resolveLineFulfillmentType(line, method)).toBe(expected);
  });
});

describe("checkout fulfilment plan (§2.7)", () => {
  it("ships physical lines with a delivery rate: address, address tax, every payment", () => {
    expect(resolveCheckoutFulfilment([physical, service], "delivery")).toEqual({
      ok: true,
      lineTypes: ["ship", "service"],
      requiresDeliveryMethod: true,
      deliveryMethodKind: "delivery",
      requiresShipping: true,
      requiresAddress: true,
      usesAddressTaxDestination: true,
      allowsCashOnDelivery: true,
    });
  });

  it("hands physical lines over at the counter with a pickup rate: no address, null tax destination, COD at the counter", () => {
    expect(resolveCheckoutFulfilment([physical, physical], "pickup")).toEqual({
      ok: true,
      lineTypes: ["pickup", "pickup"],
      requiresDeliveryMethod: true,
      deliveryMethodKind: "pickup",
      requiresShipping: false,
      requiresAddress: false,
      usesAddressTaxDestination: false,
      allowsCashOnDelivery: true,
    });
  });

  it("needs no delivery method for service-only carts and ignores one that was sent", () => {
    for (const method of [null, "delivery", "pickup"] as const) {
      expect(resolveCheckoutFulfilment([service], method)).toEqual({
        ok: true,
        lineTypes: ["service"],
        requiresDeliveryMethod: false,
        deliveryMethodKind: null,
        requiresShipping: false,
        requiresAddress: false,
        usesAddressTaxDestination: false,
        allowsCashOnDelivery: true,
      });
    }
  });

  it("never allows cash on delivery for carts made only of digital and gift-card lines", () => {
    expect(resolveCheckoutFulfilment([digital, giftCard], null)).toEqual({
      ok: true,
      lineTypes: ["digital", "gift_card"],
      requiresDeliveryMethod: false,
      deliveryMethodKind: null,
      requiresShipping: false,
      requiresAddress: false,
      usesAddressTaxDestination: false,
      allowsCashOnDelivery: false,
    });
  });

  it("allows cash when a digital line rides with a service or physical line", () => {
    expect(resolveCheckoutFulfilment([digital, service], null)).toMatchObject({ ok: true, allowsCashOnDelivery: true });
    expect(resolveCheckoutFulfilment([digital, physical], "pickup")).toMatchObject({
      ok: true,
      lineTypes: ["digital", "pickup"],
      allowsCashOnDelivery: true,
      requiresAddress: false,
    });
  });

  it("refuses a physical cart without a delivery method, and an empty cart", () => {
    expect(resolveCheckoutFulfilment([physical, digital], null)).toEqual({
      ok: false,
      issue: "DELIVERY_METHOD_REQUIRED",
    });
    expect(resolveCheckoutFulfilment([], "delivery")).toEqual({ ok: false, issue: "EMPTY" });
  });

  it("never mixes ship and pickup in one order", () => {
    for (const method of ["delivery", "pickup"] as const) {
      const result = resolveCheckoutFulfilment([physical, physical, service, giftCard], method);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const physicalTypes = new Set(result.lineTypes.filter((type) => type === "ship" || type === "pickup"));
      expect(physicalTypes.size).toBe(1);
    }
  });
});

describe("fulfilment type groups", () => {
  it("partitions every type into manual or automatic fulfilment", () => {
    expect([...MANUAL_FULFILLMENT_TYPES, ...AUTO_FULFILLMENT_TYPES].sort()).toEqual([...FULFILLMENT_TYPES].sort());
    expect(FULFILLMENT_TYPES.filter(blocksDelivered)).toEqual(["ship", "pickup", "service"]);
    expect(FULFILLMENT_TYPES.filter(isReturnableFulfillmentType)).toEqual(["ship", "pickup"]);
  });

  it("recognises only the stored values", () => {
    expect(isFulfillmentKind("physical")).toBe(true);
    expect(isFulfillmentKind("gift_card")).toBe(false);
    expect(isFulfillmentType("gift_card")).toBe(true);
    expect(isFulfillmentType("delivery")).toBe(false);
    expect(isFulfillmentType(undefined)).toBe(false);
  });
});
