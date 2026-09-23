import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminTaxes,
  getApiV1AdminTaxesClassifications,
  getApiV1AdminTaxesSettings,
} from "@scalius/api-client/sdk";

import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

export type TaxConfigurationPayload = ApiResult<typeof getApiV1AdminTaxes>;
export type TaxSettingsRecord = TaxConfigurationPayload["settings"];
export type TaxClassRecord = TaxConfigurationPayload["classes"][number];
export type TaxRateRecord = TaxConfigurationPayload["rates"][number];
export type TaxJurisdictionOption = TaxConfigurationPayload["jurisdictions"][number];
export type TaxJurisdictionType = TaxRateRecord["jurisdictionType"];
export type TaxClassificationItem =
  ApiResult<typeof getApiV1AdminTaxesClassifications>["items"][number];
export type TaxClassificationKind = TaxClassificationItem["kind"];

/** Groups, rates and delivery places. */
export const taxConfigurationQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.taxes(),
    queryFn: () => apiData(getApiV1AdminTaxes()),
  });

export const fetchTaxSettings = async () => (await apiData(getApiV1AdminTaxesSettings())).settings;

/** The versioned settings document (nested under the configuration key). */
export const taxSettingsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.settings.taxes(), "settings"] as const,
    queryFn: fetchTaxSettings,
  });

export const taxClassificationsQueryOptions = (input: {
  kind: TaxClassificationKind;
  page: number;
  limit: number;
  search?: string;
}) => {
  const query = { kind: input.kind, page: input.page, limit: input.limit, ...(input.search ? { search: input.search } : {}) };
  return queryOptions({
    queryKey: queryKeys.settings.taxClassifications(query),
    queryFn: () => apiData(getApiV1AdminTaxesClassifications({ query })),
    staleTime: 15_000,
  });
};
