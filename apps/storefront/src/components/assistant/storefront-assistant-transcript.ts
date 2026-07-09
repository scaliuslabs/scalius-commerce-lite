import type { StorefrontAssistantPageContextSnapshot } from
  "@/lib/assistant-page-context";

import type { StorefrontAssistantUiMessage } from
  "./storefront-assistant-chat";
import {
  createStorefrontConversationId,
  isStorefrontConversationId,
  type StorefrontConversationContextMarker,
  type StorefrontConversationMessageEvent,
} from "./storefront-assistant-conversation";

export const STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY =
  "scalius.storefront-assistant.conversation-id.v1";

const SENSITIVE_CONTEXT_TERMS = [
  "account",
  "auth",
  "authentication",
  "checkout",
  "credential",
  "customer",
  "login",
  "order",
  "otp",
  "payment",
  "receipt",
  "recovery",
  "security",
] as const;

let activeClaimConversationId: string | null = null;
let claimPromise: Promise<string> | null = null;
let activeLockRelease: (() => void) | null = null;

export function getOrCreateStorefrontAssistantConversationId(): string {
  const storage = readSessionStorage();
  if (storage) {
    try {
      const stored = storage.getItem(
        STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      );
      if (stored && isStorefrontConversationId(stored)) return stored;

      const conversationId = createStorefrontConversationId();
      storage.setItem(
        STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
        conversationId,
      );
      return conversationId;
    } catch {
      // Privacy modes can deny storage after exposing the Storage object.
    }
  }
  return createStorefrontConversationId();
}

export function replaceStorefrontAssistantConversationId(): string {
  const conversationId = createStorefrontConversationId();
  const storage = readSessionStorage();
  if (storage) {
    try {
      storage.setItem(
        STOREFRONT_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
        conversationId,
      );
    } catch {
      // The in-memory tab can still continue when storage is denied.
    }
  }
  return conversationId;
}

export function claimStorefrontAssistantConversationId(): Promise<string> {
  if (activeClaimConversationId) {
    return Promise.resolve(activeClaimConversationId);
  }
  claimPromise ??= claimConversationIdForThisTab();
  return claimPromise;
}

export function rotateStorefrontAssistantConversationClaim(): void {
  activeLockRelease?.();
  activeLockRelease = null;
  activeClaimConversationId = null;
  claimPromise = null;
  replaceStorefrontAssistantConversationId();
}

async function claimConversationIdForThisTab(): Promise<string> {
  let conversationId = getOrCreateStorefrontAssistantConversationId();
  if (
    typeof navigator === "undefined" ||
    !navigator.locks ||
    typeof navigator.locks.request !== "function"
  ) {
    // Privacy wins over cross-navigation continuity on older browsers that
    // cannot exclusively claim sessionStorage copied by a duplicated tab.
    conversationId = replaceStorefrontAssistantConversationId();
    activeClaimConversationId = conversationId;
    return conversationId;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await tryHoldConversationLock(conversationId)) {
      activeClaimConversationId = conversationId;
      return conversationId;
    }
    conversationId = replaceStorefrontAssistantConversationId();
  }

  // If the LockManager itself fails repeatedly, use a final fresh 128-bit ID;
  // never fall back to the copied sessionStorage identifier.
  conversationId = replaceStorefrontAssistantConversationId();
  activeClaimConversationId = conversationId;
  return conversationId;
}

function tryHoldConversationLock(conversationId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (claimed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(claimed);
    };
    void navigator.locks.request(
      `scalius.storefront-assistant:${conversationId}`,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settle(false);
          return;
        }
        let release: () => void = () => {};
        const held = new Promise<void>((releaseLock) => {
          release = releaseLock;
        });
        activeLockRelease = release;
        settle(true);
        await held;
      },
    ).catch(() => settle(false));
  });
}

export function storefrontConversationContextMarker(
  context: StorefrontAssistantPageContextSnapshot | null,
): StorefrontConversationContextMarker {
  const page = context?.page;
  const values = [
    page?.kind,
    page?.path,
    page?.route,
    page?.canonicalUrl,
    page?.title,
  ];
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (
    SENSITIVE_CONTEXT_TERMS.some((term) => normalized.includes(term))
  ) {
    return "storefront:sensitive";
  }

  switch (page?.kind) {
    case "home":
      return "storefront:home";
    case "product":
      return "storefront:product";
    case "category":
      return "storefront:category";
    case "collection":
      return "storefront:collection";
    case "search":
      return "storefront:search";
    case "cart":
      return "storefront:cart";
    case "page":
      return "storefront:page";
    default:
      return "storefront:unknown";
  }
}

export function mergeStorefrontConversationEvents(
  current: readonly StorefrontAssistantUiMessage[],
  events: readonly StorefrontConversationMessageEvent[],
): StorefrontAssistantUiMessage[] {
  const next = [...current];
  const ordered = [...events].sort((left, right) =>
    left.sequence - right.sequence
  );

  for (const event of ordered) {
    const existingIndex = next.findIndex(
      (message) => message.id === event.message.id,
    );
    if (existingIndex >= 0) {
      next[existingIndex] = {
        ...next[existingIndex]!,
        role: event.message.role,
        transcriptSequence: event.sequence,
      };
      continue;
    }

    const higherSequenceIndex = next.findIndex(
      (message) =>
        message.transcriptSequence !== undefined &&
        message.transcriptSequence > event.sequence,
    );
    const firstLiveOnlyIndex = next.findIndex(
      (message) => message.transcriptSequence === undefined,
    );
    const insertionIndex = higherSequenceIndex >= 0
      ? higherSequenceIndex
      : firstLiveOnlyIndex >= 0
        ? firstLiveOnlyIndex
        : next.length;
    next.splice(insertionIndex, 0, toUiMessage(event));
  }
  return next;
}

export function reconcileStorefrontPersistedMessage(
  current: readonly StorefrontAssistantUiMessage[],
  event: StorefrontConversationMessageEvent,
  optimisticMessageId: string,
): StorefrontAssistantUiMessage[] {
  const optimisticIndex = current.findIndex(
    (message) => message.id === optimisticMessageId,
  );
  const durableIndex = current.findIndex(
    (message) => message.id === event.message.id,
  );
  const optimistic = optimisticIndex >= 0
    ? current[optimisticIndex]
    : undefined;
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
        message.id !== optimisticMessageId &&
        message.id !== event.message.id,
    ).length;

  retained.splice(insertionIndex, 0, {
    ...durable,
    ...optimistic,
    id: event.message.id,
    role: event.message.role,
    parts: optimistic?.parts ?? [{ type: "text", text: event.message.content }],
    transcriptSequence: event.sequence,
  });
  return retained;
}

function toUiMessage(
  event: StorefrontConversationMessageEvent,
): StorefrontAssistantUiMessage {
  return {
    id: event.message.id,
    role: event.message.role,
    parts: [{ type: "text", text: event.message.content }],
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
