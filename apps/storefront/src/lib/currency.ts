// src/lib/currency.ts
// Re-exports currency utilities from @scalius/shared.
export {
  getCurrencySymbol,
  getCurrencyCode,
  getDecimalPlaces,
  formatPrice,
  formatPriceShort,
  // F1 lands the real shared `formatMoney`; this alias only keeps F3 compiling.
  formatPriceShort as formatMoney,
  type CurrencyConfig,
  DEFAULT_CURRENCY,
} from "@scalius/shared/currency";
