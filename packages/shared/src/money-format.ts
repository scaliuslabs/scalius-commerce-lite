// Money amounts through the formatting layer (./locale-format): a currency's
// symbol, the locale its amounts are grouped in, and the digits of an amount.
// The symbol-first money formats are ./currency (buyers, emails) and the
// dashboard's `useCurrency().fmt`. Pure, browser-safe.
import { baseLanguage, formatNumber, numberFormatter, numberLocale } from "./locale-format";

/** A currency's narrow symbol (`$`, `€`, `৳`), else its code. */
export function currencySymbol(code: string): string {
  try {
    const symbol = numberFormatter("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value;
    return symbol || code;
  } catch {
    return code;
  }
}

/** Currencies grouped in lakhs and crores (12,34,567): Bangladesh's and India's. */
const LAKH_CURRENCIES = new Set(["BDT", "INR"]);

/**
 * The locale a money amount is written in where the store's country is not at
 * hand (buyer prices, emails, invoices, labels): the language, grouped as the
 * currency's country groups it, as Shopify's per-currency money formats do.
 * Bangla is `bn-BD` (Bangla digits); other languages keep their own digits.
 */
export function moneyLocale(currencyCode: string, language = "en"): string {
  const lang = baseLanguage(language);
  if (lang === "bn") return numberLocale("bn");
  if (lang === "en" && LAKH_CURRENCIES.has(currencyCode.trim().toUpperCase())) return "en-IN";
  return lang;
}

/** Digits of a money amount: `digits` decimals (none for a whole amount when `trimWhole`). */
export function formatAmount(amount: number, locale: string, digits: number, trimWhole = false): string {
  const shown = trimWhole && Number.isInteger(Math.round(amount * 10 ** digits) / 10 ** digits) ? 0 : digits;
  return formatNumber(amount, locale, { minimumFractionDigits: shown, maximumFractionDigits: shown });
}
