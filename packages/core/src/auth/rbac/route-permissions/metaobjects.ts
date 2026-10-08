// Route permissions for metaobjects (content types and their entries):
// reading needs metaobjects.view, every write metaobjects.edit.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

const view = { permission: PERMISSIONS.METAOBJECTS_VIEW };
const edit = { permission: PERMISSIONS.METAOBJECTS_EDIT };

export const METAOBJECT_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/metaobjects/definitions": { GET: view, POST: edit },
  "/api/v1/admin/metaobjects/definitions/*": { GET: view, PATCH: edit, DELETE: edit },
  "/api/v1/admin/metaobjects/definitions/*/entries": { GET: view, POST: edit },
  "/api/v1/admin/metaobjects/definitions/*/entries/*": { GET: view, PATCH: edit, DELETE: edit },
};
