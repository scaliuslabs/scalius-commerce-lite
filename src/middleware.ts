import { defineMiddleware, sequence } from "astro:middleware";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";
import { createAuth } from "@/lib/auth";
import {
  getUserPermissions,
  isSuperAdmin,
} from "@/lib/rbac/helpers";
import { autoSeedRbacIfNeeded } from "@/lib/rbac/auto-seed";
import { getRoutePermission } from "@/lib/rbac/route-permissions";
import { hasPageAccess } from "@/lib/rbac/page-permissions";

const protectedApiPatterns = [
  /^\/api\/v1\/admin(\/.*)?$/,
  /^\/api\/admin(\/.*)?$/,
  /^\/api\/analytics(\/.*)?$/,
  /^\/api\/categories(\/.*)?$/,
  /^\/api\/attributes(\/.*)?$/,
  /^\/api\/collections(\/.*)?$/,
  /^\/api\/customers(\/.*)?$/,
  /^\/api\/dashboard(\/.*)?$/,
  /^\/api\/discounts(\/.*)?$/,
  /^\/api\/media(\/.*)?$/,
  /^\/api\/navigation(\/.*)?$/,
  /^\/api\/orders(\/.*)?$/,
  /^\/api\/pages(\/.*)?$/,
  /^\/api\/products(\/.*)?$/,
  /^\/api\/search(\/.*)?$/,
  /^\/api\/settings(\/.*)?$/,
  /^\/api\/shipments(\/.*)?$/,
  /^\/api\/system-prompt(\/.*)?$/,
  /^\/api\/widgets(\/.*)?$/,
  /^\/api\/inventory(\/.*)?$/,
];

function isProtectedApiRoute(pathname: string): boolean {
  // Exclude Better Auth routes from protection
  if (pathname.startsWith("/api/auth/")) {
    return false;
  }
  return protectedApiPatterns.some((pattern) => pattern.test(pathname));
}

function isAdminRoute(pathname: string): boolean {
  return pathname.startsWith("/admin");
}

async function hasAdminUsers(env?: Env | NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { getDb } = await import("@/db");
    const { user } = await import("@/db/schema");
    const { count, eq } = await import("drizzle-orm");

    const db = getDb(env);
    const result = await db
      .select({ count: count() })
      .from(user)
      .where(eq(user.role, "admin"));
    return result[0]?.count > 0;
  } catch (error) {
    console.error("Error checking for admin users:", error);
    return true; // Assume admins exist on error to avoid redirect loops
  }
}

async function getSessionTwoFactorVerified(
  sessionId: string,
  env?: Env | NodeJS.ProcessEnv
): Promise<boolean> {
  try {
    const { getDb } = await import("@/db");
    const { session: sessionTable } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const db = getDb(env);
    const result = await db
      .select({ twoFactorVerified: sessionTable.twoFactorVerified })
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .get();

    // Handle both boolean and SQLite integer (SQLite stores booleans as 0/1)
    const verified = result?.twoFactorVerified;
    return verified === true || (verified as unknown) === 1;
  } catch (error) {
    console.error("Error checking 2FA verification status:", error);
    return false;
  }
}

