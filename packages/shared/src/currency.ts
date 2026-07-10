// packages/shared/src/currency.ts
// Pure currency type and formatting utilities.
// getCurrencyConfig lives in @scalius/core (settings service) because it requires DB access.
// Uses currency.js for precision arithmetic and ISO 4217 decimal places.

import Currency from "currency.js";

// Declare window for environments without DOM types (e.g. Cloudflare Workers).
// Uses a plain object type so it compiles without the DOM lib.
// The typeof check at runtime ensures this is only accessed in browsers.
declare const window: { __CURRENCY_SYMBOL__?: string; __CURRENCY_CODE__?: string; __CURRENCY_DECIMAL_PLACES__?: number } | undefined;

export interface CurrencyConfig {
  code: string;
  symbol: string;
  usdExchangeRate: number;
  decimalPlaces: number;
}

export const DEFAULT_CURRENCY: CurrencyConfig = {
  code: "BDT",
  symbol: "৳",
  usdExchangeRate: 1,
  decimalPlaces: 2,
};

/**
 * Currency codes exposed by the dashboard currency picker. Keep this as the
 * single runtime allowlist for settings writes and buyer-facing reads.
 */
export const SUPPORTED_CURRENCY_CODES = [
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "SGD", "SEK",
  "NOK", "DKK", "MXN", "BRL", "BDT", "INR", "PKR", "LKR", "NPR", "AFN", "BTN", "MVR",
  "MYR", "PHP", "THB", "IDR", "VND", "MMK", "KHR", "LAK", "BND", "KRW", "TWD", "MNT",
  "KPW", "MOP", "AED", "SAR", "QAR", "KWD", "BHD", "OMR", "JOD", "IQD", "IRR", "YER",
  "LBP", "SYP", "ILS", "KZT", "UZS", "KGS", "TJS", "TMT", "GEL", "AMD", "AZN", "TRY",
  "RUB", "UAH", "PLN", "CZK", "HUF", "RON", "BGN", "HRK", "RSD", "BAM", "MKD", "ALL",
  "MDL", "BYN", "ISK", "ARS", "CLP", "COP", "PEN", "UYU", "PYG", "BOB", "VES", "GYD",
  "SRD", "TTD", "JMD", "BBD", "BSD", "BZD", "CRC", "CUP", "DOP", "GTQ", "HNL", "HTG",
  "NIO", "PAB", "AWG", "ANG", "KYD", "BMD", "XCD", "FKP", "NGN", "GHS", "XOF", "GMD",
  "GNF", "SLL", "LRD", "CVE", "MRU", "KES", "TZS", "UGX", "RWF", "BIF", "ETB", "SOS",
  "ERN", "DJF", "SDG", "SSP", "SCR", "KMF", "MGA", "MUR", "XAF", "CDF", "ZAR", "BWP",
  "LSL", "SZL", "NAD", "MWK", "ZMW", "MZN", "AOA", "ZWL", "EGP", "DZD", "MAD", "TND",
  "LYD", "STN", "FJD", "PGK", "WST", "TOP", "VUV", "SBD", "XPF", "XDR", "XAG", "XAU",
] as const;

export type SupportedCurrencyCode = (typeof SUPPORTED_CURRENCY_CODES)[number];

const SUPPORTED_CURRENCY_CODE_SET = new Set<string>(SUPPORTED_CURRENCY_CODES);

export function normalizeSupportedCurrencyCode(
  value: unknown,
): SupportedCurrencyCode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return SUPPORTED_CURRENCY_CODE_SET.has(normalized)
    ? normalized as SupportedCurrencyCode
    : null;
}

// ---------------------------------------------------------------------------
// ISO 4217 decimal places lookup
// ---------------------------------------------------------------------------
// Most currencies use 2 decimal places. Only exceptions are listed here.

const CURRENCY_DECIMALS: Record<string, number> = {
  // 0 decimal places
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimal places
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** Get the ISO 4217 decimal places for a currency code. Defaults to 2. */
export function getDecimalPlaces(currencyCode: string): number {
  return CURRENCY_DECIMALS[currencyCode.toUpperCase()] ?? 2;
}

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

/**
 * Format a price with the correct symbol and decimal places.
 * Uses currency.js for precision.
 */
export function formatPrice(
  price: number | string,
  opts?: { symbol?: string; code?: string; precision?: number },
): string {
  const symbol = opts?.symbol ?? getCurrencySymbol();
  const code = opts?.code ?? getCurrencyCode();
  const precision = opts?.precision ?? getDecimalPlaces(code);

  return Currency(price, { symbol, precision, separator: ",", decimal: "." }).format();
}

/**
 * Short format — no trailing zeros for whole numbers.
 */
export function formatPriceShort(
  price: number | string,
  opts?: { symbol?: string; code?: string },
): string {
  const symbol = opts?.symbol ?? getCurrencySymbol();
  const code = opts?.code ?? getCurrencyCode();
  const precision = getDecimalPlaces(code);

  const val = Currency(price, { precision });
  // If it's a whole number, show without decimals
  if (val.cents() % Math.pow(10, precision) === 0) {
    return Currency(price, { symbol, precision: 0, separator: "," }).format();
  }
  return Currency(price, { symbol, precision, separator: ",", decimal: "." }).format();
}
