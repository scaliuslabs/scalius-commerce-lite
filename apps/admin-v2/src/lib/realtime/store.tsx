/**
 * The seam screens use to hear the realtime hub, without loading the
 * connection: the admin frame's lazy bridge attaches it
 * (components/admin/realtime/RealtimeBridge.tsx). Until it does (or when it
 * never can), subscriptions wait and editors simply show no presence.
 *
 * Presence on an editor (docs/platform/REALTIME.md, DESIGN.md W1–W6):
 *
 *   <EditorPresenceProvider presenceKey={presenceKey("product", id)} …>
 *     <PageHeader presence={<PresenceSlot />} … />   avatars beside the title
 *     <PresenceNotices />                            banner, field rings, save notice
 *     <form data-presence-root={key}>…</form>        fields report focus
 *   </EditorPresenceProvider>
 *
 * The visible parts load only when someone else is there or has saved, so an
 * editor alone pays for this file and an empty reserved box.
 */
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PresenceListPrefix, RealtimeChange, RealtimePerson, RealtimePresence, RealtimeTopic } from "@scalius/shared/realtime";
import type { RealtimeConnection, RealtimeListener } from "./connection";
import { setRealtimeOpen } from "../admin-query-client";

export { pollWhileOffline } from "../admin-query-client";

export type PresencePrefix = "order" | "product" | "category" | "collection" | "page" | "theme" | "settings";

/**
 * `<prefix>:<id>`, as `presenceKey` in `@scalius/shared/realtime` (whose
 * PRESENCE_KEY_TOPICS the hub checks). Repeated here so editors load no
 * shared module for one template string.
 */
export function presenceKey(prefix: PresencePrefix, id: string): string {
  return `${prefix}:${id}`;
}

/** The record a key names (`product` of `product:prd_1`), for "editing this product". */
export function presencePrefixOf(key: string): PresencePrefix {
  return key.slice(0, key.indexOf(":")) as PresencePrefix;
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

// ── Field keys ───────────────────────────────────────────────────────────
// A field is named by its control's form `name` (or the nearest
// `data-field`), the same in every browser and language. Generated ids
// (`:r1:`) never match. Mirrors isFieldKey in @scalius/shared/realtime.

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

export function isFieldKey(value: unknown): value is string {
  return typeof value === "string" && FIELD_KEY.test(value);
}

/** The field key of a focused element, or null when it has no stable name. */
export function fieldKeyOf(element: Element | null): string | null {
  if (!element) return null;
  const own = element.getAttribute("name") ?? element.getAttribute("data-field");
  if (isFieldKey(own)) return own;
  const holder = element.closest("[data-field]");
  const named = holder?.getAttribute("data-field");
  if (isFieldKey(named)) return named;
  // A custom control (select trigger, combobox) beside its hidden named input.
  const item = element.closest("[data-slot=field], [data-slot=form-item]");
  const input = item?.querySelector("[name]")?.getAttribute("name");
  return isFieldKey(input) ? input : null;
}

/**
 * The form names of a react-hook-form `dirtyFields` tree (`price`,
 * `seo.title`, `variants.0.sku`): what a save tells the others it changed.
 */
export function changedFieldNames(dirty: unknown, prefix = ""): string[] {
  if (dirty === true) return prefix ? [prefix] : [];
  if (!dirty || typeof dirty !== "object") return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(dirty as Record<string, unknown>)) {
    names.push(...changedFieldNames(value, prefix ? `${prefix}.${key}` : key));
  }
  return names;
}

/** The root element of the editor on `key` (`data-presence-root`). */
export function presenceRoot(key: string): Element | null {
  if (typeof document === "undefined") return null;
  for (const root of document.querySelectorAll("[data-presence-root]")) {
    if (root.getAttribute("data-presence-root") === key) return root;
  }
  return null;
}

// ── One editor's presence ────────────────────────────────────────────────

let saveStamp = 0;

export interface RemoteSave {
  by: RealtimePerson;
  rev: number | null;
  /** The fields they changed (form names), when their editor said. */
  fields: string[];
  /** When it arrived (epoch ms), unique per notice. */
  at: number;
}

export interface EditorPresence {
  /** Other staff on this editor now (never the viewer). */
  others: RealtimePresence[];
  /** The last save by someone else since this editor opened, until dismissed. */
  remoteSave: RemoteSave | null;
  dismissRemoteSave(): void;
}

/**
 * Presence and live save notices for one revision-fenced editor. `key` is
 * `presenceKey(prefix, id)`; null turns it off (a new, unsaved record).
 * `currentRev` drops a save notice for a revision this editor already has.
 */
