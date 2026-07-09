export const STOREFRONT_CONVERSATION_PROTOCOL_VERSION = "2026-07-10";
export const STOREFRONT_CONVERSATION_PUBLIC_PREFIX =
  "/api/assistant/conversations/";
export const STOREFRONT_AGENT_CONVERSATION_ORIGIN =
  "http://storefront-agent.internal";
export const STOREFRONT_ASSISTANT_API_ORIGIN = "http://api.internal";
export const STOREFRONT_ASSISTANT_AUDIENCE =
  "scalius-storefront-browser-v1";
export const STOREFRONT_ASSISTANT_COOKIE_NAME =
  "scalius_storefront_assistant";
export const STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX =
  "/api/assistant/conversations/";
export const STOREFRONT_ASSISTANT_AUTHORITY_PATHS = Object.freeze({
  create: "/api/v1/internal/storefront-assistant/session/create",
  resolve: "/api/v1/internal/storefront-assistant/session/resolve",
  revoke: "/api/v1/internal/storefront-assistant/session/revoke",
} as const);

export const STOREFRONT_CONVERSATION_ID_PATTERN =
  /^conv_[A-Za-z0-9_-]{22,64}$/;
export const STOREFRONT_SUBJECT_PATTERN =
  /^storefront_subject_[A-Za-z0-9_-]{43}$/;
export const STOREFRONT_CREDENTIAL_PATTERN =
  /^session_asst_[A-Za-z0-9_-]{43}$/;

export const STOREFRONT_CONVERSATION_MAX_REQUEST_BYTES = 12 * 1024;
export const STOREFRONT_CHAT_MAX_REQUEST_BYTES = 32 * 1024;
export const STOREFRONT_CONVERSATION_MAX_RESPONSE_BYTES = 1024 * 1024;
export const STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES = 16 * 1024;
export const STOREFRONT_CONVERSATION_MAX_COOKIE_BYTES = 8 * 1024;
export const STOREFRONT_CONVERSATION_MAX_REPLAY_LIMIT = 100;

const STOREFRONT_CONTEXT_MARKERS = new Set([
  "storefront:home",
  "storefront:product",
  "storefront:category",
  "storefront:collection",
  "storefront:search",
  "storefront:cart",
  "storefront:page",
  "storefront:unknown",
  "storefront:sensitive",
]);
const OPAQUE_ID_MAX_CHARS = 160;
const MESSAGE_MAX_CHARS = 8_000;

export type StorefrontConversationEndpoint =
  | {
      kind: "session-revoke";
      conversationId: string;
      targetPath: string;
    }
  | { kind: "delete"; conversationId: string; targetPath: string }
  | {
      kind: "append" | "cancel";
      conversationId: string;
      targetPath: string;
    }
  | {
      kind: "chat";
      conversationId: string;
      targetPath: string;
    }
  | {
      kind: "replay";
      conversationId: string;
      targetPath: string;
      normalizedSearch: string;
    }
  | {
      kind: "stream-unavailable";
      conversationId: string;
      targetPath: string;
    };

export interface StorefrontAuthorityIdentity {
  subject: string;
  audience: typeof STOREFRONT_ASSISTANT_AUDIENCE;
  conversationId: string;
  expiresAt: number;
}

export class StorefrontConversationFacadeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StorefrontConversationFacadeError";
    this.status = status;
    this.code = code;
  }
}

export function facadeJsonError(
  status: number,
  code: string,
  message: string,
  setCookie?: string,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(JSON.stringify({
    success: false,
    error: { code, message },
  }), { status, headers });
}

export function rejectCrossOriginConversationRequest(
  request: Request,
  url: URL,
): boolean {
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      const submittedOrigin = new URL(origin);
      if (
        submittedOrigin.protocol !== "http:" &&
        submittedOrigin.protocol !== "https:"
      ) {
        return true;
      }
      if (submittedOrigin.origin !== url.origin) return true;
    } catch {
      return true;
    }
  }

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite !== null && fetchSite.toLowerCase() !== "same-origin";
}

