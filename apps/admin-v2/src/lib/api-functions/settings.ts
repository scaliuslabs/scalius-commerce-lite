import { createServerFn } from "@tanstack/react-start";
import type { CustomerAuthMethod } from "@scalius/shared/customer-auth-policy";
import type { StorefrontThemeSettings } from "@scalius/shared/storefront-theme";
import type {
  CustomerRequestPolicy,
  CustomerRequestPreviewState,
} from "@scalius/core/modules/settings/customer-request-policy";
import type {
  GetApiV1AdminSettingsCheckoutFlowResponses,
  GetApiV1AdminSettingsCheckoutReadinessResponses,
  GetApiV1AdminSettingsSeoResponses,
  PostApiV1AdminSettingsSeoData,
  PutApiV1AdminSettingsCheckoutFlowData,
} from "@scalius/api-client/types";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";
import type {
  MetaConversionsSettings,
  MetaConversionsSettingsResponse,
} from "../../types/api-responses";
export {
  getStorefrontUrl,
  updateStorefrontUrl,
  type StorefrontUrlPayload,
  type UpdateStorefrontUrlInput,
} from "./storefront-url";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SettingsPayload = { [key: string]: JsonValue };
type ApiEnvelopeData<T> = T extends { success: true; data: infer D }
  ? D
  : never;
export type MessagePayload = { message?: string };
export type EmptyPayload = Record<string, never>;
export type SettingsByCategoryInput = { category: string };
export type UpdateSettingsByCategoryInput = SettingsByCategoryInput & {
  settings: SettingsPayload;
};

export interface SocialLinkConfig {
  id: string;
  label: string;
  url: string;
  iconUrl?: string;
}

export interface LogoConfig {
  src: string;
  alt: string;
}

export interface FaviconConfig {
  src: string;
  alt: string;
}

export interface HeaderConfigInput {
  expectedRevision: number;
  topBar: {
    text: string;
    isEnabled: boolean;
  };
  logo: LogoConfig;
  favicon: FaviconConfig;
  contact: {
    phone: string;
    text: string;
    isEnabled: boolean;
  };
  social: SocialLinkConfig[];
}

export interface FooterConfigInput {
  expectedRevision: number;
  logo: LogoConfig;
  tagline: string;
  description: string;
  copyrightText: string;
  social: SocialLinkConfig[];
}

export interface GeneralSettingsPayload {
  headerConfig: SettingsPayload;
  footerConfig: SettingsPayload;
  revisions: {
    header: number;
    footer: number;
  };
  navigationReadiness: {
    header: NavigationConfigSectionReadiness;
    footer: NavigationConfigSectionReadiness;
  };
}
export type NavigationConfigReadinessState =
  | "ready"
  | "legacy_normalized"
  | "invalid";
export interface NavigationConfigSectionReadiness {
  state: NavigationConfigReadinessState;
  message?: string;
}
export type SeoSettingsPayload = ApiEnvelopeData<
  GetApiV1AdminSettingsSeoResponses[200]
>;
export type UpdateSeoSettingsInput = NonNullable<
  PostApiV1AdminSettingsSeoData["body"]
>;
export type SecuritySettingsPayload = SettingsPayload;
export type UpdateSecuritySettingsInput = SettingsPayload;
export type AuthVerificationMethod = CustomerAuthMethod;
export interface AuthSettingsPayload {
  authVerificationMethod: AuthVerificationMethod | string;
  customerAuthPolicy?: SettingsPayload;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappTemplateName: string;
}
export type CheckoutFlowSettingsPayload = ApiEnvelopeData<
  GetApiV1AdminSettingsCheckoutFlowResponses[200]
>;
export type CheckoutMode = CheckoutFlowSettingsPayload["checkoutMode"];
export type UpdateCheckoutFlowSettingsInput = NonNullable<
  PutApiV1AdminSettingsCheckoutFlowData["body"]
>;
export type UpdateAuthSettingsInput = SettingsPayload;
export type CheckoutReadinessPayload = ApiEnvelopeData<
  GetApiV1AdminSettingsCheckoutReadinessResponses[200]
