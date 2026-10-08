/**
 * Hub notices → TanStack Query keys. Only queries a screen is showing refetch
 * (`refetchType: "active"`); the rest are marked stale for their next visit.
 * The order list adds rows itself (the "new orders" bar), so a new order never
 * shifts a list the merchant is reading.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { RealtimeChange, RealtimeTopic } from "@scalius/shared/realtime";
import { queryKeys } from "~/lib/query-keys";
import { inboxKeys } from "~/lib/api-query-options/inbox";
import { reviewKeys } from "~/lib/api-query-options/reviews";

export type KeyMatch = { prefix: QueryKey } | { orderId: string };

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
export function resyncKeys(topics: readonly RealtimeTopic[]): KeyMatch[] {
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
  return [...keys.values()].map((prefix) => ({ prefix }));
}

function startsWith(key: QueryKey, prefix: QueryKey): boolean {
  return prefix.length <= key.length && prefix.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]));
}

/** One order's own reads (`["orders", <part>, id]`), never the list. */
function isOrderRead(key: QueryKey, orderId: string): boolean {
  return key[0] === "orders" && key[1] !== "list" && key[2] === orderId;
}

/**
 * Coalesces notices for `delayMs` and invalidates once: a burst (a bulk status
 * change, a stock import) costs one refetch per screen, not one per row.
 */
export function createInvalidator(queryClient: QueryClient, delayMs = 250) {
  let pending: KeyMatch[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const matches = pending;
    pending = [];
    if (matches.length === 0) return;
    void queryClient.invalidateQueries({
      refetchType: "active",
      predicate: (query) => matches.some((match) => "prefix" in match
        ? startsWith(query.queryKey, match.prefix)
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
      if (timer) clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}
