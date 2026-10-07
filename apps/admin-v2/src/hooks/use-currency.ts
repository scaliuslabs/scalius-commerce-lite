import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { currencySettingsQueryOptions } from "~/lib/api-query-options/currency";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { discountedPriceMinor, fromMinor, percentToBps, toMinor } from "@scalius/shared/money";
import { formatNumber, useLocale } from "~/i18n";

const DEFAULT_SYMBOL = "৳";
const DEFAULT_CODE = "BDT";

/** Store currency, its price increment, and a money formatter for the dashboard language. */
export function useCurrency() {
  const { data } = useQuery(currencySettingsQueryOptions());
  const locale = useLocale();
  const settings = data as Record<string, unknown> | undefined;

  const symbol = settings?.currencySymbol as string ?? DEFAULT_SYMBOL;
  const code = settings?.currencyCode as string ?? DEFAULT_CODE;
  // The backup market's price increment (Settings → Markets): whole units or minor units.
  const priceIncrementMinor = resolvePriceIncrementMinor(code, settings?.priceIncrementMinor);

  const fmt = useCallback(
    (price: number | string) => {
      const value = Number(price);
      const amount = Number.isFinite(value) ? value : 0;
      const digits = getDecimalPlaces(code);
      const formatted = formatNumber(Math.abs(amount), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      return `${amount < 0 ? "-" : ""}${symbol}${formatted}`;
    },
    // `locale` changes the output of formatNumber.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbol, code, locale],
  );

  /** What customers pay after a catalog discount, or null when nothing is off. */
  const salePrice = useCallback(
    (price: number, discount: { discountType?: string | null; discountPercentage?: number | null; discountAmount?: number | null }) => {
      const digits = getDecimalPlaces(code);
      try {
        const priceMinor = toMinor(price, digits);
        const sale = discountedPriceMinor(
          priceMinor,
          discount.discountType ?? "percentage",
          percentToBps(discount.discountPercentage ?? 0),
          toMinor(discount.discountAmount ?? 0, digits),
          priceIncrementMinor,
        );
        return sale < priceMinor ? fromMinor(sale, digits) : null;
      } catch {
        // A draft number outside the money range (being typed) has no sale price yet.
        return null;
      }
    },
    [code, priceIncrementMinor],
  );

  return { symbol, code, priceIncrementMinor, fmt, formatPrice: fmt, salePrice };
}
