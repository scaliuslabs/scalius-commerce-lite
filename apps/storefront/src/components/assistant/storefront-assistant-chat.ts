import {
  assistantMessagePartSchema,
  type AssistantMessagePart,
} from "@scalius/shared/assistant-contracts";

import { resolveStorefrontAssistantNavigationTarget } from "@/lib/assistant-page-context.client";
import type { StorefrontAssistantPageContextSnapshot } from "@/lib/assistant-page-context";
import {
  createStorefrontConversationRequestId,
  isStorefrontConversationId,
  parseStorefrontConversationMessageEvent,
  type StorefrontConversationMessageEvent,
} from "./storefront-assistant-conversation";

export type StorefrontAssistantMessageRole = "assistant" | "user";

export type StorefrontAssistantUiMessage = {
  id: string;
  role: StorefrontAssistantMessageRole;
  parts: AssistantMessagePart[];
  transcriptSequence?: number;
};

export type StorefrontAssistantChatResult =
  | {
      status: "ok";
      message: StorefrontAssistantUiMessage;
      transcriptPersisted: boolean;
      transcriptEvent?: StorefrontConversationMessageEvent;
    }
  | {
      status: "disabled" | "error";
      message: string;
    };

export type StorefrontAssistantHistoryEntry = {
  role: StorefrontAssistantMessageRole;
  content: string;
};

export const CHAT_ENDPOINT = "/api/assistant/chat";
export const MAX_HISTORY_MESSAGES = 6;
export const MAX_MESSAGE_CHARS = 2_000;

const MAX_RESPONSE_CHARS = 8_000;
const MAX_ACTIONS = 3;
const MAX_ACTION_LABEL_CHARS = 80;
const MAX_PARTS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanAssistantDisplayText(
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string") return "";
  const cleaned = Array.from(value.replace(/\r\n?/g, "\n"), (char) => {
    if (char === "\n" || char === "\t") return char;
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/[\u2028\u2029]/g, " ")
    .trim();

  return cleaned.slice(0, maxLength);
}

function createMessageId(role: StorefrontAssistantMessageRole): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTextMessage(
  role: StorefrontAssistantMessageRole,
  text: string,
): StorefrontAssistantUiMessage {
  return {
    id: createMessageId(role),
    role,
    parts: [{ type: "text", text }],
  };
}

function readAssistantContent(value: unknown): string {
  if (typeof value === "string") {
    return cleanAssistantDisplayText(value, MAX_RESPONSE_CHARS);
  }
  if (!isRecord(value)) return "";
  return cleanAssistantDisplayText(value.content, MAX_RESPONSE_CHARS);
}

function withManualFallback(message: string): string {
  const fallback =
    "You can keep browsing, use search, and complete cart or checkout steps manually.";
  if (!message) return `The shopping assistant is unavailable. ${fallback}`;
  if (/\b(?:manually|keep browsing|store controls)\b/i.test(message)) {
    return message;
  }
  return `${message} ${fallback}`;
}

function normalizeParts(value: unknown): AssistantMessagePart[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_PARTS)
    .map((part) => assistantMessagePartSchema.safeParse(part))
    .filter((result) => result.success)
    .map((result) => result.data);
}

function normalizeLegacyNavigationParts(
  value: unknown,
  origin: string,
): AssistantMessagePart[] {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, MAX_ACTIONS)
    .map((action): AssistantMessagePart | null => {
      if (!isRecord(action) || action.type !== "navigate") return null;
      const path = resolveStorefrontAssistantNavigationTarget(
        action.path,
        origin,
      );
      if (!path) return null;
      return {
        type: "navigation",
        path,
        label:
          cleanAssistantDisplayText(action.label, MAX_ACTION_LABEL_CHARS) ||
          "Open page",
        requiresConfirmation: true,
      };
    })
    .filter((part): part is AssistantMessagePart => part !== null);
}

function responseMessageParts(
  record: Record<string, unknown>,
  origin: string,
): AssistantMessagePart[] {
  const messageRecord = isRecord(record.message) ? record.message : null;
  const richParts = normalizeParts(messageRecord?.parts ?? record.parts);
  const content =
    readAssistantContent(record.message) ||
    readAssistantContent(record.reply) ||
    readAssistantContent(record.text);
  const parts = [...richParts];

  if (content && !parts.some((part) => part.type === "text")) {
    parts.unshift({ type: "text", text: content });
  }

  parts.push(...normalizeLegacyNavigationParts(record.actions, origin));
  return parts.slice(0, MAX_PARTS);
}

