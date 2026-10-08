// An installed app's provider answers to the same permissions as the built-in
// providers of its port: reading the port's settings lists it (with its
// readiness), and what tests a built-in connection tests the app's.
// `GET /admin/settings/providers?kind=` and `POST …/providers/{id}/test` check
// the port here; the route map admits the union.
import type { ProviderKind } from "@scalius/shared/plugins/providers/kinds";
import { PERMISSIONS } from "./permissions";
import type { PermissionName } from "./types";

export interface ProviderPortPermissions {
  /** Any of these reads the port's providers (the built-in settings read). */
  view: readonly PermissionName[];
  /** Any of these tests a provider's connection (the built-in test or save). */
  manage: readonly PermissionName[];
}

export const PROVIDER_PORT_PERMISSIONS: Readonly<Record<ProviderKind, ProviderPortPermissions>> = {
  // Settings → Payments: GET/POST /settings/payment-methods.
  payment: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  // Settings → Notifications, email sender: GET/POST /settings/email.
  email: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  // Settings → Notifications, SMS sender: GET/POST /settings/sms.
  sms: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT] },
  // Settings → Shipping, couriers: /settings/delivery-providers.
  courier: { view: [PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW], manage: [PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT] },
  // Settings → Integrations, fraud check: /fraud-checker (its test is a read).
  fraud: { view: [PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW], manage: [PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW] },
  // Settings → Taxes: /taxes.
  tax: { view: [PERMISSIONS.TAXES_VIEW], manage: [PERMISSIONS.TAXES_MANAGE] },
  // Settings → Languages, machine translation: /settings/languages.
  translation: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  // Online store → theme editor, Draft with AI: /settings/theme/ai-draft.
  ai: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  // Settings → Notifications, chat channels and push: the notification channel rules.
  messaging: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT] },
  push: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT] },
  // Settings → Checkout (address autocomplete), Customer accounts (sign-in), Online store (search).
  search: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  address: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  identity: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
  // Settings → Markets, exchange rates: /settings/markets.
  fx: { view: [PERMISSIONS.SETTINGS_GENERAL_VIEW], manage: [PERMISSIONS.SETTINGS_GENERAL_EDIT] },
};

/** Whether these permissions read (`view`) or test (`manage`) a port's providers. */
export function canUseProviderPort(
  permissions: ReadonlySet<string> | undefined | null,
  kind: ProviderKind,
  access: keyof ProviderPortPermissions,
): boolean {
  return PROVIDER_PORT_PERMISSIONS[kind][access].some((permission) => permissions?.has(permission) ?? false);
}

/** Every permission that reads, or tests, some port: the route map's union. */
export function providerPortRouteUnion(access: keyof ProviderPortPermissions): PermissionName[] {
  return [...new Set(Object.values(PROVIDER_PORT_PERMISSIONS).flatMap((port) => port[access]))];
}
