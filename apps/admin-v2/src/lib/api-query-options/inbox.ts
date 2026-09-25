// Inbox reads: the keys, the shapes and the query options. The sidebar badge
// and the conversation route's loader load with the shell, so this file holds
// reads only; the mutations and the image upload live beside the inbox screens
// (components/admin/inbox/inbox-api.ts).
import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminConversations,
  getApiV1AdminConversationsById,
  getApiV1AdminConversationsOrderByOrderId,
  getApiV1AdminConversationsSummary,
} from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";

export type InboxQuery = ApiQuery<typeof getApiV1AdminConversations>;
export type InboxItem = ApiResult<typeof getApiV1AdminConversations>["items"][number];
export type StaffThread = ApiResult<typeof getApiV1AdminConversationsById>["conversation"];
export type StaffMessage = StaffThread["messages"][number];

export const inboxKeys = {
  all: ["conversations"] as const,
  lists: () => [...inboxKeys.all, "list"] as const,
  list: (query: InboxQuery) => [...inboxKeys.lists(), query] as const,
  summary: () => [...inboxKeys.all, "summary"] as const,
  thread: (id: string) => [...inboxKeys.all, "thread", id] as const,
  order: (orderId: string) => [...inboxKeys.all, "order", orderId] as const,
};

/** Keep an open inbox current without a socket: short polls while visible. */
const THREAD_POLL_MS = 20_000;
const SUMMARY_POLL_MS = 60_000;

export const inboxSummaryQueryOptions = () =>
  queryOptions({
    queryKey: inboxKeys.summary(),
    queryFn: () => apiData(getApiV1AdminConversationsSummary()),
    refetchInterval: SUMMARY_POLL_MS,
    staleTime: 30_000,
  });

export const threadQueryOptions = (id: string) =>
  queryOptions({
    queryKey: inboxKeys.thread(id),
    queryFn: async () => (await apiData(getApiV1AdminConversationsById({ path: { id } }))).conversation,
    refetchInterval: THREAD_POLL_MS,
    staleTime: 0,
  });

export const orderThreadQueryOptions = (orderId: string) =>
  queryOptions({
    queryKey: inboxKeys.order(orderId),
    queryFn: async () => (await apiData(getApiV1AdminConversationsOrderByOrderId({ path: { orderId } }))).conversation,
    refetchInterval: THREAD_POLL_MS,
    staleTime: 0,
  });

/** Earlier messages of a thread, for "Show earlier messages". */
export async function fetchOlderMessages(id: string, beforeSeq: number): Promise<StaffThread> {
  return (await apiData(getApiV1AdminConversationsById({ path: { id }, query: { beforeSeq } }))).conversation;
}
