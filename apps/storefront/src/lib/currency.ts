// src/lib/currency.ts
// Re-exports currency utilities from @scalius/shared.
export {
  getCurrencySymbol,
  getCurrencyCode,
  getDecimalPlaces,
  formatPrice,
  formatMoney,
  type CurrencyConfig,
  DEFAULT_CURRENCY,
} from "@scalius/shared/currency";
