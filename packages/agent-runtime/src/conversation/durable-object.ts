import { DurableObject } from "cloudflare:workers";

import { jsonResponse } from "../http";
import {
  CONVERSATION_AUTHORIZED_UNTIL_HEADER,
  CONVERSATION_INTERNAL_ORIGIN,
  CONVERSATION_PROTOCOL_VERSION,
  MAX_CONVERSATION_REPLAY_LIMIT,
  MAX_CONVERSATION_REQUEST_BYTES,
  ConversationInputError,
  normalizeConversationCancelInput,
  normalizeConversationMessageInput,
  normalizeWebSocketResumeInput,
  type ConversationSurfacePolicy,
} from "./contracts";
import { sha256Hex } from "./crypto";
import { ConversationStore, ConversationStoreError } from "./storage";
import { durableObjectStorageAdapter } from "./storage-adapter";
import type {
  ConversationReplay,
  ConversationSocketAttachment,
  StoredConversationEvent,
} from "./types";

const SOCKET_TAG = "conversation-subscriber";
const MAX_SOCKET_MESSAGE_BYTES = 1_024;

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: Record<string, number>,
): Response {
  return jsonResponse({
    success: false,
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    error: { code, message, ...(details ? { details } : {}) },
  }, status);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) {
    throw new ConversationInputError(
      "conversation_body_required",
      "A JSON request body is required.",
    );
  }
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ConversationInputError(
      "conversation_content_type_invalid",
      "Conversation writes require application/json.",
      415,
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CONVERSATION_REQUEST_BYTES) {
        await reader.cancel("conversation request too large");
        throw new ConversationInputError(
          "conversation_body_too_large",
          "Conversation request body is too large.",
          413,
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
    throw new ConversationInputError(
      "conversation_json_invalid",
      "Conversation request body must be valid JSON.",
    );
  }
}

function parseReplayQuery(url: URL): { after: number; limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") {
      throw new ConversationInputError(
        "conversation_query_invalid",
        "Conversation replay accepts only after and limit query parameters.",
      );
    }
  }
  const afterText = url.searchParams.get("after") ?? "0";
  const limitText = url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) {
    throw new ConversationInputError(
      "conversation_query_invalid",
      "Conversation replay cursor and limit must be non-negative integers.",
    );
  }
  const after = Number(afterText);
  const limit = Number(limitText);
  if (
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_CONVERSATION_REPLAY_LIMIT
  ) {
    throw new ConversationInputError(
      "conversation_query_invalid",
      `Conversation replay limit must be between 1 and ${MAX_CONVERSATION_REPLAY_LIMIT}.`,
    );
  }
  return { after, limit };
}

function parseAuthorizedUntil(
  request: Request,
  policy: ConversationSurfacePolicy,
  now: number,
): number {
  const value = request.headers.get(CONVERSATION_AUTHORIZED_UNTIL_HEADER);
  if (!value || !/^\d+$/.test(value)) {
    throw new ConversationInputError(
      "conversation_authorization_required",
      "Conversation access requires a fresh facade authorization.",
      401,
    );
  }
  const authorizedUntil = Number(value);
  if (
    !Number.isSafeInteger(authorizedUntil) ||
    authorizedUntil <= now ||
    authorizedUntil > now + policy.connectionLeaseMs + 5_000
  ) {
    throw new ConversationInputError(
      "conversation_authorization_expired",
      "Conversation facade authorization is expired or invalid.",
      401,
    );
  }
  return authorizedUntil;
}

function replayBody(
  policy: ConversationSurfacePolicy,
  replay: ConversationReplay,
  messagesOnly = false,
): Record<string, unknown> {
  const events = messagesOnly
    ? replay.events.filter((event) => event.type === "message.appended")
    : replay.events;
  return {
    success: true,
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    surface: policy.surface,
    conversation: {
      events,
      cursor: replay.cursor,
      earliestCursor: replay.earliestCursor,
      hasMore: replay.hasMore,
      expiresAt: replay.expiresAt,
      cancellation: replay.cancellation,
    },
  };
}

function isSocketAttachment(value: unknown): value is ConversationSocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachment = value as Partial<ConversationSocketAttachment>;
  return attachment.version === 1 &&
    typeof attachment.cursor === "number" &&
    Number.isSafeInteger(attachment.cursor) &&
    typeof attachment.authorizedUntil === "number" &&
    Number.isSafeInteger(attachment.authorizedUntil);
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // A concurrently closed socket needs no further cleanup.
  }
}

export abstract class ConversationDurableObject<Env> extends DurableObject<Env> {
  readonly #policy: ConversationSurfacePolicy;
  readonly #store: ConversationStore;

