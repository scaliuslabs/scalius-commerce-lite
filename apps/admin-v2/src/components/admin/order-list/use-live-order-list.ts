import { useEffect, useRef, useState } from "react";
import type { RealtimeChange } from "@scalius/shared/realtime";

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
 * offers it. A change to a row on screen refreshes the page in place, which
 * keeps every row where it is, unless new orders are waiting or the merchant
 * is busy with the rows (then the bar offers the refresh). It hears the
 * bridge's window events (RealtimeBridge.tsx), so it loads no realtime module.
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
  const visible = new Set(visibleIds);
  // A new order the list already shows (another refresh loaded it) is no longer news.
  const newCount = [...newIds].filter((id) => !visible.has(id)).length;
  const load = () => void refetch().catch(() => undefined);
  const latest = useRef({ paused, visible, newCount, load });
  latest.current = { paused, visible, newCount, load };

  useEffect(() => {
    const refreshInPlace = () => {
      const now = latest.current;
      if (now.paused || now.newCount > 0) setStale(true);
      else now.load();
    };
    const onChanges = (event: Event) => {
      const items = ((event as CustomEvent<RealtimeChange[]>).detail ?? []).filter((item) => item.topic === "orders");
      const shown = latest.current.visible;
      const created = items.filter((item) => item.kind === "order.created" && item.id && !shown.has(item.id));
      if (created.length > 0) setNewIds((current) => new Set([...current, ...created.map((item) => item.id!)]));
      // Shipment notices carry no id: they may touch any row on screen.
      if (items.some((item) => item.kind !== "order.created" && (!item.id || shown.has(item.id)))) refreshInPlace();
    };
    window.addEventListener("scalius:realtime-changes", onChanges);
    window.addEventListener("scalius:realtime-resync", refreshInPlace);
    return () => {
      window.removeEventListener("scalius:realtime-changes", onChanges);
      window.removeEventListener("scalius:realtime-resync", refreshInPlace);
    };
  }, []);

  // The merchant finished with the rows: catch up on what changed meanwhile.
  useEffect(() => {
    if (!paused && stale && newCount === 0) {
      setStale(false);
      latest.current.load();
    }
  }, [paused, stale, newCount]);

  return {
    newCount,
    stale,
    showLatest: () => {
      setNewIds(new Set());
      setStale(false);
      onShowLatest?.();
      load();
      document.getElementById("admin-main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
    },
  };
}
