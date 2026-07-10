export const ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY =
  "scalius.admin-assistant.conversation-id.v1";
export const ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY =
  "scalius.admin-assistant.conversation-history.v1";

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/u;
const MAX_CONVERSATION_HISTORY_IDS = 20;
const MAX_CONVERSATION_HISTORY_BYTES = 4_096;
const RANDOM_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
let adminAssistantTabId: string | undefined;

export function getOrCreateAdminAssistantConversationId(): string {
  const storage = readSessionStorage();
  if (storage) {
    try {
      const stored = storage.getItem(
        ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
      );
      if (stored && CONVERSATION_ID_PATTERN.test(stored)) {
        retainConversationId(storage, stored);
        return stored;
      }

      const conversationId = createBrowserIdentity("conv");
      persistActiveConversationId(storage, conversationId);
      return conversationId;
    } catch {
      // Privacy modes may deny storage even after exposing Storage.
    }
  }

  return createBrowserIdentity("conv");
}

export function createNewAdminAssistantConversationId(): string {
  const conversationId = createBrowserIdentity("conv");
  const storage = readSessionStorage();
  if (storage) {
    try {
      persistActiveConversationId(storage, conversationId);
    } catch {
      // The new in-memory thread still works when browser storage is denied.
    }
  }
  return conversationId;
}

export function getAdminAssistantConversationHistoryIds(): string[] {
  const storage = readSessionStorage();
  if (!storage) return [];
  return readConversationIds(storage);
}

export function activateAdminAssistantConversationId(
  conversationId: string,
): boolean {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return false;
  const storage = readSessionStorage();
  if (storage) {
    try {
      persistActiveConversationId(storage, conversationId);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Page-computer commands are bound to one live browser tab. This identity is
 * deliberately process-local: a full reload creates a fresh tab binding while
 * the durable conversation thread remains stable in sessionStorage.
 */
export function getOrCreateAdminAssistantTabId(): string {
  adminAssistantTabId ??= createBrowserIdentity("tab");
  return adminAssistantTabId;
}

function createBrowserIdentity(prefix: "conv" | "tab"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let result = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += RANDOM_ALPHABET[(accumulator >>> bits) & 63];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) {
    result += RANDOM_ALPHABET[(accumulator << (6 - bits)) & 63];
  }
  return `${prefix}_${result}`;
}

function persistActiveConversationId(
  storage: Storage,
  conversationId: string,
): void {
  storage.setItem(
    ADMIN_ASSISTANT_CONVERSATION_ID_STORAGE_KEY,
    conversationId,
  );
  retainConversationId(storage, conversationId);
}

function retainConversationId(storage: Storage, conversationId: string): void {
  const ids = readConversationIds(storage).filter(
    (candidate) => candidate !== conversationId,
  );
  ids.push(conversationId);
  storage.setItem(
    ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY,
    JSON.stringify(ids.slice(-MAX_CONVERSATION_HISTORY_IDS)),
  );
}

function readConversationIds(storage: Storage): string[] {
  let raw: string | null;
  try {
    raw = storage.getItem(ADMIN_ASSISTANT_CONVERSATION_HISTORY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw || raw.length > MAX_CONVERSATION_HISTORY_BYTES) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !CONVERSATION_ID_PATTERN.test(candidate) ||
      ids.includes(candidate)
    ) {
      continue;
    }
    ids.push(candidate);
  }
  return ids.slice(-MAX_CONVERSATION_HISTORY_IDS);
}

function readSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
