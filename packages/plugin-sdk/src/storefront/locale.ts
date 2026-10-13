// Words, numbers, money and dates in the page's language and the store's
// country, through the platform's one formatting layer
// (`@scalius/shared/locale-format`): the digits, grouping and plural rules
// the store's own pages use ("১২টি রিভিউ" in Bangla, "1 review" in English).

import type { StorefrontRenderContext } from "@scalius/shared/plugins/storefront-protocol";
import { baseLanguage, dateLocale, formatDateTime, formatNumber as formatLocaleNumber, numberLocale } from "@scalius/shared/locale-format";
import { pluralCategory } from "@scalius/shared/locale-words";
import { formatMoney as formatStoreMoney } from "@scalius/shared/currency";
import { commerceWallTimeToEpoch } from "@scalius/shared/commerce-time";

type Context = Pick<StorefrontRenderContext, "store">;

/** Words by language: English is required (the fallback), any other BCP-47 language is optional. */
export type Words<T = string> = { en: T } & { [language: string]: T | undefined };

/** The page language's words: the exact tag ("pt-BR"), then its language ("pt"), then English. */
export function t<T = string>(context: Context, words: Words<T>): T {
  const language = context.store.language;
  return words[language] || words[baseLanguage(language)] || words.en;
}

/** The store's country in the page locale ("BD" of "bn-BD"), if it names one. */
function region(context: Context): string | null {
  return /-([A-Z]{2})(?:-|$)/.exec(context.store.locale)?.[1] ?? null;
}

/** A number as the store writes it on this page (`{ maximumFractionDigits: 1 }`, `{ style: "percent" }`, …). */
export function formatNumber(context: Context, value: number, options?: Intl.NumberFormatOptions): string {
  return formatLocaleNumber(value, numberLocale(context.store.language, region(context)), options);
}

/** An amount in the page's currency, in the store's buyer format (the format of every `StorefrontMoney.formatted`). */
export function formatMoney(context: Context, amount: number): string {
  return formatStoreMoney(amount, { code: context.store.currency });
}

/**
 * A count with its words, by the page language's plural rules; `#` is the
 * count as the store writes it.
 *
 *   plural(context, count, { en: { one: "# review", other: "# reviews" }, bn: { other: "#টি রিভিউ" } })
 */
export function plural(context: Context, count: number, words: Words<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>): string {
  const forms = t(context, words);
  const locale = numberLocale(context.store.language, region(context));
  const form = forms[pluralCategory(count, locale)] ?? forms.other;
  return form.replaceAll("#", formatLocaleNumber(count, locale));
}

/** An instant in the store's time zone and the page's language (`{ dateStyle: "medium" }`, …). */
export function formatDate(context: Context, value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatDateTime(value, dateLocale(context.store.language, region(context)), { ...options, timeZone: context.store.timeZone });
}

/** The instant (epoch ms) a merchant's wall-clock time names in the store's time zone ("2026-12-31", 18, 0); null when it is not a real time. */
export function storeTime(context: { store: Pick<Context["store"], "timeZone"> }, date: string, hours = 0, minutes = 0): number | null {
  try {
    const seconds = commerceWallTimeToEpoch(context.store.timeZone, date, hours, minutes);
    return seconds === null ? null : seconds * 1000;
  } catch {
    return null; // not a time zone
  }
}
