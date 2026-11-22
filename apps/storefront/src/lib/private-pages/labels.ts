/**
 * The theme's words for host labels on the cart page (private-anatomy.ts,
 * `labels`): each label key rewords one of the checkout language's words,
 * on the page and in the cart script (it reads the same language object),
 * so a reworded heading or empty state stays reworded after the lines draw.
 * A label the theme leaves alone keeps the merchant's checkout words.
 */
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

/** The cart page's label keys and the checkout words each replaces. */
export const CART_LABEL_WORDS = {
  "cart.heading": "cartSectionTitle",
  "cart.continue": "continueShoppingText",
  "cart.empty": "emptyCartText",
  "cart.emptyText": "emptyCartDescriptionText",
  "cart.subtotal": "subtotalText",
} as const satisfies Record<string, keyof CheckoutLanguageData>;

/** The checkout words with the theme's labels in place (a copy: the language read is shared). */
export function withCartLabels(words: CheckoutLanguageData, labels: Readonly<Record<string, string>>): CheckoutLanguageData {
  const changed = Object.entries(CART_LABEL_WORDS).filter(([key]) => labels[key] !== undefined);
  if (changed.length === 0) return words;
  return { ...words, ...Object.fromEntries(changed.map(([key, field]) => [field, labels[key]!])) };
}
