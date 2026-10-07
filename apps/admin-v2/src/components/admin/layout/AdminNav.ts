// The dashboard sidebar: one list of sections, filtered by the same page
// permission map that guards the routes, so a link is shown exactly when its
// page would open.
import {
  BadgePercent,
  Blocks,
  ChartColumn,
  FileText,
  House,
  Inbox,
  Settings,
  ShoppingBag,
  Store,
  Tag,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { shellMessages } from "~/i18n/shell";
import { GIFT_CARDS_NAV_ENABLED } from "../gift-cards/nav";
import { REVIEWS_NAV_ENABLED } from "../reviews/nav";

type ShellKey = keyof (typeof shellMessages)["en"];

export interface NavLink {
  key: ShellKey;
  to: string;
  /** A live count beside a sub-page (pending reviews). */
  badge?: NavBadge;
  /** An app's page: its own title (plain text) instead of the `key` label. */
  label?: string;
}

export interface NavItem {
  key: ShellKey;
  /** Own page; sections without one open their first visible child. */
  to?: string;
  icon: LucideIcon;
  children?: NavLink[];
  /** Sits under a small group label (Shopify's "Sales channels ›"). */
  group?: ShellKey;
  /**
   * A live count beside the label (the inbox's open conversations). A name,
   * not the component: this list loads with every page, the count's code with
   * the sidebar.
   */
  badge?: NavBadge;
}

export type NavBadge = "inbox" | "reviews";

/** Wave B pages join the menu when their slice turns them on (each flag lives with its feature). */
const when = (enabled: boolean, link: NavLink): NavLink[] => (enabled ? [link] : []);

export const ADMIN_NAV: readonly NavItem[] = [
  { key: "home", to: "/admin", icon: House },
  { key: "orders", to: "/admin/orders", icon: ShoppingBag },
  { key: "inbox", to: "/admin/inbox", icon: Inbox, badge: "inbox" },
  {
    key: "products",
    to: "/admin/products",
    icon: Tag,
    children: [
      { key: "collections", to: "/admin/collections" },
      { key: "categories", to: "/admin/categories" },
      { key: "brands", to: "/admin/brands" },
      { key: "inventory", to: "/admin/inventory" },
      { key: "purchaseOrders", to: "/admin/inventory/purchase-orders" },
      { key: "transfers", to: "/admin/inventory/transfers" },
      { key: "attributes", to: "/admin/attributes" },
      ...when(REVIEWS_NAV_ENABLED, { key: "reviews", to: "/admin/reviews", badge: "reviews" }),
      ...when(GIFT_CARDS_NAV_ENABLED, { key: "giftCards", to: "/admin/gift-cards" }),
    ],
  },
  {
    key: "customers",
    to: "/admin/customers",
    icon: UserRound,
    children: [{ key: "segments", to: "/admin/customers/segments" }],
  },
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
  // Shopify's Analytics: the overview, with Reports under it.
  {
    key: "analytics",
    to: "/admin/analytics",
    icon: ChartColumn,
    children: [{ key: "reports", to: "/admin/analytics/reports" }],
  },
  // Installed apps sit with the store's own sections: the panel draws every
  // ungrouped row above the group labels, so panel and rail keep one order.
  { key: "apps", to: "/admin/apps", icon: Blocks },
  {
    key: "onlineStore",
    group: "salesChannels",
    icon: Store,
    children: [
      { key: "theme", to: "/admin/online-store/theme" },
      { key: "navigation", to: "/admin/online-store/navigation" },
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
  badge?: NavBadge;
}

/** An active app's page (`useAppNavPages`): listed under the section its placement names. */
export interface AppNavLink {
  placement: string;
  title: string;
  to: string;
}

/**
 * The section an app page's placement joins. Marketing pages sit with
 * Discounts; analytics and settings pages (no section of their own here)
 * sit with Apps.
 */
export const APP_PLACEMENT_SECTION: Readonly<Record<string, ShellKey>> = {
  apps: "apps",
  orders: "orders",
  products: "products",
  customers: "customers",
  marketing: "discounts",
  content: "content",
  analytics: "apps",
  settings: "apps",
};

/** An app's own page (`/admin/apps/<id>/pages/<page>`). */
const APP_PAGE_PATH = /^\/admin\/apps\/[^/]+\/pages\/[^/]+\/?$/;

export function visibleNav(canOpen: (path: string) => boolean, appPages: readonly AppNavLink[] = []): VisibleNavItem[] {
  return ADMIN_NAV.flatMap((item) => {
    const appLinks = appPages
      .filter((page) => (APP_PLACEMENT_SECTION[page.placement] ?? "apps") === item.key && canOpen(page.to))
      .map((page): NavLink => ({ key: item.key, to: page.to, label: page.title }));
    const children = [...(item.children ?? []).filter((child) => canOpen(child.to)), ...appLinks];
    const to = item.to && canOpen(item.to) ? item.to : children[0]?.to;
    return to ? [{ key: item.key, to, icon: item.icon, children, group: item.group, badge: item.badge }] : [];
  });
}

export function matchesPath(path: string, to: string): boolean {
  if (to === "/admin") return path === "/admin" || path === "/admin/";
  return path === to || path.startsWith(`${to}/`);
}

export function isSectionActive(path: string, item: VisibleNavItem): boolean {
  if (item.children.some((child) => matchesPath(path, child.to))) return true;
  // An app's page belongs to the section that lists it, not to Apps by its address.
  if (APP_PAGE_PATH.test(path)) return false;
  return matchesPath(path, item.to);
}

/**
 * The sub-page the path is on: the most specific match, so Purchase orders
 * (`/admin/inventory/purchase-orders/…`) is current rather than Inventory.
 */
export function activeNavChild(path: string, children: readonly NavLink[]): NavLink | undefined {
  return children
    .filter((child) => matchesPath(path, child.to))
    .reduce<NavLink | undefined>((best, child) => (!best || child.to.length > best.to.length ? child : best), undefined);
}
