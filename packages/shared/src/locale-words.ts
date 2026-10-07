// Words around numbers through the formatting layer (./locale-format): lists,
// plural categories, relative times and measures in CLDR units. Pure,
// browser-safe.
import { cachedFormatter, formatNumber } from "./locale-format";

/** "41 minutes ago", "in 3 days" (`numeric: "auto"` gives "yesterday"). */
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: string,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return cachedFormatter("relative", locale, options, (tag) => new Intl.RelativeTimeFormat(tag, options)).format(value, unit);
}

/** "bKash, Nagad and card" (`conjunction`) or "USD or EUR" (`disjunction`). */
export function formatList(items: readonly string[], locale: string, type: Intl.ListFormatType = "conjunction"): string {
  return cachedFormatter("list", locale, { type }, (tag) => new Intl.ListFormat(tag, { type })).format(items);
}

/** The CLDR plural category of a count: "one", "other", … */
export function pluralCategory(count: number, locale: string, options?: Intl.PluralRulesOptions): Intl.LDMLPluralRule {
  return cachedFormatter("plural", locale, options, (tag) => new Intl.PluralRules(tag, options)).select(count);
}

/** A measure in a CLDR unit: "2.5 kg", "12 oz", "5 lb" (`unitDisplay: "long"` spells it out). */
export function formatUnit(
  value: number,
  unit: string,
  locale: string,
  options: Omit<Intl.NumberFormatOptions, "style" | "unit"> = {},
): string {
  return formatNumber(value, locale, { maximumFractionDigits: 2, ...options, style: "unit", unit });
}
