import { queryOptions } from "@tanstack/react-query";

import { getApiV1AdminSettingsSeoLiveProbe } from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

export const seoDiscoveryLiveProbeQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seoDiscoveryLiveProbe(),
    queryFn: () => apiData(getApiV1AdminSettingsSeoLiveProbe()),
    staleTime: 0,
    gcTime: 1000 * 60 * 5,
    retry: false,
    refetchOnWindowFocus: false,
  });
