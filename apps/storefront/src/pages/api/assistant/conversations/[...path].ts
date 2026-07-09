import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import {
  STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
  normalizeStorefrontChatClientIp,
} from "@scalius/shared/storefront-chat-boundary";

import {
  STOREFRONT_AGENT_CONVERSATION_ORIGIN,
  STOREFRONT_ASSISTANT_API_ORIGIN,
  STOREFRONT_ASSISTANT_AUTHORITY_PATHS,
  STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
  StorefrontConversationFacadeError,
  canonicalConversationBody,
  extractStorefrontAssistantCookie,
  facadeJsonError,
  hasForbiddenConversationClientHeader,
  matchStorefrontConversationEndpoint,
  parseStorefrontAuthorityIdentity,
  readBoundedResponseJson,
  rejectCrossOriginConversationRequest,
  requireAuthoritySetCookie,
  sanitizedAgentJsonResponse,
  storefrontAssistantClearCookie,
  type StorefrontAuthorityIdentity,
  type StorefrontConversationEndpoint,
} from "@/lib/storefront-assistant-facade-contract";
import { handleStorefrontAssistantChat } from "../chat";

export const prerender = false;

type StorefrontConversationBindings = Pick<
  Env,
  "BACKEND_API" | "STOREFRONT_AGENT"
>;

interface ResolvedAuthority {
  identity: StorefrontAuthorityIdentity;
  setCookie?: string;
}

function getBindings(): StorefrontConversationBindings | null {
  try {
    const env = cfEnv as unknown as Partial<Env>;
    if (!env.BACKEND_API || !env.STOREFRONT_AGENT) return null;
    return {
      BACKEND_API: env.BACKEND_API,
      STOREFRONT_AGENT: env.STOREFRONT_AGENT,
    };
  } catch {
    return null;
  }
}

function authorityHeaders(cookie: string | null): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  if (cookie) headers.set("Cookie", cookie);
  return headers;
}

