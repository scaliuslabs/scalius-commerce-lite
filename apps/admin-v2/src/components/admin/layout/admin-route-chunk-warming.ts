import type { AnyRoute, AnyRouter } from "@tanstack/react-router";
import type { NavSection } from "./AdminNav";

const IDLE_WARMUP_TIMEOUT_MS = 1_200;
const FALLBACK_WARMUP_DELAY_MS = 800;
const FAST_CONNECTION_CONCURRENCY = 2;
const CONSTRAINED_CONNECTION_CONCURRENCY = 1;
const MIN_IDLE_TIME_MS = 4;

const ROUTE_WARM_PRIORITY = [
  "/admin/products",
  "/admin/orders",
  "/admin/inventory",
  "/admin/categories",
  "/admin/collections",
  "/admin/discounts",
  "/admin/pages",
  "/admin/media",
  "/admin/analytics",
  "/admin/customers",
] as const;

type RouteChunkRouter = Pick<AnyRouter, "loadRouteChunk" | "routesByPath">;

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining(): number;
}

interface NetworkConnectionLike {
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

export interface RouteWarmupWindow {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
  navigator: {
    onLine?: boolean;
    connection?: NetworkConnectionLike;
  };
  document: {
    hidden: boolean;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
  addEventListener(
    type: "online" | "offline" | "pagehide" | "pageshow",
    listener: () => void,
  ): void;
  removeEventListener(
    type: "online" | "offline" | "pagehide" | "pageshow",
    listener: () => void,
  ): void;
}

export interface AdminRouteChunkWarmupOptions {
  router: RouteChunkRouter;
  hrefs: readonly string[];
  currentPath: string;
  signal?: AbortSignal;
  window?: RouteWarmupWindow;
}

interface RouterWarmupState {
  warmed: Set<string>;
  inFlight: Set<string>;
}

const warmupStateByRouter = new WeakMap<object, RouterWarmupState>();

export function normalizeNavigationPath(href: string): string {
  return href.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "/";
}

/**
 * Load only a destination's code-split route chain. Deliberately do not call
 * preloadRoute: that API can run beforeLoad and loaders, which would turn an
 * idle optimization into authenticated API and customer/order data work.
 */
export async function preloadAdminRouteChunks(
  router: RouteChunkRouter,
  href: string,
): Promise<void> {
  const pathname = normalizeNavigationPath(href);
  const routesByPath = router.routesByPath as Record<
    string,
    AnyRoute | undefined
  >;
  const route =
    (pathname === "/" ? routesByPath[pathname] : routesByPath[`${pathname}/`]) ??
    routesByPath[pathname];

  if (!route) return;

  const routeChain: AnyRoute[] = [];
  let currentRoute: AnyRoute | undefined = route;
  while (currentRoute) {
    routeChain.push(currentRoute);
    currentRoute = currentRoute.parentRoute;
  }

  await Promise.all(routeChain.map((match) => router.loadRouteChunk(match)));
}

/** Return each permission-visible destination once, with high-traffic routes first. */
export function collectPermissionVisibleRouteHrefs(
  sections: readonly NavSection[],
): string[] {
  const hrefs = new Set<string>();

  for (const section of sections) {
    for (const item of section.items) {
      if (item.subItems?.length) {
        for (const subItem of item.subItems) {
          hrefs.add(normalizeNavigationPath(subItem.href));
        }
      } else {
        hrefs.add(normalizeNavigationPath(item.href));
      }
    }
  }

  const priority = new Map<string, number>(
    ROUTE_WARM_PRIORITY.map((href, index) => [href, index] as const),
  );

  return [...hrefs].sort(
    (left, right) =>
      (priority.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function getWarmupConcurrency(connection?: NetworkConnectionLike): number {
  if (connection?.saveData) return 0;
  if (
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g"
  ) {
    return 0;
  }
  if (connection?.effectiveType === "3g") {
    return CONSTRAINED_CONNECTION_CONCURRENCY;
  }
  return FAST_CONNECTION_CONCURRENCY;
}

function getBrowserWarmupWindow(): RouteWarmupWindow | undefined {
  if (typeof window === "undefined") return undefined;
  return window as unknown as RouteWarmupWindow;
}

/**
 * Warm permission-visible route code after hydration, using at most two route
 * chains at a time. The queue pauses while hidden, offline, or on a data-saver/
 * 2G connection and is fully cancellable when the persistent shell unmounts.
 */
export function scheduleAdminRouteChunkWarmup({
  router,
  hrefs,
  currentPath,
  signal,
  window: providedWindow,
}: AdminRouteChunkWarmupOptions): () => void {
  const warmWindow = providedWindow ?? getBrowserWarmupWindow();
  if (!warmWindow || signal?.aborted) return () => undefined;

  const current = normalizeNavigationPath(currentPath);
  const state = warmupStateByRouter.get(router as object) ?? {
    warmed: new Set<string>(),
    inFlight: new Set<string>(),
  };
  warmupStateByRouter.set(router as object, state);
  state.warmed.add(current);

  const queue = [...new Set(hrefs.map(normalizeNavigationPath))].filter(
    (href) =>
      href !== current && !state.warmed.has(href) && !state.inFlight.has(href),
  );
  if (queue.length === 0) return () => undefined;

  let active = 0;
  let cancelled = false;
  let pageHidden = false;
  let idleHandle: number | undefined;
  let fallbackHandle: number | undefined;

  const connection = warmWindow.navigator.connection;

  const cancelScheduledWork = () => {
    if (idleHandle !== undefined) {
      warmWindow.cancelIdleCallback?.(idleHandle);
      idleHandle = undefined;
    }
    if (fallbackHandle !== undefined) {
      warmWindow.clearTimeout(fallbackHandle);
      fallbackHandle = undefined;
    }
  };

  const canWarm = () =>
    !cancelled &&
    !signal?.aborted &&
    !pageHidden &&
    !warmWindow.document.hidden &&
    warmWindow.navigator.onLine !== false &&
    getWarmupConcurrency(connection) > 0;

  let scheduleNext = () => undefined;

  const runIdleWork = (deadline: IdleDeadlineLike) => {
    idleHandle = undefined;
    fallbackHandle = undefined;
    if (!canWarm()) return;

    const concurrency = getWarmupConcurrency(connection);
    let availableSlots = Math.max(0, concurrency - active);

    while (
      queue.length > 0 &&
      availableSlots > 0 &&
      (deadline.didTimeout || deadline.timeRemaining() >= MIN_IDLE_TIME_MS)
    ) {
      const href = queue.shift();
      if (!href) break;

      active += 1;
      availableSlots -= 1;
      state.inFlight.add(href);
      void preloadAdminRouteChunks(router, href)
        .then(() => {
          state.warmed.add(href);
        })
        .catch(() => {
          // A transient chunk failure should be retried by a later shell mount.
        })
        .finally(() => {
          state.inFlight.delete(href);
          active -= 1;
          scheduleNext();
        });
    }

    if (queue.length > 0 && active < concurrency) scheduleNext();
  };

  scheduleNext = () => {
    if (
      !canWarm() ||
      queue.length === 0 ||
      idleHandle !== undefined ||
      fallbackHandle !== undefined
    ) {
      return;
    }

    if (warmWindow.requestIdleCallback) {
      idleHandle = warmWindow.requestIdleCallback(runIdleWork, {
        timeout: IDLE_WARMUP_TIMEOUT_MS,
      });
      return;
    }

    fallbackHandle = warmWindow.setTimeout(
      () =>
        runIdleWork({
          didTimeout: true,
          timeRemaining: () => 0,
        }),
      FALLBACK_WARMUP_DELAY_MS,
    );
  };

  const reconsider = () => {
    cancelScheduledWork();
    scheduleNext();
  };
  const handlePageHide = () => {
    pageHidden = true;
    cancelScheduledWork();
  };
  const handlePageShow = () => {
    pageHidden = false;
    scheduleNext();
  };
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancelScheduledWork();
    warmWindow.document.removeEventListener("visibilitychange", reconsider);
    warmWindow.removeEventListener("online", reconsider);
    warmWindow.removeEventListener("offline", reconsider);
    warmWindow.removeEventListener("pagehide", handlePageHide);
    warmWindow.removeEventListener("pageshow", handlePageShow);
    connection?.removeEventListener?.("change", reconsider);
    signal?.removeEventListener("abort", cancel);
  };

  warmWindow.document.addEventListener("visibilitychange", reconsider);
  warmWindow.addEventListener("online", reconsider);
  warmWindow.addEventListener("offline", reconsider);
  warmWindow.addEventListener("pagehide", handlePageHide);
  warmWindow.addEventListener("pageshow", handlePageShow);
  connection?.addEventListener?.("change", reconsider);
  signal?.addEventListener("abort", cancel, { once: true });
  scheduleNext();

  return cancel;
}
