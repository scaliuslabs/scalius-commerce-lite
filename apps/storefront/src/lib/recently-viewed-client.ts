/**
 * Schedules the "Recently viewed" check (recently-viewed-check.ts) for when the
 * browser is idle. The check and its read load only then, and only when a row
 * is shown: a buyer with no list downloads nothing.
 */
const IDLE_TIMEOUT_MS = 3_000;

function runCheck(): void {
  if (!document.querySelector("[data-recently-viewed]:not([hidden])")) return;
  // A convenience: when the check cannot load, the row stays as drawn.
  import("@/lib/recently-viewed-check").then(({ checkRecentlyViewed }) => checkRecentlyViewed(), () => undefined);
}

/** Runs the check when the browser is idle (a timeout covers browsers without requestIdleCallback). */
export function scheduleRecentlyViewedCheck(): void {
  if (typeof window === "undefined") return;
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(runCheck, { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(runCheck, 1_500);
}
