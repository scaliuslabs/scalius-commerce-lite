// Settings › Markets (docs/MARKETS-DESIGN.md D4): the list, one market's
// reads and writes. An edit can change the backup market's price increment,
// which every money field reads through the currency settings query, so an
// edit refreshes that query too.
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminSettingsMarketsById,
  getApiV1AdminSettingsMarkets,
  getApiV1AdminSettingsMarketsById,
  patchApiV1AdminSettingsMarketsById,
  postApiV1AdminSettingsMarkets,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

export type Market = ApiResult<typeof getApiV1AdminSettingsMarkets>["items"][number];
export type MarketPresence = NonNullable<Market["presence"]>;
export type CreateMarketBody = ApiBody<typeof postApiV1AdminSettingsMarkets>;
export type UpdateMarketBody = ApiBody<typeof patchApiV1AdminSettingsMarketsById>;

export const marketKeys = {
  all: ["settings", "markets"] as const,
  list: () => [...marketKeys.all, "list"] as const,
  detail: (id: string) => [...marketKeys.all, "detail", id] as const,
};

/** Every market, the backup first. */
export const marketsQueryOptions = () =>
  queryOptions({
    queryKey: marketKeys.list(),
    queryFn: async () => (await apiData(getApiV1AdminSettingsMarkets())).items,
    staleTime: 30_000,
  });

export async function fetchMarket(id: string): Promise<Market> {
  return (await apiData(getApiV1AdminSettingsMarketsById({ path: { id } }))).market;
}

export async function saveMarket(id: string, body: UpdateMarketBody): Promise<Market> {
  return (await apiData(patchApiV1AdminSettingsMarketsById({ path: { id }, body }))).market;
}

/**
 * The queries a market edit can change: the list, and the price increment
 * every money field reads (currency settings). The editor keeps its own
 * market's values from the save's answer.
 */
export function marketWriteInvalidations(): Array<readonly unknown[]> {
  return [marketKeys.list(), queryKeys.settings.currency()];
}

/** After a create or delete: the list (a deleted market's page is left, not reloaded). */
function useRefreshMarketList() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: marketKeys.list() });
}

export function useCreateMarket() {
  const refresh = useRefreshMarketList();
  return useMutation({
    mutationFn: async (body: CreateMarketBody) => (await apiData(postApiV1AdminSettingsMarkets({ body }))).market,
    onSettled: refresh,
  });
}

export function useDeleteMarket() {
  const refresh = useRefreshMarketList();
  return useMutation({
    mutationFn: (market: Pick<Market, "id" | "revision">) =>
      apiData(deleteApiV1AdminSettingsMarketsById({ path: { id: market.id }, query: { expectedRevision: market.revision } })),
    onSettled: refresh,
  });
}
