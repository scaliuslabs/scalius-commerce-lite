// src/lib/rbac/permissions.ts

// All available permissions in the system
export const PERMISSIONS = {
  // =============================================
  // Products (8 permissions)
  // =============================================
  PRODUCTS_VIEW: "products.view",
  // Shopify's "View product costs": unit costs (cost per item), margins,
  // inventory value, purchase-order money and profit reports. Responses
  // leave those fields out for everyone without it.
  PRODUCTS_VIEW_COSTS: "products.view_costs",
  PRODUCTS_CREATE: "products.create",
  PRODUCTS_EDIT: "products.edit",
  PRODUCTS_DELETE: "products.delete",
  PRODUCTS_RESTORE: "products.restore",
  PRODUCTS_PERMANENT_DELETE: "products.permanent_delete",
  PRODUCTS_BULK_OPERATIONS: "products.bulk_operations",

  // =============================================
  // Inventory operations (2 permissions): locations and their addresses,
  // suppliers, purchase orders and transfers. Stock levels themselves are
  // product data (products.view reads them, products.edit adjusts them).
  // =============================================
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_MANAGE: "inventory.manage",

  // =============================================
  // Reviews (2 permissions): buyer reviews of delivered order lines
  // =============================================
  REVIEWS_VIEW: "reviews.view",
  REVIEWS_MODERATE: "reviews.moderate",

  // =============================================
  // Gift cards (2 permissions) - SENSITIVE: issuing and adjusting moves money
  // =============================================
  GIFT_CARDS_VIEW: "gift_cards.view",
  GIFT_CARDS_MANAGE: "gift_cards.manage",

  // =============================================
  // Categories (6 permissions)
  // =============================================
  CATEGORIES_VIEW: "categories.view",
  CATEGORIES_CREATE: "categories.create",
  CATEGORIES_EDIT: "categories.edit",
  CATEGORIES_DELETE: "categories.delete",
  CATEGORIES_RESTORE: "categories.restore",
  CATEGORIES_PERMANENT_DELETE: "categories.permanent_delete",

  // =============================================
  // Collections (6 permissions)
  // =============================================
  COLLECTIONS_VIEW: "collections.view",
  COLLECTIONS_CREATE: "collections.create",
  COLLECTIONS_EDIT: "collections.edit",
  COLLECTIONS_DELETE: "collections.delete",
  COLLECTIONS_RESTORE: "collections.restore",
  COLLECTIONS_TOGGLE_STATUS: "collections.toggle_status",

  // =============================================
  // Orders (9 permissions)
  // =============================================
  ORDERS_VIEW: "orders.view",
  ORDERS_CREATE: "orders.create",
  ORDERS_EDIT: "orders.edit",
  ORDERS_DELETE: "orders.delete",
  ORDERS_RESTORE: "orders.restore",
  ORDERS_CHANGE_STATUS: "orders.change_status",
  ORDERS_MANAGE_SHIPMENTS: "orders.manage_shipments",
  ORDERS_REFUND: "orders.refund",
  ORDERS_ISSUE_INVOICE: "orders.issue_invoice",

  // =============================================
  // Conversations (2 permissions): the inbox and order threads
  // =============================================
  CONVERSATIONS_VIEW: "conversations.view",
  CONVERSATIONS_REPLY: "conversations.reply",

  // =============================================
  // Customers (6 permissions)
  // =============================================
  CUSTOMERS_VIEW: "customers.view",
  CUSTOMERS_CREATE: "customers.create",
  CUSTOMERS_EDIT: "customers.edit",
  CUSTOMERS_DELETE: "customers.delete",
  CUSTOMERS_VIEW_HISTORY: "customers.view_history",
  CUSTOMERS_SYNC: "customers.sync",

  // =============================================
  // Discounts (5 permissions) - SENSITIVE
  // =============================================
  DISCOUNTS_VIEW: "discounts.view",
  DISCOUNTS_CREATE: "discounts.create",
  DISCOUNTS_EDIT: "discounts.edit",
  DISCOUNTS_DELETE: "discounts.delete",
  DISCOUNTS_TOGGLE_STATUS: "discounts.toggle_status",

  // =============================================
  // Pages (5 permissions)
  // =============================================
  PAGES_VIEW: "pages.view",
  PAGES_CREATE: "pages.create",
  PAGES_EDIT: "pages.edit",
  PAGES_DELETE: "pages.delete",
  PAGES_PUBLISH: "pages.publish",

  // =============================================
  // Media (4 permissions)
  // =============================================
  MEDIA_VIEW: "media.view",
  MEDIA_UPLOAD: "media.upload",
  MEDIA_DELETE: "media.delete",
  MEDIA_MANAGE_FOLDERS: "media.manage_folders",

  // =============================================
  // Attributes (4 permissions)
  // =============================================
  ATTRIBUTES_VIEW: "attributes.view",
  ATTRIBUTES_CREATE: "attributes.create",
  ATTRIBUTES_EDIT: "attributes.edit",
  ATTRIBUTES_DELETE: "attributes.delete",

  // =============================================
  // Analytics (4 permissions)
  // =============================================
  ANALYTICS_VIEW: "analytics.view",
  ANALYTICS_CREATE: "analytics.create",
  ANALYTICS_EDIT: "analytics.edit",
  ANALYTICS_TOGGLE: "analytics.toggle",

  // =============================================
  // Settings - General (2 permissions) - SENSITIVE
  // =============================================
  SETTINGS_GENERAL_VIEW: "settings.general.view",
  SETTINGS_GENERAL_EDIT: "settings.general.edit",

  // =============================================
  // Settings - Header/Footer/SEO (3 permissions)
  // =============================================
  SETTINGS_HEADER_EDIT: "settings.header.edit",
  SETTINGS_FOOTER_EDIT: "settings.footer.edit",
  SETTINGS_SEO_EDIT: "settings.seo.edit",

  // =============================================
  // Settings - Notifications (1 permission)
  // =============================================
  SETTINGS_NOTIFICATIONS_EDIT: "settings.notifications.edit",

  // =============================================
  // Settings - Delivery Locations (2 permissions)
  // =============================================
  SETTINGS_DELIVERY_LOCATIONS_VIEW: "settings.delivery_locations.view",
  SETTINGS_DELIVERY_LOCATIONS_EDIT: "settings.delivery_locations.edit",
  /** Add and update places through the place import only (an app's dataset): never delete. */
  SETTINGS_DELIVERY_LOCATIONS_IMPORT: "settings.delivery_locations.import",

  // =============================================
  // Settings - Delivery Providers (2 permissions) - SENSITIVE
  // =============================================
  SETTINGS_DELIVERY_PROVIDERS_VIEW: "settings.delivery_providers.view",
  SETTINGS_DELIVERY_PROVIDERS_EDIT: "settings.delivery_providers.edit",

  // =============================================
  // Settings - Shipping Methods (2 permissions)
  // =============================================
  SETTINGS_SHIPPING_METHODS_VIEW: "settings.shipping_methods.view",
  SETTINGS_SHIPPING_METHODS_EDIT: "settings.shipping_methods.edit",

  // =============================================
  // Settings - Fraud Checker (2 permissions) - SENSITIVE
  // =============================================
  SETTINGS_FRAUD_CHECKER_VIEW: "settings.fraud_checker.view",
  SETTINGS_FRAUD_CHECKER_EDIT: "settings.fraud_checker.edit",

  // =============================================
  // Settings - Cache (2 permissions)
  // =============================================
  SETTINGS_CACHE_VIEW: "settings.cache.view",
  SETTINGS_CACHE_MANAGE: "settings.cache.manage",

  // =============================================
  // Taxes (2 permissions) - SENSITIVE
  // =============================================
  TAXES_VIEW: "taxes.view",
  TAXES_MANAGE: "taxes.manage",

  // =============================================
  // Team Management (3 permissions) - SUPER ADMIN DEFAULT
  // =============================================
  TEAM_VIEW: "team.view",
  TEAM_MANAGE: "team.manage",
  TEAM_MANAGE_ROLES: "team.manage_roles",

  // =============================================
  // Agent Access (2 permissions) - SUPER ADMIN ONLY
  // =============================================
  AGENT_ACCESS_VIEW: "agent_access.view",
  AGENT_ACCESS_MANAGE: "agent_access.manage",

  // =============================================
  // Webhooks (2 permissions) - SUPER ADMIN DEFAULT
  // Endpoints receive order, customer and product data: same trust as agents.
  // =============================================
  WEBHOOKS_VIEW: "webhooks.view",
  WEBHOOKS_MANAGE: "webhooks.manage",

  // =============================================
  // Apps (3 permissions): installed plugins (docs/platform/PLUGINS.md).
  // View: see installed apps and open their pages (an app's pages show what
  // the app reads under its own grant). Use: take actions inside an app
  // (its pages' mutating calls). Manage: activate, approve access, change
  // settings, deactivate, uninstall - SUPER ADMIN DEFAULT; approving an
  // app's access additionally requires a Super Admin. Plugins can never hold
  // any of these (grants.ts).
  // =============================================
  APPS_VIEW: "apps.view",
  APPS_USE: "apps.use",
  APPS_MANAGE: "apps.manage",

  // =============================================
  // Dashboard (2 permissions)
  // =============================================
  DASHBOARD_VIEW: "dashboard.view",
  DASHBOARD_ANALYTICS: "dashboard.analytics",
} as const;

