import { queryOptions } from "@tanstack/react-query";
import {
  type CheckoutReadinessPayload,
  getAuthSettings,
  getCheckoutReadiness,
  getFirebaseSettings,
  getGeneralSettings,
  getMetaConversionsLogs,
  getMetaConversionsSettings,
  getPaymentMethods,
  getThemeSettings,
} from "../api-functions/settings";
import { extractApiError, unwrapEnvelope } from "../api-helpers";
import { queryKeys } from "../query-keys";
export { currencySettingsQueryOptions } from "./currency";
export { storefrontUrlQueryOptions } from "./storefront-url";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

async function getCheckoutReadinessForQuery(): Promise<CheckoutReadinessPayload> {
  if (typeof window === "undefined") {
    return getCheckoutReadiness();
  }

  const response = await fetch("/api/v1/admin/settings/checkout-readiness", {
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The status code below is still more useful than hiding the transport failure.
  }

  if (!response.ok) {
    throw new Error(
      extractApiError(
        body,
        `Dashboard could not check checkout readiness (${response.status}).`,
      ),
    );
  }

  return unwrapEnvelope<CheckoutReadinessPayload>(body);
}

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

export const checkoutReadinessQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutReadiness(),
    queryFn: () => getCheckoutReadinessForQuery(),
    staleTime: MODERATE_STALE_TIME_MS,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: 2,
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
