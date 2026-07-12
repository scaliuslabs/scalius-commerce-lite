export const DEFAULT_MIN_PRICE = 0;
export const DEFAULT_MAX_PRICE = 50000;

export function parsePriceFilterValue(
  value: string | undefined,
  fallback: number,
): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function appendPriceFilterParams(
  params: URLSearchParams,
  options: {
    includePriceFilter: boolean;
    priceChanged: boolean;
    minPriceInput: string;
    maxPriceInput: string;
    defaultMaxPrice?: number;
  },
): void {
  if (!options.includePriceFilter || !options.priceChanged) return;

  const minValue = parsePriceFilterValue(
    options.minPriceInput,
    DEFAULT_MIN_PRICE,
  );
  const maxValue = parsePriceFilterValue(
    options.maxPriceInput,
    options.defaultMaxPrice ?? DEFAULT_MAX_PRICE,
  );

  if (minValue > DEFAULT_MIN_PRICE) {
    params.set("minPrice", minValue.toString());
  }

  if (maxValue !== (options.defaultMaxPrice ?? DEFAULT_MAX_PRICE)) {
    params.set("maxPrice", maxValue.toString());
  }
}
