import { queryOptions } from "@tanstack/react-query";
import { getFirebaseConfig } from "../api-functions/firebase";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const firebaseConfigQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.firebase.config(),
    queryFn: () => getFirebaseConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });
