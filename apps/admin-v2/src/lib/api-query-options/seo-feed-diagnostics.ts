import { queryOptions } from "@tanstack/react-query";

import { getApiV1AdminSettingsSeoFeedDiagnostics } from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export const seoFeedDiagnosticsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seoFeedDiagnostics(),
    queryFn: () => apiData(getApiV1AdminSettingsSeoFeedDiagnostics()),
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    retry: false,
    refetchOnWindowFocus: false,
  });
