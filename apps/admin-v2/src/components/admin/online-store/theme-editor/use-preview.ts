/**
 * The real storefront in the editor's frame, and the bridge to it.
 *
 * Opening a preview hands a frame a one-time continuation code (by
 * postMessage, never in a URL) that the storefront's embed relay exchanges
 * for its partitioned preview cookie; from then on any frame of the
 * storefront under the dashboard shows the draft. A page change or a reload
 * loads in a second, hidden frame and is swapped in when it is ready, at the
 * same scroll position: there is never a white flash (research P12).
 *
 * The bridge in the page reports where its marked parts are; the editor
 * draws outlines in its own overlay. Every message is read only from the
 * active frame's window at the storefront's exact origin (Platform
 * settings) and sent only to that origin.
 *
 * Commands are never lost: each carries a sequence number, and the latest
 * command of each kind (per section or region) stays in an outbox until the
 * page acknowledges it. It is sent again when the shown frame connects (a
 * navigation, a reload swap) and when its ack is late.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiV1Platform, postApiV1AdminSettingsThemePreviewSession } from "@scalius/api-client/sdk";
import {
  THEME_EDITOR_SOURCE,
  isTrustedThemeEditorEvent,
  readThemePreviewMessage,
  type ThemeEditorMessage,
  type ThemePreviewRect,
  type ThemePreviewField,
  type ThemeTextField,
} from "@scalius/shared/theme-editor-bridge";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { apiData } from "~/lib/api";
import { isSafeThemePreviewContinuation } from "../theme-preview";

/** How long a page has to say hello before it counts as lost. */
export const PREVIEW_HELLO_TIMEOUT_MS = 15_000;
/** A command not acknowledged by then is sent again (a render or paint has longer: it waits on the server). */
export const PREVIEW_ACK_TIMEOUT_MS = 600;
export const PREVIEW_RENDER_ACK_TIMEOUT_MS = 3_000;
/** After this many unanswered sends the page loads again (from the saved draft, then the unsaved edits). */
export const PREVIEW_MAX_SENDS = 5;

/** The browser continuation relay's handshake (lib/browser-continuation-relay.ts in the storefront). */
const RELAY_READY = "scalius-continuation-ready-v1";
const RELAY_FIELDS = "scalius-continuation-fields-v1";
const RELAY_ACCEPTED = "scalius-continuation-accepted-v1";

type Outgoing<Message> = Message extends { source: string } ? Omit<Message, "source" | "seq"> : never;
export type PreviewCommand = Exclude<Outgoing<ThemeEditorMessage>, { type: "connect" }>;

/** The outbox key of a command: its latest one replaces an older one with the same key (canonical renders follow text patches, so patches are not kept). */
export function previewCommandKey(command: PreviewCommand): string | null {
  switch (command.type) {
    case "text": return null;
    case "arrange": return `arrange:${command.region}`;
    case "render": {
      const only = (command.body as { only?: unknown } | null)?.only;
      return typeof only === "string" ? `render:${only}` : "render:regions";
    }
    default: return command.type;
  }
}

interface Pending {
  seq: number;
  command: PreviewCommand;
  sentAt: number;
  sends: number;
}

export type PreviewPhase = "connecting" | "ready" | "failed" | "blocked" | "no-url";

export interface PreviewLayout {
  rects: Readonly<Record<string, ThemePreviewRect>>;
  scrollY: number;
  height: number;
  field?: ThemePreviewField | null;
}

interface Frame {
  id: number;
  src: string;
  /** The path this frame was asked to show. */
  path: string;
}

const EMPTY_LAYOUT: PreviewLayout = { rects: {}, scrollY: 0, height: 0 };

