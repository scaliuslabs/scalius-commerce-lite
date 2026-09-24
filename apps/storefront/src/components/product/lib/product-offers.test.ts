import { describe, expect, it } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { formatMoney } from "@scalius/shared/currency";
import { describeBuyGetOffer } from "./product-offers";

const product = { id: "prod_tee", slug: "tee", name: "Buyer Tee", variantId: null, price: null };
const format = (amount: number) => formatMoney(amount, { code: "BDT", symbol: "৳" });

describe("describeBuyGetOffer", () => {
  it("names the free item once, split out so the page can link it", () => {
    const text = describeBuyGetOffer(
      { buyQuantity: 1, buyAmount: null, percentOff: 100, products: [product] },
      ENGLISH_CHECKOUT_LANGUAGE_DATA,
      format,
    );
    expect(text.item).toBe("Buyer Tee");
    expect(`${text.before}${text.item}${text.after}`.split("Buyer Tee")).toHaveLength(2);
  });

  it("states a spend threshold in the store's money format and a partial benefit", () => {
    const text = describeBuyGetOffer(
      { buyQuantity: null, buyAmount: 200000, percentOff: 50, products: [product] },
      ENGLISH_CHECKOUT_LANGUAGE_DATA,
      format,
    );
    const sentence = `${text.before}${text.item}${text.after}`;
    expect(sentence).toContain("৳2,00,000");
    expect(sentence).toContain("50%");
  });
});
