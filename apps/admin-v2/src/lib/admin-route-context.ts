import { isRedirect } from "@tanstack/react-router";
import { adminRouteGuard, type AdminRouteContext } from "~/lib/auth-guards";

export const ADMIN_ROUTE_CONTEXT_FRESH_MS = 60_000;
// Keep an already-rendered admin tab responsive after long idle/background periods.
// Server APIs still enforce current auth/RBAC; this cache only avoids blocking
// client route transitions before the background guard refresh completes.
export const ADMIN_ROUTE_CONTEXT_STALE_MS = 4 * 60 * 60_000;


let cachedAdminRouteContext:
  | { context: AdminRouteContext; freshUntil: number; expiresAt: number }
  | null = null;
let adminRouteContextRefresh: Promise<void> | null = null;
let adminRouteContextEpoch = 0;
/** A sensitive route's own server read, shared by a preload and the navigation after it. */
export const ADMIN_ROUTE_CONTEXT_REVALIDATION_REUSE_MS = 5_000;
let freshRead: { context: Promise<AdminRouteContext>; epoch: number; startedAt: number } | null = null;

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
    .catch((error: unknown) => {
      // The session is gone (suspended, removed, signed out elsewhere): the next
      // navigation runs the blocking guard, which leads to sign-in and says why.
      if (isRedirect(error) && refreshEpoch === adminRouteContextEpoch) cachedAdminRouteContext = null;
      // Otherwise (offline, a server blip) keep the last verified context until
      // the hard TTL; the API still enforces every call.
    })
    .finally(() => {
      if (refreshEpoch === adminRouteContextEpoch) {
        adminRouteContextRefresh = null;
      }
    });
}

export function primeAdminRouteContextCache(context: AdminRouteContext) {
  writeAdminRouteContextCache(context);
}

export async function getAdminRouteContext(): Promise<AdminRouteContext> {
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

/**
 * Revalidates a sensitive route against the current server-owned session and
 * permissions instead of serving the responsive stale-context window.
 */
export async function getFreshAdminRouteContext(): Promise<AdminRouteContext> {
  // Hovering a link preloads the route; the click that follows reuses that
  // same server read instead of asking again.
  const now = Date.now();
  if (freshRead && freshRead.epoch === adminRouteContextEpoch && now - freshRead.startedAt < ADMIN_ROUTE_CONTEXT_REVALIDATION_REUSE_MS) {
    return freshRead.context;
  }
  clearAdminRouteContextCache();
  const loadEpoch = adminRouteContextEpoch;
  const context = adminRouteGuard().then((resolved) => {
    if (loadEpoch === adminRouteContextEpoch) writeAdminRouteContextCache(resolved);
    return resolved;
  });
  freshRead = { context, epoch: loadEpoch, startedAt: now };
  context.catch(() => {
    if (freshRead?.context === context) freshRead = null;
  });
  return context;
}
