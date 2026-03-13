// src/lib/rbac/permissions.ts
import type { PermissionMetadata, PermissionCategory } from "./types";

// All available permissions in the system
export const PERMISSIONS = {
  // =============================================
  // Products (7 permissions)
  // =============================================
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_CREATE: "products.create",
  PRODUCTS_EDIT: "products.edit",
  PRODUCTS_DELETE: "products.delete",
  PRODUCTS_RESTORE: "products.restore",
  PRODUCTS_PERMANENT_DELETE: "products.permanent_delete",
  PRODUCTS_BULK_OPERATIONS: "products.bulk_operations",

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
  // Orders (7 permissions)
  // =============================================
  ORDERS_VIEW: "orders.view",
  ORDERS_CREATE: "orders.create",
  ORDERS_EDIT: "orders.edit",
  ORDERS_DELETE: "orders.delete",
  ORDERS_RESTORE: "orders.restore",
  ORDERS_CHANGE_STATUS: "orders.change_status",
  ORDERS_MANAGE_SHIPMENTS: "orders.manage_shipments",

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
  // Widgets (5 permissions)
  // =============================================
  WIDGETS_VIEW: "widgets.view",
  WIDGETS_CREATE: "widgets.create",
  WIDGETS_EDIT: "widgets.edit",
  WIDGETS_DELETE: "widgets.delete",
  WIDGETS_TOGGLE_STATUS: "widgets.toggle_status",

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
  // Team Management (3 permissions) - SUPER ADMIN DEFAULT
  // =============================================
  TEAM_VIEW: "team.view",
  TEAM_MANAGE: "team.manage",
  TEAM_MANAGE_ROLES: "team.manage_roles",

  // =============================================
  // Dashboard (2 permissions)
  // =============================================
  DASHBOARD_VIEW: "dashboard.view",
  DASHBOARD_ANALYTICS: "dashboard.analytics",
} as const;

