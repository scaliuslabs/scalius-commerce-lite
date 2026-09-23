import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminSettingsCheckoutLanguages } from "@scalius/api-client/sdk";
import { apiData, type ApiQuery, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

type CheckoutLanguagesPayload = ApiResult<typeof getApiV1AdminSettingsCheckoutLanguages>;
export type CheckoutLanguage = CheckoutLanguagesPayload["languages"][number];
export type CheckoutLanguagesPagination = CheckoutLanguagesPayload["pagination"];
export type CheckoutLanguagesQuery = ApiQuery<typeof getApiV1AdminSettingsCheckoutLanguages>;

export const checkoutLanguagesQueryOptions = (query: CheckoutLanguagesQuery) =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutLanguages(query),
    queryFn: () => apiData(getApiV1AdminSettingsCheckoutLanguages({ query })),
    staleTime: CONFIG_STALE_TIME_MS,
  });
