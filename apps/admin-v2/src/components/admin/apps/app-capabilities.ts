// Where each kind of app provider is set up: the settings page of its
// capability (Shopify: a payment app under Settings → Payments, a carrier
// under Shipping), never the app's own page. A link to
// `capabilityPath(kind)` with `providerHash(id)` opens that page with the
// provider's setup sheet open (AppProviderSheetHost). Kept free of React and
// of the settings pages, so search and the app page link here cheaply.
import type { SettingsNavKey } from "../settings/settings-nav";

export const APP_PROVIDER_KINDS = ["payment", "courier", "sms", "email", "fraud", "tax", "translation", "ai"] as const;
export type AppProviderKind = (typeof APP_PROVIDER_KINDS)[number];

/** The settings page and card each kind lives on. */
export const PROVIDER_CAPABILITY: Readonly<Record<AppProviderKind, { page: SettingsNavKey; to: string; card: string }>> = {
  payment: { page: "payments", to: "/admin/settings/payments", card: "paymentMethods" },
  courier: { page: "shipping", to: "/admin/settings/shipping", card: "couriers" },
  sms: { page: "notifications", to: "/admin/settings/notifications", card: "sending" },
  email: { page: "notifications", to: "/admin/settings/notifications", card: "sending" },
  fraud: { page: "integrations", to: "/admin/settings/integrations", card: "fraudCheck" },
  tax: { page: "taxes", to: "/admin/settings/taxes", card: "taxCollection" },
  translation: { page: "languages", to: "/admin/settings/languages", card: "machineTranslation" },
  ai: { page: "integrations", to: "/admin/settings/integrations", card: "aiDrafting" },
};

const PREFIX = "app-provider=";

export function isAppProviderKind(kind: string): kind is AppProviderKind {
  return (APP_PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** The URL hash that opens an app provider's setup sheet (`<plugin id>:<provider id>`). */
export function providerHash(id: string): string {
  return `${PREFIX}${id}`;
}

/** The provider a URL hash asks to open, or null. */
export function providerFromHash(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!value.startsWith(PREFIX)) return null;
  const id = decodeURIComponent(value.slice(PREFIX.length));
  return /^[a-z0-9.-]+:[a-z][a-z0-9-]{0,47}$/.test(id) ? id : null;
}

/** The plugin id of `<plugin id>:<provider id>`. */
export function providerPluginId(id: string): string {
  return id.slice(0, id.indexOf(":"));
}
