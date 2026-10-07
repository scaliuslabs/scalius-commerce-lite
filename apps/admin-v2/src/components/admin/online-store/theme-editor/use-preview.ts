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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiV1Platform, postApiV1AdminSettingsThemePreviewSession } from "@scalius/api-client/sdk";
import {
  THEME_EDITOR_SOURCE,
  isTrustedThemeEditorEvent,
  readThemePreviewMessage,
  type ThemeEditorMessage,
  type ThemePreviewRect,
} from "@scalius/shared/theme-editor-bridge";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { apiData } from "~/lib/api";
import { isSafeThemePreviewContinuation } from "../theme-preview";

/** How long a page has to say hello before it counts as lost. */
export const PREVIEW_HELLO_TIMEOUT_MS = 15_000;

/** The browser continuation relay's handshake (lib/browser-continuation-relay.ts in the storefront). */
const RELAY_READY = "scalius-continuation-ready-v1";
const RELAY_FIELDS = "scalius-continuation-fields-v1";
const RELAY_ACCEPTED = "scalius-continuation-accepted-v1";

type Outgoing<Message> = Message extends { source: string } ? Omit<Message, "source"> : never;
export type PreviewCommand = Outgoing<ThemeEditorMessage>;

export type PreviewPhase = "connecting" | "ready" | "failed" | "blocked" | "no-url";

export interface PreviewLayout {
  rects: Readonly<Record<string, ThemePreviewRect>>;
  scrollY: number;
  height: number;
}

interface Frame {
  id: number;
  src: string;
  /** The path this frame was asked to show. */
  path: string;
}

const EMPTY_LAYOUT: PreviewLayout = { rects: {}, scrollY: 0, height: 0 };

export function usePreview({ draftRevision, sourceRevision, path, inspector, onSelect, onKey, onConnected }: {
  /** The saved draft revision a session opens on (it then follows every save). */
  draftRevision: number;
  /** A published version to preview instead of the draft. */
  sourceRevision: number | null;
  /** The page to show (with the market's subfolder). */
  path: string | null;
  inspector: boolean;
  onSelect: (id: string) => void;
  onKey: (key: { key: string; mod: boolean; shift: boolean; alt: boolean }) => void;
  /** A frame became the shown one (the editor sends it the unsaved state). */
  onConnected: () => void;
}) {
  const [phase, setPhase] = useState<PreviewPhase>("connecting");
  const [origin, setOrigin] = useState<string | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [layout, setLayout] = useState<PreviewLayout>(EMPTY_LAYOUT);
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
  const latest = useRef({ inspector, onSelect, onKey, onConnected, activeId, layout, path, draftRevision, sourceRevision });
  latest.current = { inspector, onSelect, onKey, onConnected, activeId, layout, path, draftRevision, sourceRevision };

  const frameWindow = (id: number | null) => (id === null ? null : elements.current.get(id)?.contentWindow ?? null);

  const post = useCallback((id: number, command: PreviewCommand) => {
    const target = frameWindow(id);
    if (!target || !origin || !connected.current.has(id)) return;
    target.postMessage({ source: THEME_EDITOR_SOURCE, ...command }, origin);
  }, [origin]);

  /** Sends to the shown frame (dropped until it connects). */
  const send = useCallback((command: PreviewCommand) => {
    if (latest.current.activeId !== null) post(latest.current.activeId, command);
  }, [post]);

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

  const reload = useCallback(() => {
    if (latest.current.path) load(latest.current.path);
  }, [load]);

  // A draft or version preview needs its own session; a page change only loads the page.
  useEffect(() => {
    setFrames([]);
    setActiveId(null);
    connected.current.clear();
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
            // Swap: the new frame shows; the old one goes.
            setActiveId(id);
            setFrames((current) => current.filter((each) => each.id === id || each.id > id));
            for (const old of connected.current) if (old < id) connected.current.delete(old);
          }
          setShownPath(message.path);
          setMarks(message.marks);
          setPhase("ready");
          latest.current.onConnected();
          break;
        case "layout":
          if (id === active || active === null) setLayout({ rects: message.rects, scrollY: message.scrollY, height: message.height });
          break;
        case "hover":
          if (id === active) setHovered(message.id);
          break;
        case "select":
          if (id === active) latest.current.onSelect(message.id);
          break;
        case "key":
          if (id === active) latest.current.onKey(message);
          break;
        case "render-failed":
          // A section the render route refused: the saved page again (no flash).
          if (id === active && latest.current.path) load(latest.current.path);
          break;
        case "expired":
          void open();
          break;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [origin, open, load]);

  // The first frame of a session becomes the shown one when its relay hands over.
  useEffect(() => {
    if (activeId === null && frames.length > 0) setActiveId(frames[0]!.id);
  }, [activeId, frames]);

  // The inspector follows the toggle.
  useEffect(() => {
    send({ type: "inspector", on: inspector });
    if (!inspector) setHovered(null);
  }, [inspector, send]);

  useEffect(() => () => window.clearTimeout(helloTimer.current), []);

  const register = useCallback((id: number) => (element: HTMLIFrameElement | null) => {
    if (element) elements.current.set(id, element);
    else {
      elements.current.delete(id);
      connected.current.delete(id);
    }
  }, []);

  return {
    phase,
    origin,
    frames,
    activeId,
    layout,
    hovered,
    marks,
    shownPath,
    send,
    reload,
    retry: () => void open(),
    register,
  };
}
