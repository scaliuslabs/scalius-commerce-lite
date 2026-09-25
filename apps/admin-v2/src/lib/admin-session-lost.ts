import { clearAdminRouteContextCache } from "./admin-route-context";
import { readDashboardSession } from "./auth-guards";
import { withDashboardBasePath } from "./dashboard-base-path";

let checking: Promise<void> | null = null;

/**
 * An admin request came back 401. Some calls refuse on their own terms (a
 * wrong two-factor code), so first ask the server whether this browser is
 * still signed in. When it is not (suspended, removed, signed out elsewhere),
 * leave the shell with a full load of the sign-in page, which says why, as a
 * fresh page load would. One check runs at a time.
 *
 * Unsaved edits are never thrown away for it: while the save bar shows, the
 * page stays and the bar offers signing in again in a new tab, after which
 * Save works (`ADMIN_SESSION_LOST_EVENT`, handled by SaveBar).
 */
export const ADMIN_SESSION_LOST_EVENT = "scalius:admin-session-lost";

export function noticeAdminUnauthorized(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  checking ??= (async () => {
    try {
      const { session } = await readDashboardSession();
      if (session) return;
      clearAdminRouteContextCache();
      if (document.querySelector("[data-save-bar]")) {
        window.dispatchEvent(new Event(ADMIN_SESSION_LOST_EVENT));
        return;
      }
      window.location.replace(withDashboardBasePath("/auth/login"));
    } catch {
      // Offline or the server is down: the page shows its own error.
    } finally {
      checking = null;
    }
  })();
  return checking;
}
