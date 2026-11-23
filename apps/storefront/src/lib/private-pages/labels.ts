/**
 * The theme's labels on the cart page (private-anatomy.ts, `labels`): each
 * label key replaces one of the checkout language's words, on the page and
 * in the cart script (it reads the same language object), so a changed
 * heading or empty state stays changed after the lines draw. A label the
 * theme leaves alone keeps the merchant's checkout words. A label that names
 * an action or an amount is one of the store's variants, worded here.
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

/**
 * The store's words for every label variant a theme may choose (private-anatomy.ts:
 * labels that name an action or an amount), in each language core translates. A
 * page in another language reads the English.
 */
export const PRIVATE_LABEL_VARIANT_WORDS: Readonly<Record<string, Readonly<{ en: string; bn: string }>>> = {
  "continue-shopping": { en: "Continue shopping", bn: "কেনাকাটা চালিয়ে যান" },
  "keep-shopping": { en: "Keep shopping", bn: "আরও কেনাকাটা করুন" },
  "back-to-store": { en: "Back to store", bn: "দোকানে ফিরে যান" },
  "start-shopping": { en: "Start shopping", bn: "কেনাকাটা শুরু করুন" },
  "browse-products": { en: "Browse products", bn: "পণ্য দেখুন" },
  subtotal: { en: "Subtotal", bn: "সাবটোটাল" },
  "items-total": { en: "Items total", bn: "পণ্যের মোট" },
  "show-summary": { en: "Show order summary", bn: "অর্ডারের সারাংশ দেখুন" },
  "show-cart": { en: "Show cart", bn: "কার্ট দেখুন" },
  "hide-summary": { en: "Hide order summary", bn: "অর্ডারের সারাংশ লুকান" },
  "hide-cart": { en: "Hide cart", bn: "কার্ট লুকান" },
  "go-back": { en: "Go back", bn: "ফিরে যান" },
  cancel: { en: "Cancel", bn: "বাতিল" },
  confirm: { en: "Confirm", bn: "নিশ্চিত করুন" },
  "continue-checkout": { en: "Continue checkout", bn: "চেকআউট চালিয়ে যান" },
  "agree-and-continue": { en: "Agree and continue", bn: "সম্মত হয়ে এগিয়ে যান" },
  checkout: { en: "Checkout", bn: "চেকআউট" },
  "proceed-to-checkout": { en: "Proceed to checkout", bn: "চেকআউটে এগিয়ে যান" },
  "view-cart": { en: "View cart", bn: "কার্ট দেখুন" },
  "go-to-cart": { en: "Go to cart", bn: "কার্টে যান" },
};

/** A label variant's words in the page's language (its base language; English for one core does not translate). */
export function privateLabelVariantWords(variant: string, language: string): string | null {
  const words = Object.hasOwn(PRIVATE_LABEL_VARIANT_WORDS, variant) ? PRIVATE_LABEL_VARIANT_WORDS[variant]! : null;
  if (!words) return null;
  return (language.toLowerCase().split(/[-_]/)[0] === "bn" ? words.bn : words.en);
}
