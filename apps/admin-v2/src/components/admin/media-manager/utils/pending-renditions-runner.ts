import { renderPendingRenditions } from "./render-pending-renditions";

/** First check, after the page has settled. */
export const FIRST_CHECK_MS = 12_000;
/** Between checks when nothing is pending, or nothing could be rendered. */
export const RECHECK_MS = 5 * 60_000;
/** Between two passes while images keep rendering. */
const NEXT_PASS_MS = 2_000;
/** Images one pass renders. */
export const PASS_LIMIT = 10;
/** Images one page load renders in all; a reload resumes from the server's own pending list. */
export const SESSION_LIMIT = 400;
/** A new upload's own browser pipeline saves its renditions within this window. */
export const UPLOAD_GRACE_MS = 2 * 60_000;
const LOCK_NAME = "scalius-pending-renditions";

type IdleHandle = number;

function whenIdle(task: () => void): IdleHandle {
  if (typeof requestIdleCallback === "function") return requestIdleCallback(task, { timeout: 4_000 }) as unknown as IdleHandle;
  return setTimeout(task, 250) as unknown as IdleHandle;
}

function cancelIdle(handle: IdleHandle): void {
  if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
  else clearTimeout(handle);
}

/** Runs `work` unless another tab of this dashboard holds the lock; null when it did. */
async function exclusively<T>(work: () => Promise<T>): Promise<T | null> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return work();
  return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? work() : null));
}

/**
 * Renders pending WebP renditions in the background while a dashboard tab is
 * open and visible: one image at a time in idle time, a few per pass, never
 * more than one tab at once (Web Locks), at most SESSION_LIMIT per page load.
 * Buyers see the original until an image is done, which is correct, only
 * larger. Returns a stop function.
 */
export function startPendingRenditions(): () => void {
  const skip = new Set<string>();
  let stopped = false;
  let handled = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: IdleHandle | undefined;
  let release: (() => void) | undefined;

  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const schedule = (delay: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void pass();
    }, delay);
  };
  const pause = () => new Promise<void>((resolve) => {
    release = resolve;
    idle = whenIdle(() => {
      idle = undefined;
      release = undefined;
      resolve();
    });
  });

  async function pass(): Promise<void> {
    if (stopped || running) return;
    if (!visible() || handled >= SESSION_LIMIT || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      schedule(RECHECK_MS);
      return;
    }
    running = true;
    try {
      const result = await exclusively(() => renderPendingRenditions({
        limit: Math.min(PASS_LIMIT, SESSION_LIMIT - handled),
        minAgeMs: UPLOAD_GRACE_MS,
        skip,
        shouldStop: () => stopped || !visible(),
        pause,
      }));
      if (!result) {
        schedule(RECHECK_MS);
        return;
      }
      handled += result.rendered + result.failed;
      schedule(result.more && result.rendered > 0 ? NEXT_PASS_MS : RECHECK_MS);
    } catch {
      schedule(RECHECK_MS);
    } finally {
      running = false;
    }
  }

  const onVisible = () => {
    if (visible()) schedule(FIRST_CHECK_MS);
  };
  document.addEventListener("visibilitychange", onVisible);
  schedule(FIRST_CHECK_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (idle !== undefined) cancelIdle(idle);
    release?.();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
