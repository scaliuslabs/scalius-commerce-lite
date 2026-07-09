import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import {
  AlertCircle,
  Grip,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  SendHorizontal,
  Sparkles,
  X,
} from "lucide-react";

import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  type StorefrontAssistantPageContextSnapshot,
} from "@/lib/assistant-page-context";
import { resolveStorefrontAssistantNavigationTarget } from "@/lib/assistant-page-context.client";
import { cn } from "@scalius/shared/utils";

import { AssistantLayoutControls } from "./AssistantLayoutControls";
import { AssistantMessageParts } from "./AssistantMessageParts";
import { StorefrontAssistantContext } from "./StorefrontAssistantContext";
import {
  ASSISTANT_LAUNCHER_SIZE,
  type AssistantPanelMode,
} from "./assistant-geometry";
import {
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  cleanAssistantDisplayText,
  createTextMessage,
  messageToHistoryContent,
  sendStorefrontAssistantMessage,
  type StorefrontAssistantUiMessage,
} from "./storefront-assistant-chat";
import { createStorefrontConversationRequestId } from
  "./storefront-assistant-conversation";
import {
  readStorefrontAssistantOpenState,
  writeStorefrontAssistantOpenState,
} from "./storefront-assistant-open-state";
import {
  mergeStorefrontConversationEvents,
  reconcileStorefrontPersistedMessage,
  storefrontConversationContextMarker,
} from "./storefront-assistant-transcript";
import { useStorefrontAssistantTranscript } from
  "./useStorefrontAssistantTranscript";
import { useAssistantGeometry } from "./useAssistantGeometry";
import "./storefront-assistant.css";

type StorefrontAssistantBridge = {
  getContext?: () => StorefrontAssistantPageContextSnapshot | null;
  navigate?: (target: unknown) => boolean;
};

type AssistantStatus = {
  kind: "idle" | "working" | "success" | "disabled" | "error";
  message: string;
};

type LauncherDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
};

type ResizeState = {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

const PANEL_ID = "storefront-assistant-panel";
const COMPOSER_ID = "storefront-assistant-message";
const LAUNCHER_HELP_ID = "storefront-assistant-launcher-help";
const DRAG_THRESHOLD = 6;
const KEYBOARD_MOVE_STEP = 32;
const KEYBOARD_RESIZE_STEP = 24;

function getAssistantBridge(): StorefrontAssistantBridge | null {
  if (typeof window === "undefined") return null;
  return (
    (
      window as Window & {
        __SCALIUS_STOREFRONT_ASSISTANT__?: StorefrontAssistantBridge;
      }
    ).__SCALIUS_STOREFRONT_ASSISTANT__ ?? null
  );
}

function readPublishedContext(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined") return null;
  return (
    getAssistantBridge()?.getContext?.() ??
    window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL] ??
    null
  );
}

function suggestedPrompts(
  context: StorefrontAssistantPageContextSnapshot | null,
): string[] {
  switch (context?.page.kind) {
    case "product":
      return [
        "What am I looking at?",
        "What are its key details?",
        "Is this available?",
      ];
    case "category":
    case "collection":
    case "search":
      return [
        "Help me choose",
        "Compare the best options",
        "What is in stock?",
      ];
    case "cart":
      return [
        "Review my cart",
        "Check item availability",
        "Explain any cart issues",
      ];
    default:
      return [
        "How can you help me shop?",
        "How do I search the catalog?",
        "What can I ask about a product?",
      ];
  }
}

function launcherMovementMessage(deltaX: number, deltaY: number): string {
  if (deltaX < 0) return "Assistant launcher moved left.";
  if (deltaX > 0) return "Assistant launcher moved right.";
  if (deltaY < 0) return "Assistant launcher moved up.";
  return "Assistant launcher moved down.";
}

function statusClasses(kind: AssistantStatus["kind"]): string {
  if (kind === "success") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200";
  }
  if (kind === "disabled") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100";
  }
  return "border-destructive/30 bg-destructive/10 text-destructive";
}

