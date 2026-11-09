// The platform's words on an order line ("Yes", "Add-on", line-entry-words.ts)
// as a buyer message writes them: the store's checkout copy of the message's
// language (Settings → Checkout languages), else that language's built-in
// copy, so an email says what the storefront says. The copies ride the
// order's own row (`messageLineCopyColumns`): no statement of their own.
import { checkoutLanguages } from "@scalius/database/schema";
import { getCheckoutLanguagePreset, resolveCheckoutLanguageData } from "@scalius/shared/checkout-language";
import { LINE_ENTRY_WORD_KEYS, type LineEntryWords } from "@scalius/shared/line-entry-words";
import { sql } from "drizzle-orm";
import type { MessageLanguage } from "./message-copy";

/** The merchant's checkout copy of a message language (its newest active one first), or null. */
const copyOf = (language: MessageLanguage) => sql<string | null>`(SELECT ${checkoutLanguages.languageData} FROM ${checkoutLanguages}
  WHERE ${checkoutLanguages.deletedAt} IS NULL AND lower(substr(${checkoutLanguages.code}, 1, 2)) = ${sql.raw(`'${language}'`)}
  ORDER BY ${checkoutLanguages.isActive} DESC, ${checkoutLanguages.id} LIMIT 1)`;

/** Selected with the order: the merchant's English and Bangla checkout copies, one per message language. */
export function messageLineCopyColumns() {
  return { lineCopyEn: copyOf("en"), lineCopyBn: copyOf("bn") };
}

/** The line words of a message language: the merchant's copy of it over the built-in one. */
export function messageLineWords(order: { lineCopyEn?: string | null; lineCopyBn?: string | null }, language: MessageLanguage): LineEntryWords {
  const stored = language === "bn" ? order.lineCopyBn : order.lineCopyEn;
  const copy = stored ? resolveCheckoutLanguageData(language, stored) : getCheckoutLanguagePreset(language);
  return Object.fromEntries(LINE_ENTRY_WORD_KEYS.map((key) => [key, copy[key]])) as LineEntryWords;
}
