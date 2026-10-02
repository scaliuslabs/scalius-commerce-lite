import {
  ArrowDownUp,
  Bell,
  Blocks,
  CreditCard,
  Database,
  FileText,
  MapPin,
  Receipt,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Truck,
  UserRound,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

/**
 * The settings pages in Shopify's order (the navigation panel lists them
 * flat); the phone list shows them in themed groups. Labels come from
 * `settingsNavMessages` (`~/i18n/settings`) under the same `key`; group
 * headings from `settingsGroupMessages`.
 */
export const SETTINGS_NAV = [
  { key: "store", to: "/admin/settings/store", icon: Store, group: "general" },
  { key: "users", to: "/admin/settings/users", icon: Users, group: "general" },
  { key: "payments", to: "/admin/settings/payments", icon: CreditCard, group: "selling" },
  { key: "checkout", to: "/admin/settings/checkout", icon: ShoppingCart, group: "selling" },
  { key: "customerAccounts", to: "/admin/settings/customer-accounts", icon: UserRound, group: "customers" },
  { key: "shipping", to: "/admin/settings/shipping", icon: Truck, group: "selling" },
  { key: "taxes", to: "/admin/settings/taxes", icon: Receipt, group: "selling" },
  { key: "locations", to: "/admin/settings/locations", icon: MapPin, group: "general" },
  { key: "integrations", to: "/admin/settings/integrations", icon: Blocks, group: "more" },
  { key: "notifications", to: "/admin/settings/notifications", icon: Bell, group: "customers" },
  { key: "webhooks", to: "/admin/settings/webhooks", icon: Webhook, group: "more" },
  { key: "customData", to: "/admin/settings/custom-data", icon: Database, group: "more" },
  { key: "policies", to: "/admin/settings/policies", icon: FileText, group: "general" },
  { key: "importExport", to: "/admin/settings/import-export", icon: ArrowDownUp, group: "more" },
  { key: "advanced", to: "/admin/settings/advanced", icon: SlidersHorizontal, group: "more" },
] as const satisfies ReadonlyArray<{ key: string; to: string; icon: LucideIcon; group: string }>;

export const SETTINGS_GROUPS = ["general", "selling", "customers", "more"] as const;

export type SettingsNavKey = (typeof SETTINGS_NAV)[number]["key"];
