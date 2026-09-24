import { describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";
import { getProductActionsPresentation } from "./product-actions";

const product = { productName: "Rider Court Trainers", copy: ENGLISH_CHECKOUT_LANGUAGE_DATA };

describe("product action presentation", () => {
  it("keeps both purchase actions enabled while options are still being chosen", () => {
    expect(
      getProductActionsPresentation({ ...product, anyVariantAvailable: true }),
    ).toEqual({
      addToCart: {
        disabled: false,
        label: "Add to cart",
        ariaLabel: "Add to cart — Rider Court Trainers",
      },
      buyNow: {
        disabled: false,
        label: "Buy now",
        ariaLabel: "Buy now — Rider Court Trainers",
      },
    });
  });

  it("disables both actions when nothing, or the chosen combination, can be bought", () => {
    for (const input of [
      { anyVariantAvailable: false },
      { anyVariantAvailable: true, chosenVariantSoldOut: true },
    ]) {
      const actions = getProductActionsPresentation({ ...product, ...input });
      expect(actions.addToCart).toMatchObject({ disabled: true, label: "Sold out" });
      expect(actions.buyNow).toMatchObject({ disabled: true, label: "Sold out" });
    }
  });

  it("uses the store's checkout language copy", () => {
    const actions = getProductActionsPresentation({
      ...product,
      anyVariantAvailable: true,
      copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
    });
    expect(actions.addToCart.label).toBe("কার্টে যোগ করুন");
    expect(actions.buyNow.label).toBe("এখনই কিনুন");
    expect(
      getProductActionsPresentation({
        ...product,
        anyVariantAvailable: false,
        copy: BANGLA_CHECKOUT_LANGUAGE_DATA,
      }).addToCart.label,
    ).toBe("স্টক শেষ");
  });
});
