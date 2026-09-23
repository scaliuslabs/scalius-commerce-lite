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
  getApiV1AdminSettingsAllowedCountries,
  getApiV1AdminSettingsCheckoutFlow,
  getApiV1AdminSettingsCheckoutReadiness,
  getApiV1AdminSettingsCustomerRequests,
  getApiV1AdminSettingsEmail,
  getApiV1AdminSettingsFirebase,
  getApiV1AdminSettingsGeneral,
  getApiV1AdminSettingsMetaConversions,
  getApiV1AdminSettingsPaymentMethods,
  getApiV1AdminSettingsSeo,
  getApiV1AdminSettingsThemeVersions,
  getApiV1AdminSettingsThemeWorkspace,
  postApiV1AdminSettingsSeo,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
export { currencySettingsQueryOptions } from "./currency";
export { storefrontUrlQueryOptions } from "./storefront-url";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;
const MODERATE_STALE_TIME_MS = 1000 * 60 * 2;

export type GeneralSettingsPayload = ApiResult<typeof getApiV1AdminSettingsGeneral>;
export type CheckoutFlowSettingsPayload = ApiResult<typeof getApiV1AdminSettingsCheckoutFlow>;
export type CheckoutMode = CheckoutFlowSettingsPayload["checkoutMode"];
export type CheckoutReadinessPayload = ApiResult<typeof getApiV1AdminSettingsCheckoutReadiness>;
export type PaymentMethodsPayload = ApiResult<typeof getApiV1AdminSettingsPaymentMethods>;
export type AllowedCountriesPayload = ApiResult<typeof getApiV1AdminSettingsAllowedCountries>;
export type EmailSettingsPayload = ApiResult<typeof getApiV1AdminSettingsEmail>;
export type FirebaseSettingsPayload = ApiResult<typeof getApiV1AdminSettingsFirebase>;
export type ThemeWorkspacePayload = ApiResult<typeof getApiV1AdminSettingsThemeWorkspace>;
export type ThemeDraftPayload = ThemeWorkspacePayload["draft"];
export type ThemeVersionPayload = ApiResult<typeof getApiV1AdminSettingsThemeVersions>["versions"][number];
export type UpdateSeoSettingsInput = ApiBody<typeof postApiV1AdminSettingsSeo>;
export type MetaConversionsSettingsResponse = ApiResult<typeof getApiV1AdminSettingsMetaConversions>;
export type MetaConversionsSettings = NonNullable<MetaConversionsSettingsResponse["settings"]>;
export type MetaPixelParityDiagnostics = MetaConversionsSettingsResponse["pixelParity"];

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
  const data = await apiData(getApiV1AdminSettingsSeo());
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
    discovery: normalizeSeoDiscoveryForQuery(data),
  };
}

export const generalSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.general(),
    queryFn: () => apiData(getApiV1AdminSettingsGeneral()),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const checkoutFlowSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutFlow(),
    queryFn: () => apiData(getApiV1AdminSettingsCheckoutFlow()),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const checkoutReadinessQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.checkoutReadiness(),
    queryFn: () => apiData(getApiV1AdminSettingsCheckoutReadiness()),
    staleTime: MODERATE_STALE_TIME_MS,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: 2,
  });

export const customerRequestPolicyQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.customerRequests(),
    queryFn: () => apiData(getApiV1AdminSettingsCustomerRequests()),
    staleTime: MODERATE_STALE_TIME_MS,
  });

export const seoSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.seo(),
    queryFn: () => getSeoSettingsForQuery(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

export const metaConversionsSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.metaConversions(),
    queryFn: () => apiData(getApiV1AdminSettingsMetaConversions()),
    staleTime: MODERATE_STALE_TIME_MS,
    refetchOnMount: "always",
  });

export const paymentMethodsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.paymentMethods(),
    queryFn: () => apiData(getApiV1AdminSettingsPaymentMethods()),
    staleTime: CONFIG_STALE_TIME_MS,
  });
