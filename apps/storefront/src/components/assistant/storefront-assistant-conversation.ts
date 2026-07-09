const CONVERSATION_PROTOCOL_VERSION = "2026-07-10";
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_OPAQUE_ID_CHARS = 160;
const MAX_REPLAY_LIMIT = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 10_000;
const RANDOM_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const STOREFRONT_CONVERSATION_TRANSPORT = Object.freeze({
  polling: true as const,
  webSocket: false as const,
});

export const STOREFRONT_CONVERSATION_CONTEXT_MARKERS = [
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

export type StorefrontConversationContextMarker =
  (typeof STOREFRONT_CONVERSATION_CONTEXT_MARKERS)[number];
export type StorefrontConversationRole = "user" | "assistant";

export interface StorefrontConversationMessage {
  id: string;
  role: StorefrontConversationRole;
  content: string;
  contextMarker: StorefrontConversationContextMarker;
  createdAt: number;
}

export interface StorefrontConversationMessageEvent {
  eventId: string;
  sequence: number;
  type: "message.appended";
  occurredAt: number;
  message: StorefrontConversationMessage;
}

export interface StorefrontConversationReplay {
  events: StorefrontConversationMessageEvent[];
  cursor: number;
  earliestCursor: number;
  hasMore: boolean;
  expiresAt: number | null;
}

export interface AppendStorefrontConversationMessageInput {
  clientMessageId: string;
  role: "user";
  content: string;
  contextMarker: StorefrontConversationContextMarker;
}

export interface PollStorefrontConversationEventsOptions {
  conversationId: string;
  after?: number;
  limit?: number;
  intervalMs?: number;
  signal: AbortSignal;
  onEvents: (
    events: readonly StorefrontConversationMessageEvent[],
    replay: StorefrontConversationReplay,
  ) => void | Promise<void>;
}

export class StorefrontConversationTransportError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "StorefrontConversationTransportError";
    this.code = code;
    this.status = status;
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
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
  if (bits > 0) result += RANDOM_ALPHABET[(accumulator << (6 - bits)) & 63];
  return result;
}

export function createStorefrontConversationId(): string {
  return `conv_${randomBase64Url(16)}`;
}

export function createStorefrontConversationRequestId(
  purpose: "message" | "run" | "chat" = "message",
): string {
  return `${purpose}_${randomBase64Url(16)}`;
}

export function isStorefrontConversationId(value: string): boolean {
  return CONVERSATION_ID_PATTERN.test(value);
}

function requireConversationId(value: string): void {
  if (!isStorefrontConversationId(value)) {
    throw new StorefrontConversationTransportError(
      "conversation_id_invalid",
      "Conversation identifier is invalid.",
      400,
    );
  }
}

function requireOpaqueId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_OPAQUE_ID_CHARS) {
    throw new StorefrontConversationTransportError(
      "conversation_request_invalid",
      "Conversation request identifier is invalid.",
      400,
    );
  }
  return normalized;
}

function requireCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorefrontConversationTransportError(
      "conversation_cursor_invalid",
      "Conversation cursor is invalid.",
      400,
    );
  }
  return value;
}

function requireReplayLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REPLAY_LIMIT) {
    throw new StorefrontConversationTransportError(
      "conversation_limit_invalid",
      `Conversation replay limit must be between 1 and ${MAX_REPLAY_LIMIT}.`,
      400,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isContextMarker(
  value: unknown,
): value is StorefrontConversationContextMarker {
  return typeof value === "string" &&
    (STOREFRONT_CONVERSATION_CONTEXT_MARKERS as readonly string[]).includes(
      value,
    );
}

export function parseStorefrontConversationMessageEvent(
  value: unknown,
): StorefrontConversationMessageEvent | null {
  if (
    !isRecord(value) ||
    value.type !== "message.appended" ||
    typeof value.eventId !== "string" ||
    !isSafeTimestamp(value.sequence) ||
    !isSafeTimestamp(value.occurredAt) ||
    !isRecord(value.message)
  ) {
    return null;
  }
  const message = value.message;
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant") ||
    typeof message.content !== "string" ||
    message.content.length < 1 ||
    message.content.length > MAX_MESSAGE_CHARS ||
    !isContextMarker(message.contextMarker) ||
    !isSafeTimestamp(message.createdAt)
  ) {
    return null;
  }
  return {
    eventId: value.eventId,
    sequence: value.sequence,
    type: "message.appended",
    occurredAt: value.occurredAt,
    message: {
      id: message.id,
      role: message.role,
      content: message.content,
      contextMarker: message.contextMarker,
      createdAt: message.createdAt,
    },
  };
}

function hasValidEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    value.success === true &&
    value.protocolVersion === CONVERSATION_PROTOCOL_VERSION &&
    value.surface === "storefront";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel("conversation response too large");
        throw new StorefrontConversationTransportError(
          "conversation_response_too_large",
          "Assistant conversation response was too large.",
          502,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalidResponse();
  }
}