const authMiddleware = defineMiddleware(async (context, next) => {
  const request = context.request;
  const url = new URL(request.url);
  const pathname = url.pathname;

  const runtimeEnv = context.locals.runtime?.env;
  const env = runtimeEnv || (typeof process !== "undefined" ? process.env : {});

  if (runtimeEnv) {
    const [{ getDb }, { initKv }, { initStorage }] = await Promise.all([
      import("@/db"),
      import("@/server/utils/kv-cache"),
      import("@/integrations/storage"),
    ]);
    getDb(runtimeEnv);
    if (runtimeEnv.CACHE) initKv(runtimeEnv.CACHE);
    if (runtimeEnv.BUCKET) {
      initStorage(runtimeEnv.BUCKET, (runtimeEnv.R2_PUBLIC_URL as string) || "");
    }
  }

  if (pathname.startsWith("/api/v1") && !pathname.startsWith("/api/v1/admin")) {
    const response = await next();
    return response || new Response();
  }

  if (pathname.startsWith("/api/auth/")) {
    const response = await next();
    return response || new Response();
  }

  let session = null;
  let sessionUser = null;
  let twoFactorVerified = false;

  try {
    const auth = createAuth(env);
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
    });

    if (sessionResult) {
      session = sessionResult.session;
      sessionUser = sessionResult.user;

      if (session?.id) {
        twoFactorVerified = await getSessionTwoFactorVerified(session.id, env);
      }
    }
  } catch (error) {
    console.error("Error getting session:", error);
  }

  if (session) {
    (session as any).twoFactorVerified = twoFactorVerified;
  }

  context.locals.session = session;
  context.locals.user = sessionUser;

  if (sessionUser) {
    try {
      const { getDb } = await import("@/db");
      const db = getDb(env);

      if (sessionUser.role === "admin") {
        await autoSeedRbacIfNeeded(db);
      }

      const userPermissions = await getUserPermissions(db, sessionUser.id);
      context.locals.permissions = userPermissions;

      const userIsSuperAdminFlag = await isSuperAdmin(db, sessionUser.id);
      (context.locals as any)._isSuperAdmin = userIsSuperAdminFlag;
      (context.locals as any)._hasAdminAccess =
        userIsSuperAdminFlag || sessionUser.role === "admin" || userPermissions.size > 0;
    } catch (error) {
      console.error("Error loading user permissions:", error);
      context.locals.permissions = new Set<string>();
    }
  } else {
    context.locals.permissions = new Set<string>();
  }

  if (pathname.startsWith("/auth/")) {
    if (pathname === "/auth/login") {
      const adminExists = await hasAdminUsers(env);
      if (!adminExists) {
        return context.redirect("/auth/setup");
      }

      if (session && sessionUser) {
        if (!sessionUser.twoFactorEnabled || twoFactorVerified) {
          return context.redirect("/admin");
        }
        return context.redirect("/auth/two-factor");
      }
    }

    const response = await next();
    return response || new Response();
  }

  if (isProtectedApiRoute(pathname) && pathname.startsWith("/api/")) {
    if (!session || !sessionUser) {
      return new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "Authentication required to access this endpoint",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (pathname.startsWith("/api/v1/admin/")) {
      const userHasAdminAccess = (context.locals as any)._hasAdminAccess ?? false;

      if (sessionUser.role !== "admin" && !userHasAdminAccess) {
        return new Response(
          JSON.stringify({
            error: "Forbidden",
            message: "Admin access required",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    const method = request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    const routePermission = getRoutePermission(pathname, method);

    if (routePermission) {
      const userIsSuperAdmin = (context.locals as any)._isSuperAdmin ?? false;

      if (!userIsSuperAdmin) {
        // Use already-loaded permissions from context.locals instead of re-querying DB
        const userPerms = context.locals.permissions || new Set<string>();
        let hasRequiredPermission = false;

        if (routePermission.permission) {
          hasRequiredPermission = userPerms.has(routePermission.permission);
        } else if (routePermission.anyOf) {
          hasRequiredPermission = routePermission.anyOf.some((p: string) => userPerms.has(p));
        } else if (routePermission.allOf) {
          hasRequiredPermission = routePermission.allOf.every((p: string) => userPerms.has(p));
        }

        if (!hasRequiredPermission) {
          const requiredPermissions =
            routePermission.permission ||
            routePermission.anyOf?.join(" or ") ||
            routePermission.allOf?.join(" and ");

          return new Response(
            JSON.stringify({
              error: "Forbidden",
              message: `You do not have permission to perform this action`,
              requiredPermission: requiredPermissions,
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }
    }

    const response = await next();
    return response || new Response();
  }

  if (isAdminRoute(pathname)) {
    const adminExists = await hasAdminUsers(env);

    if (!adminExists) {
      return context.redirect("/auth/setup");
    }

    if (!session || !sessionUser) {
      return context.redirect("/auth/login");
    }

    const sessionTwoFactorVerified = (session as any).twoFactorVerified;

    if (sessionUser.twoFactorEnabled && !sessionTwoFactorVerified) {
      return context.redirect("/auth/two-factor");
    }

    const userHasAdminAccess = (context.locals as any)._hasAdminAccess ?? false;

    // Also check the legacy role for backwards compatibility
    if (sessionUser.role !== "admin" && !userHasAdminAccess) {
      return new Response("Forbidden: Admin access required.", { status: 403 });
    }

    // RBAC: Check page-level permissions for admin routes
    // Access denied page and settings/account are always accessible
    if (pathname !== "/admin/access-denied" && pathname !== "/admin/settings/account") {
      const userPerms = context.locals.permissions || new Set<string>();
      const userIsSuperAdmin = (context.locals as any)._isSuperAdmin ?? false;

      if (!hasPageAccess(userPerms, userIsSuperAdmin, pathname)) {
        // Redirect to access denied page with the attempted URL
        const accessDeniedUrl = new URL("/admin/access-denied", url.origin);
        accessDeniedUrl.searchParams.set("from", pathname);
        return context.redirect(accessDeniedUrl.pathname + accessDeniedUrl.search);
      }
    }

    const response = await next();
    return response || new Response();
  }

  const response = await next();
  return response || new Response();
});

const cspMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    return await setPageCspHeader(response, context.locals.runtime?.env);
  }

  return response;
});

const honoCacheInvalidationMiddleware = defineMiddleware(
  async (context, next) => {
    const response = await next();

    await invalidateHonoCacheIfNeeded(context, response);

    return response;
  }
);

export const onRequest = sequence(
  authMiddleware,
  cspMiddleware,
  honoCacheInvalidationMiddleware
);
