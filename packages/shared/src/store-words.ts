// The store's own words for its actions and amounts, in every language core
// ships (English and Bangla): what the summary, the totals and the buy and
// checkout buttons say. An app's words drawn beside them (an add-on's title,
// a buyer block's button, key-value label, heading, banner title or badge)
// may never read as one of these, or a buyer could take an app's row for the
// store's total or an app's button for the store's checkout. The words come
// from the built-in checkout copy (`checkout-language-presets.ts`) and the
// private pages' label variants (`apps/storefront/src/lib/private-pages/labels.ts`);
// tests hold every entry equal to its source. A small literal table, so a
// browser bundle that checks a tree never carries the whole copy.

/** Each word by its source: a checkout copy key, or `variant:<label variant>`. */
export const STORE_ACTION_AND_AMOUNT_WORDS: Readonly<Record<string, Readonly<{ en: string; bn: string }>>> = {
  subtotalText: { en: "Subtotal", bn: "পণ্যের মোট" },
  shippingText: { en: "Shipping", bn: "ডেলিভারি চার্জ" },
  discountText: { en: "Discount", bn: "ছাড়" },
  totalText: { en: "Total", bn: "সর্বমোট" },
  estimatedTotalText: { en: "Estimated total", bn: "আনুমানিক সর্বমোট" },
  taxText: { en: "Tax", bn: "কর" },
  placeOrderText: { en: "Place order", bn: "অর্ডার করুন" },
  continueToPaymentText: { en: "Continue to payment", bn: "পেমেন্টে এগিয়ে যান" },
  dueNowText: { en: "Due now", bn: "এখন পরিশোধযোগ্য" },
  dueOnDeliveryText: { en: "Due on delivery", bn: "ডেলিভারির সময় পরিশোধযোগ্য" },
  dueAtPickupText: { en: "Due at pickup", bn: "সংগ্রহের সময় পরিশোধযোগ্য" },
  amountDueText: { en: "Amount due", bn: "পরিশোধযোগ্য টাকা" },
  onlinePaymentText: { en: "Pay online", bn: "অনলাইনে পেমেন্ট করুন" },
  addToCartText: { en: "Add to cart", bn: "কার্টে যোগ করুন" },
  buyNowText: { en: "Buy now", bn: "এখনই কিনুন" },
  orderReceiptPaidText: { en: "Paid", bn: "পরিশোধিত" },
  orderReceiptBalanceDueText: { en: "Balance due", bn: "বাকি টাকা" },
  orderReceiptLineTotalText: { en: "Line total", bn: "পণ্যটির মোট" },
  "variant:subtotal": { en: "Subtotal", bn: "সাবটোটাল" },
  "variant:items-total": { en: "Items total", bn: "পণ্যের মোট" },
  "variant:checkout": { en: "Checkout", bn: "চেকআউট" },
  "variant:proceed-to-checkout": { en: "Proceed to checkout", bn: "চেকআউটে এগিয়ে যান" },
  "variant:continue-checkout": { en: "Continue checkout", bn: "চেকআউট চালিয়ে যান" },
};

/** The machine-readable reason an app's words that read as the store's are refused with. */
export const STORE_WORDS_REASON = "store_words";

/** Words as compared: NFKC, lower case, one space between words, no punctuation or symbols at either end. */
export function foldStoreWords(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}

const FOLDED = new Set(Object.values(STORE_ACTION_AND_AMOUNT_WORDS).flatMap((words) => [foldStoreWords(words.en), foldStoreWords(words.bn)]));

/** True when `text` reads as one of the store's action or amount words (exactly, once folded). */
export function isStoreActionOrAmountWord(text: string): boolean {
  return FOLDED.has(foldStoreWords(text));
}
