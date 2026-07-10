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
  threadId: string;
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

/**
 * Flue can persist tool progress, tool completion, and the final answer as
 * separate messages for one submission. The merchant needs one conversational
 * result, not a protocol timeline, so keep only active/error progress and the
 * latest completed answer for each submission (or user turn when no durable
 * submission id is available).
 */
export function projectAdminAssistantMessages(
  messages: readonly FlueConversationMessage[],
): FlueConversationMessage[] {
  const groups = new Map<
    string,
    { messages: FlueConversationMessage[]; lastIndex: number }
  >();
  const groupKeyByIndex = new Map<number, string>();
  let turn = 0;

  messages.forEach((message, index) => {
    if (message.role === "user") {
      turn += 1;
      return;
    }
    const key = message.submissionId
      ? `submission:${message.submissionId}`
      : `turn:${turn}`;
    const group = groups.get(key) ?? { messages: [], lastIndex: index };
    group.messages.push(message);
    group.lastIndex = index;
    groups.set(key, group);
    groupKeyByIndex.set(index, key);
  });

  const projectedByIndex = new Map<number, FlueConversationMessage>();
  for (const group of groups.values()) {
    const terminalToolCalls = new Set<string>();
    for (const message of group.messages) {
      for (const part of message.parts) {
        if (
          part.type === "dynamic-tool" &&
          (part.state === "output-available" ||
            part.state === "output-error")
        ) {
          terminalToolCalls.add(part.toolCallId);
        }
      }
    }

    let lastTextMessage: FlueConversationMessage | undefined;
    for (let index = group.messages.length - 1; index >= 0; index -= 1) {
      const candidate = group.messages[index];
      if (
        candidate?.parts.some(
          (part) => part.type === "text" && part.text.trim().length > 0,
        )
      ) {
        lastTextMessage = candidate;
        break;
      }
    }
    const errorParts = group.messages
      .flatMap((message) =>
        message.parts.filter(
          (part) =>
            part.type === "dynamic-tool" && part.state === "output-error",
        ),
      )
      .slice(-2);
    const activeParts = lastTextMessage
      ? []
      : group.messages
          .flatMap((message) =>
            message.parts.filter(
              (part) =>
                part.type === "dynamic-tool" &&
                part.state === "input-available" &&
                !terminalToolCalls.has(part.toolCallId),
            ),
          )
          .slice(-2);
    const textParts = lastTextMessage
      ? lastTextMessage.parts.filter(
          (part) => part.type === "text" && part.text.trim().length > 0,
        )
      : [];
    const parts = [...textParts, ...errorParts, ...activeParts];
    if (parts.length === 0) continue;

    const source = lastTextMessage ?? group.messages.at(-1);
    if (!source) continue;
    projectedByIndex.set(group.lastIndex, { ...source, parts });
  }

  return messages.flatMap((message, index) => {
    if (message.role === "user") return [message];
    const key = groupKeyByIndex.get(index);
    const group = key ? groups.get(key) : undefined;
    if (!group || group.lastIndex !== index) return [];
    const projected = projectedByIndex.get(index);
    return projected ? [projected] : [];
  });
}

export function AdminAssistantConversation({
  threadId,
  messages,
  sending,
  onSuggestion,
}: AdminAssistantConversationProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingLatestRef = useRef(true);
  const priorLastMessageIdRef = useRef<string | undefined>(undefined);
  const projectedMessages = useMemo(
    () => projectAdminAssistantMessages(messages),
    [messages],
  );
  const visibleMessages = useMemo(
    () => projectedMessages.slice(-MAX_VISIBLE_MESSAGES),
    [projectedMessages],
  );

  useEffect(() => {
    followingLatestRef.current = true;
    priorLastMessageIdRef.current = undefined;
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [threadId]);

  useEffect(() => {
    const lastMessage = projectedMessages.at(-1);
    const newUserMessage =
      lastMessage?.role === "user" &&
      lastMessage.id !== priorLastMessageIdRef.current;
    if (newUserMessage) followingLatestRef.current = true;
    priorLastMessageIdRef.current = lastMessage?.id;
    if (followingLatestRef.current) {
      endRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [projectedMessages, sending]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Assistant conversation"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
      onScroll={() => {
        const element = scrollRef.current;
        if (!element) return;
        const distanceFromBottom =
          element.scrollHeight - element.scrollTop - element.clientHeight;
        followingLatestRef.current = distanceFromBottom <= 48;
      }}
    >
      {projectedMessages.length === 0 ? (
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
              Ask for facts or tell the assistant to navigate, inspect, click,
              fill, select, or refresh. You review and submit consequential forms.
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
          {projectedMessages.length > visibleMessages.length ? (
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
      <div
        ref={endRef}
        data-assistant-conversation-end=""
        aria-hidden="true"
      />
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
