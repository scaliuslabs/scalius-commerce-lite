export const DEFAULT_MIN_PRICE = 0;
export const DEFAULT_MAX_PRICE = 50000;

export function parsePriceFilterValue(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function appendPriceFilterParams(
  params: URLSearchParams,
  options: {
    includePriceFilter: boolean;
    priceChanged: boolean;
    minPriceInput: string;
    maxPriceInput: string;
  },
): void {
  if (!options.includePriceFilter || !options.priceChanged) return;

  const minValue = parsePriceFilterValue(
    options.minPriceInput,
    DEFAULT_MIN_PRICE,
  );
  const maxValue = parsePriceFilterValue(
    options.maxPriceInput,
    DEFAULT_MAX_PRICE,
  );

  if (minValue > DEFAULT_MIN_PRICE) {
    params.set("minPrice", minValue.toString());
  }

  if (maxValue !== DEFAULT_MAX_PRICE || minValue > DEFAULT_MIN_PRICE) {
    params.set("maxPrice", maxValue.toString());
  }
}
