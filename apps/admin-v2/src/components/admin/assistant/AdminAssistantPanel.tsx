import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, Bot, Loader2, SendHorizontal, X } from "lucide-react";

import {
  sendAdminAssistantMessage,
  type AdminAssistantChatResult,
  type AdminAssistantNavigateAction,
} from "../../../lib/api-functions/ai";
import { Button } from "../../ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../ui/sheet";
import { Textarea } from "../../ui/textarea";
import { cn } from "@scalius/shared/utils";
import { useAdminAssistantPageState } from "./useAdminAssistantPageState";

interface AdminAssistantPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MessageRole = "assistant" | "user";

interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  actions?: AdminAssistantNavigateAction[];
}

type AssistantStatus =
  | { kind: "idle"; message: string }
  | { kind: "disabled"; message: string }
  | { kind: "error"; message: string };

const MAX_HISTORY_MESSAGES = 6;

export function AdminAssistantPanel({
  open,
  onOpenChange,
}: AdminAssistantPanelProps) {
  const navigate = useNavigate();
  const pageState = useAdminAssistantPageState();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [status, setStatus] = useState<AssistantStatus>({
    kind: "idle",
    message: "Ready on the current admin page.",
  });
  const [sending, setSending] = useState(false);

  const contextLabel = useMemo(() => {
    if (!pageState) return "Current admin page";
    return pageState.pageHeading ?? pageState.pageTitle ?? pageState.routePath;
  }, [pageState]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;

    const userMessage: AssistantMessage = {
      id: createMessageId("user"),
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
    setStatus({ kind: "idle", message: "Checking assistant availability." });

    try {
      const result = (await sendAdminAssistantMessage({
        data: {
          message,
          pageContext: pageState,
          history,
        },
      })) as AdminAssistantChatResult;
      applyAssistantResult(result);
    } catch {
      setStatus({
        kind: "error",
        message: "Assistant request failed. Nothing was changed.",
      });
    } finally {
      setSending(false);
    }
  }

  function applyAssistantResult(result: AdminAssistantChatResult) {
    if (result.status === "ok") {
      setMessages((current) => [
        ...current,
        {
          id: createMessageId("assistant"),
          role: "assistant",
          content: result.message.content,
          actions: safePanelNavigationActions(result.actions),
        },
      ]);
      setStatus({ kind: "idle", message: "Ready on the current admin page." });
      return;
    }

    setStatus({
      kind: result.status === "disabled" ? "disabled" : "error",
      message: result.message,
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function handleNavigationAction(action: AdminAssistantNavigateAction) {
    const path = safeAdminNavigationPath(action.path);
    if (!path) return;

    try {
      void Promise.resolve(navigate({ to: path as string })).catch(() => {
        if (typeof window !== "undefined") window.location.assign(path);
      });
    } catch {
      if (typeof window !== "undefined") window.location.assign(path);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col overflow-hidden p-0 sm:max-w-[28rem]"
      >
        <SheetHeader className="border-b border-border px-4 py-3 text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="flex items-center gap-2 text-base">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="h-4 w-4" aria-hidden="true" />
                </span>
                Admin assistant
              </SheetTitle>
              <SheetDescription className="mt-1 truncate">
                {contextLabel}
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Close admin assistant"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            role="log"
            aria-live="polite"
            aria-label="Assistant conversation"
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
          >
            {messages.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                Start with a question about the page you are viewing.
              </div>
            ) : null}
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "max-w-[88%] rounded-md px-3 py-2 text-sm leading-6",
                  message.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "mr-auto border border-border bg-muted/60 text-foreground",
                )}
              >
                {message.content}
                {message.role === "assistant" && message.actions?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {message.actions.map((action) => (
                      <Button
                        key={`${message.id}-${action.path}`}
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 max-w-full gap-1.5 px-2 text-xs"
                        aria-label={action.label}
                        onClick={() => handleNavigationAction(action)}
                      >
                        <span className="truncate">{action.label}</span>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {sending ? (
              <div className="mr-auto inline-flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Thinking
              </div>
            ) : null}
          </div>

          {status.kind !== "idle" ? (
            <div
              role={status.kind === "error" ? "alert" : "status"}
              className={cn(
                "mx-4 mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                status.kind === "disabled"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-destructive/30 bg-destructive/10 text-destructive",
              )}
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{status.message}</span>
            </div>
          ) : null}

          <form
            method="post"
            noValidate
            className="border-t border-border bg-background px-4 py-3"
            onSubmit={handleSubmit}
          >
            <label
              htmlFor="admin-assistant-message"
              className="sr-only"
            >
              Message admin assistant
            </label>
            <div className="flex items-end gap-2">
              <Textarea
                id="admin-assistant-message"
                aria-label="Message admin assistant"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask about this page..."
                rows={2}
                disabled={sending}
                className="max-h-40 min-h-[44px] resize-none py-2 text-sm"
              />
              <Button
                type="submit"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={sending || draft.trim().length === 0}
                aria-label="Send assistant message"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <SendHorizontal className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function createMessageId(role: MessageRole): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeAdminNavigationPath(value: string): string | null {
  const path = value.trim();
  if (!/^\/admin(?:\/[a-z0-9-]+)*$/.test(path)) return null;
  const segments = path.split("/").filter(Boolean);
  const resourceRoots = new Set([
    "attributes",
    "categories",
    "collections",
    "customers",
    "discounts",
    "inventory",
    "media",
    "orders",
    "pages",
    "products",
    "widgets",
  ]);
  if (segments.slice(1).some((segment) => /^\d+$/.test(segment))) return null;
  if (segments.length > 2 && resourceRoots.has(segments[1] ?? "")) return null;
  return path;
}

function safePanelNavigationActions(
  actions: AdminAssistantNavigateAction[] | undefined,
): AdminAssistantNavigateAction[] | undefined {
  if (!actions?.length) return undefined;
  const safeActions = actions.filter((action) => safeAdminNavigationPath(action.path));
  return safeActions.length > 0 ? safeActions : undefined;
}
