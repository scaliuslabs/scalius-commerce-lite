import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminInventory,
  type postApiV1AdminInventoryByVariantIdAdjust,
  type postApiV1AdminInventoryLabelsPreview,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const FAST_STALE_TIME_MS = 1000 * 30;

type InventoryQuery = ApiQuery<typeof getApiV1AdminInventory>;
export type InventoryOverview = ApiResult<typeof getApiV1AdminInventory>;
export type InventoryVariant = NonNullable<InventoryOverview["variants"]>[number];
export type InventoryMovement = NonNullable<InventoryOverview["movements"]>[number];
export type InventoryAlert = NonNullable<InventoryOverview["alerts"]>[number];
export type InventoryAdjustmentReason =
  ApiBody<typeof postApiV1AdminInventoryByVariantIdAdjust>["reason"];
export type InventoryLabelVariant =
  ApiResult<typeof postApiV1AdminInventoryLabelsPreview>["variants"][number];

export const fetchInventory = (query: InventoryQuery) =>
  apiData(getApiV1AdminInventory({ query }));

export const inventoryQueryOptions = (query: InventoryQuery) =>
  queryOptions({
    queryKey: queryKeys.inventory.list(query),
    queryFn: () => fetchInventory(query),
    staleTime: FAST_STALE_TIME_MS,
  });
