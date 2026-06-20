import { queryOptions } from "@tanstack/react-query";
import {
  getAuthSettings,
  getFirebaseSettings,
  getGeneralSettings,
  getMetaConversionsLogs,
  getMetaConversionsSettings,
  getPaymentMethods,
  getThemeSettings,
} from "../api-functions/settings";
import { queryKeys } from "../query-keys";
export { currencySettingsQueryOptions } from "./currency";
export { storefrontUrlQueryOptions } from "./storefront-url";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export const generalSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.general(),
    queryFn: () => getGeneralSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const authSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.auth(),
    queryFn: () => getAuthSettings(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const checkoutFlowSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutFlow(),
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
