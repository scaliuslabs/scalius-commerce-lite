import { queryOptions } from "@tanstack/react-query";

import {
  getTaxClassifications,
  getTaxConfiguration,
  type TaxClassificationKind,
} from "../api-functions/taxes";
import { queryKeys } from "../query-keys";

const TAX_CONFIGURATION_STALE_TIME_MS = 60_000;

export const taxConfigurationQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.taxes(),
    queryFn: () => getTaxConfiguration(),
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
    queryFn: () => getTaxClassifications({ data: input }),
    staleTime: 15_000,
  });