>;
export interface CustomerRequestPolicyPayload {
  policy: CustomerRequestPolicy;
  resolvedIntro: string;
  preview: CustomerRequestPreviewState[];
}
export type EmailProvider = "cloudflare" | "resend";
export interface EmailSettingsPayload extends SettingsPayload {
  provider: EmailProvider;
  apiKey: string;
  sender: string;
  senderConfigured: boolean;
  cloudflareBindingConfigured: boolean;
  resendConfigured: boolean;
  ready: boolean;
  readinessError: string | null;
}
export type UpdateEmailSettingsInput = SettingsPayload;
export interface FirebaseSettingsPayload extends SettingsPayload {
  serviceAccount: string;
  publicConfig: SettingsPayload;
}
export type UpdateFirebaseSettingsInput = SettingsPayload;
export type BusinessSettingsPayload = SettingsPayload;
export type UpdateBusinessSettingsInput = SettingsPayload;
export interface ThemeSettingsPayload {
  theme: StorefrontThemeSettings;
  revision: number;
}
export interface UpdateThemeSettingsInput {
  expectedRevision: number;
  theme: StorefrontThemeSettings;
}
export interface ThemeDraftPayload {
  theme: StorefrontThemeSettings;
  revision: number;
  basePublishedRevision: number;
  updatedAt: string | number | null;
}
export interface ThemeWorkspacePayload {
  published: ThemeSettingsPayload;
  draft: ThemeDraftPayload;
}
export interface SaveThemeDraftInput {
  theme: StorefrontThemeSettings;
  expectedDraftRevision: number;
  basePublishedRevision: number;
}
export interface PublishThemeDraftInput {
  expectedPublishedRevision: number;
  expectedDraftRevision: number;
}
export interface ThemeVersionPayload extends ThemeSettingsPayload {
  id: string;
  source: "publish" | "rollback" | "migration";
  sourceRevision: number | null;
  publishedBy: string | null;
  createdAt: string | number;
}
export interface ThemeVersionsPayload {
  versions: ThemeVersionPayload[];
}
export interface RollbackThemeInput extends PublishThemeDraftInput {
  sourceRevision: number;
}
export interface ThemePreviewSessionInput {
  expectedDraftRevision: number;
}
export interface ThemePreviewSessionPayload {
  token: string;
  draftRevision: number;
  basePublishedRevision: number;
  expiresAt: string | number;
}
export type MediaSettingsPayload = SettingsPayload;
export type UpdateMediaSettingsInput = SettingsPayload;
export type SmsProvider = "smsnetbd" | "bdbulksms" | "mimsms" | "gennet";
export interface SmsSettingsPayload {
  activeProvider?: SmsProvider | string;
  activeProviderConfigured?: boolean;
  activeProviderError?: string | null;
  smsnetbdApiKey?: string;
  smsnetbdSenderId?: string;
  bdbulksmsToken?: string;
  mimsmsUsername?: string;
  mimsmsApiKey?: string;
  mimsmsSenderName?: string;
  gennetApiToken?: string;
  gennetBaseUrl?: string;
  gennetSid?: string;
}
export type UpdateSmsSettingsInput = SettingsPayload;
export type MetaConversionsSettingsPayload = MetaConversionsSettingsResponse;
export interface UpdateMetaConversionsSettingsInput {
  pixelId?: string;
  accessToken?: string;
  testEventCode?: string;
  isEnabled: boolean;
  logRetentionDays: number;
}
export type MetaConversionsLogsInput = { page?: number; limit?: number };
export type MetaConversionsLogsPayload = SettingsPayload;
export interface AllowedCountriesPayload extends SettingsPayload {
  allowedCountries: string[];
  allowedCountriesMode: string;
}
export interface UpdateAllowedCountriesInput {
  allowedCountries: string[];
  mode?: "include" | "exclude";
}
export type PaymentMethodKey = "stripe" | "sslcommerz" | "polar" | "cod";
export interface PaymentGatewayStatus {
  configured: boolean;
  enabled: boolean;
  usable?: boolean;
  missingFields?: string[];
  blockedReason?: string;
  providerEnabled?: boolean;
  checkoutSelected?: boolean;
  checkoutVisible?: boolean;
}
export interface PaymentMethodsPayload {
  enabledMethods: string[];
  defaultMethod: string;
  activeMethods?: string[];
  activeDefaultMethod?: string;
  gatewayStatus: Record<PaymentMethodKey, PaymentGatewayStatus>;
}
export interface UpdatePaymentMethodsInput {
  enabledMethods: PaymentMethodKey[];
  defaultMethod: PaymentMethodKey;
}
export type PaymentGatewaySettingsInput = { gateway: string };
export type UpdatePaymentGatewaySettingsInput = PaymentGatewaySettingsInput & {
  settings: SettingsPayload;
};
export interface NotificationChannelsPayload {
  channels: Record<string, string[]>;
  whatsappTemplate?: {
    templateName: string;
    languageCode: string;
  };
  emailConfigured?: boolean;
  emailError?: string | null;
  whatsappConfigured?: boolean;
  whatsappError?: string | null;
  smsProviderConfigured?: boolean;
  smsProviderError?: string | null;
}
export interface UpdateNotificationChannelsInput {
  channels: Record<string, string[]>;
  whatsappTemplate?: {
    templateName: string;
    languageCode: string;
  };
}
export interface AdminNotificationChannelsPayload {
  channels: Record<string, string[]>;
  pushConfigured?: boolean;
  pushError?: string | null;
}
export interface UpdateAdminNotificationChannelsInput {
  channels: Record<string, string[]>;
}

