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

/**
 * What a notice refreshes. `prefix`: every read under it (`staleBefore`, epoch
 * ms: only those read before it, a resync's catch-up). `orderId`: one order's
 * own reads. `orderVersions`: every open order page re-reads its order, and
 * an order whose version moved re-reads all its cards.
 */
export type KeyMatch =
  | { prefix: QueryKey; staleBefore?: number }
  | { orderId: string }
  | { orderVersions: true };

/**
 * Each topic's reads: the key roots its notices refresh (`roots`, minus the
 * lists that add rows themselves, `ownLists`), what one record's notice
 * refreshes when it names one (`record`), and whether Home shows the topic.
 * Typed over every topic: a new topic does not compile until it says what it
 * refreshes (invalidate.test.ts maps each topic to its screens' keys).
 */
interface TopicReads {
  roots: readonly QueryKey[];
  /** A notice naming a record: that record's reads and the topic's lists, not every record's. */
  record?: (id: string) => KeyMatch[];
  /** A notice naming no record (a table-level `changed`, a collapsed burst). */
  anyRecord?: KeyMatch[];
  home?: true;
}

/** Roots defined beside their screens' query options (kept out of this lazy chunk); invalidate.test.ts checks them. */
export const PURCHASING_ROOT = ["purchasing"] as const;
export const INVENTORY_LOCATIONS_ROOT = ["inventory-locations"] as const;
export const GIFT_CARDS_ROOT = ["gift-cards"] as const;

const orderReads: TopicReads = {
  roots: [queryKeys.orders.all],
  record: (id) => [{ orderId: id }],
  // A table-level notice names no order: each open order page checks its own.
  // Courier updates move a parcel without moving the order: shipments refresh as they are.
  anyRecord: [{ orderVersions: true }, { prefix: ["orders", "shipments"] }],
  home: true,
};

export const TOPIC_READS: Readonly<Record<RealtimeTopic, TopicReads>> = {
  orders: orderReads,
  payments: {
    roots: [queryKeys.orders.all],
    record: (id) => [{ orderId: id }],
    // Payments and disputes (chargebacks): a dispute's status can move without the order moving.
    anyRecord: [{ orderVersions: true }, { prefix: ["orders", "payments"] }, { prefix: ["orders", "disputes"] }],
    home: true,
  },
  // A return's notice names the return; its order's own notice names the order.
  returns: { roots: [["orders", "returns"]], home: true },
  inbox: { roots: [inboxKeys.all] },
  reviews: { roots: [reviewKeys.all] },
  products: {
    roots: [queryKeys.products.all],
    // Home's low-stock to-do counts only products a buyer can buy: a product put live or back to draft moves it.
    home: true,
    record: (id) => [
      { prefix: queryKeys.products.list() },
      { prefix: queryKeys.products.stats() },
      { prefix: queryKeys.products.detail(id) },
      { prefix: queryKeys.products.variants(id) },
    ],
  },
  // Stock, purchase orders, transfers and suppliers, and Home's low-stock to-do.
  inventory: { roots: [queryKeys.inventory.all, PURCHASING_ROOT, INVENTORY_LOCATIONS_ROOT], home: true },
  customers: {
    roots: [queryKeys.customers.all],
    record: (id) => [
      { prefix: queryKeys.customers.list() },
      // The customer's page: detail, history, marketing, saved payment methods.
      ...(["detail", "history", "marketing", "payment-methods"] as const).map((part) => ({ prefix: ["customers", part, id] })),
    ],
  },
  categories: { roots: [queryKeys.categories.all, queryKeys.brands.all] },
  collections: { roots: [queryKeys.collections.all] },
  pages: { roots: [queryKeys.pages.all] },
  settings: { roots: [queryKeys.settings.all] },
  discounts: { roots: [queryKeys.discounts.all] },
  gift_cards: { roots: [GIFT_CARDS_ROOT] },
  media: { roots: [queryKeys.media.all] },
  attributes: { roots: [queryKeys.attributes.all] },
  navigation: { roots: [queryKeys.navigation.all] },
};

/** The keys a set of notices makes stale. The order list adds rows itself, so no notice refetches it. */
export function keysForChanges(items: readonly RealtimeChange[]): KeyMatch[] {
  const matches: KeyMatch[] = [];
  for (const item of items) {
    const reads = TOPIC_READS[item.topic];
    if (!reads) continue;
    if (reads.home) matches.push({ prefix: queryKeys.dashboard.all });
    // A new order is offered by the list's bar; nothing on screen reads it yet.
    if (item.topic === "orders" && item.kind === "order.created") continue;
    const scoped = item.id ? reads.record?.(item.id) : reads.anyRecord;
    matches.push(...(scoped ?? reads.roots.map((prefix) => ({ prefix }))));
  }
  return matches;
}

/** What a reconnect refetches: everything the hub could have told us about. */
export function resyncKeys(topics: readonly RealtimeTopic[], staleBefore?: number): KeyMatch[] {
  const keys = new Map<string, QueryKey>();
  for (const topic of topics) {
    for (const root of TOPIC_READS[topic]?.roots ?? []) keys.set(JSON.stringify(root), root);
  }
  keys.set(JSON.stringify(queryKeys.dashboard.all), queryKeys.dashboard.all);
  return [...keys.values()].map((prefix) => (staleBefore === undefined ? { prefix } : { prefix, staleBefore }));
}

const ORDER_DETAIL_PREFIX = ["orders", "detail"] as const;
const orderVersion = (data: unknown): unknown => (data as { version?: unknown } | undefined)?.version;

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
    if (matches.some((match) => "orderVersions" in match)) void refreshOpenOrders();
    const others = matches.filter((match) => !isDashboardMatch(match) && !("orderVersions" in match));
    if (others.length === 0) return;
    void queryClient.invalidateQueries({
      refetchType: "active",
      predicate: (query) => others.some((match) => "prefix" in match
        ? partialMatchKey(query.queryKey, match.prefix) && (match.staleBefore === undefined || query.state.dataUpdatedAt < match.staleBefore)
        : "orderId" in match && isOrderRead(query.queryKey, match.orderId)),
    });
  };

  /**
   * A notice that names no order: each order page on screen re-reads its
   * order (one read), and one whose version moved re-reads every card, so a
   * page never shows actions for a state the order has left. Pages of orders
   * that did not move cost that one read.
   */
  const refreshOpenOrders = async () => {
    const open = queryClient.getQueryCache().findAll({ queryKey: ORDER_DETAIL_PREFIX, type: "active" });
    await Promise.all(open.map(async (query) => {
      const orderId = query.queryKey[2];
      if (typeof orderId !== "string") return;
      const before = orderVersion(query.state.data);
      await queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: "active" }, { cancelRefetch: false });
      if (disposed || orderVersion(query.state.data) === before) return;
      await queryClient.invalidateQueries({
        refetchType: "active",
        predicate: (other) => isOrderRead(other.queryKey, orderId) && other.queryKey[1] !== ORDER_DETAIL_PREFIX[1],
      });
    }));
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
