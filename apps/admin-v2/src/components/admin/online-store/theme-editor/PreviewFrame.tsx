/**
 * The real storefront, rendering the saved draft, in a frame. Opening it
 * hands the frame a one-time continuation code (by postMessage, never in a
 * URL) that the storefront's embed relay exchanges for its preview cookie;
 * the frame then shows any page as the draft renders it. The storefront's
 * preview bridge says hello, the dashboard answers with the section names,
 * and from then on the two talk in theme editor messages. Every message is
 * read only from the frame's window at the storefront's exact origin
 * (Platform settings) and sent only to that origin.
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { getApiV1Platform, postApiV1AdminSettingsThemePreviewSession } from "@scalius/api-client/sdk";
import {
  THEME_EDITOR_SOURCE,
  isTrustedThemeEditorEvent,
  readThemePreviewMessage,
  type ThemeEditorMessage,
} from "@scalius/shared/theme-editor-bridge";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { Button } from "~/components/ui/button";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { isSafeThemePreviewContinuation } from "../ThemePreviewAction";

export type PreviewDevice = "desktop" | "tablet" | "phone";

const DEVICE_WIDTH: Record<PreviewDevice, string> = { desktop: "100%", tablet: "768px", phone: "390px" };
/** How long a page has to say hello before the session counts as lost. */
export const PREVIEW_HELLO_TIMEOUT_MS = 15_000;

/** The browser continuation relay's handshake (lib/browser-continuation-relay.ts in the storefront). */
const RELAY_READY = "scalius-continuation-ready-v1";
const RELAY_FIELDS = "scalius-continuation-fields-v1";
const RELAY_ACCEPTED = "scalius-continuation-accepted-v1";

type Outgoing<Message> = Message extends { source: string } ? Omit<Message, "source"> : never;
export type PreviewCommand = Outgoing<ThemeEditorMessage>;

export interface PreviewController {
  send(command: PreviewCommand): void;
}

type Phase = "connecting" | "ready" | "failed" | "blocked" | "no-url";

interface Session {
  origin: string;
  src: string;
  attempt: number;
}

