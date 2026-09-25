// Queries the settings screens read. Route loaders import them from here, not
// from the screen components, so the screens (and their catalogs and deps)
// stay out of the always-loaded entry chunk.
import {
  getApiV1AdminAnalytics,
  getApiV1AdminSettingsAllowedCountries,
  getApiV1AdminSettingsAuth,
  getApiV1AdminSettingsBusiness,
  getApiV1AdminSettingsCheckoutFlow,
  getApiV1AdminSettingsCheckoutLanguages,
  getApiV1AdminSettingsCheckoutReadiness,
  getApiV1AdminSettingsCurrency,
  getApiV1AdminSettingsCustomerRequests,
  getApiV1AdminSettingsDeliveryLocations,
  getApiV1AdminSettingsEmail,
  getApiV1AdminSettingsFirebase,
  getApiV1AdminSettingsMedia,
  getApiV1AdminSettingsMetaConversions,
  getApiV1AdminSettingsNotificationChannels,
  getApiV1AdminSettingsPaymentMethods,
  getApiV1AdminSettingsPlatform,
  getApiV1AdminSettingsSecurity,
  getApiV1AdminSettingsSecurityRuntimeSources,
  getApiV1AdminSettingsSms,
  getApiV1AdminSettingsSslcommerz,
  getApiV1AdminSettingsStripe,
} from "@scalius/api-client/sdk";
import type {
  MessageLanguage,
  EmailStore,
  NotificationTemplates,
} from "@scalius/core/modules/notifications/browser";
import type { getCountries } from "@scalius/shared/customer-utils";
import { parseMerchantCspSources } from "@scalius/shared/security-csp";
import { countClearableAgentConnections, listAgentConnections } from "~/components/admin/agent-access/api";
import type { GatewayStatus, MethodKey } from "~/components/admin/settings/payment-method-outcome";
import type { PolicyKind } from "~/components/admin/settings/policy-templates";
import { apiClient, apiData, type ApiResult } from "../api";
import { queryKeys } from "../query-keys";
import { deliveryProvidersQueryOptions } from "./delivery";
import { pagesQueryOptions } from "./pages";
import { getAdminUsers, getRbacRoles } from "./rbac";

// ── Store ────────────────────────────────────────────────────────────────

type Country = ReturnType<typeof getCountries>[number];
export interface CountryPolicy {
  allowedCountries: Country[];
  allowedCountriesMode: "include" | "exclude";
}

export const businessQuery = {
  queryKey: queryKeys.settings.business(),
  queryFn: () => apiData(getApiV1AdminSettingsBusiness()),
};
export const platformQuery = {
  queryKey: queryKeys.settings.platform(),
  queryFn: () => apiData(getApiV1AdminSettingsPlatform()),
};
export const currencyQuery = {
  queryKey: queryKeys.settings.currency(),
  queryFn: () => apiData(getApiV1AdminSettingsCurrency()),
};
export const countriesQuery = {
  queryKey: queryKeys.settings.allowedCountries(),
  queryFn: async (): Promise<CountryPolicy & { revision: number }> => {
    const data = await apiData(getApiV1AdminSettingsAllowedCountries());
    return {
      allowedCountries: (Array.isArray(data.allowedCountries) ? data.allowedCountries : []) as Country[],
      allowedCountriesMode: data.allowedCountriesMode === "exclude" ? "exclude" : "include",
      revision: data.revision,
    };
  },
};

// ── Payments ─────────────────────────────────────────────────────────────

export type PaymentMethods = Omit<ApiResult<typeof getApiV1AdminSettingsPaymentMethods>, "enabledMethods" | "defaultMethod" | "gatewayStatus"> & {
  enabledMethods: MethodKey[];
  defaultMethod: MethodKey;
  gatewayStatus: Partial<Record<MethodKey, GatewayStatus>>;
};

