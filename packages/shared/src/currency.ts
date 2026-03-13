// packages/shared/src/currency.ts
// Pure currency type and formatting utilities.
// getCurrencyConfig lives in @scalius/core (settings service) because it requires DB access.

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
