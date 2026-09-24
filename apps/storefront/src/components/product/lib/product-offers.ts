import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import type { ProductBuyGetOffer } from "@/lib/api/types";
import type { ProductActionCopy } from "./product-actions";

const ITEM = "\u0000item\u0000";

/**
 * "Buy 2, get Attar 6ml free" / "Spend ৳2,000, get a cap 50% off", in the
 * store's language, split around the item name so the page can link it.
 */
export function describeBuyGetOffer(
  offer: Pick<ProductBuyGetOffer, "buyQuantity" | "buyAmount" | "percentOff" | "products">,
  copy: Pick<ProductActionCopy, "saleOfferText" | "saleOfferSpendText" | "freeBenefitText" | "percentBenefitText">,
  formatPrice: (amount: number) => string,
): { before: string; item: string; after: string } {
  const benefit = offer.percentOff >= 100
    ? copy.freeBenefitText
    : formatCheckoutLanguageText(copy.percentBenefitText, { percent: offer.percentOff });
  const text = offer.buyAmount !== null
    ? formatCheckoutLanguageText(copy.saleOfferSpendText, { amount: formatPrice(offer.buyAmount), item: ITEM, benefit })
    : formatCheckoutLanguageText(copy.saleOfferText, { quantity: offer.buyQuantity ?? 1, item: ITEM, benefit });
  const item = offer.products.map(({ name }) => name).join(" / ");
  const at = text.indexOf(ITEM);
  return at < 0
    ? { before: text, item: "", after: "" }
    : { before: text.slice(0, at), item, after: text.slice(at + ITEM.length) };
}
