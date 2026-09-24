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
 * `bn` must define every `en` key (checked by the type). Numbers, money and
 * dates are formatted with `Intl` for the active locale.
 */
import { useCallback, useSyncExternalStore } from "react";

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

function applyDocumentLocale(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
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

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
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
  // Stable per catalog and language, so memoised columns and callbacks that
  // use it survive re-renders.
  return useCallback(
    (key: K, vars?: Vars) => interpolate(catalog[locale][key] ?? catalog.en[key], vars),
    [catalog, locale],
  );
}

// Bangladesh groups digits in lakhs (12,34,567) in both languages; "en-IN"
// is the English locale that does so.
function numberLocale(): string {
  return current === "bn" ? "bn-BD" : "en-IN";
}

function dateLocale(): string {
  return current === "bn" ? "bn-BD" : "en-BD";
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(numberLocale(), options).format(value);
}

export function formatDateTime(date: Date, options?: Intl.DateTimeFormatOptions): string {
  // Bangla has no localised AM/PM in Intl ("৫:৫২ AM"), so bn shows the 24-hour clock.
  const clock: Intl.DateTimeFormatOptions = current === "bn" ? { hourCycle: "h23" } : {};
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: "Asia/Dhaka", ...clock, ...options }).format(date);
}
