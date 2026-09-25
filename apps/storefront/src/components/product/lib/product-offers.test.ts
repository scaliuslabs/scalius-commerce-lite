import { describe, expect, it } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { formatMoney } from "@scalius/shared/currency";
import { describeBundleTiers, describeBuyGetOffer } from "./product-offers";

const product = { id: "prod_tee", slug: "tee", name: "Buyer Tee", variantId: null, price: null };
const role = "buy" as const;
const format = (amount: number) => formatMoney(amount, { code: "BDT", symbol: "৳" });

describe("describeBuyGetOffer", () => {
  it("names the free item once, split out so the page can link it", () => {
    const text = describeBuyGetOffer(
      { role, buyQuantity: 1, buyAmount: null, percentOff: 100, products: [product] },
      ENGLISH_CHECKOUT_LANGUAGE_DATA,
      format,
    );
    expect(text.item).toBe("Buyer Tee");
    expect(`${text.before}${text.item}${text.after}`.split("Buyer Tee")).toHaveLength(2);
  });

  it("states a spend threshold in the store's money format and a partial benefit", () => {
    const text = describeBuyGetOffer(
      { role, buyQuantity: null, buyAmount: 200000, percentOff: 50, products: [product] },
      ENGLISH_CHECKOUT_LANGUAGE_DATA,
      format,
    );
    const sentence = `${text.before}${text.item}${text.after}`;
    expect(sentence).toContain("৳2,00,000");
    expect(sentence).toContain("50%");
  });

  it("tells the product given away which product to buy", () => {
    const text = describeBuyGetOffer(
      { role: "get", buyQuantity: 1, buyAmount: null, percentOff: 50, products: [{ ...product, name: "Tupi" }] },
      ENGLISH_CHECKOUT_LANGUAGE_DATA,
      format,
    );
    expect(`${text.before}${text.item}${text.after}`).toBe("Buy 1 Tupi, get this 50% off");
    expect(text.item).toBe("Tupi");
  });
});

describe("quantity tiers on the product page", () => {
  // Regression: product.bundles was ignored, so tiers checkout applies were never shown.
  const copy = { productBundleTierText: "Buy {quantity}, save {saving}", productBundleSetPriceText: "Buy {quantity} for {price}" };
  it("lists active tiers fewest units first, worded from the tier alone", () => {
    expect(describeBundleTiers([
      { quantity: 3, discountType: "fixed_price", discountPercentage: null, price: 600, label: "Set of 3", isActive: true },
      { quantity: 2, discountType: "percentage", discountPercentage: 12.5, price: null, label: " Pair ", isActive: true },
      { quantity: 6, discountType: "percentage", discountPercentage: 30, price: null, label: null, isActive: false },
    ], copy, (amount) => "৳" + amount)).toEqual([
      { quantity: 2, label: "Pair", text: "Buy 2, save 12.5%" },
      { quantity: 3, label: "Set of 3", text: "Buy 3 for ৳600" },
    ]);
  });
});
