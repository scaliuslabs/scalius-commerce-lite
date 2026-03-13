import { defineMiddleware, sequence } from "astro:middleware";
import { setPageCspHeader } from "@scalius/core/middleware-helper/csp-handler";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";
import { createAuth } from "@scalius/core/auth";
import {
  getUserPermissions,
  isSuperAdmin,
} from "@scalius/core/auth/rbac/helpers";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { hasPageAccess } from "@scalius/core/auth/rbac/page-permissions";
import { env as cfEnv } from 'cloudflare:workers';

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

// Simple memory cache for hasAdminUsers to prevent D1 queries on every request
// We'll also try to use KV if available in the context
let memoryHasAdminUsers: boolean | null = null;

async function hasAdminUsers(env?: Env | NodeJS.ProcessEnv): Promise<boolean> {
  if (memoryHasAdminUsers !== null) {
    return memoryHasAdminUsers;
  }

  try {
    const { getDb } = await import("@scalius/database/client");
    const { user } = await import("@scalius/database/schema");
    const { eq, or } = await import("drizzle-orm");

    const db = getDb(env);

    // Check KV cache first if available via env
    const kv = (env as any)?.CACHE as KVNamespace | undefined;
    if (kv) {
      const cached = await kv.get("app:setup:hasAdminUsers");
      if (cached === "true") {
        memoryHasAdminUsers = true;
        return true;
      }
    }

    const adminCount = await db
      .select({ id: user.id })
      .from(user)
      .where(or(eq(user.role, "admin"), eq(user.isSuperAdmin, true)))
      .limit(1);

    const hasAdmins = adminCount.length > 0;

    // If true, cache it permanently in memory and KV (you only need to set up once)
    if (hasAdmins) {
      memoryHasAdminUsers = true;
      if (kv) {
        await kv.put("app:setup:hasAdminUsers", "true"); // Cache forever, app is setup
      }
    }

    return hasAdmins;
  } catch (error) {
    console.error("Error checking for admin users:", error);
    return false;
  }
}


const authMiddleware = defineMiddleware(async (context, next) => {
  const request = context.request;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Use native CF Worker env in prod/dev, fallback to process.env for scripts
  // NOTE: Do NOT use Object.keys(cfEnv) — it returns [] on CF Workers proxy objects.
  const isCfEnv = (() => { try { return !!(cfEnv as any)?.ASSETS || !!(cfEnv as any)?.DB || !!(cfEnv as any)?.PUBLIC_API_BASE_URL; } catch { return false; } })();
  const env = isCfEnv ? (cfEnv as unknown as Env) : (typeof process !== "undefined" ? process.env as unknown as Env : {} as Env);

  if (isCfEnv) {
    const [{ getDb }, { initKv }, { initStorage }] = await Promise.all([
      import("@scalius/database/client"),
      import("@scalius/core/utils/kv-cache"),
      import("@scalius/core/integrations/storage"),
    ]);
    getDb(env);
    if (env.CACHE) initKv(env.CACHE);
    if (env.BUCKET) {
      initStorage(env.BUCKET, (env.R2_PUBLIC_URL as string) || "");
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
        // The two-factor plugin automatically attaches `twoFactorVerified` to the session response.
        // Even if stored as 0/1 in SQLite, Better Auth maps it to boolean.
        twoFactorVerified = (session as any).twoFactorVerified === true;
      }
    }
  } catch (error) {
    console.error("Error getting session:", error);
  }

  context.locals.session = session;
  context.locals.user = sessionUser;

  if (sessionUser) {
    try {
      const { getDb } = await import("@scalius/database/client");
      const db = getDb(env);
      const kv = env.CACHE as KVNamespace | undefined; // Get KV namespace

      // Ensure RBAC permissions/roles exist (no-op after first call per isolate)
      await autoSeedRbacIfNeeded(db);

      // Passing kv down enables instantaneous KV lookup (bypass D1 table joins)
      const userPermissions = await getUserPermissions(db, sessionUser.id, kv);
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
    const cspIsCfEnv = (() => { try { return !!(cfEnv as any)?.ASSETS || !!(cfEnv as any)?.DB; } catch { return false; } })();
    const env = cspIsCfEnv ? (cfEnv as unknown as Env) : (typeof process !== "undefined" ? process.env as unknown as Env : {} as Env);
    return await setPageCspHeader(response, env);
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
