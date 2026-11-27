import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsAllowedCountries,
  getApiV1AdminSettingsCatalog,
  getApiV1AdminSettingsSeo,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
export { currencySettingsQueryOptions } from "./currency";
export { storefrontUrlQueryOptions } from "./storefront-url";

export type AllowedCountriesPayload = ApiResult<typeof getApiV1AdminSettingsAllowedCountries>;

/** How the storefront's listings behave (Online store -> Preferences). */
export const catalogSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.catalog(),
    queryFn: () => apiData(getApiV1AdminSettingsCatalog()),
    staleTime: 1000 * 60 * 30,
  });

export const seoSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seo(),
    queryFn: () => apiData(getApiV1AdminSettingsSeo()),
    staleTime: 1000 * 60 * 30,
  });
