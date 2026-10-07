import { useCallback } from "react";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { currencySymbol } from "@scalius/shared/money-format";
import { formatNumber, useLocale } from "~/i18n";
import { useCurrency } from "./use-currency";

/**
 * `fmt` for an amount of a given currency (an order in a market's own
 * currency, MARKETS-DESIGN step 6): the store's format for its own
 * currency, else that currency's symbol and places. Only order screens
 * load it, so other pages keep their first download.
 */
export function useOrderCurrency() {
  const { fmt, code } = useCurrency();
  const locale = useLocale();
  const fmtIn = useCallback(
    (price: number | string, currencyCode: string | null | undefined) => {
      const other = currencyCode?.trim().toUpperCase();
      if (!other || other === code) return fmt(price);
      const value = Number(price);
      const amount = Number.isFinite(value) ? value : 0;
      const digits = getDecimalPlaces(other);
      const formatted = formatNumber(Math.abs(amount), { minimumFractionDigits: digits, maximumFractionDigits: digits });
      return `${amount < 0 ? "-" : ""}${currencySymbol(other)}${formatted}`;
    },
    // `locale` changes the output of formatNumber.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fmt, code, locale],
  );
  return { fmt, fmtIn };
}
