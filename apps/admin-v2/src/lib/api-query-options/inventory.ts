import { queryOptions } from "@tanstack/react-query";
import {
  getInventory,
  type InventoryQueryInput,
} from "../api-functions/inventory";
import { queryKeys } from "../query-keys";

const FAST_STALE_TIME_MS = 1000 * 30;

export const inventoryQueryOptions = (params: InventoryQueryInput) =>
  queryOptions({
    queryKey: queryKeys.inventory.list(params),
    queryFn: () => getInventory({ data: params }),
    staleTime: FAST_STALE_TIME_MS,
  });
