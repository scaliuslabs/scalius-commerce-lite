import {
  Bell,
  Blocks,
  CreditCard,
  FileText,
  Receipt,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Truck,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { translate } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";

/**
 * Shopify-style settings list, in themed groups. Labels come from
 * `settingsNavMessages` (`~/i18n/settings`) under the same `key`; group
 * headings from `settingsGroupMessages`.
 */
export const SETTINGS_NAV = [
  { key: "store", to: "/admin/settings/store", icon: Store, group: "general" },
  { key: "users", to: "/admin/settings/users", icon: Users, group: "general" },
  { key: "policies", to: "/admin/settings/policies", icon: FileText, group: "general" },
  { key: "payments", to: "/admin/settings/payments", icon: CreditCard, group: "selling" },
  { key: "checkout", to: "/admin/settings/checkout", icon: ShoppingCart, group: "selling" },
  { key: "shipping", to: "/admin/settings/shipping", icon: Truck, group: "selling" },
  { key: "taxes", to: "/admin/settings/taxes", icon: Receipt, group: "selling" },
  { key: "customerAccounts", to: "/admin/settings/customer-accounts", icon: UserRound, group: "customers" },
  { key: "notifications", to: "/admin/settings/notifications", icon: Bell, group: "customers" },
  { key: "apps", to: "/admin/settings/apps", icon: Blocks, group: "more" },
  { key: "advanced", to: "/admin/settings/advanced", icon: SlidersHorizontal, group: "more" },
] as const satisfies ReadonlyArray<{ key: string; to: string; icon: LucideIcon; group: string }>;

export const SETTINGS_GROUPS = ["general", "selling", "customers", "more"] as const;

export type SettingsNavKey = (typeof SETTINGS_NAV)[number]["key"];

/** Route `head` for a settings page, in the dashboard language. */
export function settingsHead(key: SettingsNavKey) {
  return { meta: [{ title: `${translate(settingsNavMessages, key)} | Scalius Admin` }] };
}