export const checkoutFlowQuery = {
  queryKey: queryKeys.settings.checkoutFlow(),
  queryFn: () => apiData(getApiV1AdminSettingsCheckoutFlow()),
};
export const paymentMethodsQuery = {
  queryKey: queryKeys.settings.paymentMethods(),
  queryFn: async () => (await apiData(getApiV1AdminSettingsPaymentMethods())) as unknown as PaymentMethods,
};
/** A gateway document as read: keys, flags and its `revision` (kept apart from the form values). */
export type GatewayValues = Record<string, string | boolean | number>;
export const gatewayQuery = (gateway: "stripe" | "sslcommerz") => ({
  queryKey: queryKeys.settings.paymentGateway(gateway),
  queryFn: async (): Promise<GatewayValues> =>
    gateway === "stripe"
      ? await apiData(getApiV1AdminSettingsStripe())
      : await apiData(getApiV1AdminSettingsSslcommerz()),
});

// ── Checkout ─────────────────────────────────────────────────────────────

const LANGUAGES_PARAMS = { page: 1, limit: 10, sort: "name", order: "asc" } as const;
export const languagesQuery = {
  queryKey: queryKeys.settings.checkoutLanguages(LANGUAGES_PARAMS),
  queryFn: () => apiData(getApiV1AdminSettingsCheckoutLanguages({ query: LANGUAGES_PARAMS })),
};
export const checkoutReadinessQuery = {
  queryKey: queryKeys.settings.checkoutReadiness(),
  queryFn: () => apiData(getApiV1AdminSettingsCheckoutReadiness()),
};
export const customerRequestsQuery = {
  queryKey: queryKeys.settings.customerRequests(),
  queryFn: async () => {
    const { policy, revision } = await apiData(getApiV1AdminSettingsCustomerRequests());
    return { ...policy, revision };
  },
};

// ── Shipping ─────────────────────────────────────────────────────────────

export const areaCountsQuery = {
  queryKey: [...queryKeys.settings.deliveryLocations(), "counts"],
  queryFn: async () => {
    const [cities, zones, areas] = await Promise.all(
      (["city", "zone", "area"] as const).map((type) =>
        apiData(getApiV1AdminSettingsDeliveryLocations({ query: { type, page: 1, limit: 1 } })),
      ),
    );
    return { cities: cities!.pagination.total, zones: zones!.pagination.total, areas: areas!.pagination.total };
  },
};
export const couriersQuery = deliveryProvidersQueryOptions();

// TODO(sdk): the generated SDK predates delivery zones; switch these raw calls
// to it after `pnpm generate:sdk`.
export const ZONES_URL = "/api/v1/admin/settings/shipping-methods";

interface Rate {
  id: string;
  kind: "delivery" | "pickup";
  name: string;
  fee: number;
  freeOver: number | null;
  description: string | null;
  pickupAddress: string | null;
  pickupHours: string | null;
  isActive: boolean;
}
interface Place {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentName: string | null;
}
interface Zone {
  id: string;
  name: string;
  revision: number;
  locations: Place[];
  rates: Rate[];
}
export interface DeliveryZones {
  zones: Zone[];
  everywhereElse: { revision: number; rates: Rate[] };
}

export const deliveryZonesQuery = {
  queryKey: queryKeys.settings.shippingMethods(),
  queryFn: () => apiData(apiClient.get<{ 200: { data: DeliveryZones } }>({ url: ZONES_URL })),
};

// ── Policies ─────────────────────────────────────────────────────────────

export type PoliciesPayload = Record<PolicyKind, string | null> & { revision: number };

// Not in the generated SDK yet: the route is new (dashboard.policies.get/update).
export const POLICIES_URL = "/api/v1/admin/settings/policies";
export const policiesQuery = {
  queryKey: ["settings", "policies"] as const,
  queryFn: () => apiData(apiClient.get<{ 200: { success: boolean; data: PoliciesPayload } }>({ url: POLICIES_URL })),
};

/** The store's content pages (drafts too), for linking a policy to one. */
export const storePagesQuery = pagesQueryOptions({ page: 1, limit: 100, contentType: "page", sort: "title", order: "asc" });

// ── Notifications ────────────────────────────────────────────────────────

export const customerRulesQuery = {
  queryKey: queryKeys.settings.notificationChannels(),
  queryFn: () => apiData(getApiV1AdminSettingsNotificationChannels()),
};
export const emailQuery = {
  queryKey: queryKeys.settings.email(),
  queryFn: () => apiData(getApiV1AdminSettingsEmail()),
};
export const smsQuery = {
  queryKey: queryKeys.settings.sms(),
  queryFn: () => apiData(getApiV1AdminSettingsSms()),
};
export const authQuery = {
  queryKey: queryKeys.settings.auth(),
  queryFn: () => apiData(getApiV1AdminSettingsAuth()),
};
export const firebaseQuery = {
  queryKey: queryKeys.settings.firebase(),
  queryFn: () => apiData(getApiV1AdminSettingsFirebase()),
};

