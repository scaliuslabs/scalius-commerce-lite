// SKU unit costs ("cost per item", staff-only) and the inventory value they
// give. One write for every screen that edits costs (the product editor, the
// inventory list's bulk edit): up to 100 SKUs at once, each with the cost the
// merchant saw, so a cost a receipt or another tab changed meanwhile refuses
// the whole save (409) instead of being overwritten.
import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminInventoryValuation, putApiV1AdminInventoryCosts } from "@scalius/api-client/sdk";
import { toMinor } from "@scalius/shared/money";
import { AdminApiResponseError } from "../admin-api-error";
import { apiData, type ApiBody, type ApiResult } from "../api";

export type InventoryValuation = ApiResult<typeof getApiV1AdminInventoryValuation>;
export type SkuCostItem = ApiBody<typeof putApiV1AdminInventoryCosts>["items"][number];

/** The largest cost the API takes, in major units (core `UNIT_COST_MAX`). */
export const UNIT_COST_MAX = 9_000_000_000;
/** SKUs one cost write may change. */
export const SKU_COST_BATCH_LIMIT = 100;

/** Under `["inventory"]`, so every inventory refresh also refreshes the value. */
export const inventoryValuationKey = ["inventory", "valuation"] as const;

/** On-hand units times each SKU's current cost, per location, plus units in transit. */
export const inventoryValuationQueryOptions = () =>
  queryOptions({
    queryKey: inventoryValuationKey,
    queryFn: () => apiData(getApiV1AdminInventoryValuation()),
    staleTime: 30_000,
  });

/** Saves up to 100 SKU costs atomically (null clears a cost). */
export const saveSkuCosts = (items: SkuCostItem[]) =>
  apiData(putApiV1AdminInventoryCosts({ body: { items } }));

/** A cost changed since it was read (a purchase order receipt, another tab): the save was refused. */
export function isSkuCostConflict(error: unknown): boolean {
  return error instanceof AdminApiResponseError && error.status === 409;
}

/** Two costs are the same (null is "no cost"). */
export function sameCost(a: number | null | undefined, b: number | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Why a typed cost can't be saved, or null when it can (empty clears it).
 * A cost may carry paisa: it is what the merchant paid, not a cash amount.
 */
export function costProblem(cost: number | null): "costInvalid" | "costTooLarge" | null {
  if (cost === null) return null;
  if (!Number.isFinite(cost) || cost < 0) return "costInvalid";
  return cost > UNIT_COST_MAX ? "costTooLarge" : null;
}

export interface CostMargin {
  /** What one sale earns over its cost, in major units (negative when sold below cost). */
  profit: number;
  /** Profit as a share of the price, one decimal; null when the price is 0. */
  margin: number | null;
}

/**
 * Profit and margin of selling at `price` (what the customer pays) with this
 * unit cost, in exact minor units; the margin rounds like the API's
 * `marginPercent`. Null without a cost or a usable price.
 */
export function costMargin(
  price: number | null | undefined,
  cost: number | null | undefined,
  decimalPlaces: number,
): CostMargin | null {
  if (cost === null || cost === undefined || costProblem(cost) !== null) return null;
  if (price === null || price === undefined || !Number.isFinite(price) || price < 0) return null;
  try {
    const priceMinor = toMinor(price, decimalPlaces);
    const profitMinor = priceMinor - toMinor(cost, decimalPlaces);
    return {
      profit: profitMinor / 10 ** decimalPlaces,
      // `|| 0`: a margin that rounds to nothing reads 0%, never -0%.
      margin: priceMinor > 0 ? Math.round((profitMinor * 1000) / priceMinor) / 10 || 0 : null,
    };
  } catch {
    return null;
  }
}