export function PreviewFrame({ draftRevision, sourceRevision, previewPath = "/", device, names, selectedId, onSelect, controller }: {
  /** The saved draft revision the session opens on (it then follows every save). */
  draftRevision: number;
  sourceRevision?: number;
  previewPath?: string;
  device: PreviewDevice;
  /** Section names by id, for the outlines' labels. */
  names: Readonly<Record<string, string>>;
  selectedId: string | null;
  onSelect: (sectionId: string) => void;
  controller: Ref<PreviewController>;
}) {
  const t = useMessages(themeEditorMessages);
  const frame = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [session, setSession] = useState<Session | null>(null);
  const [path, setPath] = useState("/");
  const connected = useRef(false);
  const helloTimer = useRef(0);
  /** The session's one-time code until the relay accepts it. */
  const pendingFields = useRef<{ continuationCode: string; path: string; device: string } | null>(null);
  const latest = useRef({ names, selectedId, onSelect, draftRevision, sourceRevision, previewPath });
  latest.current = { names, selectedId, onSelect, draftRevision, sourceRevision, previewPath };

  // A session: the storefront origin from Platform settings, then a
  // one-time continuation the frame's embed relay redeems.
  const open = useCallback(async () => {
    connected.current = false;
    window.clearTimeout(helloTimer.current);
    setPhase("connecting");
    try {
      const { storefrontUrl } = await apiData(getApiV1Platform());
      const origin = normalizeStorefrontOrigin(storefrontUrl);
      if (!origin) {
        setPhase("no-url");
        return;
      }
      const result = await apiData(postApiV1AdminSettingsThemePreviewSession({
        body: { expectedDraftRevision: latest.current.draftRevision, ...(latest.current.sourceRevision === undefined ? {} : { sourceRevision: latest.current.sourceRevision }), path: latest.current.previewPath, device: "full" },
      }));
      if (!isSafeThemePreviewContinuation(result.continuation, origin, latest.current.previewPath, "full")) throw new Error("Unsafe continuation");
      pendingFields.current = result.continuation.fields;
      setSession((current) => ({
        origin,
        src: new URL("/theme-preview/embed", origin).toString(),
        attempt: (current?.attempt ?? 0) + 1,
      }));
    } catch {
      setPhase("failed");
    }
  }, []);

  /** Waits for the page's hello; without one the session is lost (expired, blocked) and opens again. */
  const expectHello = useCallback((firstTime: boolean) => {
    window.clearTimeout(helloTimer.current);
    helloTimer.current = window.setTimeout(() => {
      if (firstTime) setPhase("blocked");
      else void open();
    }, PREVIEW_HELLO_TIMEOUT_MS);
  }, [open]);

  const send = useCallback((command: PreviewCommand) => {
    const target = frame.current?.contentWindow;
    if (!target || !session || !connected.current) return;
    target.postMessage({ source: THEME_EDITOR_SOURCE, ...command }, session.origin);
    if (command.type === "reload" || command.type === "go-home") {
      connected.current = false;
      expectHello(false);
    }
  }, [session, expectHello]);

  useImperativeHandle(controller, () => ({ send }), [send]);

  useEffect(() => { void open(); }, [open, sourceRevision, previewPath]);

  // Messages from the frame: the relay's handshake, then the bridge's.
  useEffect(() => {
    if (!session) return;
    expectHello(true);
    const receive = (event: MessageEvent) => {
      const target = frame.current?.contentWindow ?? null;
      if (!target || !isTrustedThemeEditorEvent(event, { origin: session.origin, source: target })) return;
      const data = event.data as { type?: unknown } | null;
      if (data?.type === RELAY_READY && pendingFields.current) {
        target.postMessage({ type: RELAY_FIELDS, fields: pendingFields.current }, session.origin);
        return;
      }
      if (data?.type === RELAY_ACCEPTED) {
        // The code is spent: a relay page that asks again needs a new session.
        pendingFields.current = null;
        return;
      }
      const message = readThemePreviewMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case "hello":
          window.clearTimeout(helloTimer.current);
          connected.current = true;
          setPath(message.path);
          target.postMessage({
            source: THEME_EDITOR_SOURCE,
            type: "connect",
            names: latest.current.names,
            selected: latest.current.selectedId,
          }, session.origin);
          break;
        case "ready":
          setPhase("ready");
          setPath(message.path);
          break;
        case "select":
          latest.current.onSelect(message.sectionId);
          break;
        case "expired":
          void open();
          break;
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(helloTimer.current);
      window.removeEventListener("message", receive);
    };
  }, [session, expectHello, open]);

  // Section names follow the editor (the outlines' labels).
  const namesKey = JSON.stringify(names);
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!target || !session || !connected.current) return;
    target.postMessage({ source: THEME_EDITOR_SOURCE, type: "connect", names: latest.current.names, selected: latest.current.selectedId }, session.origin);
  }, [namesKey, session]);

  // The selection follows the editor and scrolls into view.
  useEffect(() => {
    send({ type: "select", sectionId: selectedId });
    if (selectedId) send({ type: "scroll-to", sectionId: selectedId });
  }, [selectedId, send, phase]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {path !== "/" && phase === "ready" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card px-3 py-1.5 shadow-card">
          <p className="min-w-0 truncate text-body text-muted-foreground">{t("viewingPath", { path })}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => send({ type: "go-home" })}>
            {t("backToHome")}
          </Button>
        </div>
      ) : null}
      <div
        // The frame's width follows the device toggle (a runtime value as a custom property).
        style={{ "--frame-width": DEVICE_WIDTH[device] } as CSSProperties}
        data-device={device}
        className="relative mx-auto min-h-0 w-(--frame-width) max-w-full flex-1 overflow-clip rounded-lg bg-card shadow-card"
      >
        {session ? (
          <iframe
            key={session.attempt}
            ref={frame}
            src={session.src}
            title={t("previewFrame")}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms"
            className="size-full border-0 bg-card"
          />
        ) : null}
        {phase !== "ready" ? (
          <div className="absolute inset-0 grid place-items-center bg-card p-6 text-center">
            <div className="max-w-sm space-y-3">
              <p role="status" className="text-body text-muted-foreground">
                {phase === "connecting" ? t("previewLoading")
                  : phase === "blocked" ? t("previewBlocked")
                    : phase === "no-url" ? t("previewNeedsUrl")
                      : t("previewFailed")}
              </p>
              {phase === "failed" || phase === "blocked" ? (
                <Button type="button" variant="outline" onClick={() => void open()}>{t("previewRetry")}</Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
