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
 */
export function noticeAdminUnauthorized(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  checking ??= (async () => {
    try {
      const { session } = await readDashboardSession();
      if (session) return;
      clearAdminRouteContextCache();
      window.location.replace(withDashboardBasePath("/auth/login"));
    } catch {
      // Offline or the server is down: the page shows its own error.
    } finally {
      checking = null;
    }
  })();
  return checking;
}
