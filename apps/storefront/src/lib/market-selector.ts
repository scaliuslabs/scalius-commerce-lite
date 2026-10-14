/**
 * The market and language selectors and the geo suggestion
 * (docs/MARKETS-DESIGN.md D4): which countries and languages a buyer can
 * choose, in the page's language, and what the forms and the suggestion say.
 * They appear only while the store has more than one active presence (the
 * country form: more than one market; the language form: two languages in
 * the page's market), so a single-language store's pages stay as they are.
 */
import {
  activePresences,
  backupMarket,
  defaultLocale,
  isStorefrontPagePath,
  marketLanguagePresences,
  marketOfPresence,
  presenceOfPath,
  stripPresencePath,
  type MarketMatrix,
  type PublicMarket,
} from "@scalius/shared/markets";

export interface MarketCountryOption {
  code: string;
  name: string;
  /** The currency its market sells in (MARKETS-DESIGN step 6). */
  currencyCode?: string;
}

/** Whether the store sells at more than one URL: the selector, hreflang and the suggestion appear only then. */
export function hasSeveralPresences(matrix: MarketMatrix | null | undefined): boolean {
  return activePresences(matrix ?? { markets: [] }).length > 1;
}

/**
 * A page's language (`<html lang>`): a subfolder presence's locale
 * (`/en-in`); on root pages the store default once the store sells at more
 * than one URL (hreflang names it), else the page's own document language.
 */
export function presencePageLanguage(matrix: MarketMatrix | null | undefined, presence: string | null, documentLanguage: string): string {
  const markets = matrix ?? { markets: [] };
  const entry = presence ? marketOfPresence(markets, presence) : null;
  return entry?.presence.locale ?? (hasSeveralPresences(markets) ? defaultLocale(markets) : null) ?? documentLanguage;
}

function regionName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language, "en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Every country an active market sells to, by name in the page's language. */
export function marketCountryOptions(matrix: MarketMatrix, language: string, shopCurrencyCode?: string): MarketCountryOption[] {
  const currencyOf = new Map(matrix.markets.flatMap((market) => market.countries.map((code) => [code, market.currencyCode ?? shopCurrencyCode] as const)));
  const codes = new Set(matrix.markets.flatMap((market) => market.countries));
  return [...codes]
    .map((code) => ({ code, name: regionName(code, language), currencyCode: currencyOf.get(code) }))
    .sort((left, right) => left.name.localeCompare(right.name, language));
}

/** The market a page is in: its presence's, else (the root) the backup market. */
export function pageMarket(matrix: MarketMatrix, presence: string | null): PublicMarket | null {
  return presence ? marketOfPresence(matrix, presence)?.market ?? null : backupMarket(matrix);
}

/** The country form appears only when the store sells in more than one market. */
export function hasSeveralMarkets(matrix: MarketMatrix | null | undefined): boolean {
  return (matrix?.markets.length ?? 0) > 1;
}

export interface LanguageOption {
  locale: string;
  /** The language in itself ("বাংলা", "English"), as Shopify's language form names it. */
  name: string;
}

function languageName(locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale, "en"], { type: "language" }).of(locale) ?? locale;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return locale;
  }
}

/** The languages a market's pages are in (the root's first); the form shows them when there are two or more. */
export function languageOptions(market: PublicMarket): LanguageOption[] {
  return marketLanguagePresences(market).map(({ locale }) => ({ locale, name: languageName(locale) }));
}

/** The country the selector shows as chosen: the first of the page's market. */
export function selectedMarketCountry(matrix: MarketMatrix, presence: string | null): string | null {
  const market = presence ? marketOfPresence(matrix, presence)?.market : backupMarket(matrix);
  return market?.countries[0] ?? null;
}

export interface MarketSelectorCopy {
  label: string;
  languageLabel: string;
  submit: string;
  suggestion: string;
  go: string;
  dismiss: string;
}

const COPY: Record<"en" | "bn", MarketSelectorCopy> = {
  en: {
    label: "Country/region",
    languageLabel: "Language",
    submit: "Update",
    suggestion: "Shopping from {country}? See the store for your country.",
    go: "Go",
    dismiss: "Dismiss",
  },
  bn: {
    label: "দেশ/অঞ্চল",
    languageLabel: "ভাষা",
    submit: "হালনাগাদ করুন",
    suggestion: "{country} থেকে কিনছেন? আপনার দেশের দোকান দেখুন।",
    go: "যান",
    dismiss: "বন্ধ করুন",
  },
};

export function marketSelectorCopy(language: string | null | undefined): MarketSelectorCopy {
  return language?.toLowerCase().startsWith("bn") ? COPY.bn : COPY.en;
}

/** A same-origin page path (its presence removed), else the home page. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://store.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://store.local" || !value.startsWith("/") || value.startsWith("//")) return "/";
  const pathname = stripPresencePath(url.pathname, presenceOfPath(url.pathname));
  return isStorefrontPagePath(pathname) ? `${pathname}${url.search}` : "/";
}
