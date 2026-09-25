// Route permissions for the catalogue merchandising settings (slice 1c). EMI
// plans are a store-wide storefront setting beside the homepage
// presentation, so they reuse the general settings permissions (no new role
// grants). Content blocks, bundles and templates are product sections and
// keep the product permissions.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const MERCHANDISING_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/settings/emi": {
    GET: { permission: PERMISSIONS.SETTINGS_GENERAL_VIEW },
    PUT: { permission: PERMISSIONS.SETTINGS_GENERAL_EDIT },
  },
};
