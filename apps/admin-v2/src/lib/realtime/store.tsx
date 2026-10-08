/**
 * The seam screens use to hear the realtime hub, without loading the
 * connection: the admin frame's lazy bridge attaches it
 * (components/admin/realtime/RealtimeBridge.tsx). Until it does (or when it
 * never can), subscriptions wait and editors simply show no presence.
 */
import { createContext, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { RealtimeChange, RealtimePerson, RealtimeTopic } from "@scalius/shared/realtime";
import type { RealtimeConnection, RealtimeListener } from "./connection";
import { setRealtimeOpen } from "../admin-query-client";

export { pollWhileOffline } from "../admin-query-client";

/**
 * `<prefix>:<id>`, as `presenceKey` in `@scalius/shared/realtime` (whose
 * PRESENCE_KEY_TOPICS the hub checks). Repeated here so editors load no
 * shared module for one template string.
 */
export function presenceKey(prefix: "product" | "category" | "collection" | "page" | "theme" | "settings", id: string): string {
  return `${prefix}:${id}`;
}

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

/**
 * The presence key of the page around a card (a settings page): cards that
 * save on their own announce their saves under it.
 */
export const PresenceScopeContext = createContext<string | null>(null);

export interface EditorPresence {
  /** Other staff on this editor now (never the viewer). */
  others: RealtimePerson[];
  /** The last save by someone else since this editor opened, until dismissed. */
  remoteSave: { by: RealtimePerson; rev: number | null; at: number } | null;
  dismissRemoteSave(): void;
}

/**
 * Presence and live save notices for one revision-fenced editor. `key` is
 * `presenceKey(prefix, id)`; null turns it off (a new, unsaved record).
 * `currentRev` drops a save notice for a revision this editor already has.
 */
export function useEditorPresence(key: string | null, currentRev?: number | null): EditorPresence {
  const [others, setOthers] = useState<RealtimePerson[]>([]);
  const [remoteSave, setRemoteSave] = useState<EditorPresence["remoteSave"]>(null);
  const rev = useRef(currentRev ?? null);
  rev.current = currentRev ?? null;
  useEffect(() => {
    setOthers([]);
    setRemoteSave(null);
    if (!key) return;
    const release = watchKey(key);
    const unsubscribe = subscribeRealtime({
      presence: (presenceKey, people) => {
        if (presenceKey !== key) return;
        setOthers(people.filter((person) => person.id !== realtimeUserId()));
      },
      saved: (savedKey, by, savedRev) => {
        if (savedKey !== key) return;
        if (savedRev !== null && rev.current !== null && savedRev <= rev.current) return;
        setRemoteSave({ by, rev: savedRev, at: Date.now() });
      },
      status: (next) => {
        if (next !== "open") setOthers([]);
      },
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [key]);
  return { others, remoteSave, dismissRemoteSave: () => setRemoteSave(null) };
}

// ── The editor's presence line ───────────────────────────────────────────
// "Rahim is also editing" and the live save notice (Shopify and Linear's
// presence). The editor joins its key at once; the visible part
// (components/admin/realtime/PresenceView.tsx) loads only when someone else
// is there or has saved, so an editor alone pays almost nothing for it.

const PresenceNotice = lazy(() => import("~/components/admin/realtime/PresenceView"));

/**
 * `presenceKey` is `presenceKey(prefix, id)` from `@scalius/shared/realtime`
 * (null for a new record). `dirty` picks the notice's advice; `onLoadLatest`
 * loads the other save (keeping unsaved edits where the editor can).
 */
export function EditorPresence({
  presenceKey,
  revision,
  dirty,
  onLoadLatest,
}: {
  presenceKey: string | null;
  revision?: number | null;
  dirty: boolean;
  onLoadLatest?: () => void;
}) {
  const presence = useEditorPresence(presenceKey, revision);
  if (presence.others.length === 0 && !presence.remoteSave) return null;
  return (
    <Suspense fallback={null}>
      <PresenceNotice {...presence} dirty={dirty} onLoadLatest={onLoadLatest} />
    </Suspense>
  );
}