export function useEditorPresence(key: string | null, currentRev?: number | null): EditorPresence {
  const [others, setOthers] = useState<RealtimePresence[]>([]);
  const [remoteSave, setRemoteSave] = useState<RemoteSave | null>(null);
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
      saved: (savedKey, by, savedRev, fields) => {
        if (savedKey !== key) return;
        if (savedRev !== null && rev.current !== null && savedRev <= rev.current) return;
        saveStamp = Math.max(saveStamp + 1, Date.now());
        setRemoteSave({ by, rev: savedRev, fields, at: saveStamp });
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

/**
 * Reports which field of the editor on `key` this tab is in, and whether its
 * draft is dirty: one document listener, scoped by `data-presence-root`.
 */
export function usePresenceReporter(key: string | null, dirty: boolean): void {
  const field = useRef<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!key) return;
    const inEditor = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[data-presence-root]")?.getAttribute("data-presence-root") === key;
    const onFocusIn = (event: FocusEvent) => {
      field.current = inEditor(event.target) ? fieldKeyOf(event.target as Element) : null;
      reportFocus(key, field.current, dirtyRef.current);
    };
    const onFocusOut = (event: FocusEvent) => {
      // Focus moving to another field reports there; leaving the editor clears the ring.
      if (inEditor(event.relatedTarget)) return;
      field.current = null;
      reportFocus(key, null, dirtyRef.current);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      reportFocus(key, null, false);
    };
  }, [key]);
  useEffect(() => {
    if (key) reportFocus(key, field.current, dirty);
  }, [key, dirty]);
}

export interface EditorPresenceValue extends EditorPresence {
  presenceKey: string;
  dirty: boolean;
  /** The fields this draft changed (form names), to tell a clean merge from a clash. */
  changedFields?: () => readonly string[];
  /** Loads the latest saved record under this draft's edits (a merge), or simply the latest when clean. */
  onLoadLatest?: () => void;
}

const EditorPresenceContext = createContext<EditorPresenceValue | null>(null);

/** The presence of the editor around a component (null outside one, or for a new record). */
export function useEditorPresenceContext(): EditorPresenceValue | null {
  return useContext(EditorPresenceContext);
}

/**
 * Joins `presenceKey`, reports this tab's field and draft state, and gives
 * `PresenceSlot` and `PresenceNotices` below it the people and saves.
 * `presenceKey` null (a new record) renders the children alone.
 */
export function EditorPresenceProvider({
  presenceKey: key,
  revision,
  dirty,
  changedFields,
  onLoadLatest,
  children,
}: {
  presenceKey: string | null;
  revision?: number | null;
  dirty: boolean;
  changedFields?: () => readonly string[];
  onLoadLatest?: () => void;
  children: ReactNode;
}) {
  const presence = useEditorPresence(key, revision);
  usePresenceReporter(key, dirty);
  const { others, remoteSave, dismissRemoteSave } = presence;
  const value = useMemo<EditorPresenceValue | null>(
    () => (key ? { presenceKey: key, others, remoteSave, dismissRemoteSave, dirty, changedFields, onLoadLatest } : null),
    // dismissRemoteSave is a fresh closure over a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, others, remoteSave, dirty, changedFields, onLoadLatest],
  );
  return <EditorPresenceContext.Provider value={value}>{children}</EditorPresenceContext.Provider>;
}

// ── Presence in lists ────────────────────────────────────────────────────

/**
 * Who else has each record of a list open ("Rahim is viewing" on an order
 * row), by record id, without the viewer. For list screens: pass the result
 * to `RowPresence` (components/admin/realtime/RowPresence.tsx) for one row.
 */
export function useListPresence(prefix: PresenceListPrefix): ReadonlyMap<string, RealtimePresence[]> {
  const [people, setPeople] = useState<ReadonlyMap<string, RealtimePresence[]>>(() => new Map());
  useEffect(() => {
    const release = watchPresenceList(prefix);
    const head = `${prefix}:`;
    const unsubscribe = subscribeRealtime({
      presence: (key, list) => {
        if (!key.startsWith(head)) return;
        const others = list.filter((person) => person.id !== realtimeUserId());
        setPeople((current) => {
          const id = key.slice(head.length);
          if (others.length === 0 && !current.has(id)) return current;
          const next = new Map(current);
          if (others.length === 0) next.delete(id);
          else next.set(id, others);
          return next;
        });
      },
      status: (next) => {
        if (next !== "open") setPeople(new Map());
      },
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [prefix]);
  return people;
}

// ── The visible parts, loaded only when needed ───────────────────────────

const PresenceAvatars = lazy(() => import("~/components/admin/realtime/PresenceAvatars"));
const PresenceLayer = lazy(() => import("~/components/admin/realtime/PresenceLayer"));

/**
 * The avatars beside the page title: pass it as `PageHeader`'s `presence`
 * (the header's `data-slot="presence"`). The box is always there on a saved
 * record, sized for three avatars and "+N" (104 by 28 px), so people
 * arriving never move the page.
 */
export function PresenceSlot() {
  const presence = useEditorPresenceContext();
  if (!presence) return null;
  return (
    <div data-slot="presence-avatars" className="flex h-7 w-26 shrink-0 items-center">
      {presence.others.length > 0 ? (
        <Suspense fallback={null}>
          <PresenceAvatars people={presence.others} prefix={presencePrefixOf(presence.presenceKey)} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * The banner when someone else edits this record, the rings on the fields
 * they are in, and the notice when they save. It floats over the page's end
 * and takes no space, so it never moves the fields under the merchant.
 */
export function PresenceNotices() {
  const presence = useEditorPresenceContext();
  if (!presence || (presence.others.length === 0 && !presence.remoteSave)) return null;
  return (
    <Suspense fallback={null}>
      <PresenceLayer presence={presence} />
    </Suspense>
  );
}
