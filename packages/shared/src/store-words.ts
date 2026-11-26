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
  // The Pay button's own words: a `{placeholder}` stands for any amount or provider, or none.
  payAmountText: { en: "Pay {amount}", bn: "{amount} পরিশোধ করুন" },
  payAmountNowText: { en: "Pay {amount} now", bn: "এখন {amount} পরিশোধ করুন" },
  continueToProviderText: { en: "Continue to {provider}", bn: "{provider}-এ এগিয়ে যান" },
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

/** Zero-width, soft-hyphen and bidi control characters: invisible, so "Pl\u200Bace order" reads as "Place order". */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/** Words as compared: invisible characters dropped, NFKC, lower case, one space between words, no punctuation or symbols at either end. */
export function foldStoreWords(text: string): string {
  return text.replace(INVISIBLE, "").normalize("NFKC").replace(INVISIBLE, "").toLowerCase().replace(/\s+/gu, " ")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One word of the list as a whole-label pattern over folded text. A
 * `{placeholder}` stands for anything or nothing: "Pay {amount} now" is
 * "Pay ৳1,200 now" and "Pay now"; "Pay {amount}" is "Pay" too. Where the
 * copy puts a space beside the placeholder, the words around it stay whole
 * ("Pay {amount}" is not "Payback").
 */
function wordPattern(word: string): string {
  const parts = foldStoreWords(word.replace(/\{[^{}]*\}/g, "\uE000")).split(/(\s?\uE000\s?)/u);
  return parts.map((part, index) => {
    if (index % 2 === 0) return escapeRegExp(part);
    const before = parts[index - 1] !== "";
    const after = parts[index + 1] !== "";
    const left = part.startsWith(" ");
    const right = part.endsWith(" ");
    if (before && after) return left && right ? " (?:.* )?" : left ? " .*" : right ? ".* " : ".*";
    if (before) return left ? "(?: .*)?" : ".*";
    if (after) return right ? "(?:.* )?" : ".*";
    return ".*";
  }).join("");
}

const PATTERN = new RegExp(`^(?:${Object.values(STORE_ACTION_AND_AMOUNT_WORDS)
  .flatMap((words) => [wordPattern(words.en), wordPattern(words.bn)]).join("|")})$`, "u");

/** True when `text` reads as one of the store's action or amount words: the whole label once folded, any amount or provider where the copy names one. */
export function isStoreActionOrAmountWord(text: string): boolean {
  return PATTERN.test(foldStoreWords(text));
}
