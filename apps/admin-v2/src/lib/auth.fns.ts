/**
 * Auth-related server functions.
 *
 * Used by auth page routes for session checks, admin-exists checks, etc.
 */

import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";

/**
 * Get current auth session. Returns { user, session } or null.
 * Used by auth pages to redirect already-logged-in users.
 */
export const getSessionInfo = createServerFn().handler(async () => {
  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  const { getRequestHeader } = await import("@tanstack/react-start/server");

  initBindings();

  // Extract cookies from the current request
  const cookieHeader = getRequestHeader("cookie") ?? "";
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const authResult = await getAuthSession(headers);
  if (!authResult) return null;

  return {
    user: {
      id: authResult.user.id,
      name: authResult.user.name,
      email: authResult.user.email,
      role: authResult.user.role,
      twoFactorEnabled: authResult.user.twoFactorEnabled,
    },
    session: {
      id: authResult.session.id,
      twoFactorVerified: authResult.session.twoFactorVerified,
    },
  };
});

/**
 * Check if any admin user exists in admin-v2's local Better Auth DB.
 */
export const checkAdminExists = createServerFn().handler(async () => {
  const { initBindings } = await import("~/lib/auth.server");
  const { env } = await import("cloudflare:workers");
  initBindings();
  try {
    const result = await env.DB.prepare("SELECT COUNT(*) as count FROM user").first<{ count: number }>();
    return (result?.count ?? 0) > 0;
  } catch {
    return false;
  }
});

/**
 * Login page guard — matches original admin-detection middleware behavior:
 * 1. If no admin users exist -> redirect to /auth/setup
 * 2. If user has a valid session with 2FA verified (or no 2FA) -> redirect to /admin
 * 3. If user has session but 2FA not verified -> redirect to /auth/two-factor
 */
export const loginPageGuard = createServerFn().handler(async () => {
  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const { apiBaseGet } = await import("~/lib/api.server");
  initBindings();

  // Check if any admin exists in local Better Auth DB
  const { env } = await import("cloudflare:workers");
  let adminExists = true;
  try {
    const result = await env.DB.prepare("SELECT COUNT(*) as count FROM user").first<{ count: number }>();
    adminExists = (result?.count ?? 0) > 0;
  } catch {
    // DB error -- assume admin exists and continue to login page
  }
  if (!adminExists) {
    throw redirect({ to: "/auth/setup" });
  }

  // Check session
  const cookieHeader = getRequestHeader("cookie") ?? "";
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const authResult = await getAuthSession(headers);
  if (authResult?.session && authResult?.user) {
    const twoFactorVerified = authResult.session.twoFactorVerified === true;
    if (!authResult.user.twoFactorEnabled || twoFactorVerified) {
      throw redirect({ to: "/admin" });
    }
    throw redirect({ to: "/auth/two-factor" });
  }

  return null;
});

/**
 * Admin route guard — matches original admin-detection + RBAC middleware:
 * 1. If no admin users exist -> redirect to /auth/setup
 * 2. If not authenticated -> redirect to /auth/login
 * 3. If 2FA enabled but not verified -> redirect to /auth/two-factor
 * 4. Loads RBAC permissions and returns user context
 */
export const adminRouteGuard = createServerFn().handler(async () => {
  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const { loadUserPermissions } = await import("~/middleware/rbac.server");
  const { env } = await import("cloudflare:workers");
  initBindings();

  // Check if any admin exists in local Better Auth DB
  let adminExists = true;
  try {
    const result = await env.DB.prepare("SELECT COUNT(*) as count FROM user").first<{ count: number }>();
    adminExists = (result?.count ?? 0) > 0;
  } catch {
    // DB error -- assume admin exists
  }
  if (!adminExists) {
    throw redirect({ to: "/auth/setup" });
  }

  // Check session
  const cookieHeader = getRequestHeader("cookie") ?? "";
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const authResult = await getAuthSession(headers);
  if (!authResult?.session || !authResult?.user) {
    throw redirect({ to: "/auth/login" });
  }

  // Check 2FA
  if (
    authResult.user.twoFactorEnabled &&
    !authResult.session.twoFactorVerified
  ) {
    throw redirect({ to: "/auth/two-factor" });
  }

  // Load RBAC permissions
  const rbac = await loadUserPermissions(
    authResult.user.id,
    authResult.user.role,
  );

  return {
    user: {
      id: authResult.user.id,
      name: authResult.user.name,
      email: authResult.user.email,
      image: authResult.user.image ?? null,
      role: authResult.user.role ?? "admin",
      twoFactorEnabled: authResult.user.twoFactorEnabled ?? false,
      isSuperAdmin: rbac.isSuperAdmin,
    },
    permissions: Array.from(rbac.permissions),
    isSuperAdmin: rbac.isSuperAdmin,
    hasAdminAccess: rbac.hasAdminAccess,
  };
});

/**
 * Mark the first user as super admin in admin-v2's local D1.
 * Called after setup to ensure the first user has full access.
 */
export const markFirstUserAsSuperAdmin = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string }) => data)
  .handler(async ({ data }) => {
    const { initBindings } = await import("~/lib/auth.server");
    const { env } = await import("cloudflare:workers");
    initBindings();
    try {
      await env.DB.prepare(
        "UPDATE user SET role = 'admin', is_super_admin = 1 WHERE email = ?",
      )
        .bind(data.email)
        .run();
      return { success: true };
    } catch {
      return { success: false };
    }
  });

/**
 * Simple redirect if user has ANY valid session.
 * Used in beforeLoad of forgot-password page.
 */
export const redirectIfAuthenticated = createServerFn().handler(async () => {
  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  initBindings();

  const cookieHeader = getRequestHeader("cookie") ?? "";
  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);

  const authResult = await getAuthSession(headers);
  if (authResult?.session) {
    throw redirect({ to: "/admin" });
  }
  return null;
});