export const getSettingsByCategory = createServerFn({ method: "GET" })
  .validator((data: SettingsByCategoryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<SettingsPayload>(`/settings/${data.category}`);
  });

export const updateSettingsByCategory = createServerFn({ method: "POST" })
  .validator((data: UpdateSettingsByCategoryInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>(`/settings/${data.category}`, data.settings);
  });

export const getGeneralSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<GeneralSettingsPayload>("/settings/general");
  },
);

export const saveHeaderConfig = createServerFn({ method: "POST" })
  .validator((data: HeaderConfigInput) => data)
  .handler(async ({ data }) => {
    return apiPost<{ revision: number }>("/settings/header", data);
  });

export const saveFooterConfig = createServerFn({ method: "POST" })
  .validator((data: FooterConfigInput) => data)
  .handler(async ({ data }) => {
    return apiPost<{ revision: number }>("/settings/footer", data);
  });

export const getSeoSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<SeoSettingsPayload>("/settings/seo");
  },
);

export const updateSeoSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateSeoSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/seo", data);
  });

export const getSecuritySettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<SecuritySettingsPayload>("/settings/security");
  },
);

export const updateSecuritySettings = createServerFn({ method: "POST" })
  .validator((data: UpdateSecuritySettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/security", data);
  });

export const getAuthSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<AuthSettingsPayload>("/settings/auth");
  },
);

export const updateAuthSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateAuthSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/auth", data);
  });

export const getCheckoutFlowSettings = createServerFn({ method: "GET" }).handler(
  async () => apiGet<CheckoutFlowSettingsPayload>("/settings/checkout-flow"),
);

export const updateCheckoutFlowSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateCheckoutFlowSettingsInput) => data)
  .handler(async ({ data }) => (
    apiPut<CheckoutFlowSettingsPayload>("/settings/checkout-flow", data)
  ));

export const getCheckoutReadiness = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<CheckoutReadinessPayload>("/settings/checkout-readiness");
  },
);

export const getCustomerRequestPolicySettings = createServerFn({ method: "GET" }).handler(
  async () => apiGet<CustomerRequestPolicyPayload>("/settings/customer-requests"),
);

export const updateCustomerRequestPolicySettings = createServerFn({ method: "POST" })
  .validator((data: CustomerRequestPolicy) => data)
  .handler(async ({ data }) => (
    apiPut<CustomerRequestPolicyPayload>("/settings/customer-requests", data)
  ));

export const getEmailSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<EmailSettingsPayload>("/settings/email");
  },
);

export const updateEmailSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateEmailSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/email", data);
  });

export const getFirebaseSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<FirebaseSettingsPayload>("/settings/firebase");
  },
);

export const updateFirebaseSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateFirebaseSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/firebase", data);
  });

export const getBusinessSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<BusinessSettingsPayload>("/settings/business");
  },
);

export const updateBusinessSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateBusinessSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/business", data);
  });

export const getThemeSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<ThemeSettingsPayload>("/settings/theme");
  },
);

export const updateThemeSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateThemeSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ThemeSettingsPayload & MessagePayload>("/settings/theme", data);
  });

export const getThemeWorkspace = createServerFn({ method: "GET" }).handler(
  async (): Promise<ThemeWorkspacePayload> => {
    return apiGet<ThemeWorkspacePayload>("/settings/theme/workspace");
  },
);

export const saveThemeDraft = createServerFn({ method: "POST" })
  .validator((data: SaveThemeDraftInput) => data)
  .handler(async ({ data }): Promise<ThemeDraftPayload> => {
    return apiPost<ThemeDraftPayload>("/settings/theme/draft", data);
  });

export const rebaseThemeDraft = createServerFn({ method: "POST" })
  .validator((data: SaveThemeDraftInput) => data)
  .handler(async ({ data }): Promise<ThemeDraftPayload> => {
    return apiPost<ThemeDraftPayload>("/settings/theme/draft/rebase", data);
  });

