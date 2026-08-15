/**
 * Auth-related server functions.
 *
 * Used by auth page routes for session checks, admin-exists checks, etc.
 */

import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { getDb, type Database } from "@scalius/database/client";
import { getAdminSessionFromCookieHeader } from "./admin-session.server";

type AdminDb = Pick<Database, "get">;

const ADMIN_EXISTS_CACHE_TTL_MS = 5 * 60_000;
const ADMIN_EXISTS_READ_TIMEOUT_MS = 3_000;

let adminExistsCache: { value: true; expiresAt: number } | null = null;
let adminExistsInFlight: Promise<boolean> | null = null;
let adminExistsCacheEpoch = 0;
let workerEnvInFlight: Promise<Env> | null = null;

async function getWorkerEnv(): Promise<Env> {
  const inFlight =
    workerEnvInFlight ??
    import("cloudflare:workers").then(({ env }) => env as Env);
  workerEnvInFlight = inFlight;

  try {
    return await inFlight;
  } catch (error) {
    if (workerEnvInFlight === inFlight) workerEnvInFlight = null;
    throw error;
  }
}

async function queryAdminExists(db: AdminDb): Promise<boolean> {
  const [{ adminPrincipalExists }, { retryTransientD1 }] = await Promise.all([
    import("@scalius/core/auth/admin-setup"),
    import("@scalius/core/utils/transient-d1"),
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      retryTransientD1(() => adminPrincipalExists(db)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Admin principal read timed out.")),
          ADMIN_EXISTS_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function clearAdminExistsCache() {
  adminExistsCache = null;
  adminExistsInFlight = null;
  adminExistsCacheEpoch += 1;
}

async function getCachedAdminExists(db: AdminDb): Promise<boolean> {
  const now = Date.now();
  if (adminExistsCache && adminExistsCache.expiresAt > now) {
    return adminExistsCache.value;
  }

  const cacheEpoch = adminExistsCacheEpoch;
  const inFlight = adminExistsInFlight ?? queryAdminExists(db);
  adminExistsInFlight = inFlight;

  try {
    const adminExists = await inFlight;
    if (cacheEpoch !== adminExistsCacheEpoch) {
      return adminExists;
    }
    if (!adminExists) {
      adminExistsCache = null;
      return false;
    }

    adminExistsCache = {
      value: true,
      expiresAt: now + ADMIN_EXISTS_CACHE_TTL_MS,
    };
    return true;
  } finally {
    if (adminExistsInFlight === inFlight) {
      adminExistsInFlight = null;
    }
  }
}

/**
 * Get current auth session. Returns { user, session } or null.
 * Used by auth pages to redirect already-logged-in users.
 */
export const getSessionInfoHandler = createServerOnlyFn(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const env = await getWorkerEnv();
  const db = getDb(env);
  const authResult = await getAdminSessionFromCookieHeader(
    db,
    getRequestHeader("cookie"),
    env.BETTER_AUTH_SECRET,
  );
  if (!authResult) return null;

  return {
    user: {
      id: authResult.user.id,
      name: authResult.user.name,
      email: authResult.user.email,
      role: authResult.user.role,
      twoFactorEnabled: authResult.user.twoFactorEnabled,
      mustChangePassword: authResult.user.mustChangePassword,
      mustEnrollTwoFactor: authResult.user.mustEnrollTwoFactor,
    },
    session: {
      id: authResult.session.id,
      twoFactorVerified: authResult.session.twoFactorVerified,
    },
  };
});

export const getSessionInfo = createServerFn().handler(getSessionInfoHandler);

/**
 * Check if any admin user exists in the shared Better Auth D1 database.
 */
export const checkAdminExistsHandler = createServerOnlyFn(async () => {
  const env = await getWorkerEnv();
  const db = getDb(env);
  try {
    return await getCachedAdminExists(db);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("no such table")) return false;
    console.error("Failed to check admin setup status:", e);
    return true;
  }
});

export const checkAdminExists = createServerFn().handler(checkAdminExistsHandler);

/**
 * Login page guard — matches original admin-detection middleware behavior:
 * 1. If no admin users exist -> redirect to /auth/setup
 * 2. If user has a valid session with 2FA verified (or no 2FA) -> redirect to /admin
 * 3. If user has session but 2FA not verified -> redirect to /auth/two-factor
 */
export const loginPageGuardHandler = createServerOnlyFn(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");

  // Check if any admin exists in the shared Better Auth D1 database.
  const env = await getWorkerEnv();
  const db = getDb(env);
  let adminExists = true; // fail-closed: assume admin exists unless proven otherwise
  try {
    adminExists = await getCachedAdminExists(db);
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
  const authResult = await getAdminSessionFromCookieHeader(
    db,
    getRequestHeader("cookie"),
    env.BETTER_AUTH_SECRET,
  );
  if (authResult?.session && authResult?.user) {
    const twoFactorVerified = authResult.session.twoFactorVerified === true;
    if (authResult.user.mustChangePassword) {
      throw redirect({ to: "/auth/forgot-password" });
    }
    if (!authResult.user.twoFactorEnabled || twoFactorVerified) {
      if (authResult.user.mustEnrollTwoFactor && !authResult.user.twoFactorEnabled) {
        throw redirect({ to: "/auth/setup-2fa" });
      }
      throw redirect({ to: "/admin" });
    }
    throw redirect({ to: "/auth/two-factor" });
  }

  return null;
});

export const loginPageGuard = createServerFn().handler(loginPageGuardHandler);

/**
 * Admin route guard — matches original admin-detection + RBAC middleware:
 * 1. If not authenticated -> redirect to /auth/login (whose guard owns setup detection)
 * 2. If 2FA enabled but not verified -> redirect to /auth/two-factor
 * 3. Loads RBAC permissions and returns user context
 */
export const adminRouteGuardHandler = createServerOnlyFn(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const env = await getWorkerEnv();
  const db = getDb(env);

  // Check session
  const authResult = await getAdminSessionFromCookieHeader(
    db,
    getRequestHeader("cookie"),
    env.BETTER_AUTH_SECRET,
  );
  if (!authResult?.session || !authResult?.user) {
    throw redirect({ to: "/auth/login" });
  }

  if (authResult.user.mustChangePassword) {
    throw redirect({ to: "/auth/forgot-password" });
  }

  if (
    authResult.user.mustEnrollTwoFactor &&
    !authResult.user.twoFactorEnabled
  ) {
    throw redirect({ to: "/auth/setup-2fa" });
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
      mustChangePassword: authResult.user.mustChangePassword ?? false,
      mustEnrollTwoFactor: authResult.user.mustEnrollTwoFactor ?? false,
      isSuperAdmin: rbac.isSuperAdmin,
    },
    permissions: Array.from(rbac.permissions),
    isSuperAdmin: rbac.isSuperAdmin,
    hasAdminAccess: rbac.hasAdminAccess,
  };
});

export const adminRouteGuard = createServerFn().handler(adminRouteGuardHandler);

/**
 * Simple redirect if user has ANY valid session.
 * Used in beforeLoad of forgot-password page.
 */
export const redirectIfAuthenticatedHandler = createServerOnlyFn(async () => {
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const env = await getWorkerEnv();
  const db = getDb(env);

  const authResult = await getAdminSessionFromCookieHeader(
    db,
    getRequestHeader("cookie"),
    env.BETTER_AUTH_SECRET,
  );
  if (authResult?.session) {
    if (authResult.user.mustChangePassword) {
      return null;
    }
    throw redirect({ to: "/admin" });
  }
  return null;
});

export const redirectIfAuthenticated = createServerFn().handler(
  redirectIfAuthenticatedHandler,
);
