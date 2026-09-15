import type { TaxClassificationKind } from "@/lib/api-functions/taxes";

export interface TaxClassificationRouteState {
  kind: TaxClassificationKind;
  search: string;
  page: number;
}

export const DEFAULT_TAX_CLASSIFICATION_ROUTE_STATE: TaxClassificationRouteState = {
  kind: "product",
  search: "",
  page: 1,
};

function normalizePage(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function normalizeTaxClassificationRouteState(
  search: Record<string, unknown>,
): TaxClassificationRouteState {
  return {
    kind: search.kind === "variant" ? "variant" : "product",
    search: typeof search.query === "string"
      ? search.query.trim().slice(0, 180)
      : "",
    page: normalizePage(search.page),
  };
}
