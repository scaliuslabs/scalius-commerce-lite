// The store's own words for its actions and amounts, in every language core
// ships (English and Bangla): what the buy, checkout and Pay buttons say
// (ACTION words) and what the summary's money rows say (AMOUNT words). An app
// may never pass for either: an app's button for the store's checkout, an
// app's row for the store's total. So each word is applied only where that
// impersonation is possible (`STORE_WORD_LABEL_KINDS`): action words to what a
// buyer presses or follows, amount words to what is drawn as or beside a
// money row; any other words of an app (a sentence, help, an image's
// description) only when they are, whole, one of the store's fixed words. The
// words come from the built-in checkout copy (`checkout-language-presets.ts`)
// and the private pages' label variants
// (`apps/storefront/src/lib/private-pages/labels.ts`); tests hold every entry
// equal to its source. A small literal table, so a browser bundle that checks
// a tree never carries the whole copy.

/** An action the store's buttons take, or an amount row of its summary. */
export type StoreWordClass = "action" | "amount";

/**
 * Each word by its source (a checkout copy key, or `variant:<label variant>`)
 * and its class. A `{amount}` slot holds an amount (a digit or a currency
 * sign in it), or nothing; a `{provider}` slot one word.
 */
export const STORE_ACTION_AND_AMOUNT_WORDS: Readonly<Record<string, Readonly<{ en: string; bn: string; class: StoreWordClass }>>> = {
  subtotalText: { en: "Subtotal", bn: "পণ্যের মোট", class: "amount" },
  shippingText: { en: "Shipping", bn: "ডেলিভারি চার্জ", class: "amount" },
  discountText: { en: "Discount", bn: "ছাড়", class: "amount" },
  totalText: { en: "Total", bn: "সর্বমোট", class: "amount" },
  estimatedTotalText: { en: "Estimated total", bn: "আনুমানিক সর্বমোট", class: "amount" },
  taxText: { en: "Tax", bn: "কর", class: "amount" },
  placeOrderText: { en: "Place order", bn: "অর্ডার করুন", class: "action" },
  continueToPaymentText: { en: "Continue to payment", bn: "পেমেন্টে এগিয়ে যান", class: "action" },
  dueNowText: { en: "Due now", bn: "এখন পরিশোধযোগ্য", class: "amount" },
  dueOnDeliveryText: { en: "Due on delivery", bn: "ডেলিভারির সময় পরিশোধযোগ্য", class: "amount" },
  dueAtPickupText: { en: "Due at pickup", bn: "সংগ্রহের সময় পরিশোধযোগ্য", class: "amount" },
  amountDueText: { en: "Amount due", bn: "পরিশোধযোগ্য টাকা", class: "amount" },
  onlinePaymentText: { en: "Pay online", bn: "অনলাইনে পেমেন্ট করুন", class: "action" },
  // The Pay button's own words, with the amount or the provider it names.
  payAmountText: { en: "Pay {amount}", bn: "{amount} পরিশোধ করুন", class: "action" },
  payAmountNowText: { en: "Pay {amount} now", bn: "এখন {amount} পরিশোধ করুন", class: "action" },
  continueToProviderText: { en: "Continue to {provider}", bn: "{provider}-এ এগিয়ে যান", class: "action" },
  addToCartText: { en: "Add to cart", bn: "কার্টে যোগ করুন", class: "action" },
  buyNowText: { en: "Buy now", bn: "এখনই কিনুন", class: "action" },
  orderReceiptPaidText: { en: "Paid", bn: "পরিশোধিত", class: "amount" },
  orderReceiptBalanceDueText: { en: "Balance due", bn: "বাকি টাকা", class: "amount" },
  orderReceiptLineTotalText: { en: "Line total", bn: "পণ্যটির মোট", class: "amount" },
  "variant:subtotal": { en: "Subtotal", bn: "সাবটোটাল", class: "amount" },
  "variant:items-total": { en: "Items total", bn: "পণ্যের মোট", class: "amount" },
  "variant:checkout": { en: "Checkout", bn: "চেকআউট", class: "action" },
  "variant:proceed-to-checkout": { en: "Proceed to checkout", bn: "চেকআউটে এগিয়ে যান", class: "action" },
  "variant:continue-checkout": { en: "Continue checkout", bn: "চেকআউট চালিয়ে যান", class: "action" },
};

/**
 * Which of the store's words each kind of an app's label is held to:
 * `action` (every action word, its amount or provider slots included),
 * `amount` (every amount word), `fixed` (the label, whole, is one of the
 * store's fixed words of either class: no slot). `own` names the words that
 * are a row's truthful name for itself (a discount row titled "Discount").
 * A label of an `action` or `amount` kind is also refused when one of its
 * words mixes Latin letters with Cyrillic or Greek ones ("Раy now").
 */
