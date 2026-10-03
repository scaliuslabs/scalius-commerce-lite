// packages/shared/src/currency.ts
// Pure currency type and formatting utilities.
// getCurrencyConfig lives in @scalius/core (settings service) because it requires DB access.
// Uses currency.js for precision arithmetic; per-currency facts come from ./currency-policy.

import Currency from "currency.js";
import {
  currencyExponent,
  defaultPriceIncrementMinor,
  resolvePriceIncrementMinor,
  SUPPORTED_CURRENCY_CODES,
  type SupportedCurrencyCode,
} from "./currency-policy";

// Declare window for environments without DOM types (e.g. Cloudflare Workers).
// Uses a plain object type so it compiles without the DOM lib.
// The typeof check at runtime ensures this is only accessed in browsers.
declare const window: {
  __CURRENCY_SYMBOL__?: string;
  __CURRENCY_CODE__?: string;
  __CURRENCY_DECIMAL_PLACES__?: number;
  __CURRENCY_PRICE_INCREMENT__?: number;
} | undefined;

export interface CurrencyConfig {
  code: string;
  symbol: string;
  decimalPlaces: number;
}

export const DEFAULT_CURRENCY: CurrencyConfig = {
  code: "BDT",
  symbol: "৳",
  decimalPlaces: 2,
};

/**
 * Currency codes exposed by the dashboard currency picker: the single runtime
 * allowlist for settings writes and buyer-facing reads. The list and every
 * per-currency fact live in ./currency-policy.
 */
export { SUPPORTED_CURRENCY_CODES, type SupportedCurrencyCode } from "./currency-policy";

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

/**
 * The ISO 4217 exponent of a currency (./currency-policy). An unknown code
 * has two; the excluded four-decimal units (CLF, UYW) have four, which
 * `toMinor` refuses.
 */
export function getDecimalPlaces(currencyCode: string): number {
  return currencyExponent(currencyCode);
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
 * The page store's price increment for `code` (set by Layout.astro from the
 * layout currency): percentage prices round to it exactly as checkout
 * charges. Another currency, or a page without the global (server render),
 * gets that currency's default; server renders pass the layout value
 * explicitly.
 */
export function getPriceIncrementMinor(code: string = getCurrencyCode()): number {
  const normalized = code.trim().toUpperCase();
  if (normalized !== getCurrencyCode().trim().toUpperCase()) return defaultPriceIncrementMinor(normalized);
  const pageIncrement = typeof window !== "undefined" ? window.__CURRENCY_PRICE_INCREMENT__ : undefined;
  return resolvePriceIncrementMinor(normalized, pageIncrement);
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
 * The one buyer-facing money format: the currency symbol right before the
 * amount (never a space, so it never wraps), lakh/crore grouping for BDT
 * (৳2,30,690), no decimals for whole amounts and the currency's full
 * precision otherwise (৳1,822.50). Negative amounts read "-৳150".
 */
export function formatMoney(
  amount: number | string,
  opts?: { symbol?: string; code?: string },
): string {
  const code = (opts?.code ?? getCurrencyCode()).toUpperCase();
  const precision = getDecimalPlaces(code);
  const value = Currency(amount, { precision });
  const whole = value.intValue % 10 ** precision === 0;
  const digits = whole ? 0 : precision;
  const grouped = new Intl.NumberFormat(code === "BDT" ? "en-IN" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(value.value));
  return `${value.value < 0 ? "-" : ""}${opts?.symbol ?? currencySymbolFor(code)}${grouped}`;
}

/** The page's symbol for its own currency, else the narrow symbol Intl knows. */
function currencySymbolFor(code: string): string {
  if (code === getCurrencyCode() && typeof window !== "undefined" && window.__CURRENCY_SYMBOL__) {
    return window.__CURRENCY_SYMBOL__;
  }
  if (code === DEFAULT_CURRENCY.code) return DEFAULT_CURRENCY.symbol;
  try {
    const symbol = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0).find((part) => part.type === "currency")?.value;
    return symbol && symbol !== code ? symbol : `${code} `;
  } catch {
    return `${code} `;
  }
}
