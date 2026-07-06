import { queryOptions } from "@tanstack/react-query";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";
import {
  DEFAULT_SEO_RETURN_POLICY_SETTINGS,
  normalizeSeoReturnPolicySettings,
} from "@scalius/shared/seo-return-policy";
import {
  normalizeSeoDiscoverySettingsWithReturnPolicy,
  type SeoDiscoverySettingsWithReturnPolicy,
} from "../seo-discovery-status";
import {
  type CheckoutReadinessPayload,
  getAuthSettings,
  getCheckoutReadiness,
  getFirebaseSettings,
  getGeneralSettings,
  getMetaConversionsLogs,
  getMetaConversionsSettings,
  getPaymentMethods,
  getSeoSettings,
  getThemeSettings,
} from "../api-functions/settings";
import { extractApiError, unwrapEnvelope } from "../api-helpers";
import { queryKeys } from "../query-keys";
export { currencySettingsQueryOptions } from "./currency";
export { storefrontUrlQueryOptions } from "./storefront-url";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export interface SeoSettingsQueryPayload {
  siteTitle: string;
  homepageTitle: string;
  homepageMetaDescription: string;
  robotsTxt: string;
  discovery: SeoDiscoverySettingsWithReturnPolicy;
}

interface SeoSettingsQueryRawPayload {
  discovery?: unknown;
  returnPolicy?: unknown;
}

const DEFAULT_SEO_SETTINGS_QUERY_PAYLOAD: SeoSettingsQueryPayload = {
  siteTitle: "",
  homepageTitle: "",
  homepageMetaDescription: "",
  robotsTxt: `User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]`,
  discovery: {
    ...DEFAULT_SEO_DISCOVERY_SETTINGS,
    returnPolicy: DEFAULT_SEO_RETURN_POLICY_SETTINGS,
  },
};

function readReturnPolicy(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { returnPolicy?: unknown }).returnPolicy
    : undefined;
}

function normalizeSeoDiscoveryForQuery(
  data: SeoSettingsQueryRawPayload,
): SeoDiscoverySettingsWithReturnPolicy {
  const discovery = normalizeSeoDiscoverySettingsWithReturnPolicy(data.discovery);

  return {
    ...discovery,
    returnPolicy: normalizeSeoReturnPolicySettings(
      readReturnPolicy(data.discovery) ??
        data.returnPolicy ??
        discovery.returnPolicy,
    ),
  };
}

async function getSeoSettingsForQuery(): Promise<SeoSettingsQueryPayload> {
  const data = await getSeoSettings();
  const rawData = data as SeoSettingsQueryRawPayload;
  return {
    siteTitle: data.siteTitle || DEFAULT_SEO_SETTINGS_QUERY_PAYLOAD.siteTitle,
    homepageTitle:
      data.homepageTitle || DEFAULT_SEO_SETTINGS_QUERY_PAYLOAD.homepageTitle,
    homepageMetaDescription:
      data.homepageMetaDescription ||
      DEFAULT_SEO_SETTINGS_QUERY_PAYLOAD.homepageMetaDescription,
    robotsTxt:
      typeof data.robotsTxt === "string"
        ? data.robotsTxt
        : DEFAULT_SEO_SETTINGS_QUERY_PAYLOAD.robotsTxt,
    discovery: normalizeSeoDiscoveryForQuery(rawData),
  };
}

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

export const seoSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seo(),
    queryFn: () => getSeoSettingsForQuery(),
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
    staleTime: MODERATE_STALE_TIME_MS,
    refetchOnMount: "always",
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
