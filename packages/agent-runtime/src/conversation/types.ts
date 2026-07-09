import type {
  ConversationContextMarker,
  ConversationRole,
  ConversationSurfacePolicy,
} from "./contracts";

export const MAX_CONVERSATION_EVENTS = 200;
export const MAX_CONVERSATION_EVENT_BYTES = 384 * 1024;
export const MAX_CONVERSATION_DEDUPE_RECORDS = 320;

export interface StoredConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  contextMarker: ConversationContextMarker;
  createdAt: number;
}

export interface StoredConversationMessageEvent {
  eventId: string;
  sequence: number;
  type: "message.appended";
  occurredAt: number;
  message: StoredConversationMessage;
}

export interface StoredConversationCancellationEvent {
  eventId: string;
  sequence: number;
  type: "stream.cancelled";
  occurredAt: number;
  cancellation: {
    runHash: string;
  };
}

export type StoredConversationEvent =
  | StoredConversationMessageEvent
  | StoredConversationCancellationEvent;

export interface ConversationCancellationState {
  runHash: string;
  sequence: number;
  requestedAt: number;
}

export interface ConversationMeta {
  version: 1;
  lastSequence: number;
  earliestSequence: number;
  eventCount: number;
  eventBytes: number;
  expiresAt: number;
  cancellation: ConversationCancellationState | null;
  dedupeOrder: string[];
}

export interface ConversationReplay {
  events: StoredConversationEvent[];
  cursor: number;
  earliestCursor: number;
  hasMore: boolean;
  expiresAt: number | null;
  cancellation: ConversationCancellationState | null;
}

export interface ConversationAppendResult {
  event: StoredConversationEvent;
  replayed: boolean;
  expiresAt: number;
}

export interface ConversationDedupeRecord {
  sequence: number;
  fingerprint: string;
}

export interface ConversationStorageListOptions {
  prefix?: string;
  start?: string;
  end?: string;
  limit?: number;
}

export interface ConversationStorageReader {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options?: ConversationStorageListOptions): Promise<Map<string, T>>;
}

export interface ConversationStorageTransaction extends ConversationStorageReader {
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<unknown>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface ConversationStorage extends ConversationStorageReader {
  transaction<T>(
    closure: (transaction: ConversationStorageTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ConversationSocketAttachment {
  version: 1;
  cursor: number;
  authorizedUntil: number;
}

export interface ConversationDurableContext {
  readonly storage: ConversationStorage;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
}

export interface ConversationRuntimeOptions {
  policy: ConversationSurfacePolicy;
  now?: () => number;
}
