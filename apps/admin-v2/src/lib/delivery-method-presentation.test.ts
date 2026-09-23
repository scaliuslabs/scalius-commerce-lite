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
  it("shows the saved method and the waived configured fee", () => {
    const presentation = resolveDeliveryMethodPresentation({
      shippingMethodName: "Express Delivery",
      shippingMethodDescription: "Faster delivery for eligible areas.",
      shippingMethodBaseAmountMinor: 20_000,
      shippingFeeWaived: true,
    }, savedSummary);
    expect(presentation.label).toContain("Express Delivery");
    expect(presentation.details).toContain("Faster delivery for eligible areas.");
    expect(presentation.details).toContain("৳200.00");
  });

  it("falls back to a plain delivery label when no method was saved", () => {
    const presentation = resolveDeliveryMethodPresentation({
      shippingMethodName: null,
      shippingMethodDescription: null,
      shippingMethodBaseAmountMinor: null,
      shippingFeeWaived: null,
    }, savedSummary);
    expect(presentation.details).toBe("");
    expect(presentation.label).not.toContain("·");
  });

  it("does not invent a configured fee when saved money is unavailable", () => {
    const presentation = resolveDeliveryMethodPresentation({
      shippingMethodName: "Collection Point",
      shippingMethodBaseAmountMinor: 5_000,
      shippingFeeWaived: true,
    }, null);
    expect(presentation.label).toContain("Collection Point");
    expect(presentation.details).not.toMatch(/\d/);
    expect(presentation.details).not.toBe("");
  });
});