export interface TemplatesData {
  templates: NotificationTemplates;
  revision: number;
  /** The checkout language: the defaults' and the email frame's. */
  language: MessageLanguage;
  /** The store as its emails show it; `nameFromAddress` when no business name is set. */
  store: EmailStore & { storefrontUrl: string | null; nameFromAddress: boolean };
}

// Stopgap until `pnpm generate:sdk` adds the notification template operations.
export const TEMPLATES_URL = "/api/v1/admin/settings/notification-channels/templates";

export const templatesQuery = {
  queryKey: [...queryKeys.settings.notificationChannels(), "templates"] as const,
  queryFn: async () => (await apiData(apiClient.get({ url: TEMPLATES_URL }))) as TemplatesData,
};

// ── Customer accounts ────────────────────────────────────────────────────

export const signInPolicyQuery = {
  queryKey: [...authQuery.queryKey, "policy"],
  queryFn: async () => {
    const auth = await authQuery.queryFn();
    return {
      identity: auth.customerIdentity,
      revision: auth.revision,
    };
  },
};

// ── Apps ─────────────────────────────────────────────────────────────────

const TRACKING_PARAMS = { page: 1, limit: 100, sort: "name", order: "asc", trashed: "false" } as const;
export const trackingQuery = {
  queryKey: queryKeys.analytics.list(TRACKING_PARAMS),
  queryFn: () => apiData(getApiV1AdminAnalytics({ query: TRACKING_PARAMS })),
};

export const metaQuery = {
  queryKey: queryKeys.settings.metaConversions(),
  queryFn: () => apiData(getApiV1AdminSettingsMetaConversions()),
};

const LIST_LIMIT = 100;

/** Active connections plus how many old ones "Clear old connections" would remove. */
export const aiAccessQuery = {
  queryKey: ["agent-access", "card"] as const,
  queryFn: async () => {
    const [page, clearable] = await Promise.all([
      listAgentConnections({ page: 1, limit: LIST_LIMIT, status: "active" }),
      countClearableAgentConnections(),
    ]);
    return {
      connections: page.connections,
      total: page.pagination.total,
      clearable: clearable.total,
      // The server's verdict on this session (store owner, two-step verified).
      canManage: page.canManage === true,
    };
  },
};

// ── Staff ────────────────────────────────────────────────────────────────

export const staffQuery = { queryKey: queryKeys.adminUsers.list(), queryFn: getAdminUsers };
export const rolesQuery = { queryKey: queryKeys.rbac.roles(), queryFn: getRbacRoles };

// ── Advanced ─────────────────────────────────────────────────────────────

export const trustedWebsitesQuery = {
  queryKey: queryKeys.settings.security(),
  // Platform origins are always trusted, so only merchant additions show.
  queryFn: async () => {
    const [security, inherited] = await Promise.all([
      apiData(getApiV1AdminSettingsSecurity()),
      apiData(getApiV1AdminSettingsSecurityRuntimeSources()),
    ]);
    const platform = new Set(inherited.map((source) => source.source).filter(Boolean));
    return {
      sources: parseMerchantCspSources(security.cspAllowedDomains).filter((source) => !platform.has(source)),
      revision: security.revision,
    };
  },
};

export interface MediaValues {
  canonicalCdnUrl: string;
  aliases: string;
}

export const mediaQuery = {
  queryKey: queryKeys.settings.media(),
  queryFn: async (): Promise<MediaValues & { revision: number }> => {
    const data = (await apiData(getApiV1AdminSettingsMedia())) as {
      canonicalCdnUrl?: string;
      canonicalHostAliases?: string[];
      revision: number;
    };
    return {
      canonicalCdnUrl: data.canonicalCdnUrl ?? "",
      aliases: (data.canonicalHostAliases ?? []).join("\n"),
      revision: data.revision,
    };
  },
};
