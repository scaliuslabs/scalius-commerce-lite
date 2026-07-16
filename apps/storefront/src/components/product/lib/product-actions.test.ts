import { describe, expect, it } from "vitest";
import { getProductActionsPresentation } from "./product-actions";

describe("product action presentation", () => {
  it("requires an exact option combination before either purchase action", () => {
    expect(getProductActionsPresentation({
      productName: "Rider Court Trainers",
      exactVariantAvailable: false,
      anyVariantAvailable: true,
    })).toEqual({
      addToCart: {
        disabled: true,
        label: "Select Options",
        ariaLabel: "Select an available Rider Court Trainers option to add to cart",
      },
      buyNow: {
        disabled: true,
        label: "Buy Now",
        ariaLabel: "Select an available Rider Court Trainers option before buying",
      },
    });
  });

  it("exposes accurate accessible names for an available exact SKU", () => {
    expect(getProductActionsPresentation({
      productName: "Rider Court Trainers",
      exactVariantAvailable: true,
      anyVariantAvailable: true,
    })).toEqual({
      addToCart: {
        disabled: false,
        label: "Add to Cart",
        ariaLabel: "Add Rider Court Trainers to cart",
      },
      buyNow: {
        disabled: false,
        label: "Buy Now",
        ariaLabel: "Buy Rider Court Trainers now",
      },
    });
  });

  it("keeps sold-out actions disabled and explicit", () => {
    expect(getProductActionsPresentation({
      productName: "Rider Court Trainers",
      exactVariantAvailable: false,
      anyVariantAvailable: false,
    })).toEqual({
      addToCart: {
        disabled: true,
        label: "Unavailable",
        ariaLabel: "Rider Court Trainers is unavailable",
      },
      buyNow: {
        disabled: true,
        label: "Unavailable",
        ariaLabel: "Rider Court Trainers is unavailable",
      },
    });
  });
});
