// The store's own words for its actions and amounts, in every language core
// ships (English and Bangla): what the summary, the totals and the buy and
// checkout buttons say. An app's words drawn beside them (an add-on's title,
// a buyer block's labels, links and buttons: ui.ts `BUYER_LABELS`)
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

/**
 * Fillers that draw as blank space but are no space to `\s` (the Hangul
 * fillers, the blank Braille pattern): read as a space, so "Place\u3164order"
 * is "Place order".
 */
const BLANK = /[\u115F\u1160\u2800\u3164\uFFA0]/gu;
/**
 * Every default-ignorable code point (zero-width characters, soft hyphen, bidi
 * controls, variation selectors, tag characters): drawn as nothing, so
 * "Pl\u200Bace order" and "Place\uFE0F order" read as "Place order".
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

const visible = (value: string) => value.replace(BLANK, " ").replace(INVISIBLE, "");

/** True when `text` draws as nothing but space: spaces, blank fillers and invisible characters only. */
export function isBlankWords(text: string): boolean {
  return visible(text).trim() === "";
}

/** Words as compared: blank fillers to spaces, invisible characters dropped, NFKC, lower case, one space between words, no punctuation or symbols at either end. */
export function foldStoreWords(text: string): string {
  return visible(visible(text).normalize("NFKC")).toLowerCase().replace(/\s+/gu, " ")
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

/** Where an app's label sits in what it answered, and its words. */
export interface StoreWordsLabel {
  readonly text: string | undefined;
  readonly at: ReadonlyArray<string | number>;
}

/**
 * Refuses, with reason `store_words`, each label that reads as one of the
 * store's words: one issue per label at its path. `say` ends the message
 * ("name what the add-on is").
 */
export function refuseStoreWords(
  labels: Iterable<StoreWordsLabel>,
  context: { addIssue(issue: { code: "custom"; path: Array<string | number>; message: string; params: { reason: string } }): void },
  say = "say what yours is",
): void {
  for (const label of labels) {
    if (label.text === undefined || !isStoreActionOrAmountWord(label.text)) continue;
    context.addIssue({ code: "custom", path: [...label.at], message: `"${label.text}" is the store's own word for an action or an amount: ${say}.`, params: { reason: STORE_WORDS_REASON } });
  }
}
