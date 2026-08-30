import { useEffect } from "react";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { clearAdminRouteContextCache } from "../../lib/admin-route-context";

const ADMIN_LOGIN_PATH = "/auth/login";

/**
 * Better Auth only posts this event automatically after its reactive session
 * atom has mounted. The admin shell uses its server-loaded route context
 * instead, so a confirmed sign-out must publish the same event explicitly.
 */
export function broadcastAdminSignOut() {
  getGlobalBroadcastChannel().post({
    event: "session",
    data: { trigger: "signout" },
    clientId: crypto.randomUUID(),
  });
}

/**
 * Keep independently rendered admin tabs aligned with Better Auth's
 * server-confirmed session lifecycle without polling or storing credentials.
 */
export function AdminSessionSync() {
  useEffect(() => {
    let redirecting = false;
    const channel = getGlobalBroadcastChannel();
    const unsubscribe = channel.subscribe((message) => {
      if (
        redirecting
        || message.event !== "session"
        || message.data?.trigger !== "signout"
      ) return;

      redirecting = true;
      clearAdminRouteContextCache();
      window.location.replace(ADMIN_LOGIN_PATH);
    });
    const cleanup = channel.setup();

    return () => {
      unsubscribe();
      cleanup();
    };
  }, []);

  return null;
}
