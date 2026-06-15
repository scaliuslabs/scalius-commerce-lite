import { queryOptions } from "@tanstack/react-query";
import {
  getAuthSettings,
  getCurrencySettings,
  getFirebaseSettings,
  getGeneralSettings,
  getMetaConversionsLogs,
  getMetaConversionsSettings,
  getPaymentMethods,
  getStorefrontUrl,
  getThemeSettings,
} from "../api-functions/settings";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const generalSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.general(),
    queryFn: () => getGeneralSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const storefrontUrlQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.storefrontUrl(),
    queryFn: () => getStorefrontUrl(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const currencySettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.currency(),
    queryFn: () => getCurrencySettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const authSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.auth(),
    queryFn: () => getAuthSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const firebaseSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.firebase(),
    queryFn: () => getFirebaseSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const themeSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.theme(),
    queryFn: () => getThemeSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const metaConversionsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversions(),
    queryFn: () => getMetaConversionsSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const metaConversionsLogsQueryOptions = (params: {
  page?: number;
  limit?: number;
}) =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversionsLogs(params),
    queryFn: () => getMetaConversionsLogs({ data: params }),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const paymentMethodsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.paymentMethods(),
    queryFn: () => getPaymentMethods(),
    staleTime: CONFIG_STALE_TIME_MS,
  });
