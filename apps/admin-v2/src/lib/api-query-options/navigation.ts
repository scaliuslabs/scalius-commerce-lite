import { infiniteQueryOptions } from "@tanstack/react-query";
import {
  getNavigationResourcesAuthority,
  type NavigationResourceType,
} from "../api-functions/navigation-authority";
import { queryKeys } from "../query-keys";

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
    queryFn: ({ pageParam }) => getNavigationResourcesAuthority({
      data: {
        type: input.type,
        query,
        limit,
        ...(pageParam ? {} : { selectedId }),
        ...(pageParam ? { cursor: pageParam } : {}),
      },
    }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    // Resource titles and availability can change in another editor tab.
    // Treat cached pages as hints so reopening/focusing the picker revalidates.
    staleTime: 0,
  });
};