export function hasForbiddenConversationClientHeader(
  headers: Headers,
): boolean {
  // Cloudflare can surface hop-by-hop Connection/Upgrade headers on the
  // inbound Request. They are safe here because the facade always constructs
  // a fresh outbound header allowlist instead of forwarding browser headers.
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "proxy-authorization" ||
      normalized === "x-scalius-assistant-session-credential" ||
      normalized === "x-scalius-storefront-client-ip" ||
      normalized.startsWith("x-scalius-conversation-")
    ) {
      return true;
    }
  }
  return false;
}

function parseReplaySearch(url: URL): string | null {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") return null;
  }
  const afterValues = url.searchParams.getAll("after");
  const limitValues = url.searchParams.getAll("limit");
  if (afterValues.length > 1 || limitValues.length > 1) return null;
  const afterText = afterValues[0] ?? "0";
  const limitText = limitValues[0] ?? "50";
  if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) return null;
  const after = Number(afterText);
  const limit = Number(limitText);
  if (
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(limit) ||
    after < 0 ||
    limit < 1 ||
    limit > STOREFRONT_CONVERSATION_MAX_REPLAY_LIMIT
  ) {
    return null;
  }
  return `?${new URLSearchParams({
    after: String(after),
    limit: String(limit),
  }).toString()}`;
}

export function matchStorefrontConversationEndpoint(
  request: Request,
  url: URL,
): StorefrontConversationEndpoint | null {
  if (!url.pathname.startsWith(STOREFRONT_CONVERSATION_PUBLIC_PREFIX)) {
    return null;
  }
  const remainder = url.pathname.slice(
    STOREFRONT_CONVERSATION_PUBLIC_PREFIX.length,
  );
  const segments = remainder.split("/");
  const conversationId = segments[0] ?? "";
  if (!STOREFRONT_CONVERSATION_ID_PATTERN.test(conversationId)) return null;

  if (segments.length === 1 && request.method === "DELETE" && !url.search) {
    return { kind: "delete", conversationId, targetPath: remainder };
  }
  if (segments.length !== 2) return null;
  const subpath = segments[1];
  const targetPath = `${conversationId}/${subpath}`;

  if (request.method === "DELETE" && subpath === "session" && !url.search) {
    return { kind: "session-revoke", conversationId, targetPath };
  }

  if (
    request.method === "POST" &&
    (subpath === "messages" || subpath === "cancel" || subpath === "chat") &&
    !url.search
  ) {
    return {
      kind: subpath === "messages"
        ? "append"
        : subpath === "cancel"
          ? "cancel"
          : "chat",
      conversationId,
      targetPath,
    };
  }
  if (
    request.method === "GET" &&
    (subpath === "events" || subpath === "messages")
  ) {
    const normalizedSearch = parseReplaySearch(url);
    if (!normalizedSearch) return null;
    return { kind: "replay", conversationId, targetPath, normalizedSearch };
  }
  if (request.method === "GET" && subpath === "stream" && !url.search) {
    return { kind: "stream-unavailable", conversationId, targetPath };
  }
  return null;
}

