// src/middleware.ts
import { defineMiddleware, sequence } from "astro:middleware";
import { setPageCspHeader } from "@/lib/middleware-helper/csp-handler";
import { invalidateHonoCacheIfNeeded } from "@/lib/middleware-helper/hono-cache-invalidator";
import { createAuth } from "@/lib/auth";

// Protected API route patterns
const protectedApiPatterns = [
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
];

// Check if a path matches any protected API pattern
function isProtectedApiRoute(pathname: string): boolean {
  // Exclude Better Auth routes from protection
  if (pathname.startsWith("/api/auth/")) {
    return false;
  }
  return protectedApiPatterns.some((pattern) => pattern.test(pathname));
}

// Check if the path is an admin route
function isAdminRoute(pathname: string): boolean {
  return pathname.startsWith("/admin");
}

// Check if there are any ADMIN users in the database
// This is used to determine if first-time setup is needed
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

// Helper to get twoFactorVerified status from database
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

// Create auth middleware (Better Auth)
const authMiddleware = defineMiddleware(async (context, next) => {
  const request = context.request;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Get environment from Astro context (Cloudflare Workers)
  const env = context.locals.runtime?.env || process.env;

  // Skip Hono API routes - they have their own auth
  if (pathname.startsWith("/api/v1")) {
    const response = await next();
    return response || new Response();
  }

  // Skip Better Auth routes
  if (pathname.startsWith("/api/auth/")) {
    const response = await next();
    return response || new Response();
  }

  // For auth pages, we still need to load session info
  // (e.g., two-factor page needs to know if user has a pending session)
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

      // Query database directly for twoFactorVerified since Better Auth doesn't return it
      if (session?.id) {
        twoFactorVerified = await getSessionTwoFactorVerified(session.id, env);
      }
    }
  } catch (error) {
    console.error("Error getting session:", error);
  }

  // Attach twoFactorVerified to session object for use in pages
  if (session) {
    (session as any).twoFactorVerified = twoFactorVerified;
  }

  // Set session info in locals for use in pages/components
  context.locals.session = session;
  context.locals.user = sessionUser;

  // Handle auth pages (login, setup, two-factor)
  if (pathname.startsWith("/auth/")) {
    // If accessing login page, check if we need to redirect to setup
    if (pathname === "/auth/login") {
      const adminExists = await hasAdminUsers(env);
      if (!adminExists) {
        // No admin exists, redirect to setup
        return context.redirect("/auth/setup");
      }

      // If user is already logged in and 2FA is verified (or not enabled), redirect to admin
      if (session && sessionUser) {
        if (!sessionUser.twoFactorEnabled || twoFactorVerified) {
          return context.redirect("/admin");
        }
        // User has 2FA enabled but not verified, redirect to two-factor
        return context.redirect("/auth/two-factor");
      }
    }

    const response = await next();
    return response || new Response();
  }

  // Handle protected API routes
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

    // Check if user has admin role for admin-only endpoints
    if (pathname.startsWith("/api/admin/") && sessionUser.role !== "admin") {
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

    const response = await next();
    return response || new Response();
  }

  // Handle admin routes
  if (isAdminRoute(pathname)) {
    // Check if this is the first-time setup (no admin users exist)
    const adminExists = await hasAdminUsers(env);

    if (!adminExists) {
      // Redirect to setup page if no admin users exist
      return context.redirect("/auth/setup");
    }

    // Require authentication for admin routes
    if (!session || !sessionUser) {
      return context.redirect("/auth/login");
    }

    // Check if 2FA is required but not verified
    const sessionTwoFactorVerified = (session as any).twoFactorVerified;

    // Redirect to 2FA verification if enabled but not verified
    if (sessionUser.twoFactorEnabled && !sessionTwoFactorVerified) {
      return context.redirect("/auth/two-factor");
    }

    // SECURITY: Enforce mandatory 2FA for admin users
    // If 2FA is not enabled, redirect to 2FA setup (except setup-2fa page itself)
    if (!sessionUser.twoFactorEnabled && !pathname.startsWith("/auth/setup-2fa")) {
      return context.redirect("/auth/setup-2fa");
    }

    // Check if user has admin role
    if (sessionUser.role !== "admin") {
      return new Response("Forbidden: Admin access required.", { status: 403 });
    }

    const response = await next();
    return response || new Response();
  }

  // All other routes - just continue
  const response = await next();
  return response || new Response();
});

const cspMiddleware = defineMiddleware(async (context, next) => {
  const response = await next();
  const url = new URL(context.request.url);

  if (!url.pathname.startsWith("/api/")) {
    return setPageCspHeader(response);
  }

  return response;
});

const honoCacheInvalidationMiddleware = defineMiddleware(
  async (context, next) => {
    // First, let the request go to the endpoint and get the response
    const response = await next();

    // MODIFIED: Pass the entire context object to the invalidator
    // This gives it access to `waitUntil` from the Cloudflare runtime
    await invalidateHonoCacheIfNeeded(context, response);

    return response;
  }
);

export const onRequest = sequence(
  authMiddleware,
  cspMiddleware,
  honoCacheInvalidationMiddleware
);
