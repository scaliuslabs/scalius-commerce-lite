import { redactAssistantPersistedText } from "@scalius/shared/assistant-redaction";

import {
  MAX_CONVERSATION_DEDUPE_RECORDS,
  MAX_CONVERSATION_EVENT_BYTES,
  MAX_CONVERSATION_EVENTS,
  type ConversationAppendResult,
  type ConversationDedupeRecord,
  type ConversationMeta,
  type ConversationReplay,
  type ConversationStorage,
  type ConversationStorageTransaction,
  type StoredConversationCancellationEvent,
  type StoredConversationEvent,
  type StoredConversationMessageEvent,
} from "./types";

const META_KEY = "meta";
const EVENT_PREFIX = "event:";
const DEDUPE_PREFIX = "dedupe:";
const EVENT_SEQUENCE_WIDTH = 16;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const textEncoder = new TextEncoder();

export class ConversationStoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, number>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, number>,
  ) {
    super(message);
    this.name = "ConversationStoreError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function eventKey(sequence: number): string {
  return `${EVENT_PREFIX}${String(sequence).padStart(EVENT_SEQUENCE_WIDTH, "0")}`;
}

function dedupeKey(requestHash: string): string {
  return `${DEDUPE_PREFIX}${requestHash}`;
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new ConversationStoreError(
      "conversation_hash_invalid",
      `${label} must be a SHA-256 digest.`,
      503,
    );
  }
}

function eventSize(event: StoredConversationEvent): number {
  return textEncoder.encode(JSON.stringify(event)).byteLength;
}

function initialMeta(expiresAt: number): ConversationMeta {
  return {
    version: 1,
    lastSequence: 0,
    earliestSequence: 1,
    eventCount: 0,
    eventBytes: 0,
    expiresAt,
    cancellation: null,
    dedupeOrder: [],
  };
}

function isFiniteInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isConversationMeta(value: unknown): value is ConversationMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const meta = value as Partial<ConversationMeta>;
  return meta.version === 1 &&
    isFiniteInteger(meta.lastSequence) &&
    isFiniteInteger(meta.earliestSequence) &&
    isFiniteInteger(meta.eventCount) &&
    isFiniteInteger(meta.eventBytes) &&
    isFiniteInteger(meta.expiresAt) &&
    (meta.cancellation === null || (
      typeof meta.cancellation === "object" &&
      meta.cancellation !== null &&
      typeof meta.cancellation.runHash === "string" &&
      SHA256_HEX_PATTERN.test(meta.cancellation.runHash) &&
      isFiniteInteger(meta.cancellation.sequence) &&
      isFiniteInteger(meta.cancellation.requestedAt)
    )) &&
    Array.isArray(meta.dedupeOrder) &&
    meta.dedupeOrder.every((item) =>
      typeof item === "string" && SHA256_HEX_PATTERN.test(item)
    );
}

function isStoredEvent(value: unknown): value is StoredConversationEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<StoredConversationEvent>;
  if (!(typeof event.eventId === "string" &&
    isFiniteInteger(event.sequence) &&
    isFiniteInteger(event.occurredAt))) return false;
  if (event.type === "message.appended") {
    const message = event.message;
    return typeof message === "object" &&
      message !== null &&
      typeof message.id === "string" &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.length <= 8_000 &&
      typeof message.contextMarker === "string" &&
      isFiniteInteger(message.createdAt);
  }
  if (event.type === "stream.cancelled") {
    const cancellation = event.cancellation;
    return typeof cancellation === "object" &&
      cancellation !== null &&
      typeof cancellation.runHash === "string" &&
      SHA256_HEX_PATTERN.test(cancellation.runHash);
  }
  return false;
}

function isDedupeRecord(value: unknown): value is ConversationDedupeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<ConversationDedupeRecord>;
  return isFiniteInteger(record.sequence) &&
    typeof record.fingerprint === "string" &&
    SHA256_HEX_PATTERN.test(record.fingerprint);
}

async function clearTransaction(
  transaction: ConversationStorageTransaction,
): Promise<void> {
  const entries = await transaction.list();
  const keys = [...entries.keys()];
  if (keys.length > 0) await transaction.delete(keys);
}

async function requireMeta(
  reader: ConversationStorage,
): Promise<ConversationMeta | null> {
  const value = await reader.get(META_KEY);
  if (value === undefined) return null;
  if (!isConversationMeta(value)) {
    throw new ConversationStoreError(
      "conversation_state_invalid",
      "Conversation state is unavailable.",
      503,
    );
  }
  return value;
}

export class ConversationStore {
  readonly #storage: ConversationStorage;
  readonly #retentionMs: number;

