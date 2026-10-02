// Inventory locations (commerce hook H1): where stock is held. One list
// query feeds Settings › Locations, the stock-change dialog, the inventory
// location filter and the order page; every write refreshes it and the
// inventory lists whose per-location numbers it changes. An order's own
// location is set through `useSetOrderFulfillmentLocation` (api-mutations/orders).
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getApiV1AdminInventoryByVariantIdLevels,
  getApiV1AdminInventoryLevels,
  getApiV1AdminInventoryLocations,
  patchApiV1AdminInventoryLocationsByLocationId,
  postApiV1AdminInventoryLocations,
  postApiV1AdminInventoryLocationsByLocationIdArchive,
  postApiV1AdminInventoryLocationsByLocationIdDefault,
  postApiV1AdminInventoryLocationsByLocationIdUnarchive,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

export type InventoryLocation = ApiResult<typeof getApiV1AdminInventoryLocations>["locations"][number];
export type InventoryLocationBody = ApiBody<typeof postApiV1AdminInventoryLocations>;
export type VariantInventoryLevels = ApiResult<typeof getApiV1AdminInventoryByVariantIdLevels>;
export type ProductInventoryLevels = ApiResult<typeof getApiV1AdminInventoryLevels>;

export const inventoryLocationKeys = {
  all: ["inventory-locations"] as const,
  list: (includeArchived: boolean) => [...inventoryLocationKeys.all, "list", includeArchived] as const,
  levels: (variantId: string) => [...inventoryLocationKeys.all, "levels", variantId] as const,
  productLevels: (productId: string) => [...inventoryLocationKeys.all, "product-levels", productId] as const,
};

/** Active locations (the default first); archived ones too when asked for. */
export const inventoryLocationsQueryOptions = (includeArchived = false) =>
  queryOptions({
    queryKey: inventoryLocationKeys.list(includeArchived),
    queryFn: async () =>
      (await apiData(getApiV1AdminInventoryLocations({ query: { includeArchived: includeArchived ? "true" : "false" } })))
        .locations,
    staleTime: 60_000,
  });

/** One SKU's on-hand at each active location. */
export const variantInventoryLevelsQueryOptions = (variantId: string) =>
  queryOptions({
    queryKey: inventoryLocationKeys.levels(variantId),
    queryFn: () => apiData(getApiV1AdminInventoryByVariantIdLevels({ path: { variantId } })),
    staleTime: 0,
  });

/** Every live SKU of a product at each location holding some, in one read (the product editor). */
export const productInventoryLevelsQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: inventoryLocationKeys.productLevels(productId),
    queryFn: () => apiData(getApiV1AdminInventoryLevels({ query: { productId } })),
    staleTime: 0,
  });

/**
 * Locations are worth showing only once a store has more than one: with a
 * single location every stock number is that location's.
 */
export function hasSeveralLocations(locations: readonly InventoryLocation[] | undefined): boolean {
  return (locations?.filter((location) => location.status === "active").length ?? 0) > 1;
}

function useRefreshLocations() {
  const queryClient = useQueryClient();
  return () => Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryLocationKeys.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all }),
  ]);
}

export function useSaveInventoryLocation() {
  const refresh = useRefreshLocations();
  return useMutation({
    mutationFn: (input: { id: string | null; version: number | null; body: InventoryLocationBody }) =>
      input.id
        ? apiData(patchApiV1AdminInventoryLocationsByLocationId({
          path: { locationId: input.id },
          body: { ...input.body, expectedVersion: input.version ?? 0 },
        }))
        : apiData(postApiV1AdminInventoryLocations({ body: input.body })),
    onSettled: refresh,
  });
}

export function useInventoryLocationAction() {
  const refresh = useRefreshLocations();
  return useMutation({
    mutationFn: (input: { id: string; action: "archive" | "unarchive" | "default" }) => {
      const options = { path: { locationId: input.id } };
      return apiData(input.action === "archive"
        ? postApiV1AdminInventoryLocationsByLocationIdArchive(options)
        : input.action === "unarchive"
          ? postApiV1AdminInventoryLocationsByLocationIdUnarchive(options)
          : postApiV1AdminInventoryLocationsByLocationIdDefault(options));
    },
    onSettled: refresh,
  });
}
