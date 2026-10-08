/**
 * Dashboard copy catalogs (English + Bangla).
 *
 * Each feature owns one catalog module next to its screens:
 *
 *   // src/i18n/orders.ts
 *   export const ordersMessages = defineMessages({
 *     en: { saved: "Order saved", itemCount: "{count} items" },
 *     bn: { saved: "অর্ডার সেভ হয়েছে", itemCount: "{count}টি পণ্য" },
 *   });
 *
 *   const t = useMessages(ordersMessages);
 *   t("itemCount", { count: 3 });
 *
 * `bn` must define every `en` key (checked by the type). Numbers, money,
 * dates and lists go through `@scalius/shared/locale-format` (and
 * `locale-words`) for the dashboard language in the store's country
 * (`formatNumber`, `formatDateTime`, `dashboardNumberLocale`).
 */
import { useCallback, useSyncExternalStore } from "react";
import { pluralCategory } from "@scalius/shared/locale-words";
import {
  dateLocale,
  formatDateTime as formatDateTimeIn,
  formatNumber as formatNumberIn,
  numberLocale,
  textDirection,
} from "@scalius/shared/locale-format";
import { getStoreRegion, getStoreTimeZone, useStoreDefaultsVersion } from "~/lib/store-time-zone";

export type Locale = "en" | "bn";

export const LOCALES: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "en", label: "English" },
  { value: "bn", label: "বাংলা" },
];

const STORAGE_KEY = "scalius.dashboard.locale";
const listeners = new Set<() => void>();

function readStoredLocale(): Locale {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "bn" ? "bn" : "en";
  } catch {
    return "en";
  }
}

let current: Locale = readStoredLocale();

/** `lang` and `dir` on `<html>`: the dashboard's language and its direction. */
export function applyDocumentLocale(locale: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = textDirection(locale);
}

applyDocumentLocale(current);

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // Private mode: the choice lasts for this tab only.
  }
  applyDocumentLocale(locale);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);
}

type Vars = Record<string, string | number>;

export interface MessageCatalog<K extends string> {
  en: Record<K, string>;
  bn: Record<K, string>;
}

export function defineMessages<K extends string>(catalog: MessageCatalog<K>): MessageCatalog<K> {
  return catalog;
}

/**
 * The one count syntax in every catalog: `{count, plural, one {# variant} other {# variants}}`.
 * The choice is the language's CLDR plural category of the number
 * (`Intl.PluralRules`), `=0 {…}` matches that exact number, `#` is the
 * number, and a choice may hold `{name}` variables. Bangla needs no choices
 * ("{count}টি ভ্যারিয়েন্ট").
 *
 * Pass the number itself, never `formatNumber(n)`: `t()` writes it in the
 * store's format, and a pre-formatted string ("1,200") has no plural category.
 * A string that is not a plain number still reads, in the `other` choice.
 */
const PLURAL = /\{(\w+), plural, ((?:=?\w+ \{(?:[^{}]|\{\w+\})*\} ?)+)\}/g;
const CHOICE = /(=?\w+) \{((?:[^{}]|\{\w+\})*)\}/g;

function expandPlurals(template: string, vars: Vars): string {
  return template.replace(PLURAL, (match, name: string, body: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    const count = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
    const choices = new Map(Array.from(body.matchAll(CHOICE), (choice) => [choice[1], choice[2]]));
    const chosen =
      (count === null ? undefined : choices.get(`=${count}`) ?? choices.get(pluralCategory(count, current))) ??
      choices.get("other") ??
      "";
    return chosen.replaceAll("#", `{${name}}`);
  });
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  const expanded = template.includes(", plural,") ? expandPlurals(template, vars) : template;
  return expanded.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? formatNumberForLocale(vars[name]!) : match,
  );
}

function formatNumberForLocale(value: string | number): string {
  return typeof value === "number" ? formatNumber(value) : value;
}

export function translate<K extends string>(catalog: MessageCatalog<K>, key: K, vars?: Vars): string {
  return interpolate(catalog[current][key] ?? catalog.en[key], vars);
}

/** Returns `t(key, vars)` for one catalog; re-renders when the locale changes. */
export function useMessages<K extends string>(catalog: MessageCatalog<K>): (key: K, vars?: Vars) => string {
  const locale = useLocale();
  // Dates in copy are store time and numbers the store country's: a screen
  // re-renders once they are known (`formatDateTime` reads them), like a
  // language change.
  const storeDefaults = useStoreDefaultsVersion();
  // Stable per catalog, language, zone and country, so memoised columns and
  // callbacks that use it survive re-renders.
  return useCallback(
    (key: K, vars?: Vars) => interpolate(catalog[locale][key] ?? catalog.en[key], vars),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, locale, storeDefaults],
  );
}

/** The locale the dashboard writes numbers in: its language in the store's country (lakhs in Bangladesh). */
export function dashboardNumberLocale(): string {
  return numberLocale(current, getStoreRegion());
}

/** The locale the dashboard writes dates in. */
export function dashboardDateLocale(): string {
  return dateLocale(current, getStoreRegion());
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(value, dashboardNumberLocale(), options);
}

/**
 * An instant in store time. Bangla has no localised AM/PM in Intl ("৫:৫২ AM"),
 * so the Bangla dashboard shows the 24-hour clock.
 */
export function formatDateTime(date: Date, options?: Intl.DateTimeFormatOptions): string {
  return formatDateTimeIn(date, dashboardDateLocale(), { timeZone: getStoreTimeZone(), ...(current === "bn" && { hourCycle: "h23" }), ...options });
}
