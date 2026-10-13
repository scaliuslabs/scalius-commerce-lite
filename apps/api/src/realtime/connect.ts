/**
 * `<dashboard>/api/realtime`: a staff dashboard's WebSocket to the store's
 * realtime hub. The upgrade is authenticated here, once, the same way an admin
 * request is (signed Better Auth cookie, live session, onboarding and 2FA
 * gates, RBAC from the relational database). The hub receives only the proven
 * identity and the topics the permissions allow; it never reads the database.
 *
 * Cross-site WebSocket hijacking: browsers send cookies on a cross-site
 * upgrade, so the Origin must be the dashboard's own.
 */
import { getUserPermissions } from "@scalius/core/auth/rbac/helpers";
import { getDb } from "@scalius/database/client";
import { presenceEditMask, realtimeTopicsFor } from "@scalius/shared/realtime";
import { getAdminSessionFromCookieHeader } from "../middleware/admin-auth";
import { isForeignDashboardRequest } from "../middleware/cookie-origin-guard";
import { REALTIME_IDENTITY_HEADER, type RealtimeIdentity } from "./hub";
import { realtimeHub } from "./publish";

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function handleRealtimeConnect(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return refuse(405, "Method Not Allowed");
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return refuse(426, "Expected a WebSocket upgrade");
  // Browsers always send Origin on a WebSocket handshake; its absence means a non-browser caller.
  if (!request.headers.get("Origin") || isForeignDashboardRequest(request, env.PLATFORM_CONFIG?.dashboardUrl ?? env.BETTER_AUTH_URL)) {
    return refuse(403, "Forbidden");
  }
  const hub = realtimeHub(env);
  if (!hub) return refuse(503, "Realtime is not available");

  const db = getDb(env);
  const result = await getAdminSessionFromCookieHeader(db, request.headers.get("Cookie") ?? undefined, env.BETTER_AUTH_SECRET)
    .catch(() => null);
  if (!result) return refuse(401, "Unauthorized");
  const { user, session } = result;
  if (user.mustChangePassword === true) return refuse(403, "Forbidden");
  if (user.mustEnrollTwoFactor === true && user.twoFactorEnabled !== true) return refuse(403, "Forbidden");
  if (user.twoFactorEnabled === true && session.twoFactorVerified !== true) return refuse(403, "Forbidden");

  const permissions = await getUserPermissions(db, user.id, env.CACHE, user.isSuperAdmin === true);
  const topics = realtimeTopicsFor(permissions);
  if (permissions.size === 0) return refuse(403, "Forbidden");

  const identity: RealtimeIdentity = { userId: user.id, name: user.name ?? "", topics, edit: presenceEditMask(permissions) };
  const headers = new Headers({ Upgrade: "websocket", [REALTIME_IDENTITY_HEADER]: JSON.stringify(identity) });
  for (const name of ["Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Only the handshake headers reach the hub: never the cookie.
  return hub.fetch(new Request("https://realtime-hub.internal/connect", { method: "GET", headers }));
}
