import { jsonResponse } from "../http";
import {
  CONVERSATION_AUTHORIZED_UNTIL_HEADER,
  CONVERSATION_INTERNAL_ORIGIN,
  CONVERSATION_INTERNAL_PREFIX,
  isConversationId,
  type ConversationSurfacePolicy,
} from "./contracts";
import { conversationObjectName } from "./crypto";

export interface ConversationObjectStub {
  fetch(input: Request): Promise<Response>;
}

export interface ConversationObjectNamespace {
  getByName(name: string): ConversationObjectStub;
}

export interface MatchedConversationRoute {
  conversationId: string;
  objectPath: string;
}

function exactOrigin(url: URL, origin: string): boolean {
  return url.origin === origin &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "";
}

export function matchInternalConversationRoute(
  request: Request,
  expectedOrigin: string,
): MatchedConversationRoute | null {
  const url = new URL(request.url);
  if (!exactOrigin(url, expectedOrigin)) return null;
  const prefix = `${CONVERSATION_INTERNAL_PREFIX}/`;
  if (!url.pathname.startsWith(prefix)) return null;

  const remainder = url.pathname.slice(prefix.length);
  const slash = remainder.indexOf("/");
  const conversationId = slash === -1 ? remainder : remainder.slice(0, slash);
  if (!isConversationId(conversationId)) return null;

  const objectPath = slash === -1 ? "/" : remainder.slice(slash);
  if (!objectPath.startsWith("/") || objectPath.includes("//")) return null;
  return { conversationId, objectPath };
}

function sanitizedObjectRequest(
  request: Request,
  route: MatchedConversationRoute,
  authorizedUntil: number,
): Request {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(route.objectPath, CONVERSATION_INTERNAL_ORIGIN);
  targetUrl.search = sourceUrl.search;

  const headers = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const upgrade = request.headers.get("Upgrade");
  if (upgrade) headers.set("Upgrade", upgrade);
  headers.set(CONVERSATION_AUTHORIZED_UNTIL_HEADER, String(authorizedUntil));

  return new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body,
    redirect: "manual",
  });
}

export async function proxyInternalConversationRequest(input: {
  request: Request;
  route: MatchedConversationRoute;
  namespace: ConversationObjectNamespace | undefined;
  policy: ConversationSurfacePolicy;
  subject: string;
  now?: number;
}): Promise<Response> {
  if (!input.namespace) {
    return jsonResponse({
      success: false,
      error: {
        code: "conversation_runtime_unavailable",
        message: "Conversation runtime is temporarily unavailable.",
      },
    }, 503);
  }

  const now = input.now ?? Date.now();
  const objectName = await conversationObjectName(
    input.policy.audience,
    input.subject,
    input.route.conversationId,
  );
  const stub = input.namespace.getByName(objectName);
  return stub.fetch(sanitizedObjectRequest(
    input.request,
    input.route,
    now + input.policy.connectionLeaseMs,
  ));
}
