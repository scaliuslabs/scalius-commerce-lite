// The dashboard sidebar: one list of sections, filtered by the same page
// permission map that guards the routes, so a link is shown exactly when its
// page would open.
import {
  BadgePercent,
  FileText,
  House,
  Inbox,
  Settings,
  Store,
  Tag,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { shellMessages } from "~/i18n/shell";

type ShellKey = keyof (typeof shellMessages)["en"];

export interface NavLink {
  key: ShellKey;
  to: string;
}

export interface NavItem {
  key: ShellKey;
  /** Own page; sections without one open their first visible child. */
  to?: string;
  icon: LucideIcon;
  children?: NavLink[];
  /** Sits under a small group label (Shopify's "Sales channels ›"). */
  group?: ShellKey;
}

export const ADMIN_NAV: readonly NavItem[] = [
  { key: "home", to: "/admin", icon: House },
  { key: "orders", to: "/admin/orders", icon: Inbox },
  {
    key: "products",
    to: "/admin/products",
    icon: Tag,
    children: [
      { key: "collections", to: "/admin/collections" },
      { key: "categories", to: "/admin/categories" },
      { key: "inventory", to: "/admin/inventory" },
      { key: "attributes", to: "/admin/attributes" },
    ],
  },
  { key: "customers", to: "/admin/customers", icon: UserRound },
  { key: "discounts", to: "/admin/discounts", icon: BadgePercent },
  {
    key: "content",
    icon: FileText,
    children: [
      { key: "pages", to: "/admin/pages" },
      { key: "blogPosts", to: "/admin/articles" },
      { key: "files", to: "/admin/media" },
    ],
  },
  {
    key: "onlineStore",
    group: "salesChannels",
    icon: Store,
    children: [
      { key: "theme", to: "/admin/online-store/theme" },
      { key: "navigation", to: "/admin/online-store/navigation" },
      { key: "homepageBanners", to: "/admin/online-store/banners" },
      { key: "preferences", to: "/admin/online-store/preferences" },
    ],
  },
];

export const SETTINGS_ITEM: { key: ShellKey; to: string; icon: LucideIcon } = { key: "settings", to: "/admin/settings", icon: Settings };

export interface VisibleNavItem {
  key: ShellKey;
  to: string;
  icon: LucideIcon;
  children: NavLink[];
  group?: ShellKey;
}

/** Shopify-style sequences: G then the letter, within a second. */
export const GO_SHORTCUTS: Readonly<Record<string, string>> = {
  h: "/admin",
  o: "/admin/orders",
  p: "/admin/products",
  c: "/admin/customers",
  d: "/admin/discounts",
  s: "/admin/settings",
};

/**
 * Settings pages as search destinations. Keywords are the words merchants
 * type (English and Bangla), so "cod", "bkash" or "কুরিয়ার" lands on the page.
 */
export const SETTINGS_DESTINATIONS: ReadonlyArray<{ key: ShellKey; to: string; keywords: string }> = [
  { key: "settingsStore", to: "/admin/settings/store", keywords: "store name address phone logo currency domain country স্টোর ঠিকানা মুদ্রা" },
  { key: "settingsUsers", to: "/admin/settings/users", keywords: "staff team users roles permissions ইউজার স্টাফ" },
  { key: "settingsPayments", to: "/admin/settings/payments", keywords: "payment cod cash on delivery bkash nagad sslcommerz stripe card advance পেমেন্ট ক্যাশ বিকাশ নগদ" },
  { key: "settingsCheckout", to: "/admin/settings/checkout", keywords: "checkout guest form fields language চেকআউট" },
  { key: "settingsShipping", to: "/admin/settings/shipping", keywords: "shipping delivery courier pathao steadfast redx area charge ডেলিভারি কুরিয়ার শিপিং" },
  { key: "settingsTaxes", to: "/admin/settings/taxes", keywords: "tax vat ট্যাক্স ভ্যাট" },
  { key: "settingsNotifications", to: "/admin/settings/notifications", keywords: "notification sms email whatsapp push নোটিফিকেশন এসএমএস" },
  { key: "settingsPolicies", to: "/admin/settings/policies", keywords: "policy return refund নীতিমালা রিটার্ন" },
  { key: "settingsApps", to: "/admin/settings/apps", keywords: "apps tracking facebook meta pixel google analytics fraud scanner ai অ্যাপ" },
  { key: "settingsCustomerAccounts", to: "/admin/settings/customer-accounts", keywords: "customer sign in login otp কাস্টমার লগইন" },
  { key: "settingsAdvanced", to: "/admin/settings/advanced", keywords: "advanced developer sso setup token refresh অ্যাডভান্সড" },
];

export function visibleNav(canOpen: (path: string) => boolean): VisibleNavItem[] {
  return ADMIN_NAV.flatMap((item) => {
    const children = (item.children ?? []).filter((child) => canOpen(child.to));
    const to = item.to && canOpen(item.to) ? item.to : children[0]?.to;
    return to ? [{ key: item.key, to, icon: item.icon, children, group: item.group }] : [];
  });
}

export function matchesPath(path: string, to: string): boolean {
  if (to === "/admin") return path === "/admin" || path === "/admin/";
  return path === to || path.startsWith(`${to}/`);
}

export function isSectionActive(path: string, item: VisibleNavItem): boolean {
  return matchesPath(path, item.to) || item.children.some((child) => matchesPath(path, child.to));
}
