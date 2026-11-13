/**
 * Hub notices → TanStack Query keys. Only queries a screen is showing refetch
 * (`refetchType: "active"`); the rest are marked stale for their next visit.
 * The order list adds rows itself (the "new orders" bar), so a new order never
 * shifts a list the merchant is reading.
 */
import { partialMatchKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { RealtimeChange, RealtimeTopic } from "@scalius/shared/realtime";
import { queryKeys } from "~/lib/query-keys";
import { inboxKeys } from "~/lib/api-query-options/inbox";
import { reviewKeys } from "~/lib/api-query-options/reviews";

/** `staleBefore` (epoch ms): only queries read before it (a resync's catch-up). */
export type KeyMatch = { prefix: QueryKey; staleBefore?: number } | { orderId: string };

/** The keys a set of notices makes stale. */
export function keysForChanges(items: readonly RealtimeChange[]): KeyMatch[] {
  const matches: KeyMatch[] = [];
  const add = (prefix: QueryKey) => matches.push({ prefix });
  for (const item of items) {
    switch (item.topic) {
      case "orders":
        add(queryKeys.dashboard.all);
        if (item.id && item.kind !== "order.created") matches.push({ orderId: item.id });
        if (item.kind === "changed") add(["orders", "shipments"]);
        break;
      case "payments":
        if (item.id) add(queryKeys.orders.payments(item.id));
        else add(["orders", "payments"]);
        break;
      case "returns":
        add(["orders", "returns"]);
        break;
      case "inbox":
        add(inboxKeys.all);
        break;
      case "reviews":
        add(reviewKeys.all);
        break;
      case "products":
        add(queryKeys.products.list());
        add(queryKeys.products.stats());
        if (item.id) {
          add(queryKeys.products.detail(item.id));
          add(queryKeys.products.variants(item.id));
        }
        break;
      case "inventory":
        add(queryKeys.inventory.all);
        break;
      case "customers":
        add(queryKeys.customers.list());
        if (item.id) add(queryKeys.customers.detail(item.id));
        break;
      default:
        break;
    }
  }
  return matches;
}

/** What a reconnect refetches: everything the hub could have told us about. */
export function resyncKeys(topics: readonly RealtimeTopic[], staleBefore?: number): KeyMatch[] {
  const roots: Partial<Record<RealtimeTopic, QueryKey>> = {
    orders: queryKeys.orders.all,
    payments: queryKeys.orders.all,
    returns: queryKeys.orders.all,
    inbox: inboxKeys.all,
    reviews: reviewKeys.all,
    products: queryKeys.products.all,
    inventory: queryKeys.inventory.all,
    customers: queryKeys.customers.all,
  };
  const keys = new Map<string, QueryKey>();
  for (const topic of topics) {
    const root = roots[topic];
    if (root) keys.set(JSON.stringify(root), root);
  }
  keys.set(JSON.stringify(queryKeys.dashboard.all), queryKeys.dashboard.all);
  return [...keys.values()].map((prefix) => (staleBefore === undefined ? { prefix } : { prefix, staleBefore }));
}

/** One order's own reads (`["orders", <part>, id]`), never the list. */
function isOrderRead(key: QueryKey, orderId: string): boolean {
  return key[0] === "orders" && key[1] !== "list" && key[2] === orderId;
}

/** The dashboard's keys: Home, its activity feed and the setup guide all live under `["dashboard"]`. */
function isDashboardMatch(match: KeyMatch): boolean {
  return "prefix" in match && match.prefix[0] === queryKeys.dashboard.all[0];
}

/** At most one dashboard refetch per window while the tab is in view. */
export const DASHBOARD_REFETCH_WINDOW_MS = 30_000;

export interface InvalidatorOptions {
  /** Milliseconds now (tests inject a clock). */
  now?: () => number;
  /** Whether the tab is in the background. */
  isHidden?: () => boolean;
  /** Calls `listener` when the tab is shown or hidden; returns the unsubscribe. */
  onVisibilityChange?: (listener: () => void) => () => void;
  dashboardWindowMs?: number;
}

const documentHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const documentVisibilityChange = (listener: () => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/**
 * Coalesces notices for `delayMs` and invalidates once: a burst (a bulk status
 * change, a stock import) costs one refetch per screen, not one per row.
 *
 * The dashboard is heavier than a list and every order notice touches it, so
 * its queries refetch at most once per `dashboardWindowMs` while the tab is in
 * view (the first notice at once, later ones at the window's end) and never
 * while it is hidden: they are only marked stale, and one refetch runs when the
 * tab is shown again. The query client does not refetch on window focus, so
 * that return refetch is this function's.
 */
export function createInvalidator(queryClient: QueryClient, delayMs = 250, options: InvalidatorOptions = {}) {
  const now = options.now ?? Date.now;
  const isHidden = options.isHidden ?? documentHidden;
  const windowMs = options.dashboardWindowMs ?? DASHBOARD_REFETCH_WINDOW_MS;
  const subscribeVisibility = options.onVisibilityChange ?? documentVisibilityChange;

  let pending: KeyMatch[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dashboardTimer: ReturnType<typeof setTimeout> | null = null;
  let dashboardLastRefetch = Number.NEGATIVE_INFINITY;
  /** Dashboard queries went stale while the tab was hidden. */
  let dashboardStaleHidden = false;
  let disposed = false;

  const dashboardPredicate = (query: { queryKey: QueryKey }) => partialMatchKey(query.queryKey, queryKeys.dashboard.all);

  const refreshDashboard = () => {
    if (disposed) return;
    if (isHidden()) {
      void queryClient.invalidateQueries({ refetchType: "none", predicate: dashboardPredicate });
      dashboardStaleHidden = true;
      return;
    }
    const wait = dashboardLastRefetch + windowMs - now();
    if (wait <= 0) {
      if (dashboardTimer) clearTimeout(dashboardTimer);
      dashboardTimer = null;
      dashboardStaleHidden = false;
      dashboardLastRefetch = now();
      void queryClient.invalidateQueries({ refetchType: "active", predicate: dashboardPredicate });
      return;
    }
    void queryClient.invalidateQueries({ refetchType: "none", predicate: dashboardPredicate });
    dashboardTimer ??= setTimeout(() => {
      dashboardTimer = null;
      refreshDashboard();
    }, wait);
  };

  const unsubscribeVisibility = subscribeVisibility(() => {
    if (!isHidden() && dashboardStaleHidden) {
      dashboardStaleHidden = false;
      refreshDashboard();
    }
  });

  const flush = () => {
    timer = null;
    const matches = pending;
    pending = [];
    if (matches.length === 0) return;
    // A catch-up (`staleBefore`) refreshes Home only when Home holds data that old; through the same throttle.
    const dashboardOlderThan = (staleBefore: number) => queryClient.getQueryCache()
      .findAll({ predicate: dashboardPredicate })
      .some((query) => query.state.dataUpdatedAt < staleBefore);
    if (matches.some((match) => isDashboardMatch(match) && ("prefix" in match && match.staleBefore !== undefined ? dashboardOlderThan(match.staleBefore) : true))) refreshDashboard();
    const others = matches.filter((match) => !isDashboardMatch(match));
    if (others.length === 0) return;
    void queryClient.invalidateQueries({
      refetchType: "active",
      predicate: (query) => others.some((match) => "prefix" in match
        ? partialMatchKey(query.queryKey, match.prefix) && (match.staleBefore === undefined || query.state.dataUpdatedAt < match.staleBefore)
        : isOrderRead(query.queryKey, match.orderId)),
    });
  };
  return {
    add(matches: KeyMatch[]) {
      if (matches.length === 0) return;
      pending.push(...matches);
      timer ??= setTimeout(flush, delayMs);
    },
    dispose() {
      // Notices still inside the 250 ms coalesce are applied now, not lost.
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      // A trailing dashboard refetch the window still owed runs now: its
      // notices already marked the queries stale, and nothing else would
      // refetch them while they stay on screen.
      const owedRefetch = dashboardTimer !== null && !isHidden();
      disposed = true;
      if (dashboardTimer) clearTimeout(dashboardTimer);
      if (owedRefetch) void queryClient.invalidateQueries({ refetchType: "active", predicate: dashboardPredicate });
      timer = null;
      dashboardTimer = null;
      pending = [];
      unsubscribeVisibility();
    },
  };
}
