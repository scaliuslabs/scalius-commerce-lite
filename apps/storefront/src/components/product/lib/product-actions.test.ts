import { describe, expect, it } from "vitest";
import { getProductActionsPresentation } from "./product-actions";

describe("product action presentation", () => {
  it("requires an exact option combination before either purchase action", () => {
    expect(
      getProductActionsPresentation({
        productName: "Rider Court Trainers",
        exactVariantAvailable: false,
        anyVariantAvailable: true,
      }),
    ).toEqual({
      addToCart: {
        disabled: true,
        label: "Select Options",
        ariaLabel:
          "Select Options — choose an available Rider Court Trainers option",
      },
      buyNow: {
        disabled: true,
        label: "Buy Now",
        ariaLabel:
          "Buy Now — select an available Rider Court Trainers option first",
      },
    });
  });

  it("exposes accurate accessible names for an available exact SKU", () => {
    expect(
      getProductActionsPresentation({
        productName: "Rider Court Trainers",
        exactVariantAvailable: true,
        anyVariantAvailable: true,
      }),
    ).toEqual({
      addToCart: {
        disabled: false,
        label: "Add to Cart",
        ariaLabel: "Add to Cart — Rider Court Trainers",
      },
      buyNow: {
        disabled: false,
        label: "Buy Now",
        ariaLabel: "Buy Now — Rider Court Trainers",
      },
    });
  });

  it("keeps sold-out actions disabled and explicit", () => {
    expect(
      getProductActionsPresentation({
        productName: "Rider Court Trainers",
        exactVariantAvailable: false,
        anyVariantAvailable: false,
      }),
    ).toEqual({
      addToCart: {
        disabled: true,
        label: "Unavailable",
        ariaLabel: "Unavailable — Rider Court Trainers",
      },
      buyNow: {
        disabled: true,
        label: "Unavailable",
        ariaLabel: "Unavailable — Rider Court Trainers",
      },
    });
  });
});
