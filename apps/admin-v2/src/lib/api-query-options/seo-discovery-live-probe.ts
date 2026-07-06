import { queryOptions } from "@tanstack/react-query";

import { getSeoDiscoveryLiveProbe } from "../api-functions/seo-discovery-live-probe-rpc";
import { queryKeys } from "../query-keys";

export const seoDiscoveryLiveProbeQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seoDiscoveryLiveProbe(),
    queryFn: () => getSeoDiscoveryLiveProbe(),
    staleTime: 0,
    gcTime: 1000 * 60 * 5,
    retry: false,
    refetchOnWindowFocus: false,
  });
