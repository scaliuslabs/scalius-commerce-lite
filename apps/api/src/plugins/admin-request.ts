// The admin auth branch for an in-process plugin dispatch (middleware/
// admin-auth.ts). The plugin's authority is resolved again from the database,
// the request must be an operation of the app's tier within the risk ceiling,
// and the route's own RBAC mapping must be satisfied by the plugin's grant.

import type { Context } from "hono";
import { staffPermissionSql, getFreshUserPermissionsFromD1 } from "@scalius/core/auth/rbac/helpers";
import { user } from "@scalius/database/schema";
import { and, eq } from "drizzle-orm";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { resolveDirectAgentOperation } from "../agent-access/direct-operation";
import { isAgentRiskAllowed, type PluginPrincipal } from "../agent-access/types";
import { ForbiddenError, UnauthorizedError } from "../utils/api-error";
import { routedApiPath } from "../utils/routed-path";
import { isOperationAvailableToPlugin, resolvePluginPrincipal } from "./authority";

export async function authorizePluginAdminRequest(c: Context, dispatched: PluginPrincipal): Promise<void> {
  const principal = await resolvePluginPrincipal(c.get("db"), dispatched.pluginId);
  if (!principal || principal.version !== dispatched.version || principal.actorUserId !== dispatched.actorUserId) {
    throw new UnauthorizedError("Plugin authority is no longer active");
  }
  const pathname = routedApiPath(c);
  const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const operation = resolveDirectAgentOperation(method, pathname);
  if (!operation || !isOperationAvailableToPlugin(operation, principal.firstParty) || !isAgentRiskAllowed(principal.riskCeiling, operation.risk)) {
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

  // A grant permits the app to offer marketing, not to impersonate its approver.
  // Scheduled jobs have no operator; their immutable approved runs use a separate consumer.
  if (routePermission.permission === "marketing.send") {
    const operator = dispatched.operator;
    const active = operator && await c.get("db").select({ id: user.id }).from(user)
      .where(and(eq(user.id, operator.userId), staffPermissionSql(user.id, "marketing.send"))).get();
    if (!active) throw new ForbiddenError("A staff member with marketing.send must approve this action.");
    principal.operator = { userId: active.id };
    principal.permissions = new Set([...principal.permissions].filter((permission) => permission !== "marketing.send"));
    const permissions = await getFreshUserPermissionsFromD1(c.get("db"), active.id);
    if (!permissions.has("marketing.send")) throw new ForbiddenError("Your marketing permission changed.");
    principal.permissions.add("marketing.send");
  } else if (dispatched.operator) principal.operator = dispatched.operator;
  c.set("pluginPrincipal", principal);
  c.set("user", {
    id: routePermission.permission === "marketing.send" ? principal.operator!.userId : principal.actorUserId,
    email: "",
    name: principal.pluginName,
    role: "plugin",
    isSuperAdmin: false,
  });
  c.set("adminPermissions", principal.permissions);
  c.header("Cache-Control", "private, no-store");
}
