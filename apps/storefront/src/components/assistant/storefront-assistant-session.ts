import { isScaliusComputerResultContinuation } from "@scalius/shared/assistant-computer-handoff";
import { redactAssistantPersistedText } from "@scalius/shared/assistant-redaction";
import {
  normalizeStorefrontAssistantCatalogProductIds,
  splitStorefrontAssistantCatalogReferences,
} from "@scalius/shared/storefront-assistant-references";

import {
  MAX_MESSAGE_CHARS,
  cleanAssistantDisplayText,
  messageToHistoryContent,
  type StorefrontAssistantUiMessage,
} from "./storefront-assistant-chat";

export const STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY =
  "scalius.storefront-assistant.session-handoff.v1";

const SESSION_HANDOFF_VERSION = 1;
const MAX_PERSISTED_MESSAGES = 12;
const MAX_PERSISTED_CONTENT_CHARS = MAX_MESSAGE_CHARS;
const MAX_SERIALIZED_CHARS = 32_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PersistedMessage = {
  id: string;
  role: StorefrontAssistantUiMessage["role"];
  content: string;
};

type SessionHandoff = {
  version: typeof SESSION_HANDOFF_VERSION;
  savedAt: number;
  messages: PersistedMessage[];
};

function browserSessionStorage(): SessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function safeMessageId(value: string, index: number): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
    ? value
    : `restored-message-${index + 1}`;
}

function toPersistedMessage(
  message: StorefrontAssistantUiMessage,
  index: number,
): PersistedMessage | null {
  const content = cleanAssistantDisplayText(
    redactAssistantPersistedText(messageToHistoryContent(message)),
    MAX_PERSISTED_CONTENT_CHARS,
  );
  if (!content) return null;
  return {
    id: safeMessageId(message.id, index),
    role: message.role,
    content,
  };
}

function toUiMessage(
  message: PersistedMessage,
  index: number,
): StorefrontAssistantUiMessage | null {
  if (message.role !== "assistant" && message.role !== "user") return null;
  if (typeof message.content !== "string") return null;
  if (
    message.role === "assistant" &&
    isScaliusComputerResultContinuation(message.content, "storefront")
  ) {
    return null;
  }
  const boundedContent = cleanAssistantDisplayText(
    redactAssistantPersistedText(message.content),
    MAX_PERSISTED_CONTENT_CHARS,
  );
  if (!boundedContent) return null;

  const split = message.role === "assistant"
    ? splitStorefrontAssistantCatalogReferences(boundedContent)
    : { content: boundedContent, productIds: [] as string[] };
  const visibleContent = cleanAssistantDisplayText(
    split.content,
    MAX_PERSISTED_CONTENT_CHARS,
  ) || "Catalog results from the previous page.";
  const catalogReferences = normalizeStorefrontAssistantCatalogProductIds(
    split.productIds,
  );

  return {
    id: safeMessageId(message.id, index),
    role: message.role,
    parts: [{ type: "text", text: visibleContent }],
    ...(catalogReferences.length > 0 ? { catalogReferences } : {}),
  };
}

export function writeStorefrontAssistantSessionHandoff(
  messages: readonly StorefrontAssistantUiMessage[],
  storage: SessionStorage | null = browserSessionStorage(),
  now = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const persisted = messages
      .slice(-MAX_PERSISTED_MESSAGES)
      .map(toPersistedMessage)
      .filter((message): message is PersistedMessage => message !== null);
    if (persisted.length === 0) {
      storage.removeItem(STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY);
      return true;
    }

    const handoff: SessionHandoff = {
      version: SESSION_HANDOFF_VERSION,
      savedAt: now,
      messages: persisted,
    };
    let serialized = JSON.stringify(handoff);
    while (
      serialized.length > MAX_SERIALIZED_CHARS &&
      handoff.messages.length > 0
    ) {
      handoff.messages.shift();
      serialized = JSON.stringify(handoff);
    }
    if (handoff.messages.length === 0) return false;
    storage.setItem(STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function readStorefrontAssistantSessionHandoff(
  storage: SessionStorage | null = browserSessionStorage(),
  now = Date.now(),
): StorefrontAssistantUiMessage[] {
  if (!storage) return [];
  try {
    const serialized = storage.getItem(
      STOREFRONT_ASSISTANT_SESSION_HANDOFF_STORAGE_KEY,
    );
    if (!serialized || serialized.length > MAX_SERIALIZED_CHARS) return [];
    const value = JSON.parse(serialized) as Partial<SessionHandoff>;
    if (
      value.version !== SESSION_HANDOFF_VERSION ||
      typeof value.savedAt !== "number" ||
      !Number.isFinite(value.savedAt) ||
      value.savedAt > now + 60_000 ||
      now - value.savedAt > MAX_AGE_MS ||
      !Array.isArray(value.messages) ||
      value.messages.length > MAX_PERSISTED_MESSAGES
    ) {
      return [];
    }
    return value.messages
      .map((message, index) => toUiMessage(message, index))
      .filter(
        (message): message is StorefrontAssistantUiMessage => message !== null,
      );
  } catch {
    return [];
  }
}
