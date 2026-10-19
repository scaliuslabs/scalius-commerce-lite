// src/lib/currency.ts
// Currency utilities from @scalius/shared, with money written in the page's
// digits: a Bangla page shows ৳১,৭৫০, an English one ৳1,750. Storefront code
// formats money through these, never the shared formatters directly.
import {
  formatMoney as formatMoneyIn,
  formatPrice as formatPriceIn,
} from "@scalius/shared/currency";
import { pageLanguage } from "./store-time-zone";

export {
  getCurrencySymbol,
  getCurrencyCode,
  getDecimalPlaces,
  getPriceIncrementMinor,
  type CurrencyConfig,
  DEFAULT_CURRENCY,
} from "@scalius/shared/currency";

type MoneyOptions = NonNullable<Parameters<typeof formatMoneyIn>[1]>;
type PriceOptions = NonNullable<Parameters<typeof formatPriceIn>[1]>;

/** The buyer-facing money format (`@scalius/shared/currency`), in the page's digits. */
export function formatMoney(amount: number | string, opts?: MoneyOptions): string {
  return formatMoneyIn(amount, { ...opts, language: opts?.language ?? pageLanguage() });
}

/** A price with every decimal place, in the page's digits. */
export function formatPrice(price: number | string, opts?: PriceOptions): string {
  return formatPriceIn(price, { ...opts, language: opts?.language ?? pageLanguage() });
}
