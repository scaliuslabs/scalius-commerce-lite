// Price lists (docs/MARKETS-DESIGN.md D5): the list, one list and a page of
// its SKU prices, and the writes. A list and its prices save under one
// revision; every write refreshes the list and the list's own reads.
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1AdminPriceListsById,
  getApiV1AdminPriceLists,
  getApiV1AdminPriceListsById,
  getApiV1AdminPriceListsChoices,
  getApiV1AdminPriceListsByIdPrices,
  patchApiV1AdminPriceListsById,
  postApiV1AdminPriceLists,
  putApiV1AdminPriceListsByIdPrices,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";

export type PriceList = ApiResult<typeof getApiV1AdminPriceListsById>["priceList"];
/** A row of the price lists index. */
export type PriceListSummary = ApiResult<typeof getApiV1AdminPriceLists>["items"][number];
export type PriceListVariant = ApiResult<typeof getApiV1AdminPriceListsByIdPrices>["items"][number];
export type PriceListChoices = ApiResult<typeof getApiV1AdminPriceListsChoices>;
export type CreatePriceListBody = ApiBody<typeof postApiV1AdminPriceLists>;
export type UpdatePriceListBody = ApiBody<typeof patchApiV1AdminPriceListsById>;
export type SetPriceListPricesBody = ApiBody<typeof putApiV1AdminPriceListsByIdPrices>;

export const priceListKeys = {
  all: ["price-lists"] as const,
  list: (marketId?: string) => [...priceListKeys.all, "list", marketId ?? ""] as const,
  choices: () => [...priceListKeys.all, "choices"] as const,
  detail: (id: string) => [...priceListKeys.all, "detail", id] as const,
  prices: (id: string, page: number, search: string) => [...priceListKeys.all, "prices", id, page, search] as const,
};

/** Every price list (at most 100), by name; optionally one market's. */
export const priceListsQueryOptions = (marketId?: string) =>
  queryOptions({
    queryKey: priceListKeys.list(marketId),
    queryFn: async () => (await apiData(getApiV1AdminPriceLists({ query: marketId ? { marketId } : {} }))).items,
    staleTime: 30_000,
  });

/** The markets and customer segments a new list can price. */
export const priceListChoicesQueryOptions = () =>
  queryOptions({
    queryKey: priceListKeys.choices(),
    queryFn: () => apiData(getApiV1AdminPriceListsChoices()),
    staleTime: 30_000,
  });

export async function fetchPriceList(id: string): Promise<PriceList> {
  return (await apiData(getApiV1AdminPriceListsById({ path: { id } }))).priceList;
}

export const priceListQueryOptions = (id: string) =>
  queryOptions({ queryKey: priceListKeys.detail(id), queryFn: () => fetchPriceList(id), staleTime: 0 });

export const PRICE_LIST_PAGE_SIZE = 25;

/** One page of a list's SKUs and their prices; the previous page stays shown while the next loads. */
export const priceListPricesQueryOptions = (id: string, page: number, search: string) =>
  queryOptions({
    queryKey: priceListKeys.prices(id, page, search),
    queryFn: () => apiData(getApiV1AdminPriceListsByIdPrices({
      path: { id },
      query: { page, limit: PRICE_LIST_PAGE_SIZE, ...(search ? { search } : {}) },
    })),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

export async function savePriceList(id: string, body: UpdatePriceListBody): Promise<PriceList> {
  return (await apiData(patchApiV1AdminPriceListsById({ path: { id }, body }))).priceList;
}

export async function savePriceListPrices(id: string, body: SetPriceListPricesBody): Promise<PriceList> {
  return (await apiData(putApiV1AdminPriceListsByIdPrices({ path: { id }, body }))).priceList;
}

export function useCreatePriceList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreatePriceListBody) => (await apiData(postApiV1AdminPriceLists({ body }))).priceList,
    onSettled: () => queryClient.invalidateQueries({ queryKey: priceListKeys.all }),
  });
}

export function useDeletePriceList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (list: Pick<PriceList, "id" | "revision">) =>
      apiData(deleteApiV1AdminPriceListsById({ path: { id: list.id }, query: { expectedRevision: list.revision } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: priceListKeys.list() }),
  });
}

export function useSavePriceListPrices(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetPriceListPricesBody) => savePriceListPrices(id, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: priceListKeys.all }),
  });
}
