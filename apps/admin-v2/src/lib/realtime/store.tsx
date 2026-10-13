/**
 * The seam screens use to hear the realtime hub, without loading the
 * connection: the admin frame's lazy bridge attaches it
 * (components/admin/realtime/RealtimeBridge.tsx). Until it does (or when it
 * never can), subscriptions wait and editors simply show no presence.
 *
 * Presence on an editor (docs/platform/REALTIME.md, DESIGN.md W1-W6): pass
 *
 *   <PresenceSlot presenceKey={presenceKey("product", id)} revision dirty changedFields onLoadLatest />
 *
 * as `PageHeader`'s `presence`, and mark the editor's root element with
 * `data-presence-root={key}`. The slot reserves the avatars' space at once and
 * loads everything else (avatars, the editing banner, field rings, the save
 * notice, focus reporting) a moment later, so no route pays for it up front.
 */
import { createContext, lazy, Suspense } from "react";
import type { PresenceKeyPrefix, PresenceListPrefix } from "@scalius/shared/realtime";
import type { RealtimeConnection, RealtimeListener } from "./connection";
import { setRealtimeOpen } from "../admin-query-client";

export { pollWhileOffline } from "../admin-query-client";

export type PresencePrefix = PresenceKeyPrefix;

/**
 * `<prefix>:<id>`, as `presenceKey` in `@scalius/shared/realtime` (whose
 * PRESENCE_KEY_TOPICS the hub checks). Repeated here so editors load no
 * shared module for one template string.
 */
export function presenceKey(prefix: PresencePrefix, id: string): string {
  return `${prefix}:${id}`;
}

type Connection = Pick<RealtimeConnection, "subscribe" | "watch" | "watchList" | "announceSave" | "focus" | "getStatus">;

let connection: Connection | null = null;
let currentUserId: string | null = null;
const waiting = new Map<RealtimeListener, (() => void) | null>();
const watched = new Map<string, number>();
const watchReleases = new Map<string, () => void>();
const listsWatched = new Map<PresenceListPrefix, number>();
const listReleases = new Map<PresenceListPrefix, () => void>();
/** This tab's focus state per key, replayed to a connection that attaches later. */
const focusState = new Map<string, { field: string | null; editing: boolean }>();

/** The bridge hands over its connection (or null when it stops). */
export function attachRealtime(next: Connection | null, userId: string | null = null): void {
  for (const [listener, unsubscribe] of waiting) {
    unsubscribe?.();
    waiting.set(listener, next ? next.subscribe(listener) : null);
  }
  for (const release of watchReleases.values()) release();
  watchReleases.clear();
  for (const release of listReleases.values()) release();
  listReleases.clear();
  connection = next;
  currentUserId = userId;
  // No connection is a closed one: polls resume and presence clears.
  if (!next) for (const listener of [...waiting.keys()]) listener.status?.("closed");
  if (!next) return;
  for (const key of watched.keys()) watchReleases.set(key, next.watch(key));
  for (const prefix of listsWatched.keys()) listReleases.set(prefix, next.watchList(prefix));
  for (const [key, state] of focusState) next.focus(key, state.field, state.editing);
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
    focusState.delete(key);
    watchReleases.get(key)?.();
    watchReleases.delete(key);
  };
}

/** Hears who has the records of a list open (`order`), without joining them (counted). */
export function watchPresenceList(prefix: PresenceListPrefix): () => void {
  listsWatched.set(prefix, (listsWatched.get(prefix) ?? 0) + 1);
  if (connection && !listReleases.has(prefix)) listReleases.set(prefix, connection.watchList(prefix));
  return () => {
    const count = (listsWatched.get(prefix) ?? 1) - 1;
    if (count > 0) {
      listsWatched.set(prefix, count);
      return;
    }
    listsWatched.delete(prefix);
    listReleases.get(prefix)?.();
    listReleases.delete(prefix);
  };
}

/**
 * Tells the other editors on `key` that this one saved (no-op without a
 * connection). `fields` names the fields the save changed: form names, never values.
 */
export function announceSave(key: string, rev: number | null, fields: readonly string[] = []): void {
  connection?.announceSave(key, rev, fields.filter(isFieldKey));
}

/** The field this tab is in on `key` (null for none) and whether its draft has unsaved changes. */
export function reportFocus(key: string, field: string | null, editing: boolean): void {
  const state = { field: field && isFieldKey(field) ? field : null, editing };
  const previous = focusState.get(key);
  if (previous && previous.field === state.field && previous.editing === state.editing) return;
  focusState.set(key, state);
  connection?.focus(key, state.field, state.editing);
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

// ── Field keys ───────────────────────────────────────────────────────────
// A field is named by its control's form `name` (or the nearest
// `data-field`), the same in every browser and language. Generated ids
// (`:r1:`) never match. Mirrors isFieldKey in @scalius/shared/realtime.

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

export function isFieldKey(value: unknown): value is string {
  return typeof value === "string" && FIELD_KEY.test(value);
}

// -- The visible parts, loaded after the first render --------------------

const EditorPresenceView = lazy(() => import("~/components/admin/realtime/EditorPresenceView"));

export interface PresenceSlotProps {
  /** `presenceKey(prefix, id)`; null for a new, unsaved record (renders nothing). */
  presenceKey: string | null;
  /** The revision this editor has: a save notice for it or an older one is dropped. */
  revision?: number | null;
  /** This editor has unsaved changes. */
  dirty: boolean;
  /** Join as a viewer; focused immutable controls must not report editing. */
  readOnly?: boolean;
  /** The fields this draft changed (form names), to tell a clean merge from a clash. */
  changedFields?: () => readonly string[];
  /** Loads the latest saved record under this draft's edits (a merge), or simply the latest when clean. */
  onLoadLatest?: () => void;
  /** The banner, field rings and save notice; false for an editor that handles saves itself (the theme editor). */
  notices?: boolean;
  /** With `notices` false: another person saved (a newer revision than this editor has). */
  onRemoteSave?: () => void;
}

/**
 * The avatars beside the page title (pass it as `PageHeader`'s `presence`).
 * The box is always there on a saved record, sized for three avatars and
 * "+N" (96 by 28 px), so people arriving never move the page.
 */
export function PresenceSlot(props: PresenceSlotProps) {
  if (!props.presenceKey) return null;
  return (
    <div data-slot="presence-avatars" className="flex h-7 w-24 shrink-0 items-center">
      <Suspense fallback={null}>
        <EditorPresenceView {...props} presenceKey={props.presenceKey} />
      </Suspense>
    </div>
  );
}
