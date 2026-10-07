import {
  ArrowDownUp,
  Bell,
  Blocks,
  CreditCard,
  Database,
  FileText,
  Globe,
  MapPin,
  Receipt,
  Share2,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Truck,
  UserRound,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { translate } from "~/i18n";
import { settingsNavMessages } from "~/i18n/settings";
import { titleHead } from "~/i18n/page-titles";

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
  { key: "markets", to: "/admin/settings/markets", icon: Globe, group: "selling" },
  { key: "salesChannels", to: "/admin/settings/sales-channels", icon: Share2, group: "selling" },
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

/** Route `head` for a settings page, in the dashboard language. */
export function settingsHead(key: SettingsNavKey) {
  return titleHead(translate(settingsNavMessages, key));
}
