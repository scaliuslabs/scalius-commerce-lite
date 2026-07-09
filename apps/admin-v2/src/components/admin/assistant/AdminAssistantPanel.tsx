import {
  Grip,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  assistantMessagePartSchema,
  type AssistantMessagePart,
} from "@scalius/shared/assistant-contracts";
import { cn } from "@scalius/shared/utils";

import {
  createAdminConversationRequestId,
  type AdminConversationEvent,
  type AdminConversationContextMarker,
} from "../../../lib/admin-assistant-conversation";
import {
  sendAdminAssistantMessage,
  type AdminAssistantChatAction,
  type AdminAssistantChatResult,
} from "../../../lib/api-functions/ai";
import {
  getAdminAssistantConversationContextMarker,
  mergeAdminAssistantConversationEvents,
  reconcileAdminAssistantPersistedMessage,
} from "./admin-assistant-transcript";
import {
  clampAdminAssistantPosition,
  getAdminAssistantViewport,
  type AdminAssistantMode,
  type AdminAssistantPosition,
  type AdminAssistantSize,
} from "./assistant-layout";
import { getAdminAssistantPageActionStatus } from "./assistant-action-status";
import {
  safeAdminAssistantNavigationPath,
  safeAdminAssistantPanelActions,
} from "./assistant-navigation";
import type {
  AdminAssistantActionExecutionState,
  AdminAssistantMessage,
  AdminAssistantStatus,
} from "./assistant-panel-types";
import { AdminAssistantComposer } from "./AdminAssistantComposer";
import { AdminAssistantConversation } from "./AdminAssistantConversation";
import { AdminAssistantPanelHeader } from "./AdminAssistantPanelHeader";
import { AdminAssistantStatusBanner } from "./AdminAssistantStatusBanner";
import { AdminAssistantTranscriptStatus } from "./AdminAssistantTranscriptStatus";
import {
  executeAdminAssistantPageActionWithResult,
} from "./page-actions";
import { useAdminAssistantPageState } from "./useAdminAssistantPageState";
import { useAdminAssistantTranscript } from "./useAdminAssistantTranscript";
import { usePointerGesture } from "./usePointerGesture";

interface AdminAssistantPanelProps {
  mode: AdminAssistantMode;
  open: boolean;
  position: AdminAssistantPosition;
  size: AdminAssistantSize;
  onModeChange: (mode: AdminAssistantMode) => void;
  onOpenChange: (open: boolean) => void;
  onPositionChange: (position: AdminAssistantPosition) => void;
  onSizeChange: (size: AdminAssistantSize) => void;
}

const MAX_HISTORY_MESSAGES = 6;
const MAX_CLAIMED_ACTION_KEYS = 200;
const KEYBOARD_GEOMETRY_STEP = 12;