export function usePreview({ draftRevision, sourceRevision, path, inspector, onSelect, onEditText, onKey, onConnected }: {
  /** The saved draft revision a session opens on (it then follows every save). */
  draftRevision: number;
  /** A published version to preview instead of the draft. */
  sourceRevision: number | null;
  /** The page to show (with the market's subfolder). */
  path: string | null;
  inspector: boolean;
  onSelect: (id: string, field?: ThemeTextField) => void;
  onEditText?: (id: string, field: ThemeTextField, rect?: ThemePreviewRect) => void;
  onKey: (key: { key: string; mod: boolean; shift: boolean; alt: boolean }) => void;
  /** A frame became the shown one (the editor sends it the unsaved state). */
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<PreviewPhase>("connecting");
  const [origin, setOrigin] = useState<string | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [layout, setLayout] = useState<PreviewLayout>(EMPTY_LAYOUT);
  const [fieldsEnabled, setFieldsEnabled] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [marks, setMarks] = useState<readonly string[]>([]);
  /** Where the shown frame is now (a link the merchant followed moves it). */
  const [shownPath, setShownPath] = useState<string | null>(null);
  const elements = useRef(new Map<number, HTMLIFrameElement>());
  const nextId = useRef(1);
  const ticket = useRef(0);
  const helloTimer = useRef(0);
  const pendingFields = useRef<{ frame: number; fields: { continuationCode: string; path: string; device: string } } | null>(null);
  const connected = useRef(new Set<number>());
  const refs = useRef(new Map<number, (element: HTMLIFrameElement | null) => void>());
  const outbox = useRef(new Map<string, Pending>());
  const seq = useRef(0);
  // The global timer functions (not window.*), as test clocks replace them.
  const resendTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The page is behind the editor: a command had to be sent again. */
  const [behind, setBehind] = useState(false);
  const [failed, setFailed] = useState(false);
  const [resyncAt, setResyncAt] = useState(0);
  const latest = useRef({ inspector, onSelect, onEditText, onKey, onConnected, activeId, layout, path, draftRevision, sourceRevision });
  latest.current = { inspector, onSelect, onEditText, onKey, onConnected, activeId, layout, path, draftRevision, sourceRevision };

  const frameWindow = (id: number | null) => (id === null ? null : elements.current.get(id)?.contentWindow ?? null);

  const originRef = useRef(origin);
  originRef.current = origin;
  const post = useCallback((id: number | null, command: PreviewCommand, number: number) => {
    const target = frameWindow(id);
    const to = originRef.current;
    if (id === null || !target || !to || !connected.current.has(id)) return false;
    target.postMessage({ source: THEME_EDITOR_SOURCE, ...command, seq: number }, to);
    return true;
  }, []);

  /** Unacknowledged commands again, to the shown frame (or a frame that just became it). */
  const flush = useCallback((id: number | null, onlyLate: boolean) => {
    const now = Date.now();
    let lost = false;
    for (const pending of outbox.current.values()) {
      if (latest.current.sourceRevision !== null && !["inspector", "reveal"].includes(pending.command.type)) continue;
      const wait = pending.command.type === "render" || pending.command.type === "paint" ? PREVIEW_RENDER_ACK_TIMEOUT_MS : PREVIEW_ACK_TIMEOUT_MS;
      if (onlyLate && now - pending.sentAt < wait) continue;
      if (post(id, pending.command, pending.seq)) {
        pending.sentAt = now;
        pending.sends += 1;
        if (pending.sends > PREVIEW_MAX_SENDS) lost = true;
      }
    }
    return lost;
  }, [post]);

  const watch = useCallback(() => {
    if (resendTimer.current !== null) return;
    resendTimer.current = setInterval(() => {
      if (outbox.current.size === 0) {
        clearInterval(resendTimer.current!);
        resendTimer.current = null;
        setBehind(false);
        return;
      }
      setBehind([...outbox.current.values()].some((pending) => pending.sends > 1));
      if (flush(latest.current.activeId, true)) {
        // The page answers nothing: load it again; it then gets the unsaved edits on connect.
        outbox.current.clear();
        if (latest.current.path) loadRef.current(latest.current.path);
      }
    }, 200);
  }, [flush]);

  /** Sends to the shown frame; kept until acknowledged, and sent again on connect or when late. */
  const send = useCallback((command: PreviewCommand) => {
    if (latest.current.sourceRevision !== null && !["inspector", "reveal"].includes(command.type)) return;
    const number = ++seq.current;
    const sent = post(latest.current.activeId, command, number);
    const key = previewCommandKey(command);
    if (!key) return;
    outbox.current.set(key, { seq: number, command, sentAt: sent ? Date.now() : 0, sends: sent ? 1 : 0 });
    watch();
  }, [post, watch]);

  const expectHello = useCallback((onLost: () => void) => {
    window.clearTimeout(helloTimer.current);
    helloTimer.current = window.setTimeout(onLost, PREVIEW_HELLO_TIMEOUT_MS);
  }, []);

  /** A new session: the storefront origin, then a one-time continuation the frame's relay redeems. */
  const open = useCallback(async () => {
    const mine = ++ticket.current;
    setPhase("connecting");
    try {
      const { storefrontUrl } = await apiData(getApiV1Platform());
      const storefront = normalizeStorefrontOrigin(storefrontUrl);
      if (mine !== ticket.current) return;
      if (!storefront) {
        setPhase("no-url");
        return;
      }
      const { draftRevision: revision, sourceRevision: source, path: page } = latest.current;
      if (!page) return;
      const result = await apiData(postApiV1AdminSettingsThemePreviewSession({
        body: { expectedDraftRevision: revision, ...(source === null ? {} : { sourceRevision: source }), path: page, device: "full" },
      }));
      if (mine !== ticket.current) return;
      if (!isSafeThemePreviewContinuation(result.continuation, storefront, page, "full")) throw new Error("Unsafe continuation");
      const id = nextId.current++;
      pendingFields.current = { frame: id, fields: result.continuation.fields };
      setOrigin(storefront);
      setFrames((current) => [...current, { id, src: new URL("/theme-preview/embed", storefront).toString(), path: page }]);
      expectHello(() => setPhase("blocked"));
    } catch {
      if (mine === ticket.current) setPhase("failed");
    }
  }, [expectHello]);

  /** The page again (or another page) in a hidden frame, swapped in when ready; a lost session opens a new one. */
  const load = useCallback((page: string) => {
    if (!origin || latest.current.activeId === null) {
      void open();
      return;
    }
    const id = nextId.current++;
    setFrames((current) => [...current.filter((frame) => frame.id === latest.current.activeId), { id, src: new URL(page, origin).toString(), path: page }]);
    expectHello(() => {
      setFrames((current) => current.filter((frame) => frame.id !== id));
      void open();
    });
  }, [origin, open]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    if (latest.current.path) load(latest.current.path);
  }, [load]);

  // A draft or version preview needs its own session; a page change only loads the page.
  useEffect(() => {
    setFrames([]);
    setActiveId(null);
    setFieldsEnabled(false);
    connected.current.clear();
    outbox.current.clear();
    setFailed(false);
    void open();
  }, [open, sourceRevision]);
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    if (path) load(path);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- a new page only; `load` changes with the origin.

  // Messages from the frames: the relay's handshake, then the bridge's.
  useEffect(() => {
    if (!origin) return;
    const receive = (event: MessageEvent) => {
      const frame = [...elements.current.entries()].find(([, element]) => element.contentWindow === event.source);
      if (!frame) return;
      const [id, element] = frame;
      if (!isTrustedThemeEditorEvent(event, { origin, source: element.contentWindow })) return;
      const data = event.data as { type?: unknown } | null;
      if (data?.type === RELAY_READY && pendingFields.current?.frame === id) {
        element.contentWindow!.postMessage({ type: RELAY_FIELDS, fields: pendingFields.current.fields }, origin);
        return;
      }
      if (data?.type === RELAY_ACCEPTED) {
        // The code is spent: a relay that asks again needs a new session.
        pendingFields.current = null;
        return;
      }
      const message = readThemePreviewMessage(event.data);
      if (!message) return;
      const active = latest.current.activeId;
      switch (message.type) {
        case "hello": {
          window.clearTimeout(helloTimer.current);
          connected.current.add(id);
          // A replacing frame opens where the shown one is.
          const scrollY = id === active ? null : latest.current.layout.scrollY;
          element.contentWindow!.postMessage({ source: THEME_EDITOR_SOURCE, type: "connect", inspector: latest.current.inspector, scrollY }, origin);
          if (id === active) setShownPath(message.path);
          break;
        }
        case "ready":
          if (id !== active) {
            // Swap: the new frame shows; the old one goes. Its outlines wait for its own layout.
            latest.current.activeId = id;
            setActiveId(id);
            setFrames((current) => current.filter((each) => each.id === id || each.id > id));
            for (const old of connected.current) if (old < id) connected.current.delete(old);
            setLayout(EMPTY_LAYOUT);
          }
          setShownPath(message.path);
          setMarks(message.marks);
          setFieldsEnabled(message.fields === 1);
          setPhase("ready");
          setFailed(false);
          // A (re)connected page gets every command it has not acknowledged, then the unsaved edits.
          flush(id, false);
          latest.current.onConnected();
          break;
        case "ack": {
          if (id !== latest.current.activeId) break;
          for (const [key, pending] of outbox.current) {
            if (pending.seq !== message.seq) continue;
            outbox.current.delete(key);
            if (message.status === "stale") setResyncAt((value) => value + 1);
            if (message.status === "failed") setFailed(true);
            else if (!message.status && (pending.command.type === "render" || pending.command.type === "paint")) setFailed(false);
          }
          if (outbox.current.size === 0 && resendTimer.current !== null) {
            clearInterval(resendTimer.current);
            resendTimer.current = null;
            setBehind(false);
          }
          if (message.marks && id === latest.current.activeId) setMarks(message.marks);
          break;
        }
        case "layout":
          if (id === active || active === null) setLayout({ rects: message.rects, scrollY: message.scrollY, height: message.height, field: message.field });
          break;
        case "hover":
          if (id === active) setHovered(message.id);
          break;
        case "select":
          if (id === active) latest.current.onSelect(message.id, message.field);
          break;
        case "edit-text":
          if (id === active) latest.current.onEditText?.(message.id, message.field, message.rect);
          break;
        case "key":
          if (id === active) latest.current.onKey(message);
          break;
        case "render-failed":
          // Keep the last canvas on an explicit failure; the merchant can retry.
          if (id === active) setFailed(true);
          break;
        case "expired":
          void open();
          break;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin, open, load, flush]);

  // The first frame of a session becomes the shown one when its relay hands over.
  useEffect(() => {
    if (activeId === null && frames.length > 0) setActiveId(frames[0]!.id);
  }, [activeId, frames]);

  // The inspector follows the toggle.
  useEffect(() => {
    send({ type: "inspector", on: inspector });
    if (!inspector) setHovered(null);
  }, [inspector, send]);

  useEffect(() => () => {
    window.clearTimeout(helloTimer.current);
    if (resendTimer.current !== null) clearInterval(resendTimer.current);
  }, []);

  /**
   * One ref callback per frame for its whole life: React calls it with null
   * only when the frame leaves (a new callback each render would detach and
   * forget the connected frame on every re-render).
   */
  const register = useCallback((id: number) => {
    let callback = refs.current.get(id);
    if (!callback) {
      // Records the element only. React also calls a ref with null when the
      // same iframe detaches and re-attaches during a render, so null must not
      // forget the connection: a frame leaves only when `frames` drops it (the
      // effect below). Forgetting here made every later command a no-op.
      callback = (element: HTMLIFrameElement | null) => {
        if (element) elements.current.set(id, element);
      };
      refs.current.set(id, callback);
    }
    return callback;
  }, []);

  // A frame is gone once `frames` no longer lists it: drop its element,
  // connection and ref callback.
  useEffect(() => {
    const live = new Set(frames.map((frame) => frame.id));
    for (const id of [...refs.current.keys()]) {
      if (live.has(id)) continue;
      elements.current.delete(id);
      connected.current.delete(id);
      refs.current.delete(id);
    }
  }, [frames]);

  return {
    phase,
    origin,
    frames,
    activeId,
    layout,
    hovered,
    fieldsEnabled,
    marks,
    shownPath,
    behind,
    failed,
    resyncAt,
    /** A page loads in a hidden frame to replace the shown one. */
    loading: frames.some((frame) => frame.id !== activeId),
    send,
    reload,
    retry: () => void open(),
    register,
  };
}
