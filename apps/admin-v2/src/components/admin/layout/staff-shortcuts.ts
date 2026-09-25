import { queryOptions, useQuery } from "@tanstack/react-query";
import { getApiV1AdminAuthShortcuts } from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";

/** This staff member's own go-to shortcuts (destination → "g x", or "" for a default turned off). */
export const staffShortcutsQueryOptions = () =>
  queryOptions({
    queryKey: ["account", "shortcuts"] as const,
    queryFn: () => apiData(getApiV1AdminAuthShortcuts()),
    staleTime: Infinity,
    // Shortcuts are a convenience: the defaults work while this can't be read.
    retry: false,
  });

export function useStaffShortcuts() {
  return useQuery(staffShortcutsQueryOptions());
}
