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
  Grip,
  Loader2,
  MessageCircle,
  SendHorizontal,
  Sparkles,
} from "lucide-react";

import {
  AssistantDock,
  type AssistantDockMode,
  type AssistantDockSide,
  type AssistantDockStatus,
} from "@scalius/ui/assistant";
import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  type StorefrontAssistantPageContextSnapshot,
} from "@/lib/assistant-page-context";
import { resolveStorefrontAssistantNavigationTarget } from "@/lib/assistant-page-context.client";
import { cn } from "@scalius/shared/utils";

import { AssistantMessageParts } from "./AssistantMessageParts";
import { ASSISTANT_LAUNCHER_SIZE } from "./assistant-geometry";
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
  readStorefrontAssistantSessionHandoff,
  writeStorefrontAssistantSessionHandoff,
} from "./storefront-assistant-session";
import {
  mergeStorefrontConversationEvents,
  reconcileStorefrontPersistedMessage,
  storefrontConversationContextMarker,
} from "./storefront-assistant-transcript";
import { getDirectlyConfirmedStorefrontNavigation } from
  "./storefront-assistant-navigation";
import { useStorefrontAssistantTranscript } from
  "./useStorefrontAssistantTranscript";
import { useAssistantGeometry } from "./useAssistantGeometry";
import "@scalius/ui/assistant/styles.css";
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

const LAYOUT_ID = "storefront-assistant-layout";
const PANEL_ID = "storefront-assistant-panel";
const COMPOSER_ID = "storefront-assistant-message";
const LAUNCHER_HELP_ID = "storefront-assistant-launcher-help";
const DRAG_THRESHOLD = 6;
const KEYBOARD_MOVE_STEP = 32;
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

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

function sharedStatus(kind: AssistantStatus["kind"]): AssistantDockStatus {
  if (kind === "disabled") return "offline";
  return kind;
}

function contextSummary(
  context: StorefrontAssistantPageContextSnapshot | null,
) {
  if (!context) return "Waiting for this page";
  const privatePage = context.page.kind === "account" ||
    context.page.kind === "checkout";
  const page = privatePage
    ? `${context.page.kind} · private context protected`
    : context.page.title || context.page.kind;
  const count = context.cart.totalItems;
  return `${page} · ${count} ${count === 1 ? "cart item" : "cart items"}`;
}

