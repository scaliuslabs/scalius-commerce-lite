/**
 * Auth-related server functions.
 *
 * Used by auth page routes for session checks, admin-exists checks, etc.
 */

import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";

type AdminDb = Pick<D1Database, "prepare">;

const ADMIN_EXISTS_CACHE_TTL_MS = 5 * 60_000;

let adminExistsCache: { value: true; expiresAt: number } | null = null;

function buildCookieHeaders(cookieHeader: string | null | undefined): Headers | null {
  const cookie = cookieHeader?.trim();
  if (!cookie) return null;
  const headers = new Headers();
  headers.set("cookie", cookie);
  return headers;
}

async function queryAdminExists(db: AdminDb): Promise<boolean> {
  const { retryTransientD1 } = await import("@scalius/core/utils/transient-d1");
  const result = await retryTransientD1(() =>
    db
      .prepare(
        "SELECT COUNT(*) as count FROM user WHERE role = ? OR is_super_admin = 1",
      )
      .bind("admin")
      .first<{ count: number }>(),
  );
  return (result?.count ?? 0) > 0;
}

export function clearAdminExistsCache() {
  adminExistsCache = null;
}

async function getCachedAdminExists(db: AdminDb): Promise<boolean> {
  const now = Date.now();
  if (adminExistsCache && adminExistsCache.expiresAt > now) {
    return adminExistsCache.value;
  }

  const adminExists = await queryAdminExists(db);
  if (adminExists) {
    adminExistsCache = {
      value: true,
      expiresAt: now + ADMIN_EXISTS_CACHE_TTL_MS,
    };
  } else {
    clearAdminExistsCache();
  }
  return adminExists;
}

/**
 * Get current auth session. Returns { user, session } or null.
 * Used by auth pages to redirect already-logged-in users.
 */
export const getSessionInfo = createServerFn().handler(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const headers = buildCookieHeaders(getRequestHeader("cookie"));
  if (!headers) return null;

  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  initBindings();

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
 * Check if any admin user exists in the shared Better Auth D1 database.
 */
export const checkAdminExists = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  try {
    return await getCachedAdminExists(env.DB);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("no such table")) return false;
    console.error("Failed to check admin setup status:", e);
    return true;
  }
});

/**
 * Login page guard — matches original admin-detection middleware behavior:
 * 1. If no admin users exist -> redirect to /auth/setup
 * 2. If user has a valid session with 2FA verified (or no 2FA) -> redirect to /admin
 * 3. If user has session but 2FA not verified -> redirect to /auth/two-factor
 */
export const loginPageGuard = createServerFn().handler(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");

  // Check if any admin exists in the shared Better Auth D1 database.
  const { env } = await import("cloudflare:workers");
  let adminExists = true; // fail-closed: assume admin exists unless proven otherwise
  try {
    adminExists = await getCachedAdminExists(env.DB);
  } catch (e: unknown) {
    // "no such table" = fresh DB after reset → no admin
    // Any other DB error = fail-closed, show login (safe for production)
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("no such table")) adminExists = false;
  }
  if (!adminExists) {
    throw redirect({ to: "/auth/setup" });
  }

  // Check session
  const headers = buildCookieHeaders(getRequestHeader("cookie"));
  if (!headers) return null;

  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  initBindings();

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
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const { env } = await import("cloudflare:workers");

  // Check if any admin exists in the shared Better Auth D1 database.
  let adminExists = true; // fail-closed
  try {
    adminExists = await getCachedAdminExists(env.DB);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("no such table")) adminExists = false;
  }
  if (!adminExists) {
    throw redirect({ to: "/auth/setup" });
  }

  // Check session
  const headers = buildCookieHeaders(getRequestHeader("cookie"));
  if (!headers) {
    throw redirect({ to: "/auth/login" });
  }

  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  initBindings();

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
  const { loadUserPermissions } = await import("~/middleware/rbac.server");
  const rbac = await loadUserPermissions(
    authResult.user.id,
    authResult.user.role,
    authResult.user.isSuperAdmin,
  );

  return {
    user: {
      id: authResult.user.id,
      name: authResult.user.name,
      email: authResult.user.email,
      image: authResult.user.image ?? null,
      role: authResult.user.role ?? null,
      twoFactorEnabled: authResult.user.twoFactorEnabled ?? false,
      isSuperAdmin: rbac.isSuperAdmin,
    },
    permissions: Array.from(rbac.permissions),
    isSuperAdmin: rbac.isSuperAdmin,
    hasAdminAccess: rbac.hasAdminAccess,
  };
});

/**
 * Simple redirect if user has ANY valid session.
 * Used in beforeLoad of forgot-password page.
 */
export const redirectIfAuthenticated = createServerFn().handler(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const headers = buildCookieHeaders(getRequestHeader("cookie"));
  if (!headers) return null;

  const { getAuthSession, initBindings } = await import("~/lib/auth.server");
  initBindings();

  const authResult = await getAuthSession(headers);
  if (authResult?.session) {
    throw redirect({ to: "/admin" });
  }
  return null;
});
