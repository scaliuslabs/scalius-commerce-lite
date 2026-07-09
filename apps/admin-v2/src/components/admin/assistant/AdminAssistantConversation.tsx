import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef } from "react";

import type { AdminAssistantChatAction } from "../../../lib/api-functions/ai";
import { cn } from "@scalius/shared/utils";

import { Button } from "../../ui/button";
import {
  getAdminAssistantActionExecutionKey,
} from "./assistant-navigation";
import type {
  AdminAssistantActionExecutionState,
  AdminAssistantMessage,
} from "./assistant-panel-types";
import { AdminAssistantMessageContent } from "./AdminAssistantMessageContent";
import { AdminAssistantRichParts } from "./AdminAssistantRichParts";

interface AdminAssistantConversationProps {
  actionExecutionStates: Record<string, AdminAssistantActionExecutionState>;
  messages: AdminAssistantMessage[];
  sending: boolean;
  onAction: (action: AdminAssistantChatAction, executionKey: string) => void;
  onNavigate: (path: string) => void;
  onSuggestion: (suggestion: string) => void;
}

const EMPTY_SUGGESTIONS = [
  "Summarize this page",
  "What can I do here?",
  "Show me what needs attention",
] as const;

export function AdminAssistantConversation({
  actionExecutionStates,
  messages,
  sending,
  onAction,
  onNavigate,
  onSuggestion,
}: AdminAssistantConversationProps) {
  const endRef = useRef<HTMLDivElement>(null);

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
        <section className="flex min-h-full flex-col justify-center py-4" aria-labelledby="admin-assistant-empty-title">
          <div className="mx-auto w-full max-w-sm rounded-xl border border-border/80 bg-gradient-to-b from-muted/40 to-background p-4 shadow-sm">
            <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <h3 id="admin-assistant-empty-title" className="text-sm font-semibold tracking-tight">
              Work from where you are
            </h3>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              Ask about the current page or directly open a named dashboard
              page. Suggested destinations and page-changing actions wait for
              your click.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Suggested prompts">
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
          {messages.map((message) => {
            const richTextOwnsCopy = message.parts?.some(
              (part) => part.type === "text",
            );
            return (
              <article
                key={message.id}
                data-assistant-message-role={message.role}
                className={cn(
                  "text-sm leading-6",
                  message.role === "user"
                    ? "ml-auto max-w-[88%] rounded-xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground shadow-sm"
                    : "relative pl-5 text-foreground",
                )}
              >
                {message.role === "assistant" ? (
                  <span className="absolute bottom-0 left-0 top-0 w-px bg-border" aria-hidden="true">
                    <span className="absolute -left-[7px] top-0 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-primary/30 bg-background text-primary">
                      <Bot className="h-2.5 w-2.5" />
                    </span>
                  </span>
                ) : null}

                {!richTextOwnsCopy ? (
                  <AdminAssistantMessageContent content={message.content} />
                ) : null}

                {message.role === "assistant" && message.parts?.length ? (
                  <AdminAssistantRichParts
                    parts={message.parts}
                    onNavigate={onNavigate}
                  />
                ) : null}

                {message.role === "assistant" && message.actions?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2" aria-label="Assistant suggestions">
                    {message.actions.map((action) => {
                      const executionKey = getAdminAssistantActionExecutionKey(
                        message.id,
                        action,
                      );
                      const executionState = actionExecutionStates[executionKey];
                      return (
                        <Button
                          key={executionKey}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 max-w-full gap-1.5 rounded-lg bg-background px-2.5 text-xs"
                          aria-label={action.label}
                          aria-busy={executionState === "running"}
                          disabled={executionState !== undefined}
                          onClick={() => onAction(action, executionKey)}
                        >
                          <span className="truncate">{action.label}</span>
                          {executionState === "running" ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                          ) : executionState === "consumed" ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                          ) : (
                            <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          )}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {sending ? (
        <div
          role="status"
          data-assistant-activity="requesting"
          className="relative mt-4 pl-5 text-xs"
        >
          <span className="absolute bottom-0 left-0 top-0 w-px bg-primary/30" aria-hidden="true">
            <span className="absolute -left-1 top-0 h-2.5 w-2.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
          </span>
          <div className="flex items-center gap-2 font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            Reviewing the current page
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            No page action runs without a visible control.
          </p>
        </div>
      ) : null}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}
