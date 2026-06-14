import { adminRouteGuard } from "~/lib/auth.fns";

const ADMIN_ROUTE_CONTEXT_CACHE_MS = 15_000;

type AdminRouteContext = Awaited<ReturnType<typeof adminRouteGuard>>;

let cachedAdminRouteContext:
  | { context: AdminRouteContext; expiresAt: number }
  | null = null;

export function clearAdminRouteContextCache() {
  cachedAdminRouteContext = null;
}

export function primeAdminRouteContextCache(context: AdminRouteContext) {
  if (typeof window === "undefined") return;
  cachedAdminRouteContext = {
    context,
    expiresAt: Date.now() + ADMIN_ROUTE_CONTEXT_CACHE_MS,
  };
}

export async function getAdminRouteContext(): Promise<AdminRouteContext> {
  if (typeof window === "undefined") {
    return adminRouteGuard();
  }

  const now = Date.now();
  if (cachedAdminRouteContext && cachedAdminRouteContext.expiresAt > now) {
    return cachedAdminRouteContext.context;
  }

  const context = await adminRouteGuard();
  cachedAdminRouteContext = {
    context,
    expiresAt: now + ADMIN_ROUTE_CONTEXT_CACHE_MS,
  };
  return context;
}
