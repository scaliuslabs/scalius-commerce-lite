import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminTaxes,
  getApiV1AdminTaxesClassifications,
  type putApiV1AdminTaxesSettings,
} from "@scalius/api-client/sdk";

import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const TAX_CONFIGURATION_STALE_TIME_MS = 60_000;

export type TaxConfigurationPayload = ApiResult<typeof getApiV1AdminTaxes>;
export type TaxClassRecord = TaxConfigurationPayload["classes"][number];
export type TaxRateRecord = TaxConfigurationPayload["rates"][number];
export type TaxJurisdictionOption = TaxConfigurationPayload["jurisdictions"][number];
export type TaxJurisdictionType = TaxRateRecord["jurisdictionType"];
export type UpdateTaxSettingsInput = ApiBody<typeof putApiV1AdminTaxesSettings>;
export type TaxClassificationItem =
  ApiResult<typeof getApiV1AdminTaxesClassifications>["items"][number];
export type TaxClassificationKind = TaxClassificationItem["kind"];

export const taxConfigurationQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.taxes(),
    queryFn: () => apiData(getApiV1AdminTaxes()),
    staleTime: TAX_CONFIGURATION_STALE_TIME_MS,
  });

export const taxClassificationsQueryOptions = (input: {
  kind: TaxClassificationKind;
  page: number;
  limit: number;
  search?: string;
}) =>
  queryOptions({
    queryKey: queryKeys.settings.taxClassifications(input),
    queryFn: () => apiData(getApiV1AdminTaxesClassifications({
      query: { ...input, search: input.search || undefined },
    })),
    staleTime: 15_000,
  });
