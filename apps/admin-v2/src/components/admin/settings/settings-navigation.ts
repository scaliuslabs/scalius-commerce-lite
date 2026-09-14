// Every settings destination in one list.
//
// Before this module the dashboard had two competing menus: a "Settings"
// sub-menu in the app sidebar and an in-page tab list inside General settings.
// Half the destinations lived in one, half in the other, so operators had to
// remember which. The settings area now owns a single navigation (Shopify's
// settings pattern): the general sections and the standalone settings routes
// are listed together, grouped by what they affect.
//
// Two kinds of destination share the list:
//   - `section` — a section of the general settings page, reached with the
//     existing `?section=` deep link on `/admin/settings`.
//   - `route`   — its own route, unchanged (`/admin/settings/theme`, ...).
// Nothing here renames a route or a query parameter.

import {
  Banknote,
  Bell,
  Bot,
  Building2,
  Database,
  GalleryHorizontalEnd,
  Globe,
  Image,
  KeyRound,
  Flag,
  Mail,
  Palette,
  PanelBottom,
  PanelTop,
  ReceiptText,
  ScanLine,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShoppingBasket,
  Truck,
  UserCog,
} from "lucide-react";
import type { ComponentType } from "react";

import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { MetaCapiNavIcon } from "../layout/AdminNav";
import type { GeneralSettingsSection } from "./general-settings-sections";

export const SETTINGS_INDEX_PATH = "/admin/settings";

export type SettingsNavIcon = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean;
}>;

interface SettingsNavItemBase {
  /** Stable identity; the React key and the test handle. */
  id: string;
  label: string;
  /** One line saying what the destination controls. Also the page subtitle. */
  description: string;
  icon: SettingsNavIcon;
  /** Omitted for destinations the whole settings area already gates. */
  requiredPermission?: string;
}

export interface SettingsNavSectionItem extends SettingsNavItemBase {
  kind: "section";
  section: GeneralSettingsSection;
}

export interface SettingsNavRouteItem extends SettingsNavItemBase {
  kind: "route";
  href: string;
}

export type SettingsNavItem = SettingsNavSectionItem | SettingsNavRouteItem;

export interface SettingsNavGroup {
  id: string;
  label: string;
  items: SettingsNavItem[];
}

function section(
  sectionId: GeneralSettingsSection,
  label: string,
  description: string,
  icon: SettingsNavIcon,
): SettingsNavSectionItem {
  return {
    kind: "section",
    id: sectionId,
    section: sectionId,
    label,
    description,
    icon,
  };
}

function route(
  id: string,
  href: string,
  label: string,
  description: string,
  icon: SettingsNavIcon,
  requiredPermission?: string,
): SettingsNavRouteItem {
  return { kind: "route", id, href, label, description, icon, requiredPermission };
}

