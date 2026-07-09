import { redactAssistantPersistedText } from "@scalius/shared/assistant-redaction";
import * as z from "zod/v4";

export const CONVERSATION_PROTOCOL_VERSION = "2026-07-10" as const;
export const CONVERSATION_INTERNAL_PREFIX = "/internal/conversations" as const;
export const CONVERSATION_INTERNAL_ORIGIN = "http://conversation.internal" as const;
export const CONVERSATION_AUTHORIZED_UNTIL_HEADER =
  "X-Scalius-Conversation-Authorized-Until" as const;
export const STOREFRONT_CONVERSATION_SUBJECT_HEADER =
  "X-Scalius-Conversation-Subject" as const;
export const STOREFRONT_CONVERSATION_AUDIENCE_HEADER =
  "X-Scalius-Conversation-Audience" as const;
export const STOREFRONT_CONVERSATION_AUDIENCE =
  "scalius-storefront-browser-v1" as const;

export const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/;
export const STOREFRONT_CONVERSATION_SUBJECT_PATTERN =
  /^storefront_subject_[A-Za-z0-9_-]{43,86}$/;
export const MAX_CONVERSATION_MESSAGE_CHARS = 8_000;
export const MAX_CONVERSATION_REQUEST_BYTES = 12 * 1024;
export const MAX_CONVERSATION_REPLAY_LIMIT = 100;
export const SENSITIVE_CONVERSATION_OMISSION =
  "Sensitive page conversation was intentionally omitted." as const;

export const ADMIN_CONTEXT_MARKERS = [
  "admin:page",
  "admin:sensitive",
] as const;
export const STOREFRONT_CONTEXT_MARKERS = [
  "storefront:home",
  "storefront:product",
  "storefront:category",
  "storefront:collection",
  "storefront:search",
  "storefront:cart",
  "storefront:page",
  "storefront:unknown",
  "storefront:sensitive",
] as const;

export type ConversationSurface = "admin" | "storefront";
export type AdminConversationContextMarker = (typeof ADMIN_CONTEXT_MARKERS)[number];
export type StorefrontConversationContextMarker =
  (typeof STOREFRONT_CONTEXT_MARKERS)[number];
export type ConversationContextMarker =
  | AdminConversationContextMarker
  | StorefrontConversationContextMarker;
export type ConversationRole = "user" | "assistant";

export interface ConversationSurfacePolicy {
  surface: ConversationSurface;
  audience: string;
  retentionMs: number;
  connectionLeaseMs: number;
  contextMarkers: ReadonlySet<ConversationContextMarker>;
  sensitiveContextMarkers: ReadonlySet<ConversationContextMarker>;
}

export const ADMIN_CONVERSATION_POLICY: ConversationSurfacePolicy = {
  surface: "admin",
  audience: "scalius-admin-dashboard-v1",
  retentionMs: 7 * 24 * 60 * 60 * 1_000,
  connectionLeaseMs: 60_000,
  contextMarkers: new Set(ADMIN_CONTEXT_MARKERS),
  sensitiveContextMarkers: new Set<ConversationContextMarker>(["admin:sensitive"]),
};

export const STOREFRONT_CONVERSATION_POLICY: ConversationSurfacePolicy = {
  surface: "storefront",
  audience: STOREFRONT_CONVERSATION_AUDIENCE,
  retentionMs: 24 * 60 * 60 * 1_000,
  connectionLeaseMs: 60_000,
  contextMarkers: new Set(STOREFRONT_CONTEXT_MARKERS),
  sensitiveContextMarkers: new Set<ConversationContextMarker>([
    "storefront:sensitive",
  ]),
};

const boundedOpaqueInput = z.string().trim().min(1).max(160);

const appendMessageInputSchema = z.object({
  clientMessageId: boundedOpaqueInput,
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_CONVERSATION_MESSAGE_CHARS),
  contextMarker: z.string().trim().min(1).max(80),
}).strict();

const cancelInputSchema = z.object({
  clientRequestId: boundedOpaqueInput,
  runId: boundedOpaqueInput,
}).strict();

const webSocketResumeInputSchema = z.object({
  type: z.literal("resume"),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export interface NormalizedConversationMessageInput {
  clientMessageId: string;
  role: ConversationRole;
  content: string;
  contextMarker: ConversationContextMarker;
}

export interface NormalizedConversationCancelInput {
  clientRequestId: string;
  runId: string;
}

export interface ConversationWebSocketResumeInput {
  type: "resume";
  after: number;
}

export class ConversationInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ConversationInputError";
    this.code = code;
    this.status = status;
  }
}

function normalizePlainText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    if (character === "\n" || character === "\t") return character;
    return code <= 31 || code === 127 ? " " : character;
  }).join("")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .trim();
}

export function normalizeConversationMessageInput(
  policy: ConversationSurfacePolicy,
  value: unknown,
): NormalizedConversationMessageInput {
  const parsed = appendMessageInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConversationInputError(
      "conversation_message_invalid",
      "Conversation messages require a bounded role, plain-text body, and context marker.",
    );
  }

  const contextMarker = parsed.data.contextMarker as ConversationContextMarker;
  if (!policy.contextMarkers.has(contextMarker)) {
    throw new ConversationInputError(
      "conversation_context_invalid",
      "Conversation context marker is invalid for this surface.",
    );
  }

  const content = policy.sensitiveContextMarkers.has(contextMarker)
    ? SENSITIVE_CONVERSATION_OMISSION
    : redactAssistantPersistedText(normalizePlainText(parsed.data.content));
  if (!content) {
    throw new ConversationInputError(
      "conversation_message_empty",
      "Conversation message is empty after privacy normalization.",
    );
  }

  return {
    clientMessageId: parsed.data.clientMessageId,
    role: parsed.data.role,
    content,
    contextMarker,
  };
}

export function normalizeConversationCancelInput(
  value: unknown,
): NormalizedConversationCancelInput {
  const parsed = cancelInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConversationInputError(
      "conversation_cancel_invalid",
      "Cancellation requires bounded client request and run identifiers.",
    );
  }
  return parsed.data;
}

export function normalizeWebSocketResumeInput(
  value: unknown,
): ConversationWebSocketResumeInput {
  const parsed = webSocketResumeInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConversationInputError(
      "conversation_socket_message_invalid",
      "Conversation sockets accept only bounded resume cursor messages.",
    );
  }
  return parsed.data;
}

export function isConversationId(value: string): boolean {
  return CONVERSATION_ID_PATTERN.test(value);
}

export function isStorefrontConversationSubject(value: string): boolean {
  return STOREFRONT_CONVERSATION_SUBJECT_PATTERN.test(value);
}