export const STORE_WORD_LABEL_KINDS = {
  // What a buyer presses or follows.
  button: { reach: ["action"] },
  link: { reach: ["action"] },
  "bulk-action": { reach: ["action"] },
  // A way to buy, drawn beside Add to cart.
  "purchase-option": { reach: ["action"] },
  // Drawn as or beside a money row.
  "add-on": { reach: ["amount"] },
  "add-on-detail": { reach: ["amount"] },
  discount: { reach: ["amount"], own: ["discountText"] },
  bundle: { reach: ["amount"] },
  "key-value": { reach: ["amount"] },
  badge: { reach: ["amount"] },
  heading: { reach: ["amount"] },
  "banner-title": { reach: ["amount"] },
  // A summary line in the summary that the buyer presses to open.
  disclosure: { reach: ["action", "amount"] },
  // Sentences and other words: only a whole fixed store word.
  sentence: { reach: ["fixed"] },
  help: { reach: ["fixed"] },
  alt: { reach: ["fixed"] },
  choice: { reach: ["fixed"] },
  "input-label": { reach: ["fixed"] },
  agreement: { reach: ["fixed"] },
} as const satisfies Record<string, { reach: ReadonlyArray<StoreWordClass | "fixed">; own?: readonly string[] }>;
export type StoreWordLabelKind = keyof typeof STORE_WORD_LABEL_KINDS;

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

/** An amount in a slot, as folded: a token holding a digit or a currency sign, with a currency code beside it at most. */
const AMOUNT = "(?:(?:bdt|usd|eur|gbp|inr|tk|taka) )?[^\\s]*[\\p{Nd}\\p{Sc}][^\\s]*(?: (?:bdt|usd|eur|gbp|inr|tk|taka|টাকা))?";
/** A provider in a slot: one word. */
const PROVIDER = "[^\\s]+";

/**
 * One word of the list as a whole-label pattern over folded text. A
 * `{amount}` slot holds an amount or nothing ("Pay ৳1,200", "Pay"; never
 * "Pay later"); a `{provider}` slot holds one word ("Continue to bKash", never
 * "Continue to read our terms"). The words around a slot stay whole.
 */
function wordPattern(word: string): string {
  const marked = word.replace(/\{amount\}/g, "\uE000").replace(/\{[^{}]*\}/g, "\uE001");
  const parts = foldStoreWords(marked).split(/( ?[\uE000\uE001] ?)/u);
  return parts.map((part, index) => {
    if (index % 2 === 0) return escapeRegExp(part);
    const left = part.startsWith(" ") ? " " : "";
    const right = part.endsWith(" ") ? " " : "";
    if (part.includes("\uE001")) return `${left}${PROVIDER}${right}`;
    return left && right ? `(?: ${AMOUNT})? ` : left ? `(?: ${AMOUNT})?` : right ? `(?:${AMOUNT} )?` : `(?:${AMOUNT})?`;
  }).join("");
}

const patterns = new Map<StoreWordLabelKind, RegExp | null>();

/** The whole-label pattern of one label kind's words (null: no word applies to it). */
function kindPattern(kind: StoreWordLabelKind): RegExp | null {
  if (patterns.has(kind)) return patterns.get(kind)!;
  const scope: { reach: ReadonlyArray<StoreWordClass | "fixed">; own?: readonly string[] } = STORE_WORD_LABEL_KINDS[kind];
  const words = Object.entries(STORE_ACTION_AND_AMOUNT_WORDS).filter(([key, entry]) => !scope.own?.includes(key)
    && scope.reach.some((reach) => reach === entry.class || (reach === "fixed" && !/\{/.test(entry.en))));
  const pattern = words.length === 0 ? null
    : new RegExp(`^(?:${words.flatMap(([, entry]) => [wordPattern(entry.en), wordPattern(entry.bn)]).join("|")})$`, "u");
  patterns.set(kind, pattern);
  return pattern;
}

/** A word mixing Latin letters with Cyrillic or Greek ones: a look-alike ("Раy", "Τotal"). */
function mixesScripts(text: string): boolean {
  return (visible(text).normalize("NFKC").match(/[\p{L}\p{M}]+/gu) ?? [])
    .some((word) => /\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word));
}

/** Why `text`, as a label of `kind`, passes for the store's words, or null: the store's word itself, or a look-alike of mixed scripts. */
export function storeWordsIssue(text: string, kind: StoreWordLabelKind): "word" | "mixed_script" | null {
  if (kindPattern(kind)?.test(foldStoreWords(text))) return "word";
  const scope: { reach: ReadonlyArray<StoreWordClass | "fixed"> } = STORE_WORD_LABEL_KINDS[kind];
  return scope.reach.some((reach) => reach !== "fixed") && mixesScripts(text) ? "mixed_script" : null;
}

/** What a refusal says of `text`: the store's word, or a look-alike. */
export function storeWordsMessage(text: string, issue: "word" | "mixed_script", say = "say what yours is"): string {
  return issue === "word"
    ? `"${text}" is the store's own word for an action or an amount: ${say}.`
    : `"${text}" mixes Latin letters with Cyrillic or Greek ones in one word, a look-alike of the store's words: write it in one script.`;
}

/** Where an app's label sits in what it answered, its words and its kind. */
export interface StoreWordsLabel {
  readonly text: string | undefined;
  readonly at: ReadonlyArray<string | number>;
  readonly kind: StoreWordLabelKind;
}

/** Every label of `labels` that passes for the store's words, with its refusal: reason `store_words`. */
export function storeWordsIssues(labels: Iterable<StoreWordsLabel>, say?: string): Array<{ path: Array<string | number>; message: string; reason: typeof STORE_WORDS_REASON }> {
  const issues: Array<{ path: Array<string | number>; message: string; reason: typeof STORE_WORDS_REASON }> = [];
  for (const label of labels) {
    const issue = label.text === undefined ? null : storeWordsIssue(label.text, label.kind);
    if (issue) issues.push({ path: [...label.at], message: storeWordsMessage(label.text!, issue, say), reason: STORE_WORDS_REASON });
  }
  return issues;
}
