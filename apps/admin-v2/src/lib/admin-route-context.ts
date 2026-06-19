import { adminRouteGuard } from "~/lib/auth.fns";

export const ADMIN_ROUTE_CONTEXT_FRESH_MS = 60_000;
// Keep an already-rendered admin tab responsive after long idle/background periods.
// Server APIs still enforce current auth/RBAC; this cache only avoids blocking
// client route transitions before the background guard refresh completes.
export const ADMIN_ROUTE_CONTEXT_STALE_MS = 4 * 60 * 60_000;

type AdminRouteContext = Awaited<ReturnType<typeof adminRouteGuard>>;

let cachedAdminRouteContext:
  | { context: AdminRouteContext; freshUntil: number; expiresAt: number }
  | null = null;
let adminRouteContextRefresh: Promise<void> | null = null;
let adminRouteContextEpoch = 0;

export function clearAdminRouteContextCache() {
  adminRouteContextEpoch += 1;
  cachedAdminRouteContext = null;
  adminRouteContextRefresh = null;
}

interface AdminRouteInvalidator {
  invalidate: () => Promise<unknown> | unknown;
}

export async function refreshAdminRouteContext(
  router: AdminRouteInvalidator,
) {
  clearAdminRouteContextCache();
  try {
    await router.invalidate();
  } catch (error) {
    console.warn("Failed to refresh admin route context", error);
  }
}

function writeAdminRouteContextCache(
  context: AdminRouteContext,
  now = Date.now(),
) {
  cachedAdminRouteContext = {
    context,
    freshUntil: now + ADMIN_ROUTE_CONTEXT_FRESH_MS,
    expiresAt: now + ADMIN_ROUTE_CONTEXT_STALE_MS,
  };
}

function refreshAdminRouteContextInBackground() {
  if (adminRouteContextRefresh) return;

  const refreshEpoch = adminRouteContextEpoch;
  adminRouteContextRefresh = adminRouteGuard()
    .then((context) => {
      if (refreshEpoch !== adminRouteContextEpoch) return;
      writeAdminRouteContextCache(context);
    })
    .catch(() => {
      // Keep the last verified context until the hard TTL; the next blocking guard
      // will redirect or surface errors if the session is truly no longer usable.
    })
    .finally(() => {
      if (refreshEpoch === adminRouteContextEpoch) {
        adminRouteContextRefresh = null;
      }
    });
}

export function primeAdminRouteContextCache(context: AdminRouteContext) {
  if (typeof window === "undefined") return;
  writeAdminRouteContextCache(context);
}

export async function getAdminRouteContext(): Promise<AdminRouteContext> {
  if (typeof window === "undefined") {
    return adminRouteGuard();
  }

  const now = Date.now();
  if (cachedAdminRouteContext && cachedAdminRouteContext.expiresAt > now) {
    if (cachedAdminRouteContext.freshUntil <= now) {
      refreshAdminRouteContextInBackground();
    }
    return cachedAdminRouteContext.context;
  }

  const loadEpoch = adminRouteContextEpoch;
  const context = await adminRouteGuard();
  if (loadEpoch === adminRouteContextEpoch) {
    writeAdminRouteContextCache(context);
  }
  return context;
}
