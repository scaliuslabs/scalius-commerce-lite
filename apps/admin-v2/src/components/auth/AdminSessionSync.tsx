import { useEffect } from "react";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { clearAdminRouteContextCache } from "../../lib/admin-route-context";

const ADMIN_LOGIN_PATH = "/auth/login";

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
