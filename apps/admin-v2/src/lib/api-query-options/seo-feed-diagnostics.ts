import { queryOptions } from "@tanstack/react-query";

import { getSeoFeedDiagnostics } from "../api-functions/seo-feed-diagnostics";
import { queryKeys } from "../query-keys";

export const seoFeedDiagnosticsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seoFeedDiagnostics(),
    queryFn: () => getSeoFeedDiagnostics(),
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 5,
    retry: false,
    refetchOnWindowFocus: false,
  });