export default function StorefrontAssistantBubble() {
  const layout = useAssistantGeometry();
  const [isOpen, setIsOpen] = useState(false);
  const [mobileFullscreen, setMobileFullscreen] = useState(false);
  const [context, setContext] =
    useState<StorefrontAssistantPageContextSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<StorefrontAssistantUiMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<AssistantStatus>({
    kind: "idle",
    message: "Ready for public catalog questions.",
  });
  const [launcherAnnouncement, setLauncherAnnouncement] = useState("");
  const launcherRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const launcherDragRef = useRef<LauncherDragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const suppressLauncherClickRef = useRef(false);
  const wasOpenRef = useRef(false);
  const focusComposerOnOpenRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);

  const mergeTranscriptEvents = useCallback(
    (events: Parameters<typeof mergeStorefrontConversationEvents>[1]) => {
      setMessages((current) =>
        mergeStorefrontConversationEvents(current, events)
      );
    },
    [],
  );
  const transcript = useStorefrontAssistantTranscript({
    open: isOpen,
    onEvents: mergeTranscriptEvents,
  });

  const refreshContext = useCallback(() => {
    const nextContext = readPublishedContext();
    setContext(nextContext);
    return nextContext;
  }, []);

  useEffect(() => {
    refreshContext();
    const handleContextChange = (
      event: CustomEvent<StorefrontAssistantPageContextSnapshot>,
    ) => setContext(event.detail);

    window.addEventListener(
      STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
      handleContextChange as EventListener,
    );
    return () => {
      window.removeEventListener(
        STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
        handleContextChange as EventListener,
      );
    };
  }, [refreshContext]);

  useEffect(() => {
    if (readStorefrontAssistantOpenState()) setIsOpen(true);
  }, []);

  useEffect(() => {
    if (isOpen) refreshContext();
  }, [isOpen, refreshContext]);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen && !wasOpen) {
      const shouldFocusComposer = focusComposerOnOpenRef.current;
      focusComposerOnOpenRef.current = false;
      if (shouldFocusComposer) {
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
    } else if (!isOpen && wasOpen) {
      window.requestAnimationFrame(() => launcherRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    const body = document.body;
    const mode = layout.geometry.mode;
    const dockSide = isOpen && layout.ready && layout.canDock
      ? mode === "dock-left"
        ? "left"
        : mode === "dock-right"
          ? "right"
          : null
      : null;

    if (!dockSide) {
      delete body.dataset.storefrontAssistantDock;
      body.style.removeProperty("--storefront-assistant-dock-width");
      return undefined;
    }

    body.dataset.storefrontAssistantDock = dockSide;
    body.style.setProperty(
      "--storefront-assistant-dock-width",
      `${layout.panelRect.width}px`,
    );

    return () => {
      delete body.dataset.storefrontAssistantDock;
      body.style.removeProperty("--storefront-assistant-dock-width");
    };
  }, [
    isOpen,
    layout.canDock,
    layout.geometry.mode,
    layout.panelRect.width,
    layout.ready,
  ]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, sending]);

  useEffect(
    () => () => {
      requestAbortRef.current?.abort();
    },
    [],
  );

  const prompts = useMemo(() => suggestedPrompts(context), [context]);
  const panelStyle = {
    "--assistant-panel-left": `${layout.panelRect.left}px`,
    "--assistant-panel-top": `${layout.panelRect.top}px`,
    "--assistant-panel-width": `${layout.panelRect.width}px`,
    "--assistant-panel-height": `${layout.panelRect.height}px`,
  } as CSSProperties;
  const launcherStyle = layout.ready
    ? ({
        left: `${layout.geometry.launcherX}px`,
        top: `${layout.geometry.launcherY}px`,
      } satisfies CSSProperties)
    : undefined;

  const resolveNavigation = useCallback((path: string): string | null => {
    if (typeof window === "undefined") return null;
    return resolveStorefrontAssistantNavigationTarget(
      path,
      window.location.origin,
    );
  }, []);

  const canNavigate = useCallback(
    (path: string) => resolveNavigation(path) !== null,
    [resolveNavigation],
  );

  const handleNavigate = useCallback(
    (path: string, label: string) => {
      const target = resolveNavigation(path);
      if (!target) {
        setStatus({
          kind: "error",
          message:
            "That destination is not available from the assistant. Nothing changed.",
        });
        return;
      }

      const navigated = getAssistantBridge()?.navigate?.(target) === true;
      setStatus({
        kind: navigated ? "success" : "error",
        message: navigated
          ? `${label} requested. Review the destination before continuing.`
          : "Navigation is unavailable. Use the store menu or search instead.",
      });
    },
    [resolveNavigation],
  );

  const closePanel = useCallback(() => {
    focusComposerOnOpenRef.current = false;
    writeStorefrontAssistantOpenState(false);
    setIsOpen(false);
    setMobileFullscreen(false);
  }, []);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = cleanAssistantDisplayText(draft, MAX_MESSAGE_CHARS);
    if (!message || sending || typeof window === "undefined") return;

    const currentContext = refreshContext();
    const contextMarker = storefrontConversationContextMarker(currentContext);
    const userMessage = createTextMessage("user", message);
    const history = messages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((entry) => ({
        role: entry.role,
        content: messageToHistoryContent(entry),
      }))
      .filter((entry) => entry.content.length > 0);

    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setSending(true);
    setStatus({
      kind: "working",
      message: "Looking through the public catalog.",
    });
    const controller = new AbortController();
    requestAbortRef.current = controller;

    try {
      const persistedUser = await transcript.appendMessage({
        clientMessageId: createStorefrontConversationRequestId(),
        role: "user",
        content: message,
        contextMarker,
      });
      if (persistedUser) {
        setMessages((current) =>
          reconcileStorefrontPersistedMessage(
            current,
            persistedUser,
            userMessage.id,
          )
        );
      }

      const result = await sendStorefrontAssistantMessage({
        message,
        pageContext: currentContext,
        history,
        origin: window.location.origin,
        ...(persistedUser
          ? { conversationId: await transcript.getConversationId() }
          : {}),
        signal: controller.signal,
      });
      if (result.status === "ok") {
        setMessages((current) => [...current, result.message]);
        if (result.transcriptEvent) {
          setMessages((current) =>
            reconcileStorefrontPersistedMessage(
              current,
              result.transcriptEvent!,
              result.message.id,
            )
          );
        }
        setStatus(result.transcriptPersisted
          ? {
              kind: "idle",
              message: "Ready for public catalog questions.",
            }
          : {
              kind: "success",
              message:
                "Answer ready. This reply is live-only because the private transcript was unavailable.",
            });
      } else {
        setStatus({ kind: result.status, message: result.message });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus({
        kind: "error",
        message:
          "The assistant could not connect. Nothing changed; you can keep browsing and check out manually.",
      });
    } finally {
      if (requestAbortRef.current === controller)
        requestAbortRef.current = null;
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closePanel();
  }

  function choosePrompt(prompt: string) {
    setDraft(prompt);
    composerRef.current?.focus();
  }

  function beginLauncherDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    launcherDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
    };
    layout.setLauncher(rect.left, rect.top);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueLauncherDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = launcherDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD ||
      Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD
    ) {
      drag.moved = true;
    }
    layout.setLauncher(
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
    );
  }

  function endLauncherDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = launcherDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressLauncherClickRef.current = drag.moved;
    launcherDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved)
      setLauncherAnnouncement("Assistant launcher position saved.");
  }

  function handleLauncherClick() {
    if (suppressLauncherClickRef.current) {
      suppressLauncherClickRef.current = false;
      return;
    }
    writeStorefrontAssistantOpenState(true);
    focusComposerOnOpenRef.current = true;
    setIsOpen(true);
  }

  function handleLauncherKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-KEYBOARD_MOVE_STEP, 0],
      ArrowRight: [KEYBOARD_MOVE_STEP, 0],
      ArrowUp: [0, -KEYBOARD_MOVE_STEP],
      ArrowDown: [0, KEYBOARD_MOVE_STEP],
    };
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    layout.moveLauncher(delta[0], delta[1]);
    setLauncherAnnouncement(launcherMovementMessage(delta[0], delta[1]));
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: layout.geometry.panelWidth,
      startHeight: layout.geometry.panelHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const direction = layout.geometry.mode === "dock-right" ? -1 : 1;
    layout.setPanelSize(
      resize.startWidth + (event.clientX - resize.startX) * direction,
      layout.geometry.mode === "floating"
        ? resize.startHeight + (event.clientY - resize.startY)
        : resize.startHeight,
    );
  }

  function endResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (
      layout.geometry.mode !== "floating" &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      return;
    }
    const horizontalDirection = layout.geometry.mode === "dock-right"
      ? -1
      : 1;
    const resizeByKey: Record<string, [number, number]> = {
      ArrowLeft: [-KEYBOARD_RESIZE_STEP * horizontalDirection, 0],
      ArrowRight: [KEYBOARD_RESIZE_STEP * horizontalDirection, 0],
      ArrowUp: [0, -KEYBOARD_RESIZE_STEP],
      ArrowDown: [0, KEYBOARD_RESIZE_STEP],
    };
    const delta = resizeByKey[event.key];
    if (!delta) return;
    event.preventDefault();
    layout.resizePanel(delta[0], delta[1]);
  }

  function changeMode(mode: AssistantPanelMode) {
    layout.setMode(mode);
    setStatus({
      kind: "success",
      message:
        mode === "floating"
          ? "Assistant panel is floating."
          : `Assistant panel docked ${mode === "dock-left" ? "left" : "right"}.`,
    });
  }

  const isDockedSidebar = layout.canDock &&
    layout.geometry.mode !== "floating";

  return (
    <>
      {isOpen ? (
        <aside
          id={PANEL_ID}
          role={isDockedSidebar ? "complementary" : "dialog"}
          aria-modal={isDockedSidebar ? undefined : "false"}
          aria-labelledby="storefront-assistant-title"
          data-mode={layout.geometry.mode}
          data-mobile-fullscreen={mobileFullscreen ? "true" : "false"}
          className="sf-assistant-panel fixed z-[90] flex flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-2xl"
          style={panelStyle}
          onKeyDown={handlePanelKeyDown}
        >
          <header className="relative border-b border-border bg-background px-4 py-3">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent opacity-80" />
            <div className="flex items-center gap-3">
              <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <Sparkles className="size-4" aria-hidden="true" />
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                  Shopping assistant
                </p>
                <h2
                  id="storefront-assistant-title"
                  className="truncate text-base font-semibold tracking-tight text-foreground"
                >
                  Find what fits
                </h2>
              </div>

              <button
                type="button"
                aria-label={
                  mobileFullscreen ? "Exit full screen" : "Open full screen"
                }
                title={mobileFullscreen ? "Exit full screen" : "Full screen"}
                className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
                onClick={() => setMobileFullscreen((current) => !current)}
              >
                {mobileFullscreen ? (
                  <Minimize2 className="size-4" aria-hidden="true" />
                ) : (
                  <Maximize2 className="size-4" aria-hidden="true" />
                )}
              </button>

              <div className="max-sm:hidden">
                <AssistantLayoutControls
                  mode={layout.geometry.mode}
                  onModeChange={changeMode}
                  onResize={layout.resizePanel}
                  onReset={layout.reset}
                />
              </div>

              <button
                type="button"
                aria-label="Close storefront assistant"
                title="Close assistant"
                className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={closePanel}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </header>

          <StorefrontAssistantContext context={context} />

          <div
            data-assistant-transcript-state={transcript.state.kind}
            className="flex min-h-8 items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground"
          >
            <span>{transcript.state.message}</span>
            {transcript.state.kind === "disconnected" ? (
              <button
                type="button"
                className="shrink-0 font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={transcript.retry}
              >
                Retry transcript
              </button>
            ) : null}
          </div>

          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label="Storefront assistant conversation"
            className="sf-assistant-conversation min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4"
          >
            {messages.length === 0 ? (
              <section className="mx-auto flex min-h-full max-w-lg flex-col justify-center py-4">
                <div className="rounded-2xl border border-border bg-muted/30 p-4">
                  <p className="text-sm font-semibold text-foreground">
                    A guide for this store, not an autopilot
                  </p>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    Ask for recommendations, comparisons, availability, or help
                    understanding this page. The assistant cannot checkout or
                    edit your cart yet; use the store controls to finish those
                    steps manually.
                  </p>
                </div>
                <div
                  className="mt-3 flex flex-wrap gap-2"
                  aria-label="Suggested questions"
                >
                  {prompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="min-h-9 rounded-full border border-border bg-background px-3 text-left text-xs font-medium text-foreground transition hover:border-primary/35 hover:bg-primary/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => choosePrompt(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <ol className="grid gap-4">
                {messages.map((message) => (
                  <li
                    key={message.id}
                    className={cn(
                      "min-w-0",
                      message.role === "user"
                        ? "ml-auto max-w-[85%]"
                        : "mr-auto w-full",
                    )}
                  >
                    {message.role === "user" ? (
                      <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-6 text-primary-foreground shadow-sm">
                        <p className="whitespace-pre-wrap break-words">
                          {messageToHistoryContent(message)}
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2.5">
                        <span className="mt-0.5 flex size-7 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                          <Sparkles className="size-3.5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 rounded-2xl rounded-tl-md border border-border bg-popover p-3 shadow-sm">
                          <AssistantMessageParts
                            parts={message.parts}
                            canNavigate={canNavigate}
                            onNavigate={handleNavigate}
                          />
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {sending ? (
              <div className="mt-4 grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-2.5 text-sm text-muted-foreground">
                <span className="flex size-7 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                </span>
                <span>Looking through the catalog…</span>
              </div>
            ) : null}
            <div ref={conversationEndRef} aria-hidden="true" />
          </div>

          {status.kind !== "idle" && status.kind !== "working" ? (
            <div
              role={status.kind === "error" ? "alert" : "status"}
              className={cn(
                "mx-4 mb-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-5",
                statusClasses(status.kind),
              )}
            >
              <AlertCircle
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>{status.message}</span>
            </div>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {status.message}
          </p>

          <form
            method="post"
            noValidate
            className="border-t border-border bg-background px-4 py-3"
            onSubmit={handleSubmit}
          >
            <label htmlFor={COMPOSER_ID} className="sr-only">
              Message storefront assistant
            </label>
            <div className="flex items-end gap-2 rounded-2xl border border-input bg-muted/25 p-1.5 shadow-sm transition focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-ring/30">
              <textarea
                ref={composerRef}
                id={COMPOSER_ID}
                aria-label="Message storefront assistant"
                value={draft}
                maxLength={MAX_MESSAGE_CHARS}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask about products or this page…"
                rows={2}
                disabled={sending}
                className="max-h-32 min-h-11 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="submit"
                className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={sending || draft.trim().length === 0}
                aria-label="Send storefront assistant message"
              >
                {sending ? (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <SendHorizontal className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p className="mt-1.5 text-center text-[10px] leading-4 text-muted-foreground">
              Don’t share passwords, one-time codes, payment details, or receipt
              links.
            </p>
          </form>

          <button
            type="button"
            aria-label={isDockedSidebar
              ? "Resize assistant sidebar width. Use left and right arrow keys or the layout menu."
              : "Resize assistant panel. Use arrow keys or the layout menu."}
            title={isDockedSidebar
              ? "Drag the inner edge to resize width"
              : "Drag to resize; arrow keys also resize"}
            className="sf-assistant-resize-handle absolute z-10 size-7 touch-none rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={beginResize}
            onPointerMove={continueResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onKeyDown={handleResizeKeyDown}
          >
            <span className="sr-only">Resize assistant panel</span>
          </button>
        </aside>
      ) : (
        <div
          className={cn(
            "sf-assistant-launcher-shell fixed z-[90]",
            !layout.ready && "bottom-4 right-4 sm:bottom-6 sm:right-6",
          )}
          style={launcherStyle}
        >
          <p id={LAUNCHER_HELP_ID} className="sr-only">
            Drag to reposition. With the launcher focused, use arrow keys to
            move it without dragging.
          </p>
          <button
            ref={launcherRef}
            type="button"
            aria-label="Open storefront assistant"
            aria-controls={PANEL_ID}
            aria-expanded="false"
            aria-describedby={LAUNCHER_HELP_ID}
            className="group relative flex items-center justify-center rounded-full border border-primary/30 bg-primary text-primary-foreground shadow-xl shadow-foreground/20 transition hover:-translate-y-0.5 hover:shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none"
            style={{
              width: ASSISTANT_LAUNCHER_SIZE,
              height: ASSISTANT_LAUNCHER_SIZE,
            }}
            onPointerDown={beginLauncherDrag}
            onPointerMove={continueLauncherDrag}
            onPointerUp={endLauncherDrag}
            onPointerCancel={endLauncherDrag}
            onKeyDown={handleLauncherKeyDown}
            onClick={handleLauncherClick}
          >
            <span className="absolute inset-1 rounded-full border border-primary-foreground/20" />
            <Grip
              className="absolute -left-1 -top-1 size-5 rounded-full bg-background p-1 text-muted-foreground shadow-sm"
              aria-hidden="true"
            />
            <MessageCircle
              className="size-6 transition-transform group-hover:scale-105 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </button>
          <p className="sr-only" role="status" aria-live="polite">
            {launcherAnnouncement}
          </p>
        </div>
      )}
    </>
  );
}
