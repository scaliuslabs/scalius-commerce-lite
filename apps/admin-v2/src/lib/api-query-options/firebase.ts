import { queryOptions } from "@tanstack/react-query";
import { getApiV1AuthFirebaseConfig } from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const firebaseConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.firebase.config(),
    queryFn: async () => {
      const config = await apiData(getApiV1AuthFirebaseConfig());
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(config)) {
        if (typeof value === "string") normalized[key] = value;
      }
      return normalized;
    },
    staleTime: CONFIG_STALE_TIME_MS,
  });
