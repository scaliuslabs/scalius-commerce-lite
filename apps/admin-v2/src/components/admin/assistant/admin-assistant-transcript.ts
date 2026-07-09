import type {
  AdminConversationContextMarker,
  AdminConversationEvent,
  AdminConversationMessageEvent,
} from "../../../lib/admin-assistant-conversation";
import {
  createAdminConversationId,
  isAdminConversationId,
} from "../../../lib/admin-assistant-conversation";

import type { AdminAssistantMessage } from "./assistant-panel-types";
import type { AdminAssistantPageStateSnapshot } from "./page-state";

export const ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY =
  "scalius.admin-assistant.conversation-id.v1";

const SENSITIVE_CONTEXT_TERMS = [
  "auth",
  "authentication",
  "credential",
  "customer",
  "order",
  "payment",
  "receipt",
  "recovery",
  "security",
] as const;

export function getOrCreateAdminAssistantConversationId(): string {
  const storage = readSessionStorage();
  if (storage) {
    try {
      const stored = storage.getItem(ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY);
      if (stored && isAdminConversationId(stored)) return stored;

      const conversationId = createAdminConversationId();
      storage.setItem(ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY, conversationId);
      return conversationId;
    } catch {
      // Privacy modes may deny storage even after exposing the Storage object.
    }
  }

  return createAdminConversationId();
}

export function getAdminAssistantConversationContextMarker(
  pageState: AdminAssistantPageStateSnapshot | null,
): AdminConversationContextMarker {
  if (!pageState) return "admin:page";

  const contextValues = [
    pageState.routePath,
    pageState.pageTitle,
    pageState.pageHeading,
    ...pageState.surfaces.flatMap((surface) => [surface.id, surface.label]),
  ];
  const normalized = contextValues
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return SENSITIVE_CONTEXT_TERMS.some((term) => normalized.includes(term))
    ? "admin:sensitive"
    : "admin:page";
}

export function mergeAdminAssistantConversationEvents(
  current: readonly AdminAssistantMessage[],
  events: readonly AdminConversationEvent[],
): AdminAssistantMessage[] {
  const next = [...current];
  const messageEvents = events
    .filter(
      (event): event is AdminConversationMessageEvent =>
        event.type === "message.appended",
    )
    .sort((left, right) => left.sequence - right.sequence);

  for (const event of messageEvents) {
    const existingIndex = next.findIndex(
      (message) => message.id === event.message.id,
    );
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      next[existingIndex] = {
        ...existing,
        role: event.message.role,
        content: event.message.content,
        transcriptSequence: event.sequence,
      };
      continue;
    }

    const higherSequenceIndex = next.findIndex(
      (message) =>
        message.transcriptSequence !== undefined &&
        message.transcriptSequence > event.sequence,
    );
    const firstPendingIndex = next.findIndex(
      (message) => message.transcriptSequence === undefined,
    );
    const insertionIndex = higherSequenceIndex >= 0
      ? higherSequenceIndex
      : firstPendingIndex >= 0
        ? firstPendingIndex
        : next.length;
    next.splice(insertionIndex, 0, toAdminAssistantMessage(event));
  }

  return next;
}

export function reconcileAdminAssistantPersistedMessage(
  current: readonly AdminAssistantMessage[],
  event: AdminConversationMessageEvent,
  optimisticMessageId: string,
): AdminAssistantMessage[] {
  const optimisticIndex = current.findIndex(
    (message) => message.id === optimisticMessageId,
  );
  const durableIndex = current.findIndex(
    (message) => message.id === event.message.id,
  );
  const optimistic = optimisticIndex >= 0 ? current[optimisticIndex] : undefined;
  const durable = durableIndex >= 0 ? current[durableIndex] : undefined;
  const targetIndex = optimisticIndex >= 0
    ? optimisticIndex
    : durableIndex >= 0
      ? durableIndex
      : current.length;
  const retained = current.filter(
    (message) =>
      message.id !== optimisticMessageId && message.id !== event.message.id,
  );
  const insertionIndex = current
    .slice(0, targetIndex)
    .filter(
      (message) =>
        message.id !== optimisticMessageId && message.id !== event.message.id,
    ).length;
  const reconciled: AdminAssistantMessage = {
    ...durable,
    ...optimistic,
    id: event.message.id,
    role: event.message.role,
    content: event.message.content,
    transcriptSequence: event.sequence,
  };

  retained.splice(insertionIndex, 0, reconciled);
  return retained;
}

function toAdminAssistantMessage(
  event: AdminConversationMessageEvent,
): AdminAssistantMessage {
  return {
    id: event.message.id,
    role: event.message.role,
    content: event.message.content,
    transcriptSequence: event.sequence,
  };
}

function readSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
