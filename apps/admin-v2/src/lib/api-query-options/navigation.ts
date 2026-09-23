import { infiniteQueryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminNavigationMenus,
  getApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  getApiV1AdminNavigationResources,
  type postApiV1AdminNavigationMenusByMenuIdItems,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

export type NavigationMenuSummary =
  ApiResult<typeof getApiV1AdminNavigationMenus>["items"][number];
export type NavigationMenuItemRow =
  ApiResult<typeof getApiV1AdminNavigationMenusByMenuIdItemsByItemId>["item"];
/**
 * Contract gap: the placement-settings, menu detail and menu create responses
 * are declared as open records in apps/api/src/routes/admin/navigation.ts.
 * The menu detail returns a `NavigationMenuSummary`; placements look like this.
 */
export interface NavigationPlacementSetting {
  placement: {
    id: string;
    surface: string;
    slot: string;
    position: number;
    menuId: string;
    labelOverride: string | null;
    isEnabled: boolean;
    revision: number;
  };
  menuName: string;
  menuDeletedAt: string | number | null;
  publishedRevision: number | null;
  publicationItemCount: number | null;
}
export type NavigationResourceOption =
  ApiResult<typeof getApiV1AdminNavigationResources>["items"][number];
export type NavigationResourceType = NavigationResourceOption["type"];
export type NavigationItemDraft = Omit<
  ApiBody<typeof postApiV1AdminNavigationMenusByMenuIdItems>,
  "expectedRevision" | "parentId"
>;

export const navigationResourcesQueryOptions = (input: {
  type: NavigationResourceType;
  query?: string;
  limit?: number;
  selectedId?: string;
}) => {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 20;
  const selectedId = input.selectedId?.trim() || undefined;

  return infiniteQueryOptions({
    queryKey: queryKeys.navigation.resources({
      type: input.type,
      query,
      limit,
      selectedId,
    }),
    queryFn: ({ pageParam }) => apiData(getApiV1AdminNavigationResources({
      query: {
        type: input.type,
        q: query,
        limit,
        ...(pageParam ? { cursor: pageParam } : { selectedId }),
      },
    })),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    // Resource titles and availability can change in another editor tab.
    // Treat cached pages as hints so reopening/focusing the picker revalidates.
    staleTime: 0,
  });
};
