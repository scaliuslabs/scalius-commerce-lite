// Sales channels (docs/MARKETS-DESIGN.md D6): Settings › Sales channels, the
// product page's Publishing card and the products list's publishing actions
// read one list query; a channel edit refreshes it, a publication write
// refreshes it (product counts) and the product lists.
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsSalesChannels,
  patchApiV1AdminSettingsSalesChannelsById,
  postApiV1AdminProductsPublications,
  putApiV1AdminProductsByIdPublications,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import { translate } from "~/i18n";
import { salesChannelNamesMessages, type SalesChannelNamesMessageKey } from "~/i18n/sales-channel-names";

export type SalesChannel = ApiResult<typeof getApiV1AdminSettingsSalesChannels>["items"][number];
export type UpdateSalesChannelBody = ApiBody<typeof patchApiV1AdminSettingsSalesChannelsById>;
export type BulkPublicationsBody = ApiBody<typeof postApiV1AdminProductsPublications>;

export const salesChannelKeys = {
  all: ["settings", "sales-channels"] as const,
  list: () => [...salesChannelKeys.all, "list"] as const,
};

/** Every channel, the online store first. */
export const salesChannelsQueryOptions = () =>
  queryOptions({
    queryKey: salesChannelKeys.list(),
    queryFn: async () => (await apiData(getApiV1AdminSettingsSalesChannels())).items,
    staleTime: 60_000,
  });

/**
 * Whether the store has started to tell channels apart: a channel it turned
 * off, or channels that publish different numbers of products. Until then
 * every product is on every channel, and the products list shows no
 * channel column or filter (Shopify lists them as the store sells in more
 * than the online store).
 */
export function channelsInUse(channels: readonly Pick<SalesChannel, "kind" | "status" | "publishedProducts">[]): boolean {
  if (channels.some((channel) => channel.kind !== "app" && channel.status !== "active")) return true;
  return new Set(channels.filter((channel) => channel.kind !== "app").map((channel) => channel.publishedProducts)).size > 1;
}

/** A channel's name in the dashboard language: built-in channels are translated, an app's keeps its own. */
export function salesChannelName(channel: Pick<SalesChannel, "id" | "name">): string {
  const key = `channel.${channel.id}` as SalesChannelNamesMessageKey;
  return key in salesChannelNamesMessages.en ? translate(salesChannelNamesMessages, key) : channel.name;
}

export function useUpdateSalesChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: UpdateSalesChannelBody }) =>
      (await apiData(patchApiV1AdminSettingsSalesChannelsById({ path: { id }, body }))).channel,
    onSuccess: (channel) => {
      queryClient.setQueryData<SalesChannel[]>(salesChannelKeys.list(), (current) =>
        current?.map((entry) => (entry.id === channel.id ? channel : entry)));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: salesChannelKeys.list() });
    },
  });
}

/** The product page's Publishing card: exactly these channels (not under the product's revision). */
export async function saveProductChannels(productId: string, channelIds: string[]): Promise<string[]> {
  return (await apiData(putApiV1AdminProductsByIdPublications({ path: { id: productId }, body: { channelIds } }))).salesChannelIds;
}

/** The products list: up to 90 products on the chosen channels per call. */
export async function setProductPublications(body: BulkPublicationsBody) {
  return apiData(postApiV1AdminProductsPublications({ body }));
}

/** What a publication write changes on screen: product counts per channel and the product lists. */
export function publicationInvalidations(): Array<readonly unknown[]> {
  return [salesChannelKeys.list(), queryKeys.products.all];
}
