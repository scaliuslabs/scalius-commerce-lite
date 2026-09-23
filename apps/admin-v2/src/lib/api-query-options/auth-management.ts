import { queryOptions } from "@tanstack/react-query";
import {
  getAccountSessions,
  getAccountSecurity,
} from "../api-functions/auth-management";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;
const ACCOUNT_SESSIONS_STALE_TIME_MS = 1000 * 30;

export const accountSecurityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.accountSecurity(),
    queryFn: () => getAccountSecurity(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const accountSessionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.sessions(),
    queryFn: () => getAccountSessions(),
    staleTime: ACCOUNT_SESSIONS_STALE_TIME_MS,
    refetchOnMount: "always",
  });
