// Object definitions and records share the same read/edit permission pair.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

const view = { permission: PERMISSIONS.OBJECTS_VIEW };
const edit = { permission: PERMISSIONS.OBJECTS_EDIT };

export const OBJECT_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/objects/types": { GET: view, POST: edit },
  "/api/v1/admin/objects/types/*": { GET: view, PATCH: edit, DELETE: edit },
  "/api/v1/admin/objects/*": { GET: view },
  "/api/v1/admin/objects/*/*": { GET: view, PUT: edit, DELETE: edit },
};
