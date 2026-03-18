// src/lib/currency.ts
// Re-exports currency utilities from @scalius/shared.
export {
  getCurrencySymbol,
  getCurrencyCode,
  getDecimalPlaces,
  formatPrice,
  formatPriceShort,
  type CurrencyConfig,
  DEFAULT_CURRENCY,
} from "@scalius/shared/currency";
