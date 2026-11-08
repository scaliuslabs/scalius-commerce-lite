// Where each kind of app provider is chosen: the settings page of its
// capability (a payment app under Settings, Payments; a carrier under
// Shipping). The provider itself is set up on its feature's page in its app
// (`appProviderSetupPath`). Kept free of React and of the settings pages, so
// search and the app page link here cheaply.
import type { SettingsNavKey } from "../settings/settings-nav";

export const APP_PROVIDER_KINDS = [
  "payment", "courier", "sms", "email", "courier_history", "tax", "translation", "ai",
  "messaging", "push", "search", "address", "fx", "identity", "payout",
] as const;
export type AppProviderKind = (typeof APP_PROVIDER_KINDS)[number];

/** The settings page and card each kind lives on; `search` is the part of a split page that holds the card. */
export const PROVIDER_CAPABILITY: Readonly<Record<AppProviderKind, { page: SettingsNavKey; to: string; search?: { part: string }; card: string }>> = {
  payment: { page: "payments", to: "/admin/settings/payments", card: "paymentMethods" },
  courier: { page: "shipping", to: "/admin/settings/shipping", card: "couriers" },
  sms: { page: "notifications", to: "/admin/settings/notifications", search: { part: "sending" }, card: "sending" },
  email: { page: "notifications", to: "/admin/settings/notifications", search: { part: "sending" }, card: "sending" },
  courier_history: { page: "integrations", to: "/admin/settings/integrations", search: { part: "order-tools" }, card: "fraudCheck" },
  tax: { page: "taxes", to: "/admin/settings/taxes", card: "taxCollection" },
  translation: { page: "languages", to: "/admin/settings/languages", card: "machineTranslation" },
  ai: { page: "integrations", to: "/admin/settings/integrations", search: { part: "ai" }, card: "aiDrafting" },
  messaging: { page: "notifications", to: "/admin/settings/notifications", search: { part: "sending" }, card: "chatApps" },
  push: { page: "notifications", to: "/admin/settings/notifications", search: { part: "customers" }, card: "browserNotifications" },
  search: { page: "integrations", to: "/admin/settings/integrations", search: { part: "ai" }, card: "appSearch" },
  address: { page: "checkout", to: "/admin/settings/checkout", card: "addressAutocomplete" },
  fx: { page: "markets", to: "/admin/settings/markets", card: "exchangeRates" },
  identity: { page: "customerAccounts", to: "/admin/settings/customer-accounts", card: "otherSignIn" },
  payout: { page: "payments", to: "/admin/settings/payments", card: "payoutApps" },
};

export function isAppProviderKind(kind: string): kind is AppProviderKind {
  return (APP_PROVIDER_KINDS as readonly string[]).includes(kind);
}