export default function StorefrontAssistantBubble() {
  const layout = useAssistantGeometry();
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [context, setContext] =
    useState<StorefrontAssistantPageContextSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<StorefrontAssistantUiMessage[]>(
    () => readStorefrontAssistantSessionHandoff(),
  );
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
  const suppressLauncherClickRef = useRef(false);
  const wasOpenRef = useRef(false);
  const focusComposerOnOpenRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);

  const updateMessages = useCallback((
    update: (
      current: StorefrontAssistantUiMessage[],
    ) => StorefrontAssistantUiMessage[],
  ) => {
    const next = update(messagesRef.current);
    messagesRef.current = next;
    writeStorefrontAssistantSessionHandoff(next);
    setMessages(next);
  }, []);

  const mergeTranscriptEvents = useCallback(
    (events: Parameters<typeof mergeStorefrontConversationEvents>[1]) => {
      updateMessages((current) =>
        mergeStorefrontConversationEvents(current, events)
      );
    },
    [updateMessages],
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
    document.documentElement.dataset.storefrontAssistantHydrated = "true";
    if (readStorefrontAssistantOpenState()) setIsOpen(true);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
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
    const host = document.getElementById(LAYOUT_ID);
    const page = host?.querySelector<HTMLElement>("[data-assistant-page-slot]");
    if (!host || !page) return;

    const docked = layout.geometry.mode !== "floating";
    host.dataset.mode = isOpen
      ? docked ? "docked" : "floating"
      : "collapsed";
    host.dataset.side = layout.geometry.mode === "dock-left" ? "start" : "end";
    host.dataset.mobile = isMobile ? "true" : "false";
    host.style.setProperty(
      "--sc-assistant-dock-width",
      `${layout.panelRect.width}px`,
    );
    host.style.setProperty(
      "--sf-assistant-panel-left",
      `${layout.panelRect.left}px`,
    );
    host.style.setProperty(
      "--sf-assistant-panel-top",
      `${layout.panelRect.top}px`,
    );
    host.style.setProperty(
      "--sf-assistant-panel-height",
      `${layout.panelRect.height}px`,
    );

    const modal = isOpen && isMobile;
    if (modal) {
      page.inert = true;
      page.setAttribute("aria-hidden", "true");
    } else {
      page.inert = false;
      page.removeAttribute("aria-hidden");
    }
  }, [
    isMobile,
    isOpen,
    layout.geometry.mode,
    layout.panelRect.height,
    layout.panelRect.left,
    layout.panelRect.top,
    layout.panelRect.width,
  ]);

  useEffect(() => () => {
    const host = document.getElementById(LAYOUT_ID);
    const page = host?.querySelector<HTMLElement>("[data-assistant-page-slot]");
    if (host) host.dataset.mode = "collapsed";
    if (page) {
      page.inert = false;
      page.removeAttribute("aria-hidden");
    }
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    writeStorefrontAssistantSessionHandoff(messages);
  }, [messages]);

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

      writeStorefrontAssistantOpenState(true);
      writeStorefrontAssistantSessionHandoff(messagesRef.current);
      const navigated = getAssistantBridge()?.navigate?.(target) === true;
      setStatus({
        kind: navigated ? "success" : "error",
        message: navigated
          ? `Opening ${label.replace(/^(?:Open|View|Browse|Search)\s+/i, "")}.`
          : "Navigation is unavailable. Use the store menu or search instead.",
      });
    },
    [resolveNavigation],
  );

  const closePanel = useCallback(() => {
    focusComposerOnOpenRef.current = false;
    writeStorefrontAssistantOpenState(false);
    setIsOpen(false);
  }, []);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = cleanAssistantDisplayText(draft, MAX_MESSAGE_CHARS);
    if (!message || sending || typeof window === "undefined") return;

    const currentContext = refreshContext();
    const contextMarker = storefrontConversationContextMarker(currentContext);
    const userMessage = createTextMessage("user", message);
    const history = messagesRef.current
      .slice(-MAX_HISTORY_MESSAGES)
      .map((entry) => ({
        role: entry.role,
        content: messageToHistoryContent(entry),
      }))
      .filter((entry) => entry.content.length > 0);

    updateMessages((current) => [...current, userMessage]);
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
        updateMessages((current) =>
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
        updateMessages((current) => [...current, result.message]);
        if (result.transcriptEvent) {
          updateMessages((current) =>
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
        const directlyConfirmedNavigation =
          getDirectlyConfirmedStorefrontNavigation(
            message,
            result.message.parts,
            window.location.origin,
          );
        if (directlyConfirmedNavigation) {
          queueMicrotask(() =>
            handleNavigate(
              directlyConfirmedNavigation.path,
              directlyConfirmedNavigation.label,
            )
          );
        }
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
      if (requestAbortRef.current === controller) {
        requestAbortRef.current = null;
      }
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
    if (drag.moved) {
      setLauncherAnnouncement("Assistant launcher position saved.");
    }
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

  function changePanelMode(mode: AssistantDockMode) {
    if (mode === "closed" || mode === "collapsed") {
      closePanel();
      return;
    }
    if (mode === "floating") {
      layout.setMode("floating");
      setStatus({ kind: "success", message: "Assistant panel is floating." });
      return;
    }
    const side = layout.geometry.mode === "dock-left" ? "left" : "right";
    layout.setMode(side === "left" ? "dock-left" : "dock-right");
    setStatus({ kind: "success", message: `Assistant panel docked ${side}.` });
  }

  function changeDockSide(side: AssistantDockSide) {
    layout.setMode(side === "start" ? "dock-left" : "dock-right");
    setStatus({
      kind: "success",
      message: `Assistant panel docked ${side === "start" ? "left" : "right"}.`,
    });
  }

  const dockMode: AssistantDockMode = layout.geometry.mode === "floating"
    ? "floating"
    : "docked";
  const dockSide: AssistantDockSide = layout.geometry.mode === "dock-left"
    ? "start"
    : "end";

  const conversation = (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Storefront assistant conversation"
      className="sf-assistant-conversation min-h-full"
    >
      <div
        data-assistant-transcript-state={transcript.state.kind}
        className="mb-3 flex min-h-8 items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground"
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

      {messages.length === 0 ? (
        <section className="mx-auto flex min-h-[16rem] max-w-lg flex-col justify-center py-4">
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm font-semibold text-foreground">
              Help for this store
            </p>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Ask for recommendations, comparisons, availability, or help with
              this page. Use the visible store controls to change the cart or
              complete checkout.
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested questions">
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
  );

  const composer = (
    <form method="post" noValidate onSubmit={handleSubmit}>
      <label htmlFor={COMPOSER_ID} className="sr-only">
        Message storefront assistant
      </label>
      <div className="flex items-end gap-2 rounded-xl border border-input bg-muted/25 p-1.5 shadow-sm transition focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-ring/30">
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
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
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
        Don’t share passwords, one-time codes, payment details, or receipt links.
      </p>
    </form>
  );

  if (isOpen) {
    return (
      <AssistantDock
        id={PANEL_ID}
        mode={dockMode}
        side={dockSide}
        eyebrow="Shopping assistant"
        heading="Find what fits"
        description="Live store context"
        status={sharedStatus(status.kind)}
        statusLabel={status.message}
        icon={<Sparkles aria-hidden="true" />}
        context={<span>{contextSummary(context)}</span>}
        contextLabel="Current page"
        conversation={conversation}
        composer={composer}
        width={layout.panelRect.width}
        minimumWidth={340}
        maximumWidth={720}
        initialFocusRef={composerRef}
        mobile={isMobile}
        onModeChange={changePanelMode}
        onSideChange={dockMode === "docked" ? changeDockSide : undefined}
        onWidthChange={(width) =>
          layout.setPanelSize(width, layout.geometry.panelHeight)}
      />
    );
  }

  return (
    <div
      className={cn(
        "sf-assistant-launcher-shell fixed z-[90]",
        !layout.ready && "bottom-4 right-4 sm:bottom-6 sm:right-6",
      )}
      style={launcherStyle}
    >
      <p id={LAUNCHER_HELP_ID} className="sr-only">
        Drag to reposition. With the launcher focused, use arrow keys to move
        it without dragging.
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
  );
}
