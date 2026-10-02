// Route permissions for custom fields (COMMERCE-HOOKS H4). Definitions are
// store settings (Settings → Custom data). An owner's values follow the
// owner's own permission family: whoever may view a product may read its
// fields, whoever may edit it may write them (brands reuse the category
// permissions, as their own routes do).
import { PERMISSIONS } from "../permissions";
import type { PermissionName } from "../types";
import type { RoutePermissionMap } from "./shared";

const OWNER_PERMISSIONS: Record<string, { view: PermissionName; edit: PermissionName }> = {
  product: { view: PERMISSIONS.PRODUCTS_VIEW, edit: PERMISSIONS.PRODUCTS_EDIT },
  variant: { view: PERMISSIONS.PRODUCTS_VIEW, edit: PERMISSIONS.PRODUCTS_EDIT },
  customer: { view: PERMISSIONS.CUSTOMERS_VIEW, edit: PERMISSIONS.CUSTOMERS_EDIT },
  order: { view: PERMISSIONS.ORDERS_VIEW, edit: PERMISSIONS.ORDERS_EDIT },
  category: { view: PERMISSIONS.CATEGORIES_VIEW, edit: PERMISSIONS.CATEGORIES_EDIT },
  collection: { view: PERMISSIONS.COLLECTIONS_VIEW, edit: PERMISSIONS.COLLECTIONS_EDIT },
  brand: { view: PERMISSIONS.CATEGORIES_VIEW, edit: PERMISSIONS.CATEGORIES_EDIT },
  page: { view: PERMISSIONS.PAGES_VIEW, edit: PERMISSIONS.PAGES_EDIT },
};

export const CUSTOM_FIELD_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/custom-field-definitions": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/custom-field-definitions/reorder": {
    POST: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  "/api/v1/admin/custom-field-definitions/*": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PATCH: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
    DELETE: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
  ...Object.fromEntries(Object.entries(OWNER_PERMISSIONS).map(([ownerType, { view, edit }]) => [
    `/api/v1/admin/custom-fields/${ownerType}/*`,
    { GET: { permission: view }, PUT: { permission: edit } },
  ])),
};
