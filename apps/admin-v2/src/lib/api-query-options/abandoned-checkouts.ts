import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "../query-keys";

const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export interface AbandonedCheckoutsQueryInput {
  [key: string]: string | number | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
}

export const abandonedCheckoutsQueryOptions = (
  params: AbandonedCheckoutsQueryInput,
) =>
  queryOptions({
    queryKey: queryKeys.abandonedCheckouts.list(params),
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (params.page) sp.set("page", String(params.page));
      if (params.limit) sp.set("limit", String(params.limit));
      if (params.search) sp.set("search", params.search);
      if (params.sort) sp.set("sort", params.sort);
      if (params.order) sp.set("order", params.order);

      const res = await fetch(
        `/api/v1/admin/abandoned-checkouts?${sp.toString()}`,
      );
      if (!res.ok) {
        throw new Error(`Failed to fetch abandoned checkouts: ${res.status}`);
      }
      const body = (await res.json()) as { success: boolean; data?: unknown };
      return (body.data ?? body) as {
        checkouts: unknown[];
        pagination: unknown;
      };
    },
    staleTime: MODERATE_STALE_TIME_MS,
  });
