export const NON_CRITICAL_ANALYTICS_DELAY_MS = 4_000;

/**
 * Keep passive page-view analytics outside the rendering and LCP window.
 * A real interaction releases the event early; otherwise it runs after a
 * bounded delay so analytics never owns the initial network dependency chain.
 */
export function scheduleNonCriticalAnalytics(task: () => void): void {
  if (typeof window === "undefined") return;

  let completed = false;
  const run = () => {
    if (completed) return;
    completed = true;
    window.clearTimeout(timer);
    window.removeEventListener("pointerdown", run);
    window.removeEventListener("keydown", run);
    task();
  };

  const timer = window.setTimeout(run, NON_CRITICAL_ANALYTICS_DELAY_MS);
  window.addEventListener("pointerdown", run, { once: true, passive: true });
  window.addEventListener("keydown", run, { once: true });
}