export function AdminAssistantPanel({
  mode,
  open,
  position,
  size,
  onModeChange,
  onOpenChange,
  onPositionChange,
  onSizeChange,
}: AdminAssistantPanelProps) {
  const navigate = useNavigate();
  const pageState = useAdminAssistantPageState();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const claimedActionKeysRef = useRef(new Set<string>());
  const startPointerGesture = usePointerGesture();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AdminAssistantMessage[]>([]);
  const [status, setStatus] = useState<AdminAssistantStatus>({
    kind: "idle",
    message: "Ready on the current admin page.",
  });
  const [sending, setSending] = useState(false);
  const [actionExecutionStates, setActionExecutionStates] = useState<
    Record<string, AdminAssistantActionExecutionState>
  >({});
  const mergeTranscriptEvents = useCallback(
    (events: readonly AdminConversationEvent[]) => {
      setMessages((current) =>
        mergeAdminAssistantConversationEvents(current, events),
      );
    },
    [],
  );
  const transcript = useAdminAssistantTranscript({
    open,
    onEvents: mergeTranscriptEvents,
  });

  const contextLabel = useMemo(() => {
    if (!pageState) return "Current admin page";
    return pageState.pageHeading ?? pageState.pageTitle ?? pageState.routePath;
  }, [pageState]);

  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  if (!open) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;

    const contextMarker = getAdminAssistantConversationContextMarker(pageState);
    const userClientMessageId = createAdminConversationRequestId("message");
    const userMessage: AdminAssistantMessage = {
      id: userClientMessageId,
      role: "user",
      content: message,
    };
    const history = messages.slice(-MAX_HISTORY_MESSAGES).map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));

    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setSending(true);
    setStatus({ kind: "idle", message: "Reviewing the current admin page." });

    try {
      const persistedUserEvent = await transcript.appendMessage({
        clientMessageId: userClientMessageId,
        role: "user",
        content: message,
        contextMarker,
      });
      if (persistedUserEvent) {
        setMessages((current) =>
          reconcileAdminAssistantPersistedMessage(
            current,
            persistedUserEvent,
            userClientMessageId,
          ),
        );
      }

      const result = (await sendAdminAssistantMessage({
        data: { message, pageContext: pageState, history },
      })) as AdminAssistantChatResult;
      await applyAssistantResult(
        result,
        contextMarker,
        persistedUserEvent !== null,
      );
    } catch {
      setStatus({
        kind: "error",
        message: "Assistant request failed. Nothing was changed.",
      });
    } finally {
      setSending(false);
    }
  }

  async function applyAssistantResult(
    result: AdminAssistantChatResult,
    contextMarker: AdminConversationContextMarker,
    persistTranscript: boolean,
  ) {
    if (result.status === "ok") {
      const assistantClientMessageId =
        createAdminConversationRequestId("message");
      setMessages((current) => [
        ...current,
        {
          id: assistantClientMessageId,
          role: "assistant",
          content: result.message.content,
          parts: readAssistantParts(result),
          actions: safeAdminAssistantPanelActions(result.actions),
        },
      ]);
      setStatus({ kind: "idle", message: "Ready on the current admin page." });

      if (persistTranscript) {
        const persistedAssistantEvent = await transcript.appendMessage({
          clientMessageId: assistantClientMessageId,
          role: "assistant",
          content: result.message.content,
          contextMarker,
        });
        if (persistedAssistantEvent) {
          setMessages((current) =>
            reconcileAdminAssistantPersistedMessage(
              current,
              persistedAssistantEvent,
              assistantClientMessageId,
            ),
          );
        }
      }
      return;
    }

    setStatus({
      kind: result.status === "disabled" ? "disabled" : "error",
      message: result.message,
    });
  }

  async function navigateFromAssistant(pathValue: string) {
    const path = safeAdminAssistantNavigationPath(pathValue);
    if (!path) {
      setStatus({
        kind: "error",
        message: "That navigation action is no longer available.",
      });
      return;
    }

    try {
      await Promise.resolve(navigate({ to: path as string }));
    } catch {
      if (typeof window !== "undefined") window.location.assign(path);
    }
  }

  async function handleAssistantAction(
    action: AdminAssistantChatAction,
    executionKey: string,
  ) {
    if (!claimActionKey(claimedActionKeysRef.current, executionKey)) return;
    setActionExecutionStates((current) => ({
      ...current,
      [executionKey]: "running",
    }));

    try {
      if (action.type === "navigate") {
        await navigateFromAssistant(action.path);
        return;
      }

      const result = await executeAdminAssistantPageActionWithResult(action, {
        executionKey,
      });
      setStatus(getAdminAssistantPageActionStatus(action, result));
    } finally {
      setActionExecutionStates((current) => ({
        ...current,
        [executionKey]: "consumed",
      }));
    }
  }

  function handleMovePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (mode !== "floating") return;
    const startPosition = position;
    startPointerGesture(event, {
      onMove: (deltaX, deltaY) => {
        onPositionChange({
          x: startPosition.x + deltaX,
          y: startPosition.y + deltaY,
        });
      },
    });
  }

  function handleMoveKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (mode !== "floating") return;
    const delta = getMoveKeyDelta(event);
    if (!delta) return;
    event.preventDefault();
    onPositionChange(
      clampAdminAssistantPosition(
        { x: position.x + delta.x, y: position.y + delta.y },
        size,
        getAdminAssistantViewport(),
      ),
    );
  }

  function handleResizePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const startSize = size;
    startPointerGesture(event, {
      onMove: (deltaX, deltaY) => {
        onSizeChange({
          width:
            mode === "dock-right"
              ? startSize.width - deltaX
              : startSize.width + deltaX,
          height:
            mode === "floating"
              ? startSize.height + deltaY
              : startSize.height,
        });
      },
    });
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const nextSize = getKeyboardResizeSize(event, mode, size);
    if (!nextSize) return;
    event.preventDefault();
    onSizeChange(nextSize);
  }

  const panelStyle = getPanelStyle(mode, position, size);

  return (
    <section
      id="admin-assistant-panel"
      aria-label="Admin assistant"
      aria-describedby="admin-assistant-context"
      data-assistant-mode={mode}
      className={cn(
        "fixed z-[80] flex flex-col overflow-hidden border border-border/90 bg-background text-foreground shadow-2xl shadow-black/15",
        mode === "floating" && "rounded-2xl",
        mode === "dock-left" && "left-0 top-0 border-y-0 border-l-0",
        mode === "dock-right" && "right-0 top-0 border-y-0 border-r-0",
      )}
      style={panelStyle}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onOpenChange(false);
      }}
    >
      <AdminAssistantPanelHeader
        contextLabel={contextLabel}
        mode={mode}
        onModeChange={onModeChange}
        onMinimize={() => onOpenChange(false)}
        onMoveKeyDown={handleMoveKeyDown}
        onMovePointerDown={handleMovePointerDown}
      />
      <AdminAssistantTranscriptStatus
        state={transcript.state}
        onRetry={transcript.retry}
      />

      <AdminAssistantConversation
        actionExecutionStates={actionExecutionStates}
        messages={messages}
        sending={sending}
        onAction={(action, executionKey) => {
          void handleAssistantAction(action, executionKey);
        }}
        onNavigate={(path) => {
          void navigateFromAssistant(path);
        }}
        onSuggestion={(suggestion) => {
          setDraft(suggestion);
          window.setTimeout(() => textareaRef.current?.focus(), 0);
        }}
      />
      <AdminAssistantStatusBanner status={status} />
      <AdminAssistantComposer
        draft={draft}
        sending={sending}
        textareaRef={textareaRef}
        onDraftChange={setDraft}
        onSubmit={handleSubmit}
      />

      <p id="admin-assistant-resize-help" className="sr-only">
        Drag to resize, or use the arrow keys. Hold Shift for larger steps.
      </p>
      <button
        type="button"
        aria-label="Resize assistant"
        aria-describedby="admin-assistant-resize-help"
        className={cn(
          "absolute z-10 touch-none text-muted-foreground outline-none transition-colors hover:bg-primary/10 hover:text-primary focus-visible:bg-primary/10 focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 max-sm:hidden",
          mode === "floating" &&
            "bottom-0 right-0 flex h-10 w-10 cursor-nwse-resize items-end justify-end rounded-br-2xl p-2",
          mode === "dock-left" &&
            "bottom-0 right-0 top-0 w-6 cursor-ew-resize border-l border-transparent",
          mode === "dock-right" &&
            "bottom-0 left-0 top-0 w-6 cursor-ew-resize border-r border-transparent",
        )}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      >
        {mode === "floating" ? (
          <Grip className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <span className="mx-auto block h-12 w-0.5 rounded-full bg-current opacity-60" />
        )}
      </button>
    </section>
  );
}

