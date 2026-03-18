import { defineMiddleware } from "astro:middleware";
import { getUserPermissions, isSuperAdmin } from "@scalius/core/auth/rbac/helpers";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { hasPageAccess } from "@scalius/core/auth/rbac/page-permissions";

const protectedApiPatterns = [
  /^\/api\/v1\/admin(\/.*)?$/, /^\/api\/admin(\/.*)?$/,
  /^\/api\/analytics(\/.*)?$/, /^\/api\/categories(\/.*)?$/,
  /^\/api\/attributes(\/.*)?$/, /^\/api\/collections(\/.*)?$/,
  /^\/api\/customers(\/.*)?$/, /^\/api\/dashboard(\/.*)?$/,
  /^\/api\/discounts(\/.*)?$/, /^\/api\/media(\/.*)?$/,
  /^\/api\/navigation(\/.*)?$/, /^\/api\/orders(\/.*)?$/,
  /^\/api\/pages(\/.*)?$/, /^\/api\/products(\/.*)?$/,
  /^\/api\/search(\/.*)?$/, /^\/api\/settings(\/.*)?$/,
  /^\/api\/shipments(\/.*)?$/, /^\/api\/system-prompt(\/.*)?$/,
  /^\/api\/widgets(\/.*)?$/, /^\/api\/inventory(\/.*)?$/,
];

function isProtectedApiRoute(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return false;
  return protectedApiPatterns.some((pattern) => pattern.test(pathname));
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** RBAC middleware — loads permissions, enforces API-route and page-level access checks. */
export const rbacMiddleware = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  // Skip RBAC for non-admin API routes and Better Auth routes (matches original behavior)
  if (
    (pathname.startsWith("/api/v1") && !pathname.startsWith("/api/v1/admin")) ||
    pathname.startsWith("/api/auth/")
  ) {
    return (await next()) || new Response();
  }

  const env = context.locals._env;
  const sessionUser = context.locals.user;
  const session = context.locals.session;

  // Load permissions for authenticated users
  if (sessionUser) {
    try {
      const { getDb } = await import("@scalius/database/client");
      const db = getDb(env);
      const kv = env?.CACHE as KVNamespace | undefined;

      await autoSeedRbacIfNeeded(db);
      const userPermissions = await getUserPermissions(db, sessionUser.id, kv);
      context.locals.permissions = userPermissions;

      const userIsSuperAdminFlag = await isSuperAdmin(db, sessionUser.id);
      context.locals._isSuperAdmin = userIsSuperAdminFlag;
      context.locals._hasAdminAccess =
        userIsSuperAdminFlag || sessionUser.role === "admin" || userPermissions.size > 0;
    } catch (error: unknown) {
      console.error("Error loading user permissions:", error);
      context.locals.permissions = new Set<string>();
    }
  } else {
    context.locals.permissions = new Set<string>();
  }

  // Enforce API route protection
  if (isProtectedApiRoute(pathname) && pathname.startsWith("/api/")) {
    if (!session || !sessionUser) {
      return jsonError(401, {
        error: "Unauthorized",
        message: "Authentication required to access this endpoint",
      });
    }

    if (pathname.startsWith("/api/v1/admin/")) {
      const userHasAdminAccess = context.locals._hasAdminAccess ?? false;
      if (sessionUser.role !== "admin" && !userHasAdminAccess) {
        return jsonError(403, { error: "Forbidden", message: "Admin access required" });
      }
    }

    const method = context.request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    const routePermission = getRoutePermission(pathname, method);

    if (routePermission) {
      const userIsSuperAdmin = context.locals._isSuperAdmin ?? false;
      if (!userIsSuperAdmin) {
        const userPerms = context.locals.permissions || new Set<string>();
        let hasRequired = false;

        if (routePermission.permission) {
          hasRequired = userPerms.has(routePermission.permission);
        } else if (routePermission.anyOf) {
          hasRequired = routePermission.anyOf.some((p: string) => userPerms.has(p));
        } else if (routePermission.allOf) {
          hasRequired = routePermission.allOf.every((p: string) => userPerms.has(p));
        }

        if (!hasRequired) {
          return jsonError(403, {
            error: "Forbidden",
            message: "You do not have permission to perform this action",
            requiredPermission:
              routePermission.permission ||
              routePermission.anyOf?.join(" or ") ||
              routePermission.allOf?.join(" and "),
          });
        }
      }
    }
    return (await next()) || new Response();
  }

  // Enforce page-level access for admin routes
  if (pathname.startsWith("/admin")) {
    const userHasAdminAccess = context.locals._hasAdminAccess ?? false;

    if (sessionUser?.role !== "admin" && !userHasAdminAccess) {
      return new Response("Forbidden: Admin access required.", { status: 403 });
    }

    if (pathname !== "/admin/access-denied" && pathname !== "/admin/settings/account") {
      const userPerms = context.locals.permissions || new Set<string>();
      const userIsSuperAdmin = context.locals._isSuperAdmin ?? false;

      if (!hasPageAccess(userPerms, userIsSuperAdmin, pathname)) {
        const accessDeniedUrl = new URL("/admin/access-denied", url.origin);
        accessDeniedUrl.searchParams.set("from", pathname);
        return context.redirect(accessDeniedUrl.pathname + accessDeniedUrl.search);
      }
    }
    return (await next()) || new Response();
  }

  return (await next()) || new Response();
});
