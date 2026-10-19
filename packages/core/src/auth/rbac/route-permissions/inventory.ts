// Route permissions for the inventory API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermission, RoutePermissionMap } from "./shared";

const VIEW: RoutePermission = { permission: PERMISSIONS.INVENTORY_VIEW };
const MANAGE: RoutePermission = { permission: PERMISSIONS.INVENTORY_MANAGE };
// Writes that set unit costs also need to see them.
const MANAGE_WITH_COSTS: RoutePermission = {
  allOf: [PERMISSIONS.INVENTORY_MANAGE, PERMISSIONS.PRODUCTS_VIEW_COSTS],
};
// A location is store setup as much as stock: Settings and inventory staff
// both look after it.
const LOCATION_WRITE: RoutePermission = {
  anyOf: [PERMISSIONS.INVENTORY_MANAGE, PERMISSIONS.SETTINGS_GENERAL_EDIT],
};

export const INVENTORY_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Stock: product data. products.view reads it (per-location levels also
  // with inventory.view, the read_inventory app scope), products.adjust_stock
  // changes quantities, products.edit keeps alert levels. Unit costs in these
  // reads are left out without products.view_costs.
  // =============================================
  "/api/v1/admin/inventory": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/labels/preview": {
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/labels/artifact": {
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/movements/export": {
    POST: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/alerts": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/scanner/lookup": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/stock-adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_ADJUST_STOCK },
  },
  "/api/v1/admin/inventory/stock-set": {
    POST: { permission: PERMISSIONS.PRODUCTS_ADJUST_STOCK },
  },
  "/api/v1/admin/inventory/default-alert-level": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/alert-level": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_ADJUST_STOCK },
  },
  "/api/v1/admin/inventory/*/levels": {
    GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] },
  },
  "/api/v1/admin/inventory/levels": {
    GET: { anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW] },
  },

  // =============================================
  // Locations. Stock screens list them by name (products.view); their
  // addresses and phone numbers need inventory.view or settings.general.view
  // (the handler leaves them out otherwise).
  // =============================================
  "/api/v1/admin/inventory/locations": {
    GET: {
      anyOf: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.SETTINGS_GENERAL_VIEW],
    },
    POST: LOCATION_WRITE,
  },
  "/api/v1/admin/inventory/locations/*": {
    PATCH: LOCATION_WRITE,
  },
  "/api/v1/admin/inventory/locations/*/archive": {
    POST: LOCATION_WRITE,
  },
  "/api/v1/admin/inventory/locations/*/unarchive": {
    POST: LOCATION_WRITE,
  },
  "/api/v1/admin/inventory/locations/*/default": {
    POST: LOCATION_WRITE,
  },

  // =============================================
  // Inventory value and unit costs (0109): "View product costs".
  // =============================================
  "/api/v1/admin/inventory/valuation": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW_COSTS },
  },
  "/api/v1/admin/inventory/costs": {
    PUT: { allOf: [PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_VIEW_COSTS] },
  },

  // =============================================
  // Suppliers, purchase orders and transfers (0109): read with
  // inventory.view, write with inventory.manage. Purchase-order money is
  // left out of reads without products.view_costs; the writes that set it
  // (drafting, editing) and the supplier export need it too.
  // =============================================
  "/api/v1/admin/inventory/suppliers": {
    GET: VIEW,
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/suppliers/*": {
    GET: VIEW,
    PATCH: MANAGE,
  },
  "/api/v1/admin/inventory/suppliers/*/archive": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/suppliers/*/unarchive": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/purchase-orders": {
    GET: VIEW,
    POST: MANAGE_WITH_COSTS,
  },
  "/api/v1/admin/inventory/purchase-orders/*": {
    GET: VIEW,
    PUT: MANAGE_WITH_COSTS,
    DELETE: MANAGE,
  },
  "/api/v1/admin/inventory/purchase-orders/*/export": {
    GET: { allOf: [PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.PRODUCTS_VIEW_COSTS] },
  },
  "/api/v1/admin/inventory/purchase-orders/*/order": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/purchase-orders/*/receive": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/purchase-orders/*/cancel": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/transfers": {
    GET: VIEW,
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/transfers/*": {
    GET: VIEW,
    PUT: MANAGE,
    DELETE: MANAGE,
  },
  "/api/v1/admin/inventory/transfers/*/ship": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/transfers/*/receive": {
    POST: MANAGE,
  },
  "/api/v1/admin/inventory/transfers/*/cancel": {
    POST: MANAGE,
  },
};
