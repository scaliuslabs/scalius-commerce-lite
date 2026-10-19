// The store's time zone and country for buyer-facing numbers and dates
// (orders, reviews, blog posts, messages, catalog counts): server renders read
// them from the request's layout payload; browser code reads the
// `data-store-time-zone` and `data-store-region` attributes Layout.astro puts
// on <html>. Neither is the buyer's device zone or the Worker's (UTC).
// Formatting itself is `@scalius/shared/locale-format` (Intl, CLDR).
import { DEFAULT_STORE_TIME_ZONE, isValidTimeZone } from "@scalius/shared/commerce-time";
import {
  DEFAULT_STORE_REGION,
  dateLocale,
  formatDateTime,
  formatNumber,
  numberLocale,
} from "@scalius/shared/locale-format";
import { getRuntimeStoreLanguage, getRuntimeStoreRegion, getRuntimeStoreTimeZone } from "./api/runtime";

export function storeTimeZone(): string {
  const server = getRuntimeStoreTimeZone();
  if (server) return server;
  if (typeof document !== "undefined") {
    const attribute = document.documentElement.dataset.storeTimeZone;
    if (isValidTimeZone(attribute)) return attribute;
  }
  return DEFAULT_STORE_TIME_ZONE;
}

/** The page's country (ISO 3166-1 alpha-2): the presence's, else the store's; Bangladesh by default. */
export function storeRegion(): string {
  const server = getRuntimeStoreRegion();
  if (server) return server;
  if (typeof document !== "undefined") {
    const attribute = document.documentElement.dataset.storeRegion;
    if (attribute && /^[A-Z]{2}$/.test(attribute)) return attribute;
  }
  return DEFAULT_STORE_REGION;
}

/**
 * The language the page is written in: the store's words (server renders read
 * the request's layout payload; browser code the `lang` Layout.astro puts on
 * <html>). Its digits are the page's digits: Bangla on a Bangla page.
 */
export function pageLanguage(): string {
  const server = getRuntimeStoreLanguage();
  if (server) return server;
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  return "en";
}

/**
 * A count as buyers read it: in the page's digits (Bangla on a Bangla page),
 * grouped as the store's country groups them ("12,34,567" in Bangladesh,
 * "1,234,567" in the US).
 */
export function formatCount(value: number): string {
  return formatNumber(value, numberLocale(pageLanguage(), storeRegion()));
}

/**
 * A number in the page's own words: Bangla digits on a Bangla page in
 * Bangladesh ("২ / ৫"), Latin elsewhere, grouped as the store's country does.
 */
export function formatPageNumber(value: number, language: string): string {
  return formatNumber(value, numberLocale(language || "en", storeRegion()));
}

/** A buyer-facing instant in store time, in the page's language ("Oct 7, 2026, 3:42 PM"; Bangla on the 24-hour clock). */
export function formatStoreDateTime(
  value: Date | number,
  language: string,
  options: Intl.DateTimeFormatOptions,
  timeZone: string = storeTimeZone(),
): string {
  return formatDateTime(value, dateLocale(language, storeRegion()), { ...options, timeZone });
}