  constructor(storage: ConversationStorage, retentionMs: number) {
    this.#storage = storage;
    this.#retentionMs = retentionMs;
  }

  async appendMessage(
    input: {
      requestHash: string;
      fingerprint: string;
      role: StoredConversationMessageEvent["message"]["role"];
      content: string;
      contextMarker: StoredConversationMessageEvent["message"]["contextMarker"];
    },
    now: number,
  ): Promise<ConversationAppendResult> {
    const content = redactAssistantPersistedText(input.content).trim();
    if (!content) {
      throw new ConversationStoreError(
        "conversation_message_empty",
        "Conversation message is empty after privacy normalization.",
        400,
      );
    }
    return this.#append(
      input.requestHash,
      input.fingerprint,
      now,
      (sequence): StoredConversationMessageEvent => ({
        eventId: `event_${sequence}`,
        sequence,
        type: "message.appended",
        occurredAt: now,
        message: {
          id: `message_${sequence}`,
          role: input.role,
          content,
          contextMarker: input.contextMarker,
          createdAt: now,
        },
      }),
    );
  }

  async cancelRun(
    input: {
      requestHash: string;
      fingerprint: string;
      runHash: string;
    },
    now: number,
  ): Promise<ConversationAppendResult> {
    requireSha256(input.runHash, "Cancellation run hash");
    return this.#append(
      input.requestHash,
      input.fingerprint,
      now,
      (sequence): StoredConversationCancellationEvent => ({
        eventId: `event_${sequence}`,
        sequence,
        type: "stream.cancelled",
        occurredAt: now,
        cancellation: { runHash: input.runHash },
      }),
      input.runHash,
    );
  }

  async #append(
    requestHash: string,
    fingerprint: string,
    now: number,
    createEvent: (sequence: number) => StoredConversationEvent,
    cancellationRunHash?: string,
  ): Promise<ConversationAppendResult> {
    requireSha256(requestHash, "Conversation request hash");
    requireSha256(fingerprint, "Conversation fingerprint");
    return this.#storage.transaction(async (transaction) => {
      const storedMeta = await transaction.get(META_KEY);
      let meta: ConversationMeta;
      if (storedMeta === undefined || (isConversationMeta(storedMeta) && storedMeta.expiresAt <= now)) {
        if (storedMeta !== undefined) await clearTransaction(transaction);
        meta = initialMeta(now + this.#retentionMs);
      } else if (isConversationMeta(storedMeta)) {
        meta = { ...storedMeta, dedupeOrder: [...storedMeta.dedupeOrder] };
      } else {
        throw new ConversationStoreError(
          "conversation_state_invalid",
          "Conversation state is unavailable.",
          503,
        );
      }

      const existingDedupe = await transaction.get(dedupeKey(requestHash));
      if (existingDedupe !== undefined) {
        if (!isDedupeRecord(existingDedupe)) {
          throw new ConversationStoreError(
            "conversation_state_invalid",
            "Conversation duplicate state is unavailable.",
            503,
          );
        }
        if (existingDedupe.fingerprint !== fingerprint) {
          throw new ConversationStoreError(
            "conversation_duplicate_conflict",
            "The client message identifier was already used for different content.",
            409,
          );
        }
        const existingEvent = await transaction.get(eventKey(existingDedupe.sequence));
        if (!isStoredEvent(existingEvent)) {
          throw new ConversationStoreError(
            "conversation_duplicate_evicted",
            "The duplicate was suppressed but its display event is outside the retained replay window.",
            409,
            { sequence: existingDedupe.sequence },
          );
        }
        return { event: existingEvent, replayed: true, expiresAt: meta.expiresAt };
      }

      if (cancellationRunHash && meta.cancellation?.runHash === cancellationRunHash) {
        const existingEvent = await transaction.get(eventKey(meta.cancellation.sequence));
        if (isStoredEvent(existingEvent)) {
          await transaction.put(dedupeKey(requestHash), {
            sequence: meta.cancellation.sequence,
            fingerprint,
          });
          meta.dedupeOrder.push(requestHash);
          while (meta.dedupeOrder.length > MAX_CONVERSATION_DEDUPE_RECORDS) {
            const evictedHash = meta.dedupeOrder.shift();
            if (evictedHash) await transaction.delete(dedupeKey(evictedHash));
          }
          await transaction.put(META_KEY, meta);
          return { event: existingEvent, replayed: true, expiresAt: meta.expiresAt };
        }
        throw new ConversationStoreError(
          "conversation_duplicate_evicted",
          "The cancellation was already accepted outside the retained replay window.",
          409,
          { sequence: meta.cancellation.sequence },
        );
      }

      if (meta.lastSequence >= Number.MAX_SAFE_INTEGER) {
        throw new ConversationStoreError(
          "conversation_sequence_exhausted",
          "Conversation sequence is unavailable.",
          503,
        );
      }
      const sequence = meta.lastSequence + 1;
      const event = createEvent(sequence);
      const size = eventSize(event);
      await transaction.put(eventKey(sequence), event);
      await transaction.put(dedupeKey(requestHash), { sequence, fingerprint });

      meta.lastSequence = sequence;
      meta.eventCount += 1;
      meta.eventBytes += size;
      meta.expiresAt = now + this.#retentionMs;
      meta.dedupeOrder.push(requestHash);
      if (event.type === "stream.cancelled") {
        meta.cancellation = {
          runHash: event.cancellation.runHash,
          sequence,
          requestedAt: now,
        };
      }

      while (meta.dedupeOrder.length > MAX_CONVERSATION_DEDUPE_RECORDS) {
        const evictedHash = meta.dedupeOrder.shift();
        if (evictedHash) await transaction.delete(dedupeKey(evictedHash));
      }

      while (
        meta.eventCount > MAX_CONVERSATION_EVENTS ||
        meta.eventBytes > MAX_CONVERSATION_EVENT_BYTES
      ) {
        const oldestKey = eventKey(meta.earliestSequence);
        const oldest = await transaction.get(oldestKey);
        if (!isStoredEvent(oldest)) {
          throw new ConversationStoreError(
            "conversation_state_invalid",
            "Conversation replay state is unavailable.",
            503,
          );
        }
        meta.earliestSequence += 1;
        await transaction.delete(oldestKey);
        meta.eventCount -= 1;
        meta.eventBytes = Math.max(0, meta.eventBytes - eventSize(oldest));
      }

      await transaction.put(META_KEY, meta);
      await transaction.setAlarm(meta.expiresAt);
      return { event, replayed: false, expiresAt: meta.expiresAt };
    });
  }

  async readEvents(
    after: number,
    limit: number,
    now: number,
  ): Promise<ConversationReplay> {
    const meta = await requireMeta(this.#storage);
    if (!meta) {
      return {
        events: [],
        cursor: 0,
        earliestCursor: 0,
        hasMore: false,
        expiresAt: null,
        cancellation: null,
      };
    }
    if (meta.expiresAt <= now) {
      await this.delete();
      throw new ConversationStoreError(
        "conversation_expired",
        "Conversation transcript expired and was deleted.",
        410,
      );
    }
    if (after > meta.lastSequence) {
      throw new ConversationStoreError(
        "conversation_cursor_invalid",
        "Conversation cursor is ahead of retained state.",
        400,
        { cursor: meta.lastSequence },
      );
    }
    if (meta.eventCount > 0 && after < meta.earliestSequence - 1) {
      throw new ConversationStoreError(
        "conversation_cursor_evicted",
        "Conversation cursor is older than the retained replay window.",
        409,
        { earliestCursor: meta.earliestSequence - 1 },
      );
    }

    const startSequence = Math.max(after + 1, meta.earliestSequence);
    const rows = await this.#storage.list<StoredConversationEvent>({
      prefix: EVENT_PREFIX,
      start: eventKey(startSequence),
      limit: limit + 1,
    });
    const events = [...rows.values()].filter(isStoredEvent);
    const hasMore = events.length > limit;
    const selected = events.slice(0, limit);
    const cursor = selected.at(-1)?.sequence ?? after;
    return {
      events: selected,
      cursor,
      earliestCursor: meta.eventCount > 0 ? meta.earliestSequence - 1 : meta.lastSequence,
      hasMore,
      expiresAt: meta.expiresAt,
      cancellation: meta.cancellation,
    };
  }

  async delete(): Promise<void> {
    await this.#storage.transaction(async (transaction) => {
      await clearTransaction(transaction);
      await transaction.deleteAlarm();
    });
  }

  async expire(now: number): Promise<boolean> {
    return this.#storage.transaction(async (transaction) => {
      const storedMeta = await transaction.get(META_KEY);
      if (storedMeta === undefined) {
        await transaction.deleteAlarm();
        return true;
      }
      if (!isConversationMeta(storedMeta)) {
        await clearTransaction(transaction);
        await transaction.deleteAlarm();
        return true;
      }
      if (storedMeta.expiresAt > now) {
        await transaction.setAlarm(storedMeta.expiresAt);
        return false;
      }
      await clearTransaction(transaction);
      await transaction.deleteAlarm();
      return true;
    });
  }
}
