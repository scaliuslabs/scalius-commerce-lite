import type {
  FlueConversationMessage,
  FlueConversationPart,
} from "@flue/sdk";
import { Bot, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { cn } from "@scalius/shared/utils";

import { Button } from "../../ui/button";
import { AdminAssistantConversationPart } from "./AdminAssistantConversationPart";

interface AdminAssistantConversationProps {
  messages: FlueConversationMessage[];
  sending: boolean;
  onSuggestion: (suggestion: string) => void;
}

const EMPTY_SUGGESTIONS = [
  "Summarize this page",
  "What can I do here?",
  "Show me what needs attention",
] as const;
const MAX_VISIBLE_MESSAGES = 80;

export function AdminAssistantConversation({
  messages,
  sending,
  onSuggestion,
}: AdminAssistantConversationProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const visibleMessages = useMemo(
    () => messages.slice(-MAX_VISIBLE_MESSAGES),
    [messages],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages, sending]);

  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Assistant conversation"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
    >
      {messages.length === 0 ? (
        <section
          className="flex min-h-full flex-col justify-center py-4"
          aria-labelledby="admin-assistant-empty-title"
        >
          <div className="mx-auto w-full max-w-xs px-3 text-center">
            <span className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <h3
              id="admin-assistant-empty-title"
              className="text-sm font-semibold tracking-tight"
            >
              Work from where you are
            </h3>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              Ask for facts or tell the assistant to navigate, click, fill,
              select, submit, or refresh the active dashboard page.
            </p>
            <div
              className="mt-4 flex flex-wrap justify-center gap-1.5"
              aria-label="Suggested prompts"
            >
              {EMPTY_SUGGESTIONS.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full bg-background px-2.5 text-[11px]"
                  onClick={() => onSuggestion(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          {messages.length > visibleMessages.length ? (
            <p className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-center text-[10px] text-muted-foreground">
              Earlier messages remain in this durable thread.
            </p>
          ) : null}
          {visibleMessages.map((message) => (
            <article
              key={message.id}
              data-assistant-message-role={message.role}
              data-assistant-submission-id={message.submissionId}
              className={cn(
                "text-sm leading-6",
                message.role === "user"
                  ? "ml-auto max-w-[88%] rounded-xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground shadow-sm"
                  : "relative pl-5 text-foreground",
              )}
            >
              {message.role === "assistant" ? (
                <span
                  className="absolute bottom-0 left-0 top-0 w-px bg-border"
                  aria-hidden="true"
                >
                  <span className="absolute -left-[7px] top-0 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-primary/30 bg-background text-primary">
                    <Bot className="h-2.5 w-2.5" />
                  </span>
                </span>
              ) : null}

              {message.parts.map((part, partIndex) => (
                <AdminAssistantConversationPart
                  key={conversationPartKey(message.id, part, partIndex)}
                  part={part}
                />
              ))}

              {message.role === "assistant" &&
              message.parts.length === 0 &&
              sending ? (
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Starting response…
                </span>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {sending ? (
        <div
          role="status"
          data-assistant-activity="requesting"
          className="relative mt-4 pl-5 text-xs"
        >
          <span
            className="absolute bottom-0 left-0 top-0 w-px bg-primary/30"
            aria-hidden="true"
          >
            <span className="absolute -left-1 top-0 h-2.5 w-2.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
          </span>
          <div className="flex items-center gap-2 font-medium">
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
            Assistant is working
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            This durable thread stays attached while you move through the
            dashboard.
          </p>
        </div>
      ) : null}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}

function conversationPartKey(
  messageId: string,
  part: FlueConversationPart,
  partIndex: number,
): string {
  if (part.type === "dynamic-tool") return `${messageId}:${part.toolCallId}`;
  if (part.type === "file" && part.id) return `${messageId}:file:${part.id}`;
  return `${messageId}:${part.type}:${partIndex}`;
}
