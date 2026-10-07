/**
 * The market selector and the geo suggestion (docs/MARKETS-DESIGN.md D4):
 * which countries a buyer can choose, in the page's language, and what the
 * selector form and the suggestion say. Both appear only while the store
 * has more than one active presence, so today's pages stay as they are.
 */
import {
  activePresences,
  backupMarket,
  isStorefrontPagePath,
  marketOfPresence,
  presenceOfPath,
  stripPresencePath,
  type MarketMatrix,
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

/** The country the selector shows as chosen: the first of the page's market. */
export function selectedMarketCountry(matrix: MarketMatrix, presence: string | null): string | null {
  const market = presence ? marketOfPresence(matrix, presence)?.market : backupMarket(matrix);
  return market?.countries[0] ?? null;
}

export interface MarketSelectorCopy {
  label: string;
  submit: string;
  suggestion: string;
  go: string;
  dismiss: string;
}

const COPY: Record<"en" | "bn", MarketSelectorCopy> = {
  en: {
    label: "Country/region",
    submit: "Update",
    suggestion: "Shopping from {country}? See the store for your country.",
    go: "Go",
    dismiss: "Dismiss",
  },
  bn: {
    label: "দেশ/অঞ্চল",
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