function readAssistantParts(
  result: AdminAssistantChatResult,
): AssistantMessagePart[] | undefined {
  const rawMessage = (result as unknown as {
    message?: { parts?: unknown };
    parts?: unknown;
  }).message;
  const rawParts = rawMessage?.parts ?? (result as unknown as { parts?: unknown }).parts;
  if (!Array.isArray(rawParts)) return undefined;

  const parts: AssistantMessagePart[] = [];
  for (const candidate of rawParts.slice(0, 40)) {
    const parsed = assistantMessagePartSchema.safeParse(candidate);
    if (parsed.success) parts.push(parsed.data);
  }
  return parts.length > 0 ? parts : undefined;
}

function claimActionKey(keys: Set<string>, executionKey: string): boolean {
  if (keys.has(executionKey)) return false;
  keys.add(executionKey);
  while (keys.size > MAX_CLAIMED_ACTION_KEYS) {
    const oldestKey = keys.values().next().value as string | undefined;
    if (!oldestKey) break;
    keys.delete(oldestKey);
  }
  return true;
}

function getPanelStyle(
  mode: AdminAssistantMode,
  position: AdminAssistantPosition,
  size: AdminAssistantSize,
): CSSProperties {
  if (mode === "floating") {
    return {
      left: position.x,
      top: position.y,
      width: size.width,
      height: size.height,
    };
  }

  const compact = getAdminAssistantViewport().width < 640;
  return {
    width: compact ? "100vw" : size.width,
    height: "100dvh",
  };
}

function getMoveKeyDelta(
  event: KeyboardEvent<HTMLButtonElement>,
): AdminAssistantPosition | null {
  const step = KEYBOARD_GEOMETRY_STEP * (event.shiftKey ? 3 : 1);
  if (event.key === "ArrowLeft") return { x: -step, y: 0 };
  if (event.key === "ArrowRight") return { x: step, y: 0 };
  if (event.key === "ArrowUp") return { x: 0, y: -step };
  if (event.key === "ArrowDown") return { x: 0, y: step };
  return null;
}

function getKeyboardResizeSize(
  event: KeyboardEvent<HTMLButtonElement>,
  mode: AdminAssistantMode,
  size: AdminAssistantSize,
): AdminAssistantSize | null {
  const step = KEYBOARD_GEOMETRY_STEP * (event.shiftKey ? 3 : 1);
  if (event.key === "ArrowRight") {
    return { ...size, width: size.width + (mode === "dock-right" ? -step : step) };
  }
  if (event.key === "ArrowLeft") {
    return { ...size, width: size.width + (mode === "dock-right" ? step : -step) };
  }
  if (mode === "floating" && event.key === "ArrowDown") {
    return { ...size, height: size.height + step };
  }
  if (mode === "floating" && event.key === "ArrowUp") {
    return { ...size, height: size.height - step };
  }
  return null;
}