// Get all permission names
export function getAllPermissionNames(): string[] {
  return Object.values(PERMISSIONS);
}

const PERMISSION_NAMES = new Set<string>(Object.values(PERMISSIONS));

/** Prerequisites outside a permission's own area. */
const CROSS_AREA_PREREQUISITES: Readonly<Record<string, readonly string[]>> = {
  // Purchase orders, transfers and locations list products and their SKUs.
  [PERMISSIONS.INVENTORY_VIEW]: [PERMISSIONS.PRODUCTS_VIEW],
};

/**
 * What a permission needs to be useful: its area's view permission ("Edit
 * products" needs "View products"; "View analytics" needs the home page),
 * delete before delete-forever, and the few needs that cross areas ("View
 * inventory operations" needs "View products"). Roles are saved closed under
 * this, and a person's effective access drops anything whose prerequisite is
 * missing.
 */
export function permissionPrerequisites(permission: string): string[] {
  const scope = permission.slice(0, permission.lastIndexOf("."));
  return [
    `${scope}.view`,
    ...(permission.endsWith(".permanent_delete") ? [`${scope}.delete`] : []),
    ...(CROSS_AREA_PREREQUISITES[permission] ?? []),
  ].filter((required) => required !== permission && PERMISSION_NAMES.has(required));
}

/** Ticking a permission ticks what it needs. */
export function withPrerequisites(permissions: Iterable<string>): Set<string> {
  const result = new Set(permissions);
  for (const permission of result) {
    for (const required of permissionPrerequisites(permission)) result.add(required);
  }
  return result;
}

/** Unticking a permission unticks what depends on it. */
export function withoutUnmetPrerequisites(permissions: Iterable<string>): Set<string> {
  const result = new Set(permissions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const permission of result) {
      if (permissionPrerequisites(permission).some((required) => !result.has(required))) {
        result.delete(permission);
        changed = true;
      }
    }
  }
  return result;
}
