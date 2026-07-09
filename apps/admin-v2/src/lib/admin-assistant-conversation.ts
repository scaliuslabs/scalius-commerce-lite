const CONVERSATION_PROTOCOL_VERSION = "2026-07-10";
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_OPAQUE_ID_CHARS = 160;
const MAX_REPLAY_LIMIT = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const RANDOM_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const ADMIN_CONVERSATION_TRANSPORT = Object.freeze({
  polling: true as const,
  webSocket: false as const,
});

export type AdminConversationRole = "user" | "assistant";
export type AdminConversationContextMarker = "admin:page" | "admin:sensitive";

export interface AdminConversationMessage {
  id: string;
  role: AdminConversationRole;
  content: string;
  contextMarker: AdminConversationContextMarker;
  createdAt: number;
}

export interface AdminConversationMessageEvent {
  eventId: string;
  sequence: number;
  type: "message.appended";
  occurredAt: number;
  message: AdminConversationMessage;
}

export interface AdminConversationCancellationEvent {
  eventId: string;
  sequence: number;
  type: "stream.cancelled";
  occurredAt: number;
  cancellation: { runHash: string };
}

export type AdminConversationEvent =
  | AdminConversationMessageEvent
  | AdminConversationCancellationEvent;

export interface AdminConversationCancellationState {
  runHash: string;
  sequence: number;
  requestedAt: number;
}

export interface AdminConversationReplay {
  events: AdminConversationEvent[];
  cursor: number;
  earliestCursor: number;
  hasMore: boolean;
  expiresAt: number | null;
  cancellation: AdminConversationCancellationState | null;
}

export interface AppendAdminConversationMessageInput {
  clientMessageId: string;
  role: AdminConversationRole;
  content: string;
  contextMarker: AdminConversationContextMarker;
}

export interface CancelAdminConversationRunInput {
  clientRequestId: string;
  runId: string;
}

export interface AdminConversationMutationResult {
  replayed: boolean;
  event: AdminConversationEvent;
  expiresAt: number;
}

export interface PollAdminConversationEventsOptions {
  conversationId: string;
  after?: number;
  limit?: number;
  intervalMs?: number;
  signal: AbortSignal;
  onEvents: (
    events: readonly AdminConversationEvent[],
    replay: AdminConversationReplay,
  ) => void | Promise<void>;
}

export class AdminConversationTransportError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AdminConversationTransportError";
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

export function createAdminConversationId(): string {
  return `conv_${randomBase64Url(16)}`;
}

export function createAdminConversationRequestId(
  purpose: "message" | "cancel" | "run" = "message",
): string {
  return `${purpose}_${randomBase64Url(16)}`;
}

export function isAdminConversationId(value: string): boolean {
  return CONVERSATION_ID_PATTERN.test(value);
}

function requireConversationId(value: string): void {
  if (!isAdminConversationId(value)) {
    throw new AdminConversationTransportError(
      "conversation_id_invalid",
      "Conversation identifier is invalid.",
      400,
    );
  }
}

function requireOpaqueId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_OPAQUE_ID_CHARS) {
    throw new AdminConversationTransportError(
      "conversation_request_invalid",
      `${label} is invalid.`,
      400,
    );
  }
  return normalized;
}

function requireCursor(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AdminConversationTransportError(
      "conversation_cursor_invalid",
      `${label} must be a non-negative safe integer.`,
      400,
    );
  }
  return value;
}

function requireReplayLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REPLAY_LIMIT) {
    throw new AdminConversationTransportError(
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

function isAdminContextMarker(
  value: unknown,
): value is AdminConversationContextMarker {
  return value === "admin:page" || value === "admin:sensitive";
}

function parseEvent(value: unknown): AdminConversationEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.eventId !== "string" ||
    !isSafeTimestamp(value.sequence) ||
    !isSafeTimestamp(value.occurredAt)
  ) {
    return null;
  }

  if (value.type === "message.appended") {
    const message = value.message;
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.length > MAX_MESSAGE_CHARS ||
      !isAdminContextMarker(message.contextMarker) ||
      !isSafeTimestamp(message.createdAt)
    ) {
      return null;
    }
    return {
      eventId: value.eventId,
      sequence: value.sequence,
      type: value.type,
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

  if (value.type === "stream.cancelled") {
    const cancellation = value.cancellation;
    if (
      !isRecord(cancellation) ||
      typeof cancellation.runHash !== "string" ||
      !SHA256_HEX_PATTERN.test(cancellation.runHash)
    ) {
      return null;
    }
    return {
      eventId: value.eventId,
      sequence: value.sequence,
      type: value.type,
      occurredAt: value.occurredAt,
      cancellation: { runHash: cancellation.runHash },
    };
  }

  return null;
}

function parseCancellationState(
  value: unknown,
): AdminConversationCancellationState | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.runHash !== "string" ||
    !SHA256_HEX_PATTERN.test(value.runHash) ||
    !isSafeTimestamp(value.sequence) ||
    !isSafeTimestamp(value.requestedAt)
  ) {
    return undefined;
  }
  return {
    runHash: value.runHash,
    sequence: value.sequence,
    requestedAt: value.requestedAt,
  };
}

function hasValidEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    value.success === true &&
    value.protocolVersion === CONVERSATION_PROTOCOL_VERSION &&
    value.surface === "admin";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new AdminConversationTransportError(
      "conversation_response_invalid",
      "Assistant conversation response was empty.",
      502,
    );
  }

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
        throw new AdminConversationTransportError(
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
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AdminConversationTransportError(
      "conversation_response_invalid",
      "Assistant conversation response was invalid.",
      502,
    );
  }
}

function serverError(payload: unknown, status: number): AdminConversationTransportError {
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
      return new AdminConversationTransportError(code, message, status);
    }
  }
  return new AdminConversationTransportError(
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
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AdminConversationTransportError(
      "conversation_network_failed",
      "Assistant conversation request could not be completed.",
      0,
    );
  }

  const payload = await readBoundedJson(response);
  if (!response.ok) throw serverError(payload, response.status);
  return payload;
}

function conversationPath(conversationId: string, subpath?: string): string {
  requireConversationId(conversationId);
  return `/api/assistant/conversations/${conversationId}${
    subpath ? `/${subpath}` : ""
  }`;
}

export async function appendAdminConversationMessage(
  conversationId: string,
  input: AppendAdminConversationMessageInput,
  signal?: AbortSignal,
): Promise<AdminConversationMutationResult> {
  const clientMessageId = requireOpaqueId(input.clientMessageId, "Client message identifier");
  if (input.role !== "user" && input.role !== "assistant") {
    throw new AdminConversationTransportError(
      "conversation_role_invalid",
      "Conversation role is invalid.",
      400,
    );
  }
  if (
    typeof input.content !== "string" ||
    input.content.length < 1 ||
    input.content.length > MAX_MESSAGE_CHARS
  ) {
    throw new AdminConversationTransportError(
      "conversation_message_invalid",
      "Conversation message is invalid.",
      400,
    );
  }
  if (!isAdminContextMarker(input.contextMarker)) {
    throw new AdminConversationTransportError(
      "conversation_context_invalid",
      "Conversation context marker is invalid.",
      400,
    );
  }

  const payload = await requestConversation(
    conversationPath(conversationId, "messages"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientMessageId,
        role: input.role,
        content: input.content,
        contextMarker: input.contextMarker,
      }),
    },
    signal,
  );
  return parseMutationResult(payload, "message.appended");
}

export async function cancelAdminConversationRun(
  conversationId: string,
  input: CancelAdminConversationRunInput,
  signal?: AbortSignal,
): Promise<AdminConversationMutationResult> {
  const payload = await requestConversation(
    conversationPath(conversationId, "cancel"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientRequestId: requireOpaqueId(
          input.clientRequestId,
          "Client request identifier",
        ),
        runId: requireOpaqueId(input.runId, "Run identifier"),
      }),
    },
    signal,
  );
  return parseMutationResult(payload, "stream.cancelled");
}

function parseMutationResult(
  payload: unknown,
  expectedType: AdminConversationEvent["type"],
): AdminConversationMutationResult {
  if (!hasValidEnvelope(payload)) return invalidResponse();
  const event = parseEvent(payload.event);
  if (
    !event ||
    event.type !== expectedType ||
    typeof payload.replayed !== "boolean" ||
    !isSafeTimestamp(payload.expiresAt)
  ) {
    return invalidResponse();
  }
  return { replayed: payload.replayed, event, expiresAt: payload.expiresAt };
}

export async function readAdminConversationEvents(
  conversationId: string,
  options: { after?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<AdminConversationReplay> {
  const after = requireCursor(options.after ?? 0, "Conversation cursor");
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
  if (!Array.isArray(conversation.events)) return invalidResponse();
  const events = conversation.events.map(parseEvent);
  const cancellation = parseCancellationState(conversation.cancellation);
  if (
    events.some((event) => event === null) ||
    !isSafeTimestamp(conversation.cursor) ||
    !isSafeTimestamp(conversation.earliestCursor) ||
    typeof conversation.hasMore !== "boolean" ||
    (conversation.expiresAt !== null && !isSafeTimestamp(conversation.expiresAt)) ||
    cancellation === undefined
  ) {
    return invalidResponse();
  }

  return {
    events: events as AdminConversationEvent[],
    cursor: conversation.cursor,
    earliestCursor: conversation.earliestCursor,
    hasMore: conversation.hasMore,
    expiresAt: conversation.expiresAt,
    cancellation,
  };
}

export async function deleteAdminConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  const payload = await requestConversation(
    conversationPath(conversationId),
    { method: "DELETE" },
    signal,
  );
  if (!hasValidEnvelope(payload) || payload.deleted !== true) invalidResponse();
}

function invalidResponse(): never {
  throw new AdminConversationTransportError(
    "conversation_response_invalid",
    "Assistant conversation response was invalid.",
    502,
  );
}

function clampedPollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
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

export async function pollAdminConversationEvents(
  options: PollAdminConversationEventsOptions,
): Promise<number> {
  requireConversationId(options.conversationId);
  let cursor = requireCursor(options.after ?? 0, "Conversation cursor");
  const limit = requireReplayLimit(options.limit ?? 50);
  const intervalMs = clampedPollInterval(options.intervalMs);

  while (!options.signal.aborted) {
    let replay: AdminConversationReplay;
    try {
      replay = await readAdminConversationEvents(options.conversationId, {
        after: cursor,
        limit,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) break;
      throw error;
    }

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
