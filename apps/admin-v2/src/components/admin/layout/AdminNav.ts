// Admin navigation data — pure TypeScript, no DOM dependencies.

import type React from "react";
import {
  LayoutDashboard,
  ShoppingCart,
  FolderTree,
  ListTree,
  Layers3,
  Images,
  FileText,
  Blocks,
  Settings,
  SlidersHorizontal,
  Truck,
  Database,
  ShoppingBag,
  BadgePercent,
  BarChart3,
  Users,
  ShieldCheck,
  Clock3,
  Bell,
  UserCog,
  CreditCard,
  Warehouse,
  Palette,
  Package,
  PenTool,
  ReceiptText,
} from "lucide-react";
import { ADMIN_PERMISSIONS } from "../../../lib/admin-permissions";

export const NAV_PERMISSIONS = {
  DASHBOARD_VIEW: ADMIN_PERMISSIONS.DASHBOARD_VIEW,
  PRODUCTS_VIEW: ADMIN_PERMISSIONS.PRODUCTS_VIEW,
  CATEGORIES_VIEW: ADMIN_PERMISSIONS.CATEGORIES_VIEW,
  ATTRIBUTES_VIEW: ADMIN_PERMISSIONS.ATTRIBUTES_VIEW,
  COLLECTIONS_VIEW: ADMIN_PERMISSIONS.COLLECTIONS_VIEW,
  PAGES_VIEW: ADMIN_PERMISSIONS.PAGES_VIEW,
  WIDGETS_VIEW: ADMIN_PERMISSIONS.WIDGETS_VIEW,
  MEDIA_VIEW: ADMIN_PERMISSIONS.MEDIA_VIEW,
  ORDERS_VIEW: ADMIN_PERMISSIONS.ORDERS_VIEW,
  CUSTOMERS_VIEW: ADMIN_PERMISSIONS.CUSTOMERS_VIEW,
  DISCOUNTS_VIEW: ADMIN_PERMISSIONS.DISCOUNTS_VIEW,
  ANALYTICS_VIEW: ADMIN_PERMISSIONS.ANALYTICS_VIEW,
  SETTINGS_GENERAL_VIEW: ADMIN_PERMISSIONS.SETTINGS_GENERAL_VIEW,
  SETTINGS_NOTIFICATIONS_EDIT: ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
  SETTINGS_HEADER_EDIT: ADMIN_PERMISSIONS.SETTINGS_HEADER_EDIT,
  SETTINGS_DELIVERY_PROVIDERS_VIEW:
    ADMIN_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
  SETTINGS_FRAUD_CHECKER_VIEW: ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
  SETTINGS_CACHE_VIEW: ADMIN_PERMISSIONS.SETTINGS_CACHE_VIEW,
  TAXES_VIEW: ADMIN_PERMISSIONS.TAXES_VIEW,
} as const;

export interface NavSubItem {
  name: string;
  href: string;
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  requiredPermission?: string;
  anyOfPermissions?: string[];
}

export interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  subItems?: NavSubItem[];
  defaultOpen?: boolean;
  requiredPermission?: string;
  anyOfPermissions?: string[];
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export function hasNavPermission(
  item: NavItem | NavSubItem,
  permissions: Set<string> | undefined,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return true;
  if (!item.requiredPermission && !item.anyOfPermissions) return true;
  if (item.requiredPermission) {
    return permissions ? permissions.has(item.requiredPermission) : false;
  }
  if (item.anyOfPermissions) {
    return permissions
      ? item.anyOfPermissions.some((p: string) => permissions.has(p))
      : false;
  }
  return true;
}

