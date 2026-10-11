import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminNotifications,
  getApiV1AdminNotificationsSummary,
  postApiV1AdminNotificationsBySeqRead,
  postApiV1AdminNotificationsReadAll,
  postApiV1AdminNotificationsClearAll,
  postApiV1AdminNotificationsClearAllUndo,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";

export type StaffAlertPage = ApiResult<typeof getApiV1AdminNotifications>;
export type StaffAlertSummary = ApiResult<typeof getApiV1AdminNotificationsSummary>;
export type StaffAlertItem = StaffAlertPage["items"][number];
export type StaffAlertAction =
  | { kind: "read"; seq: number }
  | { kind: "read-all"; body: ApiBody<typeof postApiV1AdminNotificationsReadAll> }
  | { kind: "clear"; body: ApiBody<typeof postApiV1AdminNotificationsClearAll> }
  | { kind: "undo"; body: ApiBody<typeof postApiV1AdminNotificationsClearAllUndo> };

export const staffAlertKeys = {
  account: (userId: string) => ["staff-alerts", userId] as const,
  summary: (userId: string) => [...staffAlertKeys.account(userId), "summary"] as const,
  feed: (userId: string) => [...staffAlertKeys.account(userId), "feed"] as const,
};

export const staffAlertSummaryOptions = (userId: string) => queryOptions({
  queryKey: staffAlertKeys.summary(userId),
  queryFn: ({ signal }) => apiData(getApiV1AdminNotificationsSummary({ signal })),
  enabled: Boolean(userId),
  gcTime: 0,
  staleTime: 30_000,
  refetchInterval: 60_000,
  refetchOnWindowFocus: "always",
});

export const staffAlertFeedOptions = (userId: string, window: string, beforeFirst: () => number | undefined, beforeUpdate: () => void) => infiniteQueryOptions({
  queryKey: [...staffAlertKeys.feed(userId), window],
  queryFn: async ({ pageParam, signal }) => {
    const page = await apiData(getApiV1AdminNotifications({ query: { limit: 20, beforeSeq: pageParam ?? beforeFirst() }, signal }));
    if (!signal.aborted) beforeUpdate();
    return page;
  },
  initialPageParam: undefined as number | undefined,
  getNextPageParam: (page) => page.nextBefore ?? undefined,
  maxPages: 5,
  gcTime: 0,
  staleTime: 0,
  refetchOnMount: "always",
  refetchOnWindowFocus: "always",
});

export function mutateStaffAlert(action: StaffAlertAction) {
  switch (action.kind) {
    case "read": return apiData(postApiV1AdminNotificationsBySeqRead({ path: { seq: action.seq } }));
    case "read-all": return apiData(postApiV1AdminNotificationsReadAll({ body: action.body }));
    case "clear": return apiData(postApiV1AdminNotificationsClearAll({ body: action.body }));
    case "undo": return apiData(postApiV1AdminNotificationsClearAllUndo({ body: action.body }));
  }
}
