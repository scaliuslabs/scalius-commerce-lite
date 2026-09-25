// The dashboard sidebar: one list of sections, filtered by the same page
// permission map that guards the routes, so a link is shown exactly when its
// page would open.
import {
  BadgePercent,
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
      { key: "inventory", to: "/admin/inventory" },
      { key: "attributes", to: "/admin/attributes" },
      ...when(REVIEWS_NAV_ENABLED, { key: "reviews", to: "/admin/reviews", badge: "reviews" }),
      ...when(GIFT_CARDS_NAV_ENABLED, { key: "giftCards", to: "/admin/gift-cards" }),
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
  badge?: NavBadge;
}

export function visibleNav(canOpen: (path: string) => boolean): VisibleNavItem[] {
  return ADMIN_NAV.flatMap((item) => {
    const children = (item.children ?? []).filter((child) => canOpen(child.to));
    const to = item.to && canOpen(item.to) ? item.to : children[0]?.to;
    return to ? [{ key: item.key, to, icon: item.icon, children, group: item.group, badge: item.badge }] : [];
  });
}

export function matchesPath(path: string, to: string): boolean {
  if (to === "/admin") return path === "/admin" || path === "/admin/";
  return path === to || path.startsWith(`${to}/`);
}

export function isSectionActive(path: string, item: VisibleNavItem): boolean {
  return matchesPath(path, item.to) || item.children.some((child) => matchesPath(path, child.to));
}
