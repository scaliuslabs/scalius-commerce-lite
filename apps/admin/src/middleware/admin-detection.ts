import { defineMiddleware } from "astro:middleware";

// Memory + KV cache for hasAdminUsers to prevent D1 queries on every request
let memoryHasAdminUsers: boolean | null = null;

async function hasAdminUsers(env?: Env | NodeJS.ProcessEnv): Promise<boolean> {
  if (memoryHasAdminUsers !== null) return memoryHasAdminUsers;

  try {
    const { getDb } = await import("@scalius/database/client");
    const { user } = await import("@scalius/database/schema");
    const { eq, or } = await import("drizzle-orm");

    const db = getDb(env);

    // Check KV cache first if available
    const kv = (env as Env | undefined)?.CACHE as KVNamespace | undefined;
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

    // Cache permanently once true — setup only happens once
    if (hasAdmins) {
      memoryHasAdminUsers = true;
      if (kv) await kv.put("app:setup:hasAdminUsers", "true");
    }

    return hasAdmins;
  } catch (error: unknown) {
    console.error("Error checking for admin users:", error);
    return false;
  }
}

/**
 * Admin detection middleware — checks whether admin users exist.
 * Redirects to setup when no admin exists, handles login page redirect logic.
 */
export const adminDetectionMiddleware = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  // Skip for non-admin API routes and Better Auth routes (matches original behavior)
  if (
    (pathname.startsWith("/api/v1") && !pathname.startsWith("/api/v1/admin")) ||
    pathname.startsWith("/api/auth/")
  ) {
    return (await next()) || new Response();
  }

  const env = context.locals._env;
  const session = context.locals.session;
  const sessionUser = context.locals.user;

  // Handle /auth/ routes
  if (pathname.startsWith("/auth/")) {
    if (pathname === "/auth/login") {
      const adminExists = await hasAdminUsers(env);
      if (!adminExists) return context.redirect("/auth/setup");

      if (session && sessionUser) {
        const twoFactorVerified = session.twoFactorVerified === true;
        if (!sessionUser.twoFactorEnabled || twoFactorVerified) {
          return context.redirect("/admin");
        }
        return context.redirect("/auth/two-factor");
      }
    }
    return (await next()) || new Response();
  }

  // For /admin routes, check admin existence and authentication
  if (pathname.startsWith("/admin")) {
    const adminExists = await hasAdminUsers(env);
    if (!adminExists) return context.redirect("/auth/setup");
    if (!session || !sessionUser) return context.redirect("/auth/login");

    const sessionTwoFactorVerified = session.twoFactorVerified;
    if (sessionUser.twoFactorEnabled && !sessionTwoFactorVerified) {
      return context.redirect("/auth/two-factor");
    }
  }

  return (await next()) || new Response();
});
