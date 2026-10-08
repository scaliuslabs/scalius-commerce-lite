import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChange } from "@scalius/shared/realtime";
import { useRealtimeChanges, useRealtimeResync } from "~/lib/realtime/store";

export interface LiveOrderList {
  /** Orders placed since the list loaded that it does not show yet. */
  newCount: number;
  /** Rows on screen changed while the list could not refresh (selection, a dialog, a save). */
  stale: boolean;
  /** Loads the newest list (the bar's "Show"). */
  showLatest(): void;
}

/**
 * Keeps the order list live without moving it under the merchant (Shopify's
 * "N new orders" bar): a new order never inserts a row by itself; the bar
 * offers it. A status change to a row on screen refreshes the page in place,
 * which keeps every row where it is, unless new orders are waiting or the
 * merchant is busy with the rows (then the bar offers the refresh).
 */
export function useLiveOrderList({
  refetch,
  paused,
  visibleIds,
  onShowLatest,
}: {
  refetch: () => Promise<unknown>;
  paused: boolean;
  visibleIds: readonly string[];
  /** Moves a list on a later page back to the first, where new orders appear. */
  onShowLatest?: () => void;
}): LiveOrderList {
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stale, setStale] = useState(false);
  const state = useRef({ refetch, paused, visible: new Set(visibleIds), hasNew: false, onShowLatest });
  state.current = { refetch, paused, visible: new Set(visibleIds), hasNew: newIds.size > 0, onShowLatest };

  const refreshInPlace = useCallback(() => {
    const { paused: busy, hasNew, refetch: load } = state.current;
    if (busy || hasNew) {
      setStale(true);
      return;
    }
    void Promise.resolve(load()).catch(() => undefined);
  }, []);

  useRealtimeChanges(["orders"], (items: RealtimeChange[]) => {
    const created = items.filter((item) => item.kind === "order.created" && item.id && !state.current.visible.has(item.id));
    if (created.length > 0) {
      setNewIds((current) => {
        const next = new Set(current);
        for (const item of created) next.add(item.id!);
        return next;
      });
    }
    // Shipment notices carry no id: they may touch any row on screen.
    if (items.some((item) => item.kind !== "order.created" && (!item.id || state.current.visible.has(item.id)))) {
      refreshInPlace();
    }
  });
  useRealtimeResync(refreshInPlace);

  // The merchant finished with the rows: catch up on what changed meanwhile.
  useEffect(() => {
    if (!paused && stale && newIds.size === 0) {
      setStale(false);
      void Promise.resolve(state.current.refetch()).catch(() => undefined);
    }
  }, [paused, stale, newIds.size]);

  // A new order the list already shows (another refresh loaded it) is no longer news.
  const visibleKey = visibleIds.join(",");
  useEffect(() => {
    setNewIds((current) => {
      if (current.size === 0) return current;
      const visible = new Set(visibleKey.split(","));
      const next = new Set([...current].filter((id) => !visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleKey]);

  const showLatest = useCallback(() => {
    setNewIds(new Set());
    setStale(false);
    state.current.onShowLatest?.();
    void Promise.resolve(state.current.refetch()).catch(() => undefined);
    document.getElementById("admin-main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return { newCount: newIds.size, stale, showLatest };
}