export function extractStorefrontAssistantCookie(
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader) return null;
  if (
    new TextEncoder().encode(cookieHeader).byteLength >
      STOREFRONT_CONVERSATION_MAX_COOKIE_BYTES
  ) {
    throw new StorefrontConversationFacadeError(
      431,
      "CONVERSATION_COOKIE_TOO_LARGE",
      "Assistant session header is too large",
    );
  }

  const values = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    if (name !== STOREFRONT_ASSISTANT_COOKIE_NAME) return [];
    return [part.slice(separator + 1).trim()];
  });
  if (values.length === 0) return null;
  if (
    values.length !== 1 ||
    !STOREFRONT_CREDENTIAL_PATTERN.test(values[0] ?? "")
  ) {
    throw new StorefrontConversationFacadeError(
      401,
      "CONVERSATION_SESSION_INVALID",
      "Assistant session is unavailable",
    );
  }
  return `${STOREFRONT_ASSISTANT_COOKIE_NAME}=${values[0]}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expected[index]);
}

function requiredOpaqueId(value: unknown): string {
  if (typeof value !== "string") throw invalidBody();
  const normalized = value.trim();
  if (!normalized || normalized.length > OPAQUE_ID_MAX_CHARS) {
    throw invalidBody();
  }
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) throw invalidBody();
  }
  return normalized;
}

function invalidBody(): StorefrontConversationFacadeError {
  return new StorefrontConversationFacadeError(
    400,
    "CONVERSATION_BODY_INVALID",
    "Conversation request body is invalid",
  );
}

async function readBoundedRequestJson(
  request: Request,
  maxBytes = STOREFRONT_CONVERSATION_MAX_REQUEST_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new StorefrontConversationFacadeError(
      415,
      "CONVERSATION_CONTENT_TYPE_INVALID",
      "Conversation writes require application/json",
    );
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) throw invalidBody();
    const bytes = Number(contentLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > maxBytes
    ) {
      throw new StorefrontConversationFacadeError(
        413,
        "CONVERSATION_BODY_TOO_LARGE",
        "Conversation request body is too large",
      );
    }
  }
  return readBoundedJsonBody(
    request.body,
    maxBytes,
    invalidBody,
    () =>
      new StorefrontConversationFacadeError(
        413,
        "CONVERSATION_BODY_TOO_LARGE",
        "Conversation request body is too large",
      ),
  );
}

export async function canonicalConversationBody(
  request: Request,
  endpoint: StorefrontConversationEndpoint,
): Promise<string | null> {
  if (
    endpoint.kind !== "append" &&
    endpoint.kind !== "cancel" &&
    endpoint.kind !== "chat"
  ) {
    if (request.body) throw invalidBody();
    return null;
  }

  const value = await readBoundedRequestJson(
    request,
    endpoint.kind === "chat"
      ? STOREFRONT_CHAT_MAX_REQUEST_BYTES
      : STOREFRONT_CONVERSATION_MAX_REQUEST_BYTES,
  );
  if (!isRecord(value)) throw invalidBody();
  if (endpoint.kind === "chat") {
    if (
      !hasExactKeys(value, [
        "clientRequestId",
        "message",
        "history",
        "pageContext",
      ]) ||
      typeof value.message !== "string" ||
      value.message.length < 1 ||
      value.message.length > MESSAGE_MAX_CHARS ||
      !Array.isArray(value.history) ||
      !(value.pageContext === null || isRecord(value.pageContext))
    ) {
      throw invalidBody();
    }
    return JSON.stringify({
      clientRequestId: requiredOpaqueId(value.clientRequestId),
      message: value.message,
      history: value.history,
      pageContext: value.pageContext,
    });
  }
  if (endpoint.kind === "append") {
    if (
      !hasExactKeys(value, [
        "clientMessageId",
        "role",
        "content",
        "contextMarker",
      ]) ||
      value.role !== "user" ||
      typeof value.content !== "string" ||
      value.content.length < 1 ||
      value.content.length > MESSAGE_MAX_CHARS ||
      typeof value.contextMarker !== "string" ||
      !STOREFRONT_CONTEXT_MARKERS.has(value.contextMarker)
    ) {
      throw invalidBody();
    }
    return JSON.stringify({
      clientMessageId: requiredOpaqueId(value.clientMessageId),
      role: "user",
      content: value.content,
      contextMarker: value.contextMarker,
    });
  }

  if (!hasExactKeys(value, ["clientRequestId", "runId"])) {
    throw invalidBody();
  }
  return JSON.stringify({
    clientRequestId: requiredOpaqueId(value.clientRequestId),
    runId: requiredOpaqueId(value.runId),
  });
}

async function readBoundedJsonBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  errorFactory: () => Error,
  tooLargeErrorFactory: () => Error = errorFactory,
): Promise<unknown> {
  if (!body) throw errorFactory();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLargeErrorFactory();
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
    throw errorFactory();
  }
}

export async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  return readBoundedJsonBody(response.body, maxBytes, () =>
    new StorefrontConversationFacadeError(
      502,
      "CONVERSATION_RESPONSE_INVALID",
      "Assistant service returned an invalid response",
    ));
}

export function parseStorefrontAuthorityIdentity(
  payload: unknown,
  now = Date.now(),
): StorefrontAuthorityIdentity {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw invalidAuthorityResponse();
  }
  const data = payload.data;
  if (
    typeof data.subject !== "string" ||
    !STOREFRONT_SUBJECT_PATTERN.test(data.subject) ||
    data.audience !== STOREFRONT_ASSISTANT_AUDIENCE ||
    typeof data.conversationId !== "string" ||
    !STOREFRONT_CONVERSATION_ID_PATTERN.test(data.conversationId) ||
    !isRecord(data.session) ||
    data.session.status !== "active" ||
    typeof data.session.expiresAt !== "number" ||
    !Number.isSafeInteger(data.session.expiresAt) ||
    data.session.expiresAt <= now
  ) {
    throw invalidAuthorityResponse();
  }
  const serialized = JSON.stringify(payload);
  if (serialized.includes("session_asst_")) {
    throw invalidAuthorityResponse();
  }
  return {
    subject: data.subject,
    audience: STOREFRONT_ASSISTANT_AUDIENCE,
    conversationId: data.conversationId,
    expiresAt: data.session.expiresAt,
  };
}

function invalidAuthorityResponse(): StorefrontConversationFacadeError {
  return new StorefrontConversationFacadeError(
    502,
    "CONVERSATION_AUTHORITY_INVALID",
    "Assistant session authority is unavailable",
  );
}

export function requireAuthoritySetCookie(
  value: string | null,
  kind: "create" | "clear",
  conversationId: string,
): string {
  if (
    !value ||
    /[\r\n]/.test(value) ||
    !STOREFRONT_CONVERSATION_ID_PATTERN.test(conversationId)
  ) {
    throw invalidAuthorityResponse();
  }
  const escapedPath = `${STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX}${conversationId}`
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expected = kind === "create"
    ? new RegExp(
      `^${STOREFRONT_ASSISTANT_COOKIE_NAME}=session_asst_[A-Za-z0-9_-]{43}; Max-Age=28800; Path=${escapedPath}; HttpOnly; SameSite=Lax; Secure$`,
    )
    : new RegExp(
      `^${STOREFRONT_ASSISTANT_COOKIE_NAME}=; Max-Age=0; Path=${escapedPath}; HttpOnly; SameSite=Lax; Secure$`,
    );
  if (!expected.test(value)) throw invalidAuthorityResponse();
  return value;
}

export function storefrontAssistantClearCookie(
  conversationId: string,
): string {
  if (!STOREFRONT_CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw invalidAuthorityResponse();
  }
  return `${STOREFRONT_ASSISTANT_COOKIE_NAME}=; Max-Age=0; Path=${STOREFRONT_ASSISTANT_COOKIE_PATH_PREFIX}${conversationId}; HttpOnly; SameSite=Lax; Secure`;
}

export async function sanitizedAgentJsonResponse(
  response: Response,
  subject: string,
  setCookie?: string,
): Promise<Response> {
  const payload = await readBoundedResponseJson(
    response,
    STOREFRONT_CONVERSATION_MAX_RESPONSE_BYTES,
  );
  const body = JSON.stringify(payload);
  if (
    body.includes(subject) ||
    body.includes("storefront_subject_") ||
    body.includes("session_asst_")
  ) {
    throw new StorefrontConversationFacadeError(
      502,
      "CONVERSATION_IDENTITY_LEAK_BLOCKED",
      "Assistant service returned an unsafe response",
    );
  }
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(body, { status: response.status, headers });
}
