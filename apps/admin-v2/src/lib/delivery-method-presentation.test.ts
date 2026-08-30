import { describe, expect, it } from "vitest";
import { resolveDeliveryMethodPresentation } from "./delivery-method-presentation";

const savedSummary = {
  currencyCode: "BDT",
  decimalPlaces: 2,
  subtotalMinor: 95_000,
  shippingMinor: 0,
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 95_000,
  taxLabel: "Tax",
  pricesIncludeTax: true,
};

describe("delivery method presentation", () => {
  it("shows the immutable selected method and waived configured fee", () => {
    expect(resolveDeliveryMethodPresentation({
      shippingMethodName: "Express Delivery",
      shippingMethodDescription: "Faster delivery for eligible areas.",
      shippingMethodBaseAmountMinor: 20_000,
      shippingFeeWaived: true,
    }, savedSummary, "Shipping")).toEqual({
      label: "Delivery · Express Delivery",
      details: "Faster delivery for eligible areas. Configured fee BDT 200.00 was waived.",
    });
  });

  it("keeps the caller's historical fallback when no method snapshot exists", () => {
    expect(resolveDeliveryMethodPresentation({
      shippingMethodName: null,
      shippingMethodDescription: null,
      shippingMethodBaseAmountMinor: null,
      shippingFeeWaived: null,
    }, savedSummary, "Shipping")).toEqual({
      label: "Shipping",
      details: "",
    });
  });

  it("does not invent a configured fee when saved money is unavailable", () => {
    expect(resolveDeliveryMethodPresentation({
      shippingMethodName: "Collection Point",
      shippingMethodBaseAmountMinor: 5_000,
      shippingFeeWaived: true,
    }, null)).toEqual({
      label: "Delivery · Collection Point",
      details: "Delivery fee was waived.",
    });
  });
});
