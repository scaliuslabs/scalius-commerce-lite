import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import {
  AGENT_STOREFRONT_MAX_CART_LINES,
  addAgentStorefrontCartLine,
  normalizeAgentStorefrontDeliverySelection,
  normalizeAgentStorefrontDiscountCode,
  parseAgentStorefrontCartJson,
  removeAgentStorefrontCartLine,
  serializeAgentStorefrontCart,
  setAgentStorefrontCartLineQuantity,
} from "./state";

describe("agent storefront cart state", () => {
  it("stores variant identity and quantity without merchant or buyer projections", () => {
    const json = serializeAgentStorefrontCart([
      { variantId: "variant_1", quantity: 2 },
    ]);

    expect(JSON.parse(json)).toEqual([{ variantId: "variant_1", quantity: 2 }]);
    expect(json).not.toMatch(/price|stock|name|image|phone|email|address|token|proof/i);
  });

  it("adds a new line and merges an existing variant", () => {
    const added = addAgentStorefrontCartLine([], { variantId: "variant_1", quantity: 2 });
    expect(addAgentStorefrontCartLine(added, { variantId: "variant_1", quantity: 3 }))
      .toEqual([{ variantId: "variant_1", quantity: 5 }]);
  });

  it("enforces 99 distinct lines and quantity 1 through 99", () => {
    const fullCart = Array.from({ length: AGENT_STOREFRONT_MAX_CART_LINES }, (_, index) => ({
      variantId: `variant_${index}`,
      quantity: 1,
    }));

    expect(() => addAgentStorefrontCartLine(fullCart, { variantId: "overflow", quantity: 1 }))
      .toThrow(ValidationError);
    expect(() => addAgentStorefrontCartLine([], { variantId: "variant_1", quantity: 100 }))
      .toThrow(ValidationError);
    expect(() => addAgentStorefrontCartLine(
      [{ variantId: "variant_1", quantity: 99 }],
      { variantId: "variant_1", quantity: 1 },
    )).toThrow(ValidationError);
  });

  it("sets and removes existing lines without silently creating new state", () => {
    const lines = [{ variantId: "variant_1", quantity: 2 }];
    expect(setAgentStorefrontCartLineQuantity(lines, "variant_1", 4))
      .toEqual([{ variantId: "variant_1", quantity: 4 }]);
    expect(removeAgentStorefrontCartLine(lines, "variant_1")).toEqual([]);
    expect(() => setAgentStorefrontCartLineQuantity(lines, "missing", 4))
      .toThrow(ValidationError);
    expect(() => removeAgentStorefrontCartLine(lines, "missing"))
      .toThrow(ValidationError);
  });

  it("fails closed on malformed or duplicate persisted cart rows", () => {
    expect(() => parseAgentStorefrontCartJson("not json")).toThrow(ConflictError);
    expect(() => parseAgentStorefrontCartJson(JSON.stringify([
      { variantId: "variant_1", quantity: 1 },
      { variantId: "variant_1", quantity: 1 },
    ]))).toThrow(ConflictError);
    expect(() => serializeAgentStorefrontCart([
      { variantId: "variant_1", quantity: 1 },
      { variantId: "variant_1", quantity: 2 },
    ])).toThrow(ValidationError);
  });
});

describe("agent storefront checkout state", () => {
  it("canonicalizes discount codes", () => {
    expect(normalizeAgentStorefrontDiscountCode("  sale-10 ")).toBe("SALE-10");
  });

  it("requires a valid delivery hierarchy", () => {
    expect(normalizeAgentStorefrontDeliverySelection({
      cityId: " city ",
      zoneId: "zone",
      areaId: "area",
      shippingMethodId: "method",
    })).toEqual({ cityId: "city", zoneId: "zone", areaId: "area", shippingMethodId: "method" });

    expect(() => normalizeAgentStorefrontDeliverySelection({
      cityId: null,
      zoneId: "zone",
      areaId: null,
      shippingMethodId: null,
    })).toThrow(ValidationError);
    expect(() => normalizeAgentStorefrontDeliverySelection({
      cityId: null,
      zoneId: null,
      areaId: null,
      shippingMethodId: "method",
    })).toThrow(ValidationError);
  });
});
