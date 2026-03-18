// packages/shared/src/currency.ts
// Pure currency type and formatting utilities.
// getCurrencyConfig lives in @scalius/core (settings service) because it requires DB access.

declare global {
  interface Window {
    __CURRENCY_SYMBOL__?: string;
    __CURRENCY_CODE__?: string;
  }
}

export interface CurrencyConfig {
  code: string;
  symbol: string;
  usdExchangeRate: number;
}

export const DEFAULT_CURRENCY: CurrencyConfig = {
  code: "BDT",
  symbol: "\u09F3",
  usdExchangeRate: 1,
};

// ---------------------------------------------------------------------------
// Client-side formatting utilities
// ---------------------------------------------------------------------------
// These read from window globals that are injected by the storefront's
// Layout.astro (window.__CURRENCY_SYMBOL__ / window.__CURRENCY_CODE__).
// They are safe to import on the server — the window checks simply fall
// through to the default values.

/** Get the currency symbol from the global window variable (set by Layout.astro) */
export function getCurrencySymbol(): string {
  if (typeof window !== "undefined" && window.__CURRENCY_SYMBOL__) {
    return window.__CURRENCY_SYMBOL__;
  }
  return DEFAULT_CURRENCY.symbol;
}

/** Get the currency code from the global window variable */
export function getCurrencyCode(): string {
  if (typeof window !== "undefined" && window.__CURRENCY_CODE__) {
    return window.__CURRENCY_CODE__;
  }
  return DEFAULT_CURRENCY.code;
}

/** Format a price with the configured currency symbol */
export function formatPrice(price: number): string {
  const symbol = getCurrencySymbol();
  return `${symbol}${price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a price with no decimals */
export function formatPriceShort(price: number): string {
  const symbol = getCurrencySymbol();
  return `${symbol}${price.toLocaleString()}`;
}
