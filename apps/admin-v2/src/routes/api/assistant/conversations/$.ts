import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createFileRoute } from "@tanstack/react-router";

const PUBLIC_CONVERSATION_PREFIX = "/api/assistant/conversations/";
const ADMIN_AGENT_CONVERSATION_ORIGIN = "http://admin-agent.internal";
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/;
const MAX_REPLAY_LIMIT = 100;
const MAX_REQUEST_BYTES = 12 * 1024;
const MAX_COOKIE_BYTES = 8 * 1024;

type ConversationEndpoint =
  | { kind: "delete"; conversationId: string; targetPath: string }
  | { kind: "append" | "cancel"; conversationId: string; targetPath: string }
  | {
      kind: "replay";
      conversationId: string;
      targetPath: string;
      normalizedSearch: string;
    }
  | { kind: "stream-unavailable"; conversationId: string; targetPath: string };

const noStoreHeaders = {
  "Cache-Control": "no-store",
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers: noStoreHeaders },
  );
}

function rejectCrossOriginRequest(request: Request, url: URL): boolean {
  if (shouldRejectCrossOriginCookieRequest(request)) return true;

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

function hasForbiddenClientHeader(headers: Headers): boolean {
  for (const [name] of headers) {
    const lowerName = name.toLowerCase();
    if (
      lowerName === "authorization" ||
      lowerName === "proxy-authorization" ||
      lowerName.startsWith("x-scalius-conversation-")
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
    limit > MAX_REPLAY_LIMIT
  ) {
    return null;
  }

  const normalized = new URLSearchParams({
    after: String(after),
    limit: String(limit),
  });
  return `?${normalized.toString()}`;
}

function matchConversationEndpoint(
  request: Request,
  url: URL,
): ConversationEndpoint | null {
  if (!url.pathname.startsWith(PUBLIC_CONVERSATION_PREFIX)) return null;

  const remainder = url.pathname.slice(PUBLIC_CONVERSATION_PREFIX.length);
  const segments = remainder.split("/");
  const conversationId = segments[0] ?? "";
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;

  if (segments.length === 1 && request.method === "DELETE" && !url.search) {
    return { kind: "delete", conversationId, targetPath: remainder };
  }

  if (segments.length !== 2) return null;
  const subpath = segments[1];
  const targetPath = `${conversationId}/${subpath}`;

  if (
    request.method === "POST" &&
    (subpath === "messages" || subpath === "cancel") &&
    !url.search
  ) {
    return {
      kind: subpath === "messages" ? "append" : "cancel",
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
    return {
      kind: "replay",
      conversationId,
      targetPath,
      normalizedSearch,
    };
  }

  if (request.method === "GET" && subpath === "stream" && !url.search) {
    return { kind: "stream-unavailable", conversationId, targetPath };
  }

  return null;
}

function validateRequestBody(request: Request, endpoint: ConversationEndpoint): Response | null {
  if (endpoint.kind !== "append" && endpoint.kind !== "cancel") {
    if (request.body) {
      return jsonError(
        400,
        "CONVERSATION_BODY_FORBIDDEN",
        "This conversation request does not accept a body",
      );
    }
    return null;
  }

  const contentType = request.headers.get("Content-Type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return jsonError(
      415,
      "CONVERSATION_CONTENT_TYPE_INVALID",
      "Conversation writes require application/json",
    );
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) {
      return jsonError(
        400,
        "CONVERSATION_CONTENT_LENGTH_INVALID",
        "Conversation content length is invalid",
      );
    }
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_REQUEST_BYTES) {
      return jsonError(
        413,
        "CONVERSATION_BODY_TOO_LARGE",
        "Conversation request body is too large",
      );
    }
  }

  return null;
}

function createAgentHeaders(cookie: string, includeContentType: boolean): Headers {
  const headers = new Headers({ Accept: "application/json" });
  headers.set("Cookie", cookie);
  if (includeContentType) headers.set("Content-Type", "application/json");
  return headers;
}

function sanitizedAgentResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function proxyToAdminConversation(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return jsonError(400, "CONVERSATION_REQUEST_INVALID", "Invalid conversation request");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return jsonError(400, "CONVERSATION_REQUEST_INVALID", "Invalid conversation request");
  }

  if (rejectCrossOriginRequest(request, url)) {
    return jsonError(
      403,
      "CROSS_ORIGIN_CONVERSATION_REQUEST",
      "Cross-origin conversation request denied",
    );
  }

  if (hasForbiddenClientHeader(request.headers)) {
    return jsonError(
      400,
      "CONVERSATION_HEADER_FORBIDDEN",
      "Conversation request contains a forbidden header",
    );
  }

  const cookie = request.headers.get("Cookie")?.trim() ?? "";
  if (!cookie) {
    return jsonError(
      401,
      "CONVERSATION_SESSION_REQUIRED",
      "Dashboard session is required",
    );
  }
  if (new TextEncoder().encode(cookie).byteLength > MAX_COOKIE_BYTES) {
    return jsonError(
      431,
      "CONVERSATION_COOKIE_TOO_LARGE",
      "Dashboard session header is too large",
    );
  }

  const endpoint = matchConversationEndpoint(request, url);
  if (!endpoint) {
    return jsonError(
      404,
      "CONVERSATION_ROUTE_NOT_FOUND",
      "Conversation endpoint not found",
    );
  }

  if (endpoint.kind === "stream-unavailable") {
    return jsonError(
      501,
      "CONVERSATION_STREAM_UNAVAILABLE",
      "WebSocket conversation transport is unavailable; use event polling",
    );
  }

  const bodyError = validateRequestBody(request, endpoint);
  if (bodyError) return bodyError;

  const { env } = await import("cloudflare:workers");
  const agent = env.ADMIN_AGENT;
  if (!agent) {
    return jsonError(
      503,
      "AGENT_BINDING_UNAVAILABLE",
      "Assistant service is unavailable",
    );
  }

  const search = endpoint.kind === "replay" ? endpoint.normalizedSearch : "";
  const target = `${ADMIN_AGENT_CONVERSATION_ORIGIN}/internal/conversations/${endpoint.targetPath}${search}`;
  const isWrite = endpoint.kind === "append" || endpoint.kind === "cancel";
  const init: RequestInit = {
    method: request.method,
    headers: createAgentHeaders(cookie, isWrite),
    redirect: "manual",
  };

  if (isWrite) {
    init.body = request.body;
    // @ts-expect-error -- Cloudflare Workers service bindings accept streamed bodies.
    init.duplex = "half";
  }

  try {
    return sanitizedAgentResponse(await agent.fetch(target, init));
  } catch {
    return jsonError(
      502,
      "AGENT_CONVERSATION_PROXY_FAILED",
      "Assistant conversation request failed",
    );
  }
}

export const Route = createFileRoute("/api/assistant/conversations/$")({
  server: {
    handlers: {
      GET: async ({ request }) => proxyToAdminConversation(request),
      POST: async ({ request }) => proxyToAdminConversation(request),
      DELETE: async ({ request }) => proxyToAdminConversation(request),
    },
  },
});
