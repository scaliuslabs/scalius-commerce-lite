// Route permissions for the catalogue projection maintenance API.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const CATALOG_PROJECTION_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/catalog/projections/rebuild": {
    POST: { permission: PERMISSIONS.PRODUCTS_EDIT },
  },
};
