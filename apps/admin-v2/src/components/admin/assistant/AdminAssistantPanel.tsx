import { Grip } from "lucide-react";
import {
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

import { cn } from "@scalius/shared/utils";

import {
  getOrCreateAdminAssistantTabId,
} from "./admin-assistant-transcript";
import {
  clampAdminAssistantPosition,
  getAdminAssistantViewport,
  type AdminAssistantMode,
  type AdminAssistantPosition,
  type AdminAssistantSize,
} from "./assistant-layout";
import type { AdminAssistantStatus } from "./assistant-panel-types";
import { AdminAssistantComposer } from "./AdminAssistantComposer";
import { AdminAssistantConversation } from "./AdminAssistantConversation";
import { AdminAssistantPanelHeader } from "./AdminAssistantPanelHeader";
import { AdminAssistantStatusBanner } from "./AdminAssistantStatusBanner";
import { AdminAssistantTranscriptStatus } from "./AdminAssistantTranscriptStatus";
import { AdminFlueComputerCoordinator } from "./computer/flue-bridge";
import { createAdminAssistantComputerRuntime } from "./computer/runtime";
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

const KEYBOARD_GEOMETRY_STEP = 12;
const ADMIN_ASSISTANT_MOBILE_BREAKPOINT = 768;
const MAX_QUEUED_COMPUTER_TOOL_CALLS = 256;

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
  const openRef = useRef(open);
  const queuedComputerToolCallsRef = useRef(new Set<string>());
  const computerQueueRef = useRef(Promise.resolve());
  const startPointerGesture = usePointerGesture();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<AdminAssistantStatus>({
    kind: "idle",
    message: "Ready on the current admin page.",
  });
  const transcript = useAdminAssistantTranscript();
  openRef.current = open;

  const tabId = useMemo(getOrCreateAdminAssistantTabId, []);
  const computerRuntime = useMemo(() => {
    if (!transcript.threadId) return null;
    return createAdminAssistantComputerRuntime({
      threadId: transcript.threadId,
      tabId,
      navigate: async (route) => {
        await navigate({ to: route as string });
      },
      isActive: () =>
        openRef.current && document.visibilityState !== "hidden",
    });
  }, [navigate, tabId, transcript.threadId]);
  const computerCoordinator = useMemo(
    () =>
      computerRuntime
        ? new AdminFlueComputerCoordinator({ runtime: computerRuntime })
        : null,
    [computerRuntime],
  );

  const contextLabel = useMemo(() => {
    if (!pageState) return "Current admin page";
    return pageState.pageHeading ?? pageState.pageTitle ?? pageState.routePath;
  }, [pageState]);

  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    queuedComputerToolCallsRef.current.clear();
    computerQueueRef.current = Promise.resolve();
  }, [transcript.threadId]);

  useEffect(() => {
    if (!open || !computerCoordinator || !transcript.threadId) return;

    let latestUserMessage: string | undefined;
    for (const message of transcript.messages) {
      if (message.role === "user") {
        latestUserMessage = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .slice(0, 8_000);
        continue;
      }
      for (const part of message.parts) {
        if (
          part.type !== "dynamic-tool" ||
          part.toolName !== "computer" ||
          part.state !== "output-available" ||
          queuedComputerToolCallsRef.current.has(part.toolCallId)
        ) {
          continue;
        }
        claimBoundedToolCall(
          queuedComputerToolCallsRef.current,
          part.toolCallId,
        );
        const authorizingUserMessage = latestUserMessage;
        computerQueueRef.current = computerQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            const outcome = await computerCoordinator.consume({
              threadId: transcript.threadId,
              tabId,
              latestUserMessage: authorizingUserMessage,
              part,
            });
            if (outcome.status === "rejected") {
              setStatus({
                kind: "error",
                message:
                  outcome.reason === "navigation_not_authorized"
                    ? "Navigation needs one direct, exact destination request. Nothing was opened."
                    : "A page command was rejected safely. Nothing was run for that command.",
              });
            } else if (outcome.status === "continuation_failed") {
              setStatus({
                kind: "error",
                message:
                  "The page command finished, but its result could not return to the assistant. Ask it to observe before trying again.",
              });
            }
          });
      }
    }
  }, [
    computerCoordinator,
    open,
    tabId,
    transcript.messages,
    transcript.threadId,
  ]);

  if (!open) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || transcript.sending) return;

    setDraft("");
    transcript.clearOperationError();
    setStatus({ kind: "idle", message: "Ready on the current admin page." });
    const admitted = await transcript.sendMessage(message);
    if (!admitted && !transcript.operationError) {
      setStatus({
        kind: "error",
        message: "Assistant request was not admitted. Nothing was changed.",
      });
    }
  }

  async function handleAbort() {
    const outcome = await transcript.abort();
    if (outcome === "requested") {
      setStatus({
        kind: "success",
        message: "Stop requested. The durable thread will show the final state.",
      });
    } else if (outcome === "idle") {
      setStatus({
        kind: "disabled",
        message: "The assistant had already finished, so there was nothing to stop.",
      });
    }
  }

  function handleNewConversation() {
    const nextThreadId = transcript.startNewConversation();
    if (!nextThreadId) return;
    setStatus({
      kind: "idle",
      message: "New durable assistant conversation ready.",
    });
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleConversationChange(threadId: string) {
    if (!transcript.switchConversation(threadId)) return;
    setStatus({ kind: "idle", message: "Durable conversation restored." });
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleMovePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
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
            mode === "floating" ? startSize.height + deltaY : startSize.height,
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
  const visibleStatus: AdminAssistantStatus = transcript.operationError
    ? { kind: "error", message: transcript.operationError }
    : transcript.settlementNotice
      ? {
          kind:
            transcript.settlementNotice.kind === "failed"
              ? "error"
              : "disabled",
          message: transcript.settlementNotice.message,
        }
      : status;

  const panel = (
    <aside
      id="admin-assistant-panel"
      data-scalius-computer-exclude=""
      aria-label="Admin assistant"
      aria-describedby="admin-assistant-context"
      data-assistant-mode={mode}
      className={cn(
        "z-[80] flex flex-col overflow-hidden border border-border/90 bg-background text-foreground",
        mode === "floating" && "fixed rounded-2xl shadow-2xl shadow-black/15",
        mode !== "floating" &&
          "fixed inset-y-0 h-dvh shadow-2xl shadow-black/15 md:relative md:inset-auto md:z-20 md:h-svh md:shrink-0 md:shadow-none",
        mode === "dock-left" && "left-0 border-y-0 border-l-0",
        mode === "dock-right" && "right-0 border-y-0 border-r-0",
      )}
      style={panelStyle}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onOpenChange(false);
      }}
    >
      <AdminAssistantPanelHeader
        canStartNewConversation={transcript.canStartNewConversation}
        conversationHistoryIds={transcript.conversationHistoryIds}
        contextLabel={contextLabel}
        mode={mode}
        threadId={transcript.threadId}
        onConversationChange={handleConversationChange}
        onModeChange={onModeChange}
        onMinimize={() => onOpenChange(false)}
        onMoveKeyDown={handleMoveKeyDown}
        onMovePointerDown={handleMovePointerDown}
        onNewConversation={handleNewConversation}
      />
      <AdminAssistantTranscriptStatus
        state={transcript.state}
        onRetry={transcript.retry}
      />

      <AdminAssistantConversation
        threadId={transcript.threadId}
        messages={transcript.messages}
        sending={transcript.sending}
        onSuggestion={(suggestion) => {
          setDraft(suggestion);
          window.setTimeout(() => textareaRef.current?.focus(), 0);
        }}
      />
      <AdminAssistantStatusBanner status={visibleStatus} />
      <AdminAssistantComposer
        aborting={transcript.aborting}
        canAbort={transcript.canAbort}
        draft={draft}
        sending={transcript.sending}
        textareaRef={textareaRef}
        onAbort={() => {
          void handleAbort();
        }}
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
    </aside>
  );

  return panel;
}

function claimBoundedToolCall(keys: Set<string>, toolCallId: string): void {
  keys.add(toolCallId);
  while (keys.size > MAX_QUEUED_COMPUTER_TOOL_CALLS) {
    const oldestKey = keys.values().next().value as string | undefined;
    if (!oldestKey) break;
    keys.delete(oldestKey);
  }
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

  const compact =
    getAdminAssistantViewport().width < ADMIN_ASSISTANT_MOBILE_BREAKPOINT;
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
    return {
      ...size,
      width: size.width + (mode === "dock-right" ? -step : step),
    };
  }
  if (event.key === "ArrowLeft") {
    return {
      ...size,
      width: size.width + (mode === "dock-right" ? step : -step),
    };
  }
  if (mode === "floating" && event.key === "ArrowDown") {
    return { ...size, height: size.height + step };
  }
  if (mode === "floating" && event.key === "ArrowUp") {
    return { ...size, height: size.height - step };
  }
  return null;
}