// Permission metadata for UI display and database seeding
export const PERMISSION_METADATA: Record<
  (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
  PermissionMetadata
> = {
  // Products
  [PERMISSIONS.PRODUCTS_VIEW]: {
    name: PERMISSIONS.PRODUCTS_VIEW,
    displayName: "View Products",
    description: "View product listings and details",
    resource: "products",
    action: "view",
    category: "Products",
    isSensitive: false,
  },
  [PERMISSIONS.PRODUCTS_CREATE]: {
    name: PERMISSIONS.PRODUCTS_CREATE,
    displayName: "Create Products",
    description: "Add new products to the catalog",
    resource: "products",
    action: "create",
    category: "Products",
    isSensitive: false,
  },
  [PERMISSIONS.PRODUCTS_EDIT]: {
    name: PERMISSIONS.PRODUCTS_EDIT,
    displayName: "Edit Products",
    description: "Modify existing product information",
    resource: "products",
    action: "edit",
    category: "Products",
    isSensitive: false,
  },
  [PERMISSIONS.PRODUCTS_DELETE]: {
    name: PERMISSIONS.PRODUCTS_DELETE,
    displayName: "Delete Products",
    description: "Soft delete products (can be restored)",
    resource: "products",
    action: "delete",
    category: "Products",
    isSensitive: false,
  },
  [PERMISSIONS.PRODUCTS_RESTORE]: {
    name: PERMISSIONS.PRODUCTS_RESTORE,
    displayName: "Restore Products",
    description: "Restore soft-deleted products",
    resource: "products",
    action: "restore",
    category: "Products",
    isSensitive: false,
  },
  [PERMISSIONS.PRODUCTS_PERMANENT_DELETE]: {
    name: PERMISSIONS.PRODUCTS_PERMANENT_DELETE,
    displayName: "Permanently Delete Products",
    description: "Permanently remove products from the database",
    resource: "products",
    action: "permanent_delete",
    category: "Products",
    isSensitive: true,
  },
  [PERMISSIONS.PRODUCTS_BULK_OPERATIONS]: {
    name: PERMISSIONS.PRODUCTS_BULK_OPERATIONS,
    displayName: "Bulk Product Operations",
    description: "Perform bulk actions on multiple products",
    resource: "products",
    action: "bulk_operations",
    category: "Products",
    isSensitive: false,
  },

  // Categories
  [PERMISSIONS.CATEGORIES_VIEW]: {
    name: PERMISSIONS.CATEGORIES_VIEW,
    displayName: "View Categories",
    description: "View category listings and details",
    resource: "categories",
    action: "view",
    category: "Categories",
    isSensitive: false,
  },
  [PERMISSIONS.CATEGORIES_CREATE]: {
    name: PERMISSIONS.CATEGORIES_CREATE,
    displayName: "Create Categories",
    description: "Add new categories",
    resource: "categories",
    action: "create",
    category: "Categories",
    isSensitive: false,
  },
  [PERMISSIONS.CATEGORIES_EDIT]: {
    name: PERMISSIONS.CATEGORIES_EDIT,
    displayName: "Edit Categories",
    description: "Modify existing categories",
    resource: "categories",
    action: "edit",
    category: "Categories",
    isSensitive: false,
  },
  [PERMISSIONS.CATEGORIES_DELETE]: {
    name: PERMISSIONS.CATEGORIES_DELETE,
    displayName: "Delete Categories",
    description: "Soft delete categories",
    resource: "categories",
    action: "delete",
    category: "Categories",
    isSensitive: false,
  },
  [PERMISSIONS.CATEGORIES_RESTORE]: {
    name: PERMISSIONS.CATEGORIES_RESTORE,
    displayName: "Restore Categories",
    description: "Restore soft-deleted categories",
    resource: "categories",
    action: "restore",
    category: "Categories",
    isSensitive: false,
  },
  [PERMISSIONS.CATEGORIES_PERMANENT_DELETE]: {
    name: PERMISSIONS.CATEGORIES_PERMANENT_DELETE,
    displayName: "Permanently Delete Categories",
    description: "Permanently remove categories from the database",
    resource: "categories",
    action: "permanent_delete",
    category: "Categories",
    isSensitive: true,
  },

  // Collections
  [PERMISSIONS.COLLECTIONS_VIEW]: {
    name: PERMISSIONS.COLLECTIONS_VIEW,
    displayName: "View Collections",
    description: "View collection listings and details",
    resource: "collections",
    action: "view",
    category: "Collections",
    isSensitive: false,
  },
  [PERMISSIONS.COLLECTIONS_CREATE]: {
    name: PERMISSIONS.COLLECTIONS_CREATE,
    displayName: "Create Collections",
    description: "Add new collections",
    resource: "collections",
    action: "create",
    category: "Collections",
    isSensitive: false,
  },
  [PERMISSIONS.COLLECTIONS_EDIT]: {
    name: PERMISSIONS.COLLECTIONS_EDIT,
    displayName: "Edit Collections",
    description: "Modify existing collections",
    resource: "collections",
    action: "edit",
    category: "Collections",
    isSensitive: false,
  },
  [PERMISSIONS.COLLECTIONS_DELETE]: {
    name: PERMISSIONS.COLLECTIONS_DELETE,
    displayName: "Delete Collections",
    description: "Soft delete collections",
    resource: "collections",
    action: "delete",
    category: "Collections",
    isSensitive: false,
  },
  [PERMISSIONS.COLLECTIONS_RESTORE]: {
    name: PERMISSIONS.COLLECTIONS_RESTORE,
    displayName: "Restore Collections",
    description: "Restore soft-deleted collections",
    resource: "collections",
    action: "restore",
    category: "Collections",
    isSensitive: false,
  },
  [PERMISSIONS.COLLECTIONS_TOGGLE_STATUS]: {
    name: PERMISSIONS.COLLECTIONS_TOGGLE_STATUS,
    displayName: "Toggle Collection Status",
    description: "Enable or disable collections",
    resource: "collections",
    action: "toggle_status",
    category: "Collections",
    isSensitive: false,
  },

  // Orders
  [PERMISSIONS.ORDERS_VIEW]: {
    name: PERMISSIONS.ORDERS_VIEW,
    displayName: "View Orders",
    description: "View order listings and details",
    resource: "orders",
    action: "view",
    category: "Orders",
    isSensitive: false,
  },
  [PERMISSIONS.ORDERS_CREATE]: {
    name: PERMISSIONS.ORDERS_CREATE,
    displayName: "Create Orders",
    description: "Create new orders manually",
    resource: "orders",
    action: "create",
    category: "Orders",
    isSensitive: false,
  },
  [PERMISSIONS.ORDERS_EDIT]: {
    name: PERMISSIONS.ORDERS_EDIT,
    displayName: "Edit Orders",
    description: "Modify existing orders",
    resource: "orders",
    action: "edit",
    category: "Orders",
    isSensitive: false,
  },
  [PERMISSIONS.ORDERS_DELETE]: {
    name: PERMISSIONS.ORDERS_DELETE,
    displayName: "Delete Orders",
    description: "Soft delete orders",
    resource: "orders",
    action: "delete",
    category: "Orders",
    isSensitive: false,
  },
  [PERMISSIONS.ORDERS_RESTORE]: {
    name: PERMISSIONS.ORDERS_RESTORE,
    displayName: "Restore Orders",
    description: "Restore soft-deleted orders",
    resource: "orders",
    action: "restore",
    category: "Orders",
    isSensitive: false,
  },
  [PERMISSIONS.ORDERS_CHANGE_STATUS]: {
    name: PERMISSIONS.ORDERS_CHANGE_STATUS,
    displayName: "Change Order Status",
    description: "Update order fulfillment status",
    resource: "orders",
    action: "change_status",
    category: "Orders",
    isSensitive: false,
  },
  [PERMISSIONS.ORDERS_MANAGE_SHIPMENTS]: {
    name: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS,
    displayName: "Manage Shipments",
    description: "Create and manage delivery shipments",
    resource: "orders",
    action: "manage_shipments",
    category: "Orders",
    isSensitive: false,
  },

  // Customers
  [PERMISSIONS.CUSTOMERS_VIEW]: {
    name: PERMISSIONS.CUSTOMERS_VIEW,
    displayName: "View Customers",
    description: "View customer listings and details",
    resource: "customers",
    action: "view",
    category: "Customers",
    isSensitive: false,
  },
  [PERMISSIONS.CUSTOMERS_CREATE]: {
    name: PERMISSIONS.CUSTOMERS_CREATE,
    displayName: "Create Customers",
    description: "Add new customers manually",
    resource: "customers",
    action: "create",
    category: "Customers",
    isSensitive: false,
  },
  [PERMISSIONS.CUSTOMERS_EDIT]: {
    name: PERMISSIONS.CUSTOMERS_EDIT,
    displayName: "Edit Customers",
    description: "Modify customer information",
    resource: "customers",
    action: "edit",
    category: "Customers",
    isSensitive: false,
  },
  [PERMISSIONS.CUSTOMERS_DELETE]: {
    name: PERMISSIONS.CUSTOMERS_DELETE,
    displayName: "Delete Customers",
    description: "Delete customers from the system",
    resource: "customers",
    action: "delete",
    category: "Customers",
    isSensitive: false,
  },
  [PERMISSIONS.CUSTOMERS_VIEW_HISTORY]: {
    name: PERMISSIONS.CUSTOMERS_VIEW_HISTORY,
    displayName: "View Customer History",
    description: "Access customer order and edit history",
    resource: "customers",
    action: "view_history",
    category: "Customers",
    isSensitive: false,
  },
  [PERMISSIONS.CUSTOMERS_SYNC]: {
    name: PERMISSIONS.CUSTOMERS_SYNC,
    displayName: "Sync Customers",
    description: "Synchronize customers with external systems",
    resource: "customers",
    action: "sync",
    category: "Customers",
    isSensitive: false,
  },

  // Discounts (SENSITIVE)
  [PERMISSIONS.DISCOUNTS_VIEW]: {
    name: PERMISSIONS.DISCOUNTS_VIEW,
    displayName: "View Discounts",
    description: "View discount codes and campaigns",
    resource: "discounts",
    action: "view",
    category: "Discounts",
    isSensitive: true,
  },
  [PERMISSIONS.DISCOUNTS_CREATE]: {
    name: PERMISSIONS.DISCOUNTS_CREATE,
    displayName: "Create Discounts",
    description: "Create new discount codes",
    resource: "discounts",
    action: "create",
    category: "Discounts",
    isSensitive: true,
  },
  [PERMISSIONS.DISCOUNTS_EDIT]: {
    name: PERMISSIONS.DISCOUNTS_EDIT,
    displayName: "Edit Discounts",
    description: "Modify existing discounts",
    resource: "discounts",
    action: "edit",
    category: "Discounts",
    isSensitive: true,
  },
  [PERMISSIONS.DISCOUNTS_DELETE]: {
    name: PERMISSIONS.DISCOUNTS_DELETE,
    displayName: "Delete Discounts",
    description: "Delete discount codes",
    resource: "discounts",
    action: "delete",
    category: "Discounts",
    isSensitive: true,
  },
  [PERMISSIONS.DISCOUNTS_TOGGLE_STATUS]: {
    name: PERMISSIONS.DISCOUNTS_TOGGLE_STATUS,
    displayName: "Toggle Discount Status",
    description: "Enable or disable discounts",
    resource: "discounts",
    action: "toggle_status",
    category: "Discounts",
    isSensitive: true,
  },

  // Pages
  [PERMISSIONS.PAGES_VIEW]: {
    name: PERMISSIONS.PAGES_VIEW,
    displayName: "View Pages",
    description: "View content pages",
    resource: "pages",
    action: "view",
    category: "Pages",
    isSensitive: false,
  },
  [PERMISSIONS.PAGES_CREATE]: {
    name: PERMISSIONS.PAGES_CREATE,
    displayName: "Create Pages",
    description: "Create new content pages",
    resource: "pages",
    action: "create",
    category: "Pages",
    isSensitive: false,
  },
  [PERMISSIONS.PAGES_EDIT]: {
    name: PERMISSIONS.PAGES_EDIT,
    displayName: "Edit Pages",
    description: "Modify existing pages",
    resource: "pages",
    action: "edit",
    category: "Pages",
    isSensitive: false,
  },
  [PERMISSIONS.PAGES_DELETE]: {
    name: PERMISSIONS.PAGES_DELETE,
    displayName: "Delete Pages",
    description: "Delete content pages",
    resource: "pages",
    action: "delete",
    category: "Pages",
    isSensitive: false,
  },
  [PERMISSIONS.PAGES_PUBLISH]: {
    name: PERMISSIONS.PAGES_PUBLISH,
    displayName: "Publish Pages",
    description: "Publish or unpublish pages",
    resource: "pages",
    action: "publish",
    category: "Pages",
    isSensitive: false,
  },

  // Widgets
  [PERMISSIONS.WIDGETS_VIEW]: {
    name: PERMISSIONS.WIDGETS_VIEW,
    displayName: "View Widgets",
    description: "View widget listings",
    resource: "widgets",
    action: "view",
    category: "Widgets",
    isSensitive: false,
  },
  [PERMISSIONS.WIDGETS_CREATE]: {
    name: PERMISSIONS.WIDGETS_CREATE,
    displayName: "Create Widgets",
    description: "Create new widgets",
    resource: "widgets",
    action: "create",
    category: "Widgets",
    isSensitive: false,
  },
  [PERMISSIONS.WIDGETS_EDIT]: {
    name: PERMISSIONS.WIDGETS_EDIT,
    displayName: "Edit Widgets",
    description: "Modify existing widgets",
    resource: "widgets",
    action: "edit",
    category: "Widgets",
    isSensitive: false,
  },
  [PERMISSIONS.WIDGETS_DELETE]: {
    name: PERMISSIONS.WIDGETS_DELETE,
    displayName: "Delete Widgets",
    description: "Delete widgets",
    resource: "widgets",
    action: "delete",
    category: "Widgets",
    isSensitive: false,
  },
  [PERMISSIONS.WIDGETS_TOGGLE_STATUS]: {
    name: PERMISSIONS.WIDGETS_TOGGLE_STATUS,
    displayName: "Toggle Widget Status",
    description: "Enable or disable widgets",
    resource: "widgets",
    action: "toggle_status",
    category: "Widgets",
    isSensitive: false,
  },

  // Media
  [PERMISSIONS.MEDIA_VIEW]: {
    name: PERMISSIONS.MEDIA_VIEW,
    displayName: "View Media",
    description: "Browse media library",
    resource: "media",
    action: "view",
    category: "Media",
    isSensitive: false,
  },
  [PERMISSIONS.MEDIA_UPLOAD]: {
    name: PERMISSIONS.MEDIA_UPLOAD,
    displayName: "Upload Media",
    description: "Upload files to media library",
    resource: "media",
    action: "upload",
    category: "Media",
    isSensitive: false,
  },
  [PERMISSIONS.MEDIA_DELETE]: {
    name: PERMISSIONS.MEDIA_DELETE,
    displayName: "Delete Media",
    description: "Delete files from media library",
    resource: "media",
    action: "delete",
    category: "Media",
    isSensitive: false,
  },
  [PERMISSIONS.MEDIA_MANAGE_FOLDERS]: {
    name: PERMISSIONS.MEDIA_MANAGE_FOLDERS,
    displayName: "Manage Folders",
    description: "Create and manage media folders",
    resource: "media",
    action: "manage_folders",
    category: "Media",
    isSensitive: false,
  },

  // Attributes
  [PERMISSIONS.ATTRIBUTES_VIEW]: {
    name: PERMISSIONS.ATTRIBUTES_VIEW,
    displayName: "View Attributes",
    description: "View product attributes",
    resource: "attributes",
    action: "view",
    category: "Attributes",
    isSensitive: false,
  },
  [PERMISSIONS.ATTRIBUTES_CREATE]: {
    name: PERMISSIONS.ATTRIBUTES_CREATE,
    displayName: "Create Attributes",
    description: "Create new product attributes",
    resource: "attributes",
    action: "create",
    category: "Attributes",
    isSensitive: false,
  },
  [PERMISSIONS.ATTRIBUTES_EDIT]: {
    name: PERMISSIONS.ATTRIBUTES_EDIT,
    displayName: "Edit Attributes",
    description: "Modify existing attributes",
    resource: "attributes",
    action: "edit",
    category: "Attributes",
    isSensitive: false,
  },
  [PERMISSIONS.ATTRIBUTES_DELETE]: {
    name: PERMISSIONS.ATTRIBUTES_DELETE,
    displayName: "Delete Attributes",
    description: "Delete product attributes",
    resource: "attributes",
    action: "delete",
    category: "Attributes",
    isSensitive: false,
  },

  // Analytics
  [PERMISSIONS.ANALYTICS_VIEW]: {
    name: PERMISSIONS.ANALYTICS_VIEW,
    displayName: "View Analytics",
    description: "View analytics integrations",
    resource: "analytics",
    action: "view",
    category: "Analytics",
    isSensitive: false,
  },
  [PERMISSIONS.ANALYTICS_CREATE]: {
    name: PERMISSIONS.ANALYTICS_CREATE,
    displayName: "Create Analytics",
    description: "Add new analytics integrations",
    resource: "analytics",
    action: "create",
    category: "Analytics",
    isSensitive: false,
  },
  [PERMISSIONS.ANALYTICS_EDIT]: {
    name: PERMISSIONS.ANALYTICS_EDIT,
    displayName: "Edit Analytics",
    description: "Modify analytics configurations",
    resource: "analytics",
    action: "edit",
    category: "Analytics",
    isSensitive: false,
  },
  [PERMISSIONS.ANALYTICS_TOGGLE]: {
    name: PERMISSIONS.ANALYTICS_TOGGLE,
    displayName: "Toggle Analytics",
    description: "Enable or disable analytics integrations",
    resource: "analytics",
    action: "toggle",
    category: "Analytics",
    isSensitive: false,
  },

  // Settings - General (SENSITIVE)
  [PERMISSIONS.SETTINGS_GENERAL_VIEW]: {
    name: PERMISSIONS.SETTINGS_GENERAL_VIEW,
    displayName: "View General Settings",
    description: "View store general settings",
    resource: "settings",
    action: "general.view",
    category: "Settings",
    isSensitive: true,
  },
  [PERMISSIONS.SETTINGS_GENERAL_EDIT]: {
    name: PERMISSIONS.SETTINGS_GENERAL_EDIT,
    displayName: "Edit General Settings",
    description: "Modify store general settings",
    resource: "settings",
    action: "general.edit",
    category: "Settings",
    isSensitive: true,
  },

  // Settings - Header/Footer/SEO
  [PERMISSIONS.SETTINGS_HEADER_EDIT]: {
    name: PERMISSIONS.SETTINGS_HEADER_EDIT,
    displayName: "Edit Header",
    description: "Modify site header configuration",
    resource: "settings",
    action: "header.edit",
    category: "Settings",
    isSensitive: false,
  },
  [PERMISSIONS.SETTINGS_FOOTER_EDIT]: {
    name: PERMISSIONS.SETTINGS_FOOTER_EDIT,
    displayName: "Edit Footer",
    description: "Modify site footer configuration",
    resource: "settings",
    action: "footer.edit",
    category: "Settings",
    isSensitive: false,
  },
  [PERMISSIONS.SETTINGS_SEO_EDIT]: {
    name: PERMISSIONS.SETTINGS_SEO_EDIT,
    displayName: "Edit SEO Settings",
    description: "Modify site SEO configuration",
    resource: "settings",
    action: "seo.edit",
    category: "Settings",
    isSensitive: false,
  },

  // Settings - Notifications
  [PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT]: {
    name: PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT,
    displayName: "Edit Notifications",
    description: "Modify notification settings",
    resource: "settings",
    action: "notifications.edit",
    category: "Settings",
    isSensitive: false,
  },

  // Settings - Delivery Locations
  [PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW]: {
    name: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_VIEW,
    displayName: "View Delivery Locations",
    description: "View delivery location settings",
    resource: "settings",
    action: "delivery_locations.view",
    category: "Settings",
    isSensitive: false,
  },
  [PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT]: {
    name: PERMISSIONS.SETTINGS_DELIVERY_LOCATIONS_EDIT,
    displayName: "Edit Delivery Locations",
    description: "Modify delivery location settings",
    resource: "settings",
    action: "delivery_locations.edit",
    category: "Settings",
    isSensitive: false,
  },

  // Settings - Delivery Providers (SENSITIVE)
  [PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW]: {
    name: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW,
    displayName: "View Delivery Providers",
    description: "View delivery provider configurations",
    resource: "settings",
    action: "delivery_providers.view",
    category: "Settings",
    isSensitive: true,
  },
  [PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT]: {
    name: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT,
    displayName: "Edit Delivery Providers",
    description: "Modify delivery provider credentials and settings",
    resource: "settings",
    action: "delivery_providers.edit",
    category: "Settings",
    isSensitive: true,
  },

  // Settings - Shipping Methods
  [PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW]: {
    name: PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW,
    displayName: "View Shipping Methods",
    description: "View shipping method settings",
    resource: "settings",
    action: "shipping_methods.view",
    category: "Settings",
    isSensitive: false,
  },
  [PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT]: {
    name: PERMISSIONS.SETTINGS_SHIPPING_METHODS_EDIT,
    displayName: "Edit Shipping Methods",
    description: "Modify shipping methods and fees",
    resource: "settings",
    action: "shipping_methods.edit",
    category: "Settings",
    isSensitive: false,
  },

  // Settings - Fraud Checker (SENSITIVE)
  [PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW]: {
    name: PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
    displayName: "View Fraud Checker",
    description: "View fraud detection settings",
    resource: "settings",
    action: "fraud_checker.view",
    category: "Settings",
    isSensitive: true,
  },
  [PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT]: {
    name: PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT,
    displayName: "Edit Fraud Checker",
    description: "Modify fraud detection rules",
    resource: "settings",
    action: "fraud_checker.edit",
    category: "Settings",
    isSensitive: true,
  },

  // Settings - Cache
  [PERMISSIONS.SETTINGS_CACHE_VIEW]: {
    name: PERMISSIONS.SETTINGS_CACHE_VIEW,
    displayName: "View Cache",
    description: "View cache status",
    resource: "settings",
    action: "cache.view",
    category: "Settings",
    isSensitive: false,
  },
  [PERMISSIONS.SETTINGS_CACHE_MANAGE]: {
    name: PERMISSIONS.SETTINGS_CACHE_MANAGE,
    displayName: "Manage Cache",
    description: "Clear and manage cache",
    resource: "settings",
    action: "cache.manage",
    category: "Settings",
    isSensitive: false,
  },

  // Team Management
  [PERMISSIONS.TEAM_VIEW]: {
    name: PERMISSIONS.TEAM_VIEW,
    displayName: "View Team",
    description: "View team members",
    resource: "team",
    action: "view",
    category: "Team",
    isSensitive: false,
  },
  [PERMISSIONS.TEAM_MANAGE]: {
    name: PERMISSIONS.TEAM_MANAGE,
    displayName: "Manage Team",
    description: "Add and remove team members",
    resource: "team",
    action: "manage",
    category: "Team",
    isSensitive: true,
  },
  [PERMISSIONS.TEAM_MANAGE_ROLES]: {
    name: PERMISSIONS.TEAM_MANAGE_ROLES,
    displayName: "Manage Roles",
    description: "Create, edit, and assign roles and permissions",
    resource: "team",
    action: "manage_roles",
    category: "Team",
    isSensitive: true,
  },

  // Dashboard
  [PERMISSIONS.DASHBOARD_VIEW]: {
    name: PERMISSIONS.DASHBOARD_VIEW,
    displayName: "View Dashboard",
    description: "Access the admin dashboard",
    resource: "dashboard",
    action: "view",
    category: "Dashboard",
    isSensitive: false,
  },
  [PERMISSIONS.DASHBOARD_ANALYTICS]: {
    name: PERMISSIONS.DASHBOARD_ANALYTICS,
    displayName: "View Dashboard Analytics",
    description: "View analytics on the dashboard",
    resource: "dashboard",
    action: "analytics",
    category: "Dashboard",
    isSensitive: false,
  },
};

// Get all permissions grouped by category
export function getPermissionsByCategory(): Record<
  PermissionCategory,
  PermissionMetadata[]
> {
  const grouped: Record<PermissionCategory, PermissionMetadata[]> = {
    Products: [],
    Categories: [],
    Collections: [],
    Orders: [],
    Customers: [],
    Discounts: [],
    Pages: [],
    Widgets: [],
    Media: [],
    Attributes: [],
    Analytics: [],
    Settings: [],
    Team: [],
    Dashboard: [],
  };

  for (const meta of Object.values(PERMISSION_METADATA)) {
    grouped[meta.category as PermissionCategory].push(meta);
  }

  return grouped;
}

// Get all permission names
export function getAllPermissionNames(): string[] {
  return Object.values(PERMISSIONS);
}

// Get all permissions as metadata array
export function getAllPermissions(): PermissionMetadata[] {
  return Object.values(PERMISSION_METADATA);
}

// Check if a permission is sensitive
export function isSensitivePermission(permission: string): boolean {
  const meta = PERMISSION_METADATA[permission as keyof typeof PERMISSION_METADATA];
  return meta?.isSensitive ?? false;
}