function serverError(
  payload: unknown,
  status: number,
): StorefrontConversationTransportError {
  if (isRecord(payload) && isRecord(payload.error)) {
    const code = payload.error.code;
    const message = payload.error.message;
    if (
      typeof code === "string" &&
      code.length > 0 &&
      code.length <= 120 &&
      typeof message === "string" &&
      message.length > 0 &&
      message.length <= 500
    ) {
      return new StorefrontConversationTransportError(code, message, status);
    }
  }
  return new StorefrontConversationTransportError(
    "conversation_request_failed",
    "Assistant conversation request failed.",
    status,
  );
}

async function requestConversation(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
      cache: "no-store",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new StorefrontConversationTransportError(
      "conversation_network_failed",
      "Assistant conversation request could not be completed.",
      0,
    );
  }

  const payload = await readBoundedJson(response);
  if (!response.ok) throw serverError(payload, response.status);
  return payload;
}

function conversationPath(conversationId: string, subpath: string): string {
  requireConversationId(conversationId);
  return `/api/assistant/conversations/${conversationId}/${subpath}`;
}

export async function appendStorefrontConversationMessage(
  conversationId: string,
  input: AppendStorefrontConversationMessageInput,
  signal?: AbortSignal,
): Promise<StorefrontConversationMessageEvent> {
  if (
    input.role !== "user" ||
    typeof input.content !== "string" ||
    input.content.length < 1 ||
    input.content.length > MAX_MESSAGE_CHARS ||
    !isContextMarker(input.contextMarker)
  ) {
    throw new StorefrontConversationTransportError(
      "conversation_message_invalid",
      "Conversation message is invalid.",
      400,
    );
  }
  const payload = await requestConversation(
    conversationPath(conversationId, "messages"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientMessageId: requireOpaqueId(input.clientMessageId),
        role: input.role,
        content: input.content,
        contextMarker: input.contextMarker,
      }),
    },
    signal,
  );
  if (!hasValidEnvelope(payload)) return invalidResponse();
  const event = parseStorefrontConversationMessageEvent(payload.event);
  if (!event || typeof payload.replayed !== "boolean") return invalidResponse();
  return event;
}

export async function readStorefrontConversationEvents(
  conversationId: string,
  options: { after?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<StorefrontConversationReplay> {
  const after = requireCursor(options.after ?? 0);
  const limit = requireReplayLimit(options.limit ?? 50);
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  const payload = await requestConversation(
    `${conversationPath(conversationId, "events")}?${query.toString()}`,
    { method: "GET" },
    options.signal,
  );
  if (!hasValidEnvelope(payload) || !isRecord(payload.conversation)) {
    return invalidResponse();
  }
  const conversation = payload.conversation;
  if (
    !Array.isArray(conversation.events) ||
    !isSafeTimestamp(conversation.cursor) ||
    !isSafeTimestamp(conversation.earliestCursor) ||
    typeof conversation.hasMore !== "boolean" ||
    (conversation.expiresAt !== null &&
      !isSafeTimestamp(conversation.expiresAt))
  ) {
    return invalidResponse();
  }
  const events = conversation.events
    .filter(
      (event) => isRecord(event) && event.type === "message.appended",
    )
    .map(parseStorefrontConversationMessageEvent);
  if (events.some((event) => event === null)) return invalidResponse();
  return {
    events: events as StorefrontConversationMessageEvent[],
    cursor: conversation.cursor,
    earliestCursor: conversation.earliestCursor,
    hasMore: conversation.hasMore,
    expiresAt: conversation.expiresAt,
  };
}

function clampedPollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(done, milliseconds);
    function done() {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function pollStorefrontConversationEvents(
  options: PollStorefrontConversationEventsOptions,
): Promise<number> {
  requireConversationId(options.conversationId);
  let cursor = requireCursor(options.after ?? 0);
  const limit = requireReplayLimit(options.limit ?? 50);
  const intervalMs = clampedPollInterval(options.intervalMs);

  while (!options.signal.aborted) {
    const replay = await readStorefrontConversationEvents(
      options.conversationId,
      { after: cursor, limit, signal: options.signal },
    );
    const previousCursor = cursor;
    cursor = Math.max(cursor, replay.cursor);
    await options.onEvents(replay.events, replay);
    if (options.signal.aborted) break;
    if (!replay.hasMore || cursor === previousCursor) {
      await abortableDelay(intervalMs, options.signal);
    }
  }
  return cursor;
}

function invalidResponse(): never {
  throw new StorefrontConversationTransportError(
    "conversation_response_invalid",
    "Assistant conversation response was invalid.",
    502,
  );
}
