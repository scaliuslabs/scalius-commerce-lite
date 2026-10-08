/**
 * The seam screens use to hear the realtime hub, without loading the
 * connection: the admin frame's lazy bridge attaches it
 * (components/admin/realtime/RealtimeBridge.tsx). Until it does (or when it
 * never can), subscriptions wait and editors simply show no presence.
 */
import { useEffect, useRef } from "react";
import type { RealtimeChange, RealtimeTopic } from "@scalius/shared/realtime";
import type { RealtimeConnection, RealtimeListener } from "./connection";
import { setRealtimeOpen } from "../admin-query-client";

export { pollWhileOffline } from "../admin-query-client";

type Connection = Pick<RealtimeConnection, "subscribe" | "watch" | "announceSave" | "getStatus">;

let connection: Connection | null = null;
let currentUserId: string | null = null;
const waiting = new Map<RealtimeListener, (() => void) | null>();
const watched = new Map<string, number>();
const watchReleases = new Map<string, () => void>();

/** The bridge hands over its connection (or null when it stops). */
export function attachRealtime(next: Connection | null, userId: string | null = null): void {
  for (const [listener, unsubscribe] of waiting) {
    unsubscribe?.();
    waiting.set(listener, next ? next.subscribe(listener) : null);
  }
  for (const release of watchReleases.values()) release();
  watchReleases.clear();
  connection = next;
  currentUserId = userId;
  if (next) for (const key of watched.keys()) watchReleases.set(key, next.watch(key));
}

export function subscribeRealtime(listener: RealtimeListener): () => void {
  waiting.set(listener, connection ? connection.subscribe(listener) : null);
  return () => {
    waiting.get(listener)?.();
    waiting.delete(listener);
  };
}

/** Joins an editor's presence key (counted: two cards on one page share it). */
export function watchKey(key: string): () => void {
  watched.set(key, (watched.get(key) ?? 0) + 1);
  if (connection && !watchReleases.has(key)) watchReleases.set(key, connection.watch(key));
  return () => {
    const count = (watched.get(key) ?? 1) - 1;
    if (count > 0) {
      watched.set(key, count);
      return;
    }
    watched.delete(key);
    watchReleases.get(key)?.();
    watchReleases.delete(key);
  };
}

/** Tells the other editors on `key` that this one saved (no-op without a connection). */
export function announceSave(key: string, rev: number | null): void {
  connection?.announceSave(key, rev);
}

/** Calls `onChange` with the hub's notices for these topics. */
export function useRealtimeChanges(topics: readonly RealtimeTopic[], onChange: (items: RealtimeChange[]) => void): void {
  const callback = useRef(onChange);
  callback.current = onChange;
  const topicKey = topics.join(",");
  useEffect(() => {
    const wanted = new Set(topicKey.split(","));
    return subscribeRealtime({
      changes: (items) => {
        const mine = items.filter((item) => wanted.has(item.topic));
        if (mine.length > 0) callback.current(mine);
      },
    });
  }, [topicKey]);
}

/** Calls `onResync` when the socket reopens after a gap (missed notices). */
export function useRealtimeResync(onResync: () => void): void {
  const callback = useRef(onResync);
  callback.current = onResync;
  useEffect(() => subscribeRealtime({ resync: () => callback.current() }), []);
}

// The shell's polls stop while the hub is open (lib/admin-query-client.ts).
subscribeRealtime({ status: (next) => setRealtimeOpen(next === "open") });

/** The signed-in staff member, as the bridge attached it (presence leaves them out). */
export function realtimeUserId(): string | null {
  return currentUserId;
}