  protected constructor(
    context: DurableObjectState,
    env: Env,
    policy: ConversationSurfacePolicy,
  ) {
    super(context, env);
    this.#policy = policy;
    this.#store = new ConversationStore(
      durableObjectStorageAdapter(this.ctx.storage),
      policy.retentionMs,
    );
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        url.origin !== CONVERSATION_INTERNAL_ORIGIN ||
        url.username ||
        url.password ||
        url.hash
      ) {
        return errorResponse(
          "conversation_not_found",
          "Conversation endpoint not found.",
          404,
        );
      }
      const now = Date.now();
      const authorizedUntil = parseAuthorizedUntil(request, this.#policy, now);

      if (request.method === "POST" && url.pathname === "/messages" && !url.search) {
        const input = normalizeConversationMessageInput(
          this.#policy,
          await readBoundedJson(request),
        );
        const requestHash = await sha256Hex(input.clientMessageId);
        const fingerprint = await sha256Hex(JSON.stringify({
          type: "message.appended",
          role: input.role,
          content: input.content,
          contextMarker: input.contextMarker,
        }));
        const result = await this.#store.appendMessage({
          requestHash,
          fingerprint,
          role: input.role,
          content: input.content,
          contextMarker: input.contextMarker,
        }, now);
        if (!result.replayed) this.#broadcast(result.event, now);
        return jsonResponse({
          success: true,
          protocolVersion: CONVERSATION_PROTOCOL_VERSION,
          surface: this.#policy.surface,
          replayed: result.replayed,
          event: result.event,
          expiresAt: result.expiresAt,
        }, result.replayed ? 200 : 201);
      }

      if (request.method === "POST" && url.pathname === "/cancel" && !url.search) {
        const input = normalizeConversationCancelInput(await readBoundedJson(request));
        const requestHash = await sha256Hex(input.clientRequestId);
        const runHash = await sha256Hex(input.runId);
        const fingerprint = await sha256Hex(`stream.cancelled\u0000${runHash}`);
        const result = await this.#store.cancelRun({
          requestHash,
          fingerprint,
          runHash,
        }, now);
        if (!result.replayed) this.#broadcast(result.event, now);
        return jsonResponse({
          success: true,
          protocolVersion: CONVERSATION_PROTOCOL_VERSION,
          surface: this.#policy.surface,
          replayed: result.replayed,
          event: result.event,
          expiresAt: result.expiresAt,
        }, result.replayed ? 200 : 202);
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/events" || url.pathname === "/messages")
      ) {
        const query = parseReplayQuery(url);
        const replay = await this.#store.readEvents(query.after, query.limit, now);
        return jsonResponse(
          replayBody(this.#policy, replay, url.pathname === "/messages"),
        );
      }

      if (request.method === "GET" && url.pathname === "/stream") {
        return this.#openSocket(request, url, authorizedUntil, now);
      }

      if (request.method === "DELETE" && url.pathname === "/" && !url.search) {
        await this.#store.delete();
        for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
          closeSocket(socket, 1000, "conversation_deleted");
        }
        return jsonResponse({
          success: true,
          protocolVersion: CONVERSATION_PROTOCOL_VERSION,
          surface: this.#policy.surface,
          deleted: true,
        });
      }

      return errorResponse(
        "conversation_not_found",
        "Conversation endpoint not found.",
        404,
      );
    } catch (error) {
      if (error instanceof ConversationInputError || error instanceof ConversationStoreError) {
        return errorResponse(
          error.code,
          error.message,
          error.status,
          error instanceof ConversationStoreError ? error.details : undefined,
        );
      }
      return errorResponse(
        "conversation_runtime_error",
        "Conversation runtime is temporarily unavailable.",
        503,
      );
    }
  }

  async #openSocket(
    request: Request,
    url: URL,
    authorizedUntil: number,
    now: number,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(
        "conversation_upgrade_required",
        "Conversation stream requires a WebSocket upgrade; use /events for polling.",
        426,
      );
    }
    const query = parseReplayQuery(url);
    const replay = await this.#store.readEvents(query.after, query.limit, now);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [SOCKET_TAG]);
    const attachment: ConversationSocketAttachment = {
      version: 1,
      cursor: replay.cursor,
      authorizedUntil,
    };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({
      type: "conversation.replay",
      ...replayBody(this.#policy, replay),
    }));
    return new Response(null, {
      status: 101,
      headers: { "Cache-Control": "no-store" },
      webSocket: client,
    });
  }

  #broadcast(event: StoredConversationEvent, now: number): void {
    const payload = JSON.stringify({
      type: "conversation.event",
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      surface: this.#policy.surface,
      event,
      cursor: event.sequence,
    });
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      const attachment = socket.deserializeAttachment();
      if (!isSocketAttachment(attachment) || attachment.authorizedUntil <= now) {
        closeSocket(socket, 4001, "reauthentication_required");
        continue;
      }
      try {
        socket.send(payload);
        socket.serializeAttachment({
          ...attachment,
          cursor: event.sequence,
        } satisfies ConversationSocketAttachment);
      } catch {
        closeSocket(socket, 1011, "stream_delivery_failed");
      }
    }
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const now = Date.now();
    const attachment = socket.deserializeAttachment();
    if (!isSocketAttachment(attachment) || attachment.authorizedUntil <= now) {
      closeSocket(socket, 4001, "reauthentication_required");
      return;
    }
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_SOCKET_MESSAGE_BYTES) {
      closeSocket(socket, 1008, "invalid_stream_message");
      return;
    }
    try {
      const input = normalizeWebSocketResumeInput(JSON.parse(message));
      const replay = await this.#store.readEvents(
        input.after,
        MAX_CONVERSATION_REPLAY_LIMIT,
        now,
      );
      socket.send(JSON.stringify({
        type: "conversation.replay",
        ...replayBody(this.#policy, replay),
      }));
      socket.serializeAttachment({
        ...attachment,
        cursor: replay.cursor,
      } satisfies ConversationSocketAttachment);
    } catch (error) {
      const code = error instanceof ConversationInputError || error instanceof ConversationStoreError
        ? error.code
        : "conversation_runtime_error";
      socket.send(JSON.stringify({
        type: "conversation.error",
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        code,
      }));
    }
  }

  webSocketClose(): void {
    // The runtime auto-replies to close frames on this compatibility date.
  }

  webSocketError(socket: WebSocket): void {
    closeSocket(socket, 1011, "stream_error");
  }

  async alarm(): Promise<void> {
    const expired = await this.#store.expire(Date.now());
    if (!expired) return;
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      closeSocket(socket, 1000, "conversation_expired");
    }
  }
}
