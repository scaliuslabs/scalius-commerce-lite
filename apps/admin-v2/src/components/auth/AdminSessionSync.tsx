import { clearInboxDrafts } from "~/lib/inbox-draft-session";
import { clearCreateDrafts } from "~/lib/create-draft-account";
import { useEffect } from "react";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { clearAdminRouteContextCache } from "../../lib/admin-route-context";
import { signInHref } from "../../lib/sign-in-return";

/**
 * Better Auth only posts this event automatically after its reactive session
 * atom has mounted. The admin shell uses its server-loaded route context
 * instead, so a confirmed sign-out must publish the same event explicitly.
 */
export function broadcastAdminSignOut() {
  clearInboxDrafts();
  clearCreateDrafts();
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
      clearInboxDrafts();
      clearCreateDrafts();
      clearAdminRouteContextCache();
      // Signed out in another tab: sign-in returns to this page.
      window.location.replace(signInHref());
    });
    const cleanup = channel.setup();

    return () => {
      unsubscribe();
      cleanup();
    };
  }, []);

  return null;
}