export function normalizeStorefrontAssistantChatResult(
  value: unknown,
  origin: string,
): StorefrontAssistantChatResult {
  if (!isRecord(value)) {
    return {
      status: "error",
      message: withManualFallback("Assistant returned an empty response."),
    };
  }

  if (value.status === "disabled") {
    return {
      status: "disabled",
      message: withManualFallback(
        cleanAssistantDisplayText(value.message, 500),
      ),
    };
  }

  if (value.status === "error") {
    return {
      status: "error",
      message: withManualFallback(
        cleanAssistantDisplayText(value.message, 500) ||
          "The assistant request failed. Nothing was changed.",
      ),
    };
  }

  const parts = responseMessageParts(value, origin);
  if (parts.length === 0) {
    return {
      status: "error",
      message: withManualFallback("Assistant returned no readable message."),
    };
  }

  const messageRecord = isRecord(value.message) ? value.message : null;
  const serverId = cleanAssistantDisplayText(messageRecord?.id, 160);
  const transcriptEvent = parseStorefrontConversationMessageEvent(
    value.transcriptEvent,
  );
  return {
    status: "ok",
    message: {
      id: serverId || createMessageId("assistant"),
      role: "assistant",
      parts,
    },
    transcriptPersisted:
      value.transcriptPersisted === true && transcriptEvent?.message.role === "assistant",
    ...(transcriptEvent?.message.role === "assistant"
      ? { transcriptEvent }
      : {}),
  };
}

function partText(part: AssistantMessagePart): string | null {
  switch (part.type) {
    case "text":
      return part.text;
    case "result":
      return `${part.title}: ${part.summary}`;
    case "error":
      return part.message;
    case "handoff":
      return `${part.title}: ${part.description}`;
    case "progress":
      return `${part.label}: ${part.status}`;
    default:
      return null;
  }
}

export function messageToHistoryContent(
  message: StorefrontAssistantUiMessage,
): string {
  return cleanAssistantDisplayText(
    message.parts.map(partText).filter(Boolean).join("\n"),
    MAX_MESSAGE_CHARS,
  );
}

export async function sendStorefrontAssistantMessage(input: {
  message: string;
  pageContext: StorefrontAssistantPageContextSnapshot | null;
  history: StorefrontAssistantHistoryEntry[];
  origin: string;
  conversationId?: string;
  signal?: AbortSignal;
}): Promise<StorefrontAssistantChatResult> {
  const clientRequestId = createStorefrontConversationRequestId("chat");
  const body = JSON.stringify({
    clientRequestId,
    message: input.message,
    pageContext: input.pageContext,
    history: input.history,
  });
  const conversationEndpoint = input.conversationId &&
      isStorefrontConversationId(input.conversationId)
    ? `/api/assistant/conversations/${input.conversationId}/chat`
    : null;

  async function request(
    endpoint: string,
    credentials: RequestCredentials,
  ): Promise<{ response: Response; result: StorefrontAssistantChatResult }> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      credentials,
      mode: "same-origin",
      signal: input.signal,
    });
    const json = await response.json().catch(() => null);
    return {
      response,
      result: normalizeStorefrontAssistantChatResult(json, input.origin),
    };
  }

  let attempt: { response: Response; result: StorefrontAssistantChatResult };
  try {
    attempt = conversationEndpoint
      ? await request(conversationEndpoint, "same-origin")
      : await request(CHAT_ENDPOINT, "omit");
  } catch (error) {
    if (
      !conversationEndpoint ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw error;
    }
    attempt = await request(CHAT_ENDPOINT, "omit");
  }

  if (
    conversationEndpoint &&
    !attempt.response.ok &&
    attempt.result.status === "error"
  ) {
    attempt = await request(CHAT_ENDPOINT, "omit");
  }

  const { response, result } = attempt;

  if (!response.ok && result.status === "ok") {
    return {
      status: "error",
      message: withManualFallback(
        "The assistant request failed. Nothing was changed.",
      ),
    };
  }
  return result;
}