/**
 * Grouped by what the operator is changing, not by which route happens to
 * serve it. Keep each group short enough to scan without scrolling.
 */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  {
    id: "storefront",
    label: "Storefront",
    items: [
      section(
        "header",
        "Header",
        "Logo, announcement bar, and the navigation shown at the top of the store.",
        PanelTop,
      ),
      section(
        "footer",
        "Footer",
        "Footer columns, social links, and the legal line at the bottom of the store.",
        PanelBottom,
      ),
      route(
        "theme",
        "/admin/settings/theme",
        "Theme",
        "Colours, typography, and the presentation preview for the storefront.",
        Palette,
        ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW,
      ),
      route(
        "hero-sliders",
        "/admin/settings/hero-sliders",
        "Hero sliders",
        "Slides shown at the top of the homepage, and how they rotate.",
        GalleryHorizontalEnd,
        ADMIN_PERMISSIONS.SETTINGS_HEADER_EDIT,
      ),
      section(
        "seo",
        "SEO and discovery",
        "Meta titles, structured data, sitemaps, and the product feeds crawlers read.",
        Search,
      ),
      section(
        "storefront",
        "Storefront URL",
        "The public origin used for links, canonical URLs, and discovery XML.",
        Globe,
      ),
      section(
        "media",
        "Media delivery",
        "Which host serves images, and which hosts may be resized.",
        Image,
      ),
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      section(
        "business",
        "Business details",
        "Company identity used on invoices, emails, and store schema.",
        Building2,
      ),
      section(
        "currency",
        "Currency",
        "The currency prices are stored in, and how amounts are displayed.",
        Banknote,
      ),
      section(
        "countries",
        "Customer countries",
        "Which countries customers may enter an address for.",
        Flag,
      ),
      route(
        "checkout",
        "/admin/settings/checkout",
        "Checkout",
        "Checkout steps, payment methods, and what buyers are asked for.",
        ShoppingBasket,
        ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW,
      ),
      route(
        "taxes",
        "/admin/settings/taxes",
        "Taxes",
        "Tax rates, classes, and how tax is applied to an order.",
        ReceiptText,
        ADMIN_PERMISSIONS.TAXES_VIEW,
      ),
      route(
        "delivery-providers",
        "/admin/settings/delivery-providers",
        "Delivery providers",
        "Couriers that can receive shipments from this store.",
        Truck,
        ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
      ),
      route(
        "fraud-checker",
        "/admin/settings/fraud-checker",
        "Fraud checks",
        "Risk lookup providers a merchant can run while reviewing an order.",
        ShieldAlert,
        ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
      ),
      section(
        "email",
        "Email delivery",
        "The provider and sender address transactional email is sent from.",
        Mail,
      ),
      route(
        "notifications",
        "/admin/settings/notifications",
        "Notifications",
        "Which events notify staff and customers, and how push is delivered.",
        Bell,
        ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
      ),
      route(
        "meta-conversion",
        "/admin/settings/meta-conversion",
        "Meta conversions",
        "Server-side events sent to Meta, and the delivery results returned.",
        MetaCapiNavIcon,
        ADMIN_PERMISSIONS.ANALYTICS_VIEW,
      ),
    ],
  },
  {
    id: "access",
    label: "Access and security",
    items: [
      section(
        "auth",
        "Customer sign-in",
        "How customers sign in to the storefront and verify themselves.",
        KeyRound,
      ),
      section(
        "security",
        "Security",
        "Trusted origins, rate limits, and the protections applied to admin traffic.",
        ShieldCheck,
      ),
      section(
        "scanner",
        "Warehouse scanner",
        "Tokens that let a scanner device sign in without an admin password.",
        ScanLine,
      ),
      route(
        "account",
        "/admin/settings/account",
        "Account and staff",
        "Your profile, sign-in security, sessions, and the staff who can sign in.",
        UserCog,
      ),
      route(
        "agent-access",
        "/admin/settings/agent-access",
        "Agent access",
        "Connections that let an AI agent act against this store, and what they may do.",
        Bot,
        ADMIN_PERMISSIONS.AGENT_ACCESS_VIEW,
      ),
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      section(
        "platform",
        "Platform",
        "Public origins every Worker resolves at request time.",
        Server,
      ),
      route(
        "cache",
        "/admin/settings/cache",
        "Cache",
        "Inspect or purge the public API and storefront cache domains.",
        Database,
        ADMIN_PERMISSIONS.SETTINGS_CACHE_VIEW,
      ),
    ],
  },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] =
  SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

export function isSettingsRouteItem(
  item: SettingsNavItem,
): item is SettingsNavRouteItem {
  return item.kind === "route";
}

export function findSettingsNavItem(id: string): SettingsNavItem | undefined {
  return SETTINGS_NAV_ITEMS.find((item) => item.id === id);
}

export function findSettingsNavSection(
  sectionId: GeneralSettingsSection,
): SettingsNavSectionItem | undefined {
  return SETTINGS_NAV_ITEMS.find(
    (item): item is SettingsNavSectionItem =>
      item.kind === "section" && item.section === sectionId,
  );
}

/** Route hrefs the settings navigation can reach, for chunk warming. */
export function settingsNavRouteHrefs(): string[] {
  return SETTINGS_NAV_ITEMS.filter(isSettingsRouteItem).map((item) => item.href);
}

export function hasSettingsNavPermission(
  item: SettingsNavItem,
  permissions: Set<string> | undefined,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return true;
  if (!item.requiredPermission) return true;
  return permissions ? permissions.has(item.requiredPermission) : false;
}

/** Drops destinations the operator cannot open, then drops empty groups. */
export function getVisibleSettingsNavGroups(
  permissions: Set<string> | undefined,
  isSuperAdmin: boolean,
): SettingsNavGroup[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      hasSettingsNavPermission(item, permissions, isSuperAdmin),
    ),
  })).filter((group) => group.items.length > 0);
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export interface SettingsNavLocation {
  /** Current pathname, e.g. `/admin/settings` or `/admin/settings/theme`. */
  pathname: string;
  /** The active general-settings section, when the index route is showing. */
  section?: GeneralSettingsSection;
}

/**
 * A section is current only while the general settings index is open, so a
 * standalone route never highlights two entries at once. A route stays current
 * for its own children (`/admin/settings/agent-access/authorize/...`).
 */
export function isSettingsNavItemCurrent(
  item: SettingsNavItem,
  location: SettingsNavLocation,
): boolean {
  const pathname = normalizePath(location.pathname);
  if (item.kind === "section") {
    return (
      pathname === normalizePath(SETTINGS_INDEX_PATH) &&
      location.section === item.section
    );
  }
  const href = normalizePath(item.href);
  return pathname === href || pathname.startsWith(`${href}/`);
}
