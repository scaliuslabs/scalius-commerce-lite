// The platform's own words on a cart or order line, as opposed to the
// merchant's input labels and an app's words: "Yes" for a ticked box, "2
// files" for an upload, the "Add-on", "Purchase option" and "Bundle" labels
// and a gift card's recipient labels. The line stores them in English for
// the API's readers (apps, webhooks); every page, message and document draws
// them from this catalogue by the entry's key and type, in its reader's
// language: the buyer's surfaces in the order's language (the checkout
// language catalogue carries these keys), the dashboard in the staff
// member's. Browser-safe and free of the checkout presets.
import { parseBuyerUploadValue } from "./buyer-uploads";
import { LINE_PURCHASE_OPTION_PROPERTY_KEY } from "./line-identity";

/** The entry keys the platform freezes beside the buyer's inputs: an app's add-on and a bundle (line-properties.ts names them). */
export const LINE_ADJUSTMENT_KEY = "_adjustment";
export const LINE_BUNDLE_KEY = "_bundle";
const CHECKED_VALUE = "true";
/** An upload's file count as the line froze it (`buyerUploadDisplayValue`). */
const FROZEN_FILE_COUNT = /^\d+ files?$/;

export const LINE_ENTRY_WORDS_EN = {
  lineCheckedText: "Yes",
  lineUncheckedText: "No",
  lineOneFileText: "1 file",
  lineFilesText: "{count} files",
  lineAddOnText: "Add-on",
  linePurchaseOptionText: "Purchase option",
  lineBundleText: "Bundle",
  lineGiftCardRecipientNameText: "Recipient name",
  lineGiftCardRecipientEmailText: "Recipient email",
  lineGiftCardRecipientPhoneText: "Or recipient phone",
  lineGiftCardMessageText: "Message",
} as const;

export type LineEntryWordKey = keyof typeof LINE_ENTRY_WORDS_EN;
export type LineEntryWords = Record<LineEntryWordKey, string>;
export const LINE_ENTRY_WORD_KEYS = Object.keys(LINE_ENTRY_WORDS_EN) as LineEntryWordKey[];

export const LINE_ENTRY_WORDS_BN: LineEntryWords = {
  lineCheckedText: "হ্যাঁ",
  lineUncheckedText: "না",
  lineOneFileText: "১টি ফাইল",
  lineFilesText: "{count}টি ফাইল",
  lineAddOnText: "অ্যাড-অন",
  linePurchaseOptionText: "কেনার ধরন",
  lineBundleText: "বান্ডেল",
  lineGiftCardRecipientNameText: "প্রাপকের নাম",
  lineGiftCardRecipientEmailText: "প্রাপকের ইমেইল",
  lineGiftCardRecipientPhoneText: "অথবা প্রাপকের ফোন",
  lineGiftCardMessageText: "বার্তা",
};

/** The catalogue's words for a language: Bangla for `bn` (`bn-BD`), else English. */
export function lineEntryWords(language: string | null | undefined): LineEntryWords {
  return (language ?? "").toLowerCase().split(/[-_]/, 1)[0] === "bn" ? LINE_ENTRY_WORDS_BN : LINE_ENTRY_WORDS_EN;
}

/** The label word of an entry the platform names by its key, or null for the merchant's or an app's own label. */
function labelKey(key: string): LineEntryWordKey | null {
  switch (key) {
    case LINE_ADJUSTMENT_KEY: return "lineAddOnText";
    case LINE_PURCHASE_OPTION_PROPERTY_KEY: return "linePurchaseOptionText";
    case LINE_BUNDLE_KEY: return "lineBundleText";
    case "_gc_recipient_name": return "lineGiftCardRecipientNameText";
    case "_gc_recipient_email": return "lineGiftCardRecipientEmailText";
    case "_gc_recipient_phone": return "lineGiftCardRecipientPhoneText";
    case "_gc_message": return "lineGiftCardMessageText";
    default: return null;
  }
}

/** A cart or order line entry as every surface holds it (`type` and `value` when it knows them). */
export interface LineEntryText {
  key: string;
  label: string;
  displayValue: string;
  type?: string;
  value?: string;
}

/**
 * The entry with the platform's words in the reader's language: its label
 * when the platform names the entry (an add-on, a purchase option, a bundle,
 * a gift card's recipient), its value when the platform words it (a ticked
 * box, an upload's file count). The merchant's labels, the buyer's text and
 * an app's words are left exactly as frozen. `count` writes a number in the
 * reader's digits (default as is).
 */
export function presentLineEntry<T extends LineEntryText>(entry: T, words: LineEntryWords, count: (value: number) => string = String): T {
  const label = labelKey(entry.key);
  let displayValue = entry.displayValue;
  // A surface that kept no type (a stored cart) knows the entry by the English word the platform froze.
  const checked = entry.type === undefined ? entry.displayValue === LINE_ENTRY_WORDS_EN.lineCheckedText : entry.type === "checkbox";
  const files = entry.value !== undefined && (entry.type === "file" || (entry.type === undefined && FROZEN_FILE_COUNT.test(entry.displayValue)))
    ? parseBuyerUploadValue(entry.value)?.length
    : undefined;
  if (checked && entry.value === CHECKED_VALUE) displayValue = words.lineCheckedText;
  else if (files !== undefined) displayValue = files === 1 ? words.lineOneFileText : words.lineFilesText.replace("{count}", count(files));
  if (!label && displayValue === entry.displayValue) return entry;
  return { ...entry, ...(label ? { label: words[label] } : {}), displayValue };
}

/** Every entry of a line through `presentLineEntry`. */
export function presentLineEntries<T extends LineEntryText>(entries: readonly T[], words: LineEntryWords, count?: (value: number) => string): T[] {
  return entries.map((entry) => presentLineEntry(entry, words, count));
}
