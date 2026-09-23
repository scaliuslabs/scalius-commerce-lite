import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { getProductActionsPresentation } from "./product-actions";

const product = { productName: "Rider Court Trainers" };

describe("product action presentation", () => {
  it("requires an exact option combination before either purchase action", () => {
    expect(
      getProductActionsPresentation({
        ...product,
        exactVariantAvailable: false,
        anyVariantAvailable: true,
      }),
    ).toEqual({
      addToCart: {
        disabled: true,
        label: "Select Options",
        ariaLabel: "Select Options — Rider Court Trainers",
      },
      buyNow: {
        disabled: true,
        label: "Buy Now",
        ariaLabel: "Buy Now — Rider Court Trainers",
      },
    });
  });

  it("enables both actions for an available exact SKU", () => {
    const actions = getProductActionsPresentation({
      ...product,
      exactVariantAvailable: true,
      anyVariantAvailable: true,
    });
    expect(actions.addToCart).toEqual({
      disabled: false,
      label: "Add to Cart",
      ariaLabel: "Add to Cart — Rider Court Trainers",
    });
    expect(actions.buyNow.disabled).toBe(false);
  });

  it("keeps sold-out actions disabled and explicit", () => {
    const actions = getProductActionsPresentation({
      ...product,
      exactVariantAvailable: false,
      anyVariantAvailable: false,
    });
    expect(actions.addToCart).toMatchObject({ disabled: true, label: "Unavailable" });
    expect(actions.buyNow).toMatchObject({ disabled: true, label: "Unavailable" });
  });

  it("uses the store's checkout language copy", () => {
    const actions = getProductActionsPresentation({
      ...product,
      exactVariantAvailable: true,
      anyVariantAvailable: true,
      copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
    });
    expect(actions.addToCart.label).toBe("কার্টে যোগ করুন");
    expect(actions.buyNow.label).toBe("এখনই কিনুন");
    expect(
      getProductActionsPresentation({
        ...product,
        exactVariantAvailable: false,
        anyVariantAvailable: false,
        copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
      }).addToCart.label,
    ).toBe("পাওয়া যাচ্ছে না");
  });
});