export const publishThemeDraft = createServerFn({ method: "POST" })
  .validator((data: PublishThemeDraftInput) => data)
  .handler(async ({ data }): Promise<ThemeWorkspacePayload> => {
    return apiPost<ThemeWorkspacePayload>("/settings/theme/publish", data);
  });

export const getThemeVersions = createServerFn({ method: "GET" }).handler(
  async (): Promise<ThemeVersionsPayload> => {
    return apiGet<ThemeVersionsPayload>("/settings/theme/versions", { limit: "20" });
  },
);

export const rollbackTheme = createServerFn({ method: "POST" })
  .validator((data: RollbackThemeInput) => data)
  .handler(async ({ data }): Promise<ThemeWorkspacePayload> => {
    return apiPost<ThemeWorkspacePayload>("/settings/theme/rollback", data);
  });

export const createThemePreviewSession = createServerFn({ method: "POST" })
  .validator((data: ThemePreviewSessionInput) => data)
  .handler(async ({ data }): Promise<ThemePreviewSessionPayload> => {
    return apiPost<ThemePreviewSessionPayload>("/settings/theme/preview-session", data);
  });

export const getMediaSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<MediaSettingsPayload>("/settings/media");
  },
);

export const updateMediaSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateMediaSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/media", data);
  });

export const getSmsSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<SmsSettingsPayload>("/settings/sms");
  },
);

export const updateSmsSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateSmsSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/sms", data);
  });

export const getMetaConversionsSettings = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<MetaConversionsSettingsPayload>("/settings/meta-conversions");
});

export const updateMetaConversionsSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateMetaConversionsSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MetaConversionsSettings>("/settings/meta-conversions", data);
  });

export const getMetaConversionsLogs = createServerFn({ method: "GET" })
  .validator((data: MetaConversionsLogsInput) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page) params.page = String(data.page);
    if (data.limit) params.limit = String(data.limit);
    return apiGet<MetaConversionsLogsPayload>(
      "/settings/meta-conversions/logs",
      params,
    );
  });

export const clearMetaConversionsLogs = createServerFn({
  method: "POST",
}).handler(async () => {
  return apiDelete<MessagePayload>("/settings/meta-conversions/logs");
});

export const cleanupMetaConversionsLogs = createServerFn({
  method: "POST",
}).handler(async () => {
  return apiPost<MessagePayload>("/settings/meta-conversions/logs");
});

export const getAllowedCountries = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<AllowedCountriesPayload>("/settings/allowed-countries");
  },
);

export const updateAllowedCountries = createServerFn({ method: "POST" })
  .validator((data: UpdateAllowedCountriesInput) => data)
  .handler(async ({ data }) => {
    return apiPut<MessagePayload>("/settings/allowed-countries", data);
  });

export const getPaymentMethods = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<PaymentMethodsPayload>("/settings/payment-methods");
  },
);

export const updatePaymentMethods = createServerFn({ method: "POST" })
  .validator((data: UpdatePaymentMethodsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/payment-methods", data);
  });

export const getPaymentGatewaySettings = createServerFn({ method: "GET" })
  .validator((data: PaymentGatewaySettingsInput) => data)
  .handler(async ({ data }) => {
    return apiGet<SettingsPayload>(`/settings/${data.gateway}`);
  });

export const updatePaymentGatewaySettings = createServerFn({ method: "POST" })
  .validator((data: UpdatePaymentGatewaySettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>(`/settings/${data.gateway}`, data.settings);
  });

export const getNotificationChannels = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<NotificationChannelsPayload>("/settings/notification-channels");
});

export const updateNotificationChannels = createServerFn({ method: "POST" })
  .validator((data: UpdateNotificationChannelsInput) => data)
  .handler(async ({ data }) => {
    return apiPut<NotificationChannelsPayload>(
      "/settings/notification-channels",
      data,
    );
  });

export const getAdminNotificationChannels = createServerFn({
  method: "GET",
}).handler(async () => {
  return apiGet<AdminNotificationChannelsPayload>(
    "/settings/notification-channels/admin-channels",
  );
});

export const updateAdminNotificationChannels = createServerFn({
  method: "POST",
})
  .validator((data: UpdateAdminNotificationChannelsInput) => data)
  .handler(async ({ data }) => {
    return apiPut<AdminNotificationChannelsPayload>(
      "/settings/notification-channels/admin-channels",
      data,
    );
  });
