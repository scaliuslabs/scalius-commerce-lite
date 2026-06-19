import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { currencySettingsQueryOptions } from "~/lib/api-query-options/currency";
import { formatPrice } from "@scalius/shared/currency";

const DEFAULT_SYMBOL = "\u09F3";
const DEFAULT_CODE = "BDT";

/**
 * Thin wrapper around TanStack Query for currency settings.
 * Replaces the previous hand-rolled singleton + listener + localStorage cache.
 * TanStack Query handles deduplication, caching, and background refresh.
 */
export function useCurrency() {
  const { data } = useQuery(currencySettingsQueryOptions());

  const symbol =
    (data as Record<string, unknown> | undefined)?.currencySymbol as string ??
    DEFAULT_SYMBOL;
  const code =
    (data as Record<string, unknown> | undefined)?.currencyCode as string ??
    DEFAULT_CODE;

  const fmt = useCallback(
    (price: number | string) => formatPrice(price, { symbol, code }),
    [symbol, code],
  );

  return { symbol, code, fmt, formatPrice: fmt };
}
