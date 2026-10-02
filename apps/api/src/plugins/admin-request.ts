// The admin auth branch for an in-process plugin dispatch (middleware/
// admin-auth.ts). The plugin's authority is resolved again from the database,
// the request must be a plugin-available operation within the risk ceiling,
// and the route's own RBAC mapping must be satisfied by the plugin's grant.

import type { Context } from "hono";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { resolveDirectAgentOperation } from "../agent-access/direct-operation";
import { isAgentRiskAllowed, type PluginPrincipal } from "../agent-access/types";
import { ForbiddenError, UnauthorizedError } from "../utils/api-error";
import { isOperationAvailableToPlugins, resolvePluginPrincipal } from "./authority";

function adminPathname(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.startsWith("/api/v1") ? pathname : `/api/v1${pathname}`;
}

export async function authorizePluginAdminRequest(c: Context, dispatched: PluginPrincipal): Promise<void> {
  const principal = await resolvePluginPrincipal(c.get("db"), dispatched.pluginId);
  if (!principal || principal.version !== dispatched.version || principal.actorUserId !== dispatched.actorUserId) {
    throw new UnauthorizedError("Plugin authority is no longer active");
  }
  const pathname = adminPathname(c.req.url);
  const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const operation = resolveDirectAgentOperation(method, pathname);
  if (!operation || !isOperationAvailableToPlugins(operation) || !isAgentRiskAllowed(principal.riskCeiling, operation.risk)) {
    throw new ForbiddenError("This dashboard operation is not available to plugins");
  }
  const routePermission = getRoutePermission(pathname, method);
  if (!routePermission) throw new ForbiddenError("This admin endpoint is not configured for RBAC");
  const allowed = routePermission.allowAnyAdmin
    ? false
    : routePermission.permission
      ? principal.permissions.has(routePermission.permission)
      : routePermission.anyOf
        ? routePermission.anyOf.some((permission) => principal.permissions.has(permission))
        : routePermission.allOf
          ? routePermission.allOf.every((permission) => principal.permissions.has(permission))
          : false;
  if (!allowed) throw new ForbiddenError("You do not have permission to perform this action");

  c.set("pluginPrincipal", principal);
  c.set("user", {
    id: principal.actorUserId,
    email: "",
    name: principal.pluginName,
    role: "plugin",
    isSuperAdmin: false,
  });
  c.set("adminPermissions", principal.permissions);
  c.header("Cache-Control", "private, no-store");
}