export const allNavSections: NavSection[] = [
  {
    label: "",
    items: [
      // Dashboard — standalone
      {
        name: "Dashboard",
        href: "/admin",
        icon: LayoutDashboard,
        requiredPermission: NAV_PERMISSIONS.DASHBOARD_VIEW,
      },
      // Catalog — default open
      {
        name: "Catalog",
        href: "/admin/products",
        icon: Package,
        defaultOpen: true,
        subItems: [
          {
            name: "Products",
            href: "/admin/products",
            icon: ShoppingCart,
            requiredPermission: NAV_PERMISSIONS.PRODUCTS_VIEW,
          },
          {
            name: "Categories",
            href: "/admin/categories",
            icon: FolderTree,
            requiredPermission: NAV_PERMISSIONS.CATEGORIES_VIEW,
          },
          {
            name: "Attributes",
            href: "/admin/attributes",
            icon: ListTree,
            requiredPermission: NAV_PERMISSIONS.ATTRIBUTES_VIEW,
          },
          {
            name: "Collections",
            href: "/admin/collections",
            icon: Layers3,
            requiredPermission: NAV_PERMISSIONS.COLLECTIONS_VIEW,
          },
          {
            name: "Inventory",
            href: "/admin/inventory",
            icon: Warehouse,
            requiredPermission: NAV_PERMISSIONS.PRODUCTS_VIEW,
          },
        ],
      },
      // Content — default open
      {
        name: "Content",
        href: "/admin/pages",
        icon: PenTool,
        defaultOpen: true,
        subItems: [
          {
            name: "Pages",
            href: "/admin/pages",
            icon: FileText,
            requiredPermission: NAV_PERMISSIONS.PAGES_VIEW,
          },
          {
            name: "Widgets",
            href: "/admin/widgets",
            icon: Blocks,
            requiredPermission: NAV_PERMISSIONS.WIDGETS_VIEW,
          },
          {
            name: "Media",
            href: "/admin/media",
            icon: Images,
            requiredPermission: NAV_PERMISSIONS.MEDIA_VIEW,
          },
        ],
      },
      // Sales — default open
      {
        name: "Sales",
        href: "/admin/orders",
        icon: ShoppingBag,
        defaultOpen: true,
        subItems: [
          {
            name: "Orders",
            href: "/admin/orders",
            icon: ShoppingBag,
            requiredPermission: NAV_PERMISSIONS.ORDERS_VIEW,
          },
          {
            name: "Abandoned",
            href: "/admin/abandoned-checkouts",
            icon: Clock3,
            requiredPermission: NAV_PERMISSIONS.ORDERS_VIEW,
          },
          {
            name: "Customers",
            href: "/admin/customers",
            icon: Users,
            requiredPermission: NAV_PERMISSIONS.CUSTOMERS_VIEW,
          },
          {
            name: "Discounts",
            href: "/admin/discounts",
            icon: BadgePercent,
            requiredPermission: NAV_PERMISSIONS.DISCOUNTS_VIEW,
          },
          {
            name: "Analytics",
            href: "/admin/analytics",
            icon: BarChart3,
            requiredPermission: NAV_PERMISSIONS.ANALYTICS_VIEW,
          },
        ],
      },
      // Settings — collapsed by default
      {
        name: "Settings",
        href: "/admin/settings",
        icon: Settings,
        subItems: [
          {
            name: "General",
            href: "/admin/settings",
            icon: SlidersHorizontal,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_GENERAL_VIEW,
          },
          {
            name: "Theme",
            href: "/admin/settings/theme",
            icon: Palette,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_GENERAL_VIEW,
          },
          {
            name: "Account",
            href: "/admin/settings/account",
            icon: UserCog,
          },
          {
            name: "Notifications",
            href: "/admin/settings/notifications",
            icon: Bell,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
          },
          {
            name: "Hero Sliders",
            href: "/admin/settings/hero-sliders",
            icon: Images,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_HEADER_EDIT,
          },
          {
            name: "Checkout",
            href: "/admin/settings/checkout",
            icon: CreditCard,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_GENERAL_VIEW,
          },
          {
            name: "Taxes",
            href: "/admin/settings/taxes",
            icon: ReceiptText,
            requiredPermission: NAV_PERMISSIONS.TAXES_VIEW,
          },
          {
            name: "Delivery",
            href: "/admin/settings/delivery-providers",
            icon: Truck,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
          },
          {
            name: "Fraud Checker",
            href: "/admin/settings/fraud-checker",
            icon: ShieldCheck,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
          },
          {
            name: "Meta CAPI",
            href: "/admin/settings/meta-conversion",
            icon: BarChart3,
            requiredPermission: NAV_PERMISSIONS.ANALYTICS_VIEW,
          },
          {
            name: "Cache",
            href: "/admin/settings/cache",
            icon: Database,
            requiredPermission: NAV_PERMISSIONS.SETTINGS_CACHE_VIEW,
          },
        ],
      },
    ],
  },
];

export function getFilteredNavSections(
  permissions: Set<string> | undefined,
  isSuperAdmin: boolean,
): NavSection[] {
  return allNavSections
    .map((section) => ({
      ...section,
      items: section.items
        .filter((item) => hasNavPermission(item, permissions, isSuperAdmin))
        .map((item) => {
          if (item.subItems) {
            return {
              ...item,
              subItems: item.subItems.filter((subItem) =>
                hasNavPermission(subItem, permissions, isSuperAdmin),
              ),
            };
          }
          return item;
        })
        .filter((item) => !item.subItems || item.subItems.length > 0),
    }))
    .filter((section) => section.items.length > 0);
}
