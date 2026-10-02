// Route permissions for the inventory API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const INVENTORY_ROUTE_PERMISSIONS: RoutePermissionMap = {
  // =============================================
  // Inventory API
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
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/stock-set": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/default-alert-level": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/alert-level": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/adjust": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/*/levels": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/levels": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  // Inventory locations (where stock is held).
  "/api/v1/admin/inventory/locations": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/locations/*": {
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/locations/*/archive": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/locations/*/unarchive": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/locations/*/default": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  // Inventory value and unit costs (0109). Costs are staff-only: whoever
  // can see products can see what they cost.
  "/api/v1/admin/inventory/valuation": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/costs": {
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  // Suppliers, purchase orders and transfers (0109): read with
  // products.view; every write, receiving included, needs products.edit.
  "/api/v1/admin/inventory/suppliers": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/suppliers/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PATCH: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/suppliers/*/archive": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/suppliers/*/unarchive": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/purchase-orders": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/purchase-orders/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/purchase-orders/*/export": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
  },
  "/api/v1/admin/inventory/purchase-orders/*/order": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/purchase-orders/*/receive": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/purchase-orders/*/cancel": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/transfers": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/transfers/*": {
    GET: { permission: PERMISSIONS.PRODUCTS_VIEW },
    PUT: { permission: PERMISSIONS.PRODUCTS_EDIT },
    DELETE: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/transfers/*/ship": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/transfers/*/receive": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
  "/api/v1/admin/inventory/transfers/*/cancel": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
};
