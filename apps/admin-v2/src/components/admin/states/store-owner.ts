import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminRbacMyPermissions } from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";

/**
 * The store owner's name, so a view-only or no-access screen can say whom to
 * ask (polish bar R4, R5). Read once per session from the caller's own
 * permission context; null until known or when it cannot be read, and the
 * copy then says "the store owner".
 */
export function useStoreOwnerName(enabled = true): string | null {
  const { data } = useQuery({
    queryKey: ["rbac", "store-owner"],
    queryFn: async () => (await apiData(getApiV1AdminRbacMyPermissions())).storeOwnerName ?? null,
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
  return data ?? null;
}