function callAuthority(
  backend: Fetcher,
  path: string,
  cookie: string | null,
  body: Record<string, unknown>,
  clientIp?: string,
): Promise<Response> {
  const headers = authorityHeaders(cookie);
  if (clientIp) {
    headers.set(STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER, clientIp);
  }
  return backend.fetch(`${STOREFRONT_ASSISTANT_API_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function readAuthorityIdentity(
  response: Response,
): Promise<StorefrontAuthorityIdentity> {
  const payload = await readBoundedResponseJson(
    response,
    STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
  );
  return parseStorefrontAuthorityIdentity(payload);
}

async function createAuthoritySession(
  backend: Fetcher,
  conversationId: string,
  clientIp: string | null,
): Promise<ResolvedAuthority> {
  if (!clientIp) {
    throw new StorefrontConversationFacadeError(
      503,
      "CONVERSATION_CLIENT_IDENTITY_UNAVAILABLE",
      "Assistant session is temporarily unavailable",
    );
  }
  const response = await callAuthority(
    backend,
    STOREFRONT_ASSISTANT_AUTHORITY_PATHS.create,
    null,
    { conversationId },
    clientIp,
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 409) {
      throw new StorefrontConversationFacadeError(
        409,
        "CONVERSATION_ID_UNAVAILABLE",
        "Assistant conversation identifier is unavailable",
      );
    }
    throw new StorefrontConversationFacadeError(
      response.status === 429 ? 429 : 503,
      response.status === 429
        ? "CONVERSATION_SESSION_RATE_LIMITED"
        : "CONVERSATION_SESSION_UNAVAILABLE",
      response.status === 429
        ? "Too many assistant sessions were requested; please try again later"
        : "Assistant session is temporarily unavailable",
    );
  }
  const identity = await readAuthorityIdentity(response);
  const setCookie = requireAuthoritySetCookie(
    response.headers.get("Set-Cookie"),
    "create",
    conversationId,
  );
  return { identity, setCookie };
}

async function resolveAuthoritySession(
  backend: Fetcher,
  cookie: string,
  conversationId: string,
): Promise<ResolvedAuthority> {
  const response = await callAuthority(
    backend,
    STOREFRONT_ASSISTANT_AUTHORITY_PATHS.resolve,
    cookie,
    { conversationId },
  );
  if (response.ok) {
    if (response.headers.has("Set-Cookie")) {
      await response.body?.cancel();
      throw new StorefrontConversationFacadeError(
        502,
        "CONVERSATION_AUTHORITY_INVALID",
        "Assistant session authority is unavailable",
      );
    }
    return { identity: await readAuthorityIdentity(response) };
  }

  await response.body?.cancel();
  if (response.status === 401) {
    throw new StorefrontConversationFacadeError(
      401,
      "CONVERSATION_SESSION_EXPIRED",
      "Assistant session is unavailable or expired",
    );
  }
  throw new StorefrontConversationFacadeError(
    503,
    "CONVERSATION_SESSION_UNAVAILABLE",
    "Assistant session is temporarily unavailable",
  );
}

async function revokeAuthoritySession(
  backend: Fetcher,
  cookie: string | null,
  conversationId: string,
): Promise<Response> {
  if (!cookie) {
    throw new StorefrontConversationFacadeError(
      401,
      "CONVERSATION_SESSION_REQUIRED",
      "Assistant session is required",
    );
  }
  const response = await callAuthority(
    backend,
    STOREFRONT_ASSISTANT_AUTHORITY_PATHS.revoke,
    cookie,
    { conversationId },
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) {
      return facadeJsonError(
        401,
        "CONVERSATION_SESSION_EXPIRED",
        "Assistant session is unavailable or expired",
        storefrontAssistantClearCookie(conversationId),
      );
    }
    throw new StorefrontConversationFacadeError(
      503,
      "CONVERSATION_SESSION_REVOKE_FAILED",
      "Assistant session could not be revoked",
    );
  }
  const payload = await readBoundedResponseJson(
    response,
    STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
  );
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).success !== true ||
    typeof (payload as Record<string, unknown>).data !== "object" ||
    (payload as { data: { revoked?: unknown } }).data?.revoked !== true
  ) {
    throw new StorefrontConversationFacadeError(
      502,
      "CONVERSATION_AUTHORITY_INVALID",
      "Assistant session authority is unavailable",
    );
  }
  const setCookie = requireAuthoritySetCookie(
    response.headers.get("Set-Cookie"),
    "clear",
    conversationId,
  );
  return new Response(JSON.stringify({ success: true, revoked: true }), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": setCookie,
    },
  });
}

function agentHeaders(
  identity: StorefrontAuthorityIdentity,
  includeContentType: boolean,
): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "X-Scalius-Conversation-Audience": identity.audience,
    "X-Scalius-Conversation-Subject": identity.subject,
  });
  if (includeContentType) headers.set("Content-Type", "application/json");
  return headers;
}

async function callAgent(
  agent: Fetcher,
  endpoint: Exclude<
    StorefrontConversationEndpoint,
    { kind: "session-revoke" | "chat" }
  >,
  identity: StorefrontAuthorityIdentity,
  canonicalBody: string | null,
): Promise<Response> {
  const search = endpoint.kind === "replay" ? endpoint.normalizedSearch : "";
  const target =
    `${STOREFRONT_AGENT_CONVERSATION_ORIGIN}/internal/conversations/${endpoint.targetPath}${search}`;
  return agent.fetch(target, {
    method: endpoint.kind === "delete"
      ? "DELETE"
      : endpoint.kind === "replay" || endpoint.kind === "stream-unavailable"
        ? "GET"
        : "POST",
    headers: agentHeaders(identity, canonicalBody !== null),
    ...(canonicalBody === null ? {} : { body: canonicalBody }),
    redirect: "manual",
  });
}

const SENSITIVE_CHAT_CONTEXT_TERMS = [
  "account",
  "auth",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chatContextMarker(canonicalBody: string): string {
  const payload = JSON.parse(canonicalBody) as Record<string, unknown>;
  const pageContext = isRecord(payload.pageContext)
    ? payload.pageContext
    : null;
  const page = pageContext && isRecord(pageContext.page)
    ? pageContext.page
    : null;
  const context = [
    page?.kind,
    page?.path,
    page?.route,
    page?.canonicalUrl,
    page?.title,
  ].filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (SENSITIVE_CHAT_CONTEXT_TERMS.some((term) => context.includes(term))) {
    return "storefront:sensitive";
  }
  const markers: Record<string, string> = {
    home: "storefront:home",
    product: "storefront:product",
    category: "storefront:category",
    collection: "storefront:collection",
    search: "storefront:search",
    cart: "storefront:cart",
    page: "storefront:page",
  };
  return typeof page?.kind === "string"
    ? markers[page.kind] ?? "storefront:unknown"
    : "storefront:unknown";
}

function chatRequest(
  request: Request,
  canonicalBody: string,
): Request {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  const clientIp = normalizeStorefrontChatClientIp(
    request.headers.get("cf-connecting-ip"),
  );
  if (clientIp) headers.set("CF-Connecting-IP", clientIp);
  return new Request(request.url, {
    method: "POST",
    headers,
    body: canonicalBody,
  });
}

function chatAssistantText(payload: unknown): string | null {
  if (!isRecord(payload) || payload.status !== "ok" || !isRecord(payload.message)) {
    return null;
  }
  const content = payload.message.content;
  return payload.message.role === "assistant" &&
      typeof content === "string" &&
      content.length > 0 &&
      content.length <= 8_000
    ? content
    : null;
}

function canonicalAssistantEvent(
  payload: unknown,
  expectedMarker: string,
): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.event)) return null;
  const event = payload.event;
  const message = isRecord(event.message) ? event.message : null;
  if (
    event.type !== "message.appended" ||
    typeof event.eventId !== "string" ||
    event.eventId.length < 1 ||
    event.eventId.length > 160 ||
    typeof event.sequence !== "number" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 0 ||
    typeof event.occurredAt !== "number" ||
    !Number.isSafeInteger(event.occurredAt) ||
    !message ||
    typeof message.id !== "string" ||
    message.id.length < 1 ||
    message.id.length > 160 ||
    message.role !== "assistant" ||
    typeof message.content !== "string" ||
    message.content.length < 1 ||
    message.content.length > 8_000 ||
    message.contextMarker !== expectedMarker ||
    typeof message.createdAt !== "number" ||
    !Number.isSafeInteger(message.createdAt)
  ) {
    return null;
  }
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: "message.appended",
    occurredAt: event.occurredAt,
    message: {
      id: message.id,
      role: "assistant",
      content: message.content,
      contextMarker: message.contextMarker,
      createdAt: message.createdAt,
    },
  };
}

async function persistChatAssistantMessage(
  agent: Fetcher,
  identity: StorefrontAuthorityIdentity,
  canonicalBody: string,
  content: string,
): Promise<Record<string, unknown> | null> {
  const input = JSON.parse(canonicalBody) as Record<string, unknown>;
  const clientRequestId = typeof input.clientRequestId === "string"
    ? input.clientRequestId
    : "";
  const contextMarker = chatContextMarker(canonicalBody);
  try {
    const response = await callAgent(
      agent,
      {
        kind: "append",
        conversationId: identity.conversationId,
        targetPath: `${identity.conversationId}/messages`,
      },
      identity,
      JSON.stringify({
        clientMessageId: `assistant_${clientRequestId}`,
        role: "assistant",
        content,
        contextMarker,
      }),
    );
    const sanitized = await sanitizedAgentJsonResponse(
      response,
      identity.subject,
    );
    if (!sanitized.ok) {
      await sanitized.body?.cancel();
      return null;
    }
    return canonicalAssistantEvent(
      await readBoundedResponseJson(
        sanitized,
        STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
      ),
      contextMarker,
    );
  } catch {
    return null;
  }
}

function relayedChatResponse(
  payload: Record<string, unknown>,
  status: number,
  setCookie: string | undefined,
  transcriptEvent: Record<string, unknown> | null,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(JSON.stringify({
    ...payload,
    transcriptPersisted: transcriptEvent !== null,
    ...(transcriptEvent ? { transcriptEvent } : {}),
  }), { status, headers });
}

async function handleConversationChat(
  request: Request,
  canonicalBody: string,
  bindings: StorefrontConversationBindings,
  authority: ResolvedAuthority,
): Promise<Response> {
  const response = await handleStorefrontAssistantChat(
    chatRequest(request, canonicalBody),
  );
  const payload = await readBoundedResponseJson(
    response,
    STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
  );
  if (!isRecord(payload)) {
    throw new StorefrontConversationFacadeError(
      502,
      "CONVERSATION_CHAT_RESPONSE_INVALID",
      "Shopping assistant returned an invalid response",
    );
  }
  const content = response.ok ? chatAssistantText(payload) : null;
  const transcriptEvent = content
    ? await persistChatAssistantMessage(
      bindings.STOREFRONT_AGENT,
      authority.identity,
      canonicalBody,
      content,
    )
    : null;
  return relayedChatResponse(
    payload,
    response.status,
    authority.setCookie,
    transcriptEvent,
  );
}

async function proxyConversation(request: Request): Promise<Response> {
  let setCookie: string | undefined;
  try {
    const url = new URL(request.url);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new StorefrontConversationFacadeError(
        400,
        "CONVERSATION_REQUEST_INVALID",
        "Invalid conversation request",
      );
    }
    if (rejectCrossOriginConversationRequest(request, url)) {
      throw new StorefrontConversationFacadeError(
        403,
        "CROSS_ORIGIN_CONVERSATION_REQUEST",
        "Cross-origin conversation request denied",
      );
    }
    if (hasForbiddenConversationClientHeader(request.headers)) {
      throw new StorefrontConversationFacadeError(
        400,
        "CONVERSATION_HEADER_FORBIDDEN",
        "Conversation request contains a forbidden header",
      );
    }

    const endpoint = matchStorefrontConversationEndpoint(request, url);
    if (!endpoint) {
      throw new StorefrontConversationFacadeError(
        404,
        "CONVERSATION_ROUTE_NOT_FOUND",
        "Conversation endpoint not found",
      );
    }
    if (endpoint.kind === "stream-unavailable") {
      throw new StorefrontConversationFacadeError(
        501,
        "CONVERSATION_STREAM_UNAVAILABLE",
        "WebSocket conversation transport is unavailable; use event polling",
      );
    }

    const canonicalBody = await canonicalConversationBody(request, endpoint);
    const bindings = getBindings();
    if (!bindings) {
      throw new StorefrontConversationFacadeError(
        503,
        "CONVERSATION_BINDING_UNAVAILABLE",
        "Assistant service is unavailable",
      );
    }
    const cookie = extractStorefrontAssistantCookie(
      request.headers.get("Cookie"),
    );
    if (endpoint.kind === "session-revoke") {
      return revokeAuthoritySession(
        bindings.BACKEND_API,
        cookie,
        endpoint.conversationId,
      );
    }

    if (
      !cookie &&
      (endpoint.kind === "delete" || endpoint.kind === "cancel")
    ) {
      throw new StorefrontConversationFacadeError(
        401,
        "CONVERSATION_SESSION_REQUIRED",
        "An active assistant session is required for this operation",
      );
    }
    let authority: ResolvedAuthority;
    try {
      authority = cookie
        ? await resolveAuthoritySession(
          bindings.BACKEND_API,
          cookie,
          endpoint.conversationId,
        )
        : await createAuthoritySession(
          bindings.BACKEND_API,
          endpoint.conversationId,
          normalizeStorefrontChatClientIp(
            request.headers.get("cf-connecting-ip"),
          ),
        );
    } catch (error) {
      if (
        cookie &&
        error instanceof StorefrontConversationFacadeError &&
        error.status === 401
      ) {
        setCookie = storefrontAssistantClearCookie(endpoint.conversationId);
      }
      throw error;
    }
    setCookie = authority.setCookie;
    if (authority.identity.conversationId !== endpoint.conversationId) {
      throw new StorefrontConversationFacadeError(
        403,
        "CONVERSATION_SESSION_MISMATCH",
        "Assistant session does not own this conversation",
      );
    }
    if (endpoint.kind === "chat") {
      if (!canonicalBody) {
        throw new StorefrontConversationFacadeError(
          400,
          "CONVERSATION_BODY_INVALID",
          "Conversation request body is invalid",
        );
      }
      return handleConversationChat(
        request,
        canonicalBody,
        bindings,
        authority,
      );
    }
    const agentResponse = await callAgent(
      bindings.STOREFRONT_AGENT,
      endpoint,
      authority.identity,
      canonicalBody,
    );
    return await sanitizedAgentJsonResponse(
      agentResponse,
      authority.identity.subject,
      setCookie,
    );
  } catch (error) {
    if (error instanceof StorefrontConversationFacadeError) {
      return facadeJsonError(
        error.status,
        error.code,
        error.message,
        setCookie,
      );
    }
    return facadeJsonError(
      502,
      "CONVERSATION_PROXY_FAILED",
      "Assistant conversation request failed",
      setCookie,
    );
  }
}

export const GET: APIRoute = async ({ request }) => proxyConversation(request);
export const POST: APIRoute = async ({ request }) => proxyConversation(request);
export const DELETE: APIRoute = async ({ request }) => proxyConversation(request);

export { proxyConversation as proxyToStorefrontConversation };
