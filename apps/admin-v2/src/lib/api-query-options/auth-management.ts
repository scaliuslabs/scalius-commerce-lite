import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminAuthAccountSecurity,
  getApiV1AdminAuthSessions,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;
const ACCOUNT_SESSIONS_STALE_TIME_MS = 1000 * 30;

export type AccountSecurity = ApiResult<typeof getApiV1AdminAuthAccountSecurity>;
export type AccountSessionsResponse = ApiResult<typeof getApiV1AdminAuthSessions>;
export type AccountSession = AccountSessionsResponse["sessions"][number];

export const accountSecurityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.accountSecurity(),
    queryFn: () => apiData(getApiV1AdminAuthAccountSecurity()),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const accountSessionsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.sessions(),
    queryFn: () => apiData(getApiV1AdminAuthSessions()),
    staleTime: ACCOUNT_SESSIONS_STALE_TIME_MS,
    refetchOnMount: "always",
  });
