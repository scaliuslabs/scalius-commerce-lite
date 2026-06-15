import { queryOptions } from "@tanstack/react-query";
import {
  get2faInfo,
  getAccountSecurity,
  getAdminUsers,
  getSetupStatus,
} from "../api-functions/auth-management";
import { queryKeys } from "../query-keys";

const LOOKUP_STALE_TIME_MS = 1000 * 60 * 10;
const STATIC_STALE_TIME_MS = 1000 * 60 * 60;

export const adminUsersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.adminUsers.list(),
    queryFn: () => getAdminUsers(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const accountSecurityQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.accountSecurity(),
    queryFn: () => getAccountSecurity(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const twoFaInfoQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.auth.twoFaInfo(),
    queryFn: () => get2faInfo(),
    staleTime: LOOKUP_STALE_TIME_MS,
  });

export const setupStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.setup.status(),
    queryFn: () => getSetupStatus(),
    staleTime: STATIC_STALE_TIME_MS,
  });
