import { createServerFn } from "@tanstack/react-start";
import type { CustomerAuthMethod } from "@scalius/shared/customer-auth-policy";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";
export {
  getStorefrontUrl,
  updateStorefrontUrl,
  type StorefrontUrlPayload,
  type UpdateStorefrontUrlInput,
} from "./storefront-url";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SettingsPayload = { [key: string]: JsonValue };
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

export interface NavigationItemConfig {
  id: string;
  title: string;
  href?: string;
  subMenu?: NavigationItemConfig[];
}

export interface HeaderConfigInput {
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
  navigation: NavigationItemConfig[];
}

export interface FooterConfigInput {
  logo: LogoConfig;
  tagline: string;
  description: string;
  copyrightText: string;
  menus: Array<{
    id: string;
    title: string;
    links: NavigationItemConfig[];
  }>;
  social: SocialLinkConfig[];
}

export interface GeneralSettingsPayload {
  headerConfig: SettingsPayload;
  footerConfig: SettingsPayload;
}
export type SeoSettingsPayload = SettingsPayload;
export type UpdateSeoSettingsInput = SettingsPayload;
export type SecuritySettingsPayload = SettingsPayload;
export type UpdateSecuritySettingsInput = SettingsPayload;
export type AuthVerificationMethod = CustomerAuthMethod;
export type CheckoutMode = "guest_cod_only" | "gateways_only" | "all";
export interface AuthSettingsPayload {
  authVerificationMethod: AuthVerificationMethod | string;
  customerAuthPolicy?: SettingsPayload;
  guestCheckoutEnabled: boolean;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappTemplateName: string;
  checkoutMode: CheckoutMode | string;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number | null;
}
export type UpdateAuthSettingsInput = SettingsPayload;
export interface CheckoutReadinessPayload {
  ready: boolean;
  hasActiveShippingMethod: boolean;
  hasActiveDeliveryHierarchy: boolean;
  issues: string[];
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
export interface ThemeSettingsPayload extends SettingsPayload {
  colors: SettingsPayload;
}
export type UpdateThemeSettingsInput = SettingsPayload;
export type MediaSettingsPayload = SettingsPayload;
export type UpdateMediaSettingsInput = SettingsPayload;
export type WidgetAiSettingsPayload = SettingsPayload;
export type UpdateWidgetAiSettingsInput = SettingsPayload;
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
export type MetaConversionsSettingsPayload = SettingsPayload;
export type UpdateMetaConversionsSettingsInput = SettingsPayload;
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
  whatsappConfigured?: boolean;
}
export type UpdateNotificationChannelsInput = NotificationChannelsPayload;
export type AdminNotificationChannelsPayload = NotificationChannelsPayload;
export type UpdateAdminNotificationChannelsInput = NotificationChannelsPayload;

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
    return apiPost<EmptyPayload>("/settings/header", data);
  });

export const saveFooterConfig = createServerFn({ method: "POST" })
  .validator((data: FooterConfigInput) => data)
  .handler(async ({ data }) => {
    return apiPost<EmptyPayload>("/settings/footer", data);
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

export const getCheckoutReadiness = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<CheckoutReadinessPayload>("/settings/checkout-readiness");
  },
);

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
    return apiPost<MessagePayload>("/settings/theme", data);
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

export const getWidgetAiSettings = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<WidgetAiSettingsPayload>("/settings/widget-ai");
  },
);

export const updateWidgetAiSettings = createServerFn({ method: "POST" })
  .validator((data: UpdateWidgetAiSettingsInput) => data)
  .handler(async ({ data }) => {
    return apiPost<MessagePayload>("/settings/widget-ai", data);
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
    return apiPost<SettingsPayload>("/settings/meta-conversions", data);
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
