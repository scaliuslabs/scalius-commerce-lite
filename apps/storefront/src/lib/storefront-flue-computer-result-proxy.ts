import { parseScaliusComputerProgram } from "@scalius/shared/assistant-computer";

import {
  STOREFRONT_ASSISTANT_API_ORIGIN,
  STOREFRONT_CONVERSATION_ID_PATTERN,
  StorefrontConversationFacadeError,
  extractStorefrontAssistantCookie,
  rejectCrossOriginConversationRequest,
} from "@/lib/storefront-assistant-facade-contract";

const FLUE_ADMISSION_PATH = "/api/v1/internal/storefront-assistant/flue/admit";
const AGENT_RESULT_PATH_PREFIX = "/computer/results/";
const AGENT_ORIGIN = "http://storefront-flue-agent.internal";
const PUBLIC_RESULT_PATH_PATTERN =
  /^\/api\/assistant\/conversations\/(conv_[A-Za-z0-9_-]{22,64})\/computer\/results$/u;
const MAX_BODY_BYTES = 20_000;
const MAX_AGENT_RESPONSE_BYTES = 4_096;
const MAX_AUTHORITY_RESPONSE_BYTES = 16_384;
const MIN_SERVICE_TOKEN_CHARS = 32;
const MAX_SERVICE_TOKEN_CHARS = 512;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const TENANT_ID_PATTERN = /^tenant_[A-Za-z0-9_-]{43}$/u;
const PRINCIPAL_ID_PATTERN = /^principal_[A-Za-z0-9_-]{43}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,1600}\.[A-Za-z0-9_-]{43}$/u;
const MAX_AUTHORITY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const SUCCESS_CODES = new Set([
  "OBSERVED",
  "HELP",
  "NAVIGATED",
  "REFRESHED",
  "EXECUTED",
]);
const FAILURE_CODES = new Set([
  "INVALID_BINDING",
  "INACTIVE_TAB",
  "BUSY",
  "INVALID_PROGRAM",
  "ROUTE_BLOCKED",
  "OBSERVE_REQUIRED",
  "STALE_CONTEXT",
  "TARGET_GONE",
  "TARGET_DISABLED",
  "SENSITIVE_CONTROL",
  "HUMAN_REQUIRED",
  "ACTION_NOT_ALLOWED",
  "VALUE_NOT_FOUND",
  "EXECUTION_FAILED",
]);

export interface StorefrontFlueComputerAuthority {
  surface: "storefront";
  tenantId: string;
  principalId: string;
  threadId: string;
  instanceId: string;
  expiresAt: number;
}

export type StorefrontFlueComputerAuthorityResolution =
  | { ok: true; authority: StorefrontFlueComputerAuthority }
  | {
      ok: false;
      reason: "unauthenticated" | "forbidden" | "unavailable";
    };

/**
 * Resolves the HttpOnly Storefront session into API-owned Flue identity.
 * Neither caller-supplied headers nor fallback/default identities are inputs.
 */
export type ResolveStorefrontFlueComputerAuthority = (input: {
  assistantCookie: string;
  requestedThreadId: string;
}) => Promise<StorefrontFlueComputerAuthorityResolution>;

export interface StorefrontFlueComputerProxyDependencies {
  backend?: Pick<Fetcher, "fetch">;
  agent?: Pick<Fetcher, "fetch">;
  serviceToken?: string;
  resolveAuthority?: ResolveStorefrontFlueComputerAuthority;
  now?: () => number;
}

interface BrowserResultBody {
  surface: "storefront";
  threadId: string;
  requestId: string;
  ticket: string;
  program: string;
  result: Record<string, unknown>;
}

export async function proxyStorefrontFlueComputerResult(
  request: Request,
  dependencies: StorefrontFlueComputerProxyDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
      Allow: "POST",
    });
  }

  const requestUrl = safeHttpUrl(request.url);
  if (!requestUrl || requestUrl.search || requestUrl.hash) {
    return jsonError(
      400,
      "COMPUTER_RESULT_REQUEST_INVALID",
      "Invalid computer result request",
    );
  }
  const routeMatch = PUBLIC_RESULT_PATH_PATTERN.exec(requestUrl.pathname);
  const routeThreadId = routeMatch?.[1] ?? "";
  if (!STOREFRONT_CONVERSATION_ID_PATTERN.test(routeThreadId)) {
    return jsonError(
      400,
      "COMPUTER_RESULT_REQUEST_INVALID",
      "Invalid computer result request",
    );
  }
  if (rejectCrossOriginConversationRequest(request, requestUrl)) {
    return jsonError(
      403,
      "CROSS_ORIGIN_COMPUTER_RESULT",
      "Cross-origin request denied",
    );
  }
  if (hasForbiddenClientHeader(request.headers)) {
    return jsonError(
      400,
      "COMPUTER_RESULT_HEADER_FORBIDDEN",
      "Forbidden request header",
    );
  }

  let assistantCookie: string | null;
  try {
    assistantCookie = extractStorefrontAssistantCookie(
      request.headers.get("cookie"),
    );
  } catch (error) {
    if (error instanceof StorefrontConversationFacadeError) {
      return jsonError(error.status, error.code, error.message);
    }
    return jsonError(
      401,
      "CONVERSATION_SESSION_INVALID",
      "Assistant session is unavailable",
    );
  }
  if (!assistantCookie) {
    return jsonError(
      401,
      "CONVERSATION_SESSION_REQUIRED",
      "Assistant session is required",
    );
  }
  if (
    !/^application\/json(?:\s*;|$)/iu.test(
      request.headers.get("content-type")?.trim() ?? "",
    )
  ) {
    return jsonError(
      415,
      "COMPUTER_RESULT_CONTENT_TYPE_INVALID",
      "Computer results require application/json",
    );
  }

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (body === "oversize") {
    return jsonError(
      413,
      "COMPUTER_RESULT_TOO_LARGE",
      "Computer result is too large",
    );
  }
  const parsedBody = parseBrowserResultBody(body);
  if (!parsedBody || parsedBody.threadId !== routeThreadId) {
    return jsonError(
      400,
      "COMPUTER_RESULT_INVALID",
      "Computer result is invalid",
    );
  }

  const resolveAuthority =
    dependencies.resolveAuthority ??
    (dependencies.backend
      ? (input: { assistantCookie: string; requestedThreadId: string }) =>
          resolveStorefrontFlueComputerAuthority({
            ...input,
            backend: dependencies.backend!,
            now: dependencies.now?.() ?? Date.now(),
          })
      : undefined);
  if (!resolveAuthority) {
    return jsonError(
      503,
      "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE",
      "Assistant identity authority is unavailable",
    );
  }

  let resolution: StorefrontFlueComputerAuthorityResolution;
  try {
    resolution = await resolveAuthority({
      assistantCookie,
      requestedThreadId: routeThreadId,
    });
  } catch {
    resolution = { ok: false, reason: "unavailable" };
  }
  if (!resolution.ok) {
    if (resolution.reason === "unauthenticated") {
      return jsonError(
        401,
        "CONVERSATION_SESSION_REQUIRED",
        "Assistant session is required",
      );
    }
    if (resolution.reason === "forbidden") {
      return jsonError(
        403,
        "STOREFRONT_FLUE_THREAD_FORBIDDEN",
        "Assistant thread access denied",
      );
    }
    return jsonError(
      503,
      "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE",
      "Assistant identity authority is unavailable",
    );
  }

  const authority = resolution.authority;
  const now = dependencies.now?.() ?? Date.now();
  if (
    !isValidAuthority(authority, now) ||
    authority.threadId !== routeThreadId
  ) {
    return jsonError(
      503,
      "STOREFRONT_FLUE_AUTHORITY_INVALID",
      "Assistant identity authority is unavailable",
    );
  }
  if (
    !dependencies.agent ||
    !isConfiguredServiceToken(dependencies.serviceToken)
  ) {
    return jsonError(
      503,
      "STOREFRONT_FLUE_SERVICE_UNAVAILABLE",
      "Assistant service is unavailable",
    );
  }

  const outboundHeaders = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${dependencies.serviceToken}`,
    "Content-Type": "application/json",
    "X-Scalius-Tenant-Id": authority.tenantId,
    "X-Scalius-Principal-Id": authority.principalId,
    "X-Scalius-Thread-Id": authority.threadId,
  });
  const target = `${AGENT_ORIGIN}${AGENT_RESULT_PATH_PREFIX}${authority.instanceId}`;
  let agentResponse: Response;
  try {
    agentResponse = await dependencies.agent.fetch(target, {
      method: "POST",
      headers: outboundHeaders,
      redirect: "manual",
      body: JSON.stringify({
        ticket: parsedBody.ticket,
        program: parsedBody.program,
        result: parsedBody.result,
      }),
    });
  } catch {
    return jsonError(
      502,
      "STOREFRONT_FLUE_RESULT_PROXY_FAILED",
      "Assistant service request failed",
    );
  }

  const responseBody = await readBoundedResponseJson(
    agentResponse,
    MAX_AGENT_RESPONSE_BYTES,
  );
  if (
    agentResponse.status !== 202 ||
    !isRecord(responseBody) ||
    responseBody.accepted !== true ||
    responseBody.authoritative !== false ||
    responseBody.status !== "queued_for_agent_interpretation" ||
    responseBody.requestId !== parsedBody.requestId
  ) {
    const status =
      agentResponse.status === 413
        ? 413
        : agentResponse.status === 400
          ? 400
          : agentResponse.status === 503
            ? 503
            : 502;
    return jsonError(
      status,
      status === 413
        ? "COMPUTER_RESULT_TOO_LARGE"
        : "STOREFRONT_FLUE_RESULT_REJECTED",
      status === 503
        ? "Assistant service is unavailable"
        : "Computer result was rejected",
    );
  }

  return Response.json(
    {
      accepted: true,
      authoritative: false,
      status: "queued_for_agent_interpretation",
      requestId: parsedBody.requestId,
    },
    { status: 202, headers: noStoreHeaders() },
  );
}

export async function resolveStorefrontFlueComputerAuthority(input: {
  backend: Pick<Fetcher, "fetch">;
  assistantCookie: string;
  requestedThreadId: string;
  now?: number;
}): Promise<StorefrontFlueComputerAuthorityResolution> {
  if (
    !STOREFRONT_CONVERSATION_ID_PATTERN.test(input.requestedThreadId) ||
    !/^scalius_storefront_assistant=session_asst_[A-Za-z0-9_-]{43}$/u.test(
      input.assistantCookie,
    )
  ) {
    return { ok: false, reason: "unauthenticated" };
  }

  let response: Response;
  try {
    response = await input.backend.fetch(
      `${STOREFRONT_ASSISTANT_API_ORIGIN}${FLUE_ADMISSION_PATH}`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: input.assistantCookie,
        },
        body: JSON.stringify({ threadId: input.requestedThreadId }),
      },
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 401) {
      return { ok: false, reason: "unauthenticated" };
    }
    if (response.status === 403) {
      return { ok: false, reason: "forbidden" };
    }
    return { ok: false, reason: "unavailable" };
  }
  if (response.headers.has("set-cookie")) {
    await response.body?.cancel();
    return { ok: false, reason: "unavailable" };
  }

  const payload = await readBoundedResponseJson(
    response,
    MAX_AUTHORITY_RESPONSE_BYTES,
  );
  const authority = parseAuthorityEnvelope(payload, input.now ?? Date.now());
  if (!authority || authority.threadId !== input.requestedThreadId) {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, authority };
}

function parseAuthorityEnvelope(
  value: unknown,
  now: number,
): StorefrontFlueComputerAuthority | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["success", "data"]) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !hasOnlyKeys(value.data, ["agent"]) ||
    !isRecord(value.data.agent) ||
    !hasOnlyKeys(value.data.agent, [
      "surface",
      "instanceId",
      "tenantId",
      "principalId",
      "threadId",
      "expiresAt",
    ])
  ) {
    return null;
  }
  const agent = value.data.agent;
  if (
    agent.surface !== "storefront" ||
    typeof agent.instanceId !== "string" ||
    typeof agent.tenantId !== "string" ||
    typeof agent.principalId !== "string" ||
    typeof agent.threadId !== "string" ||
    typeof agent.expiresAt !== "number"
  ) {
    return null;
  }
  const authority: StorefrontFlueComputerAuthority = {
    surface: "storefront",
    instanceId: agent.instanceId,
    tenantId: agent.tenantId,
    principalId: agent.principalId,
    threadId: agent.threadId,
    expiresAt: agent.expiresAt,
  };
  return isValidAuthority(authority, now) ? authority : null;
}

function parseBrowserResultBody(value: unknown): BrowserResultBody | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "surface",
      "threadId",
      "requestId",
      "ticket",
      "program",
      "result",
    ])
  ) {
    return null;
  }
  if (
    value.surface !== "storefront" ||
    typeof value.threadId !== "string" ||
    !STOREFRONT_CONVERSATION_ID_PATTERN.test(value.threadId) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.ticket !== "string" ||
    !TICKET_PATTERN.test(value.ticket) ||
    typeof value.program !== "string" ||
    !parseScaliusComputerProgram(value.program).ok ||
    !isComputerResult(value.result)
  ) {
    return null;
  }
  return {
    surface: "storefront",
    threadId: value.threadId,
    requestId: value.requestId,
    ticket: value.ticket,
    program: value.program,
    result: value.result,
  };
}

function isComputerResult(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.output !== "string" ||
    value.output.length > 12_000
  ) {
    return false;
  }
  if (value.ok) {
    if (
      !hasOnlyKeys(value, ["ok", "code", "output", "changed"], ["revision"])
    ) {
      return false;
    }
    return (
      SUCCESS_CODES.has(String(value.code)) &&
      typeof value.changed === "boolean" &&
      (value.revision === undefined ||
        (typeof value.revision === "string" &&
          /^r[1-9][0-9]{0,9}$/u.test(value.revision)))
    );
  }
  return (
    hasOnlyKeys(value, ["ok", "code", "output", "retryable"]) &&
    FAILURE_CODES.has(String(value.code)) &&
    typeof value.retryable === "boolean"
  );
}

function isValidAuthority(
  value: StorefrontFlueComputerAuthority,
  now: number,
): boolean {
  return (
    value.surface === "storefront" &&
    TENANT_ID_PATTERN.test(value.tenantId) &&
    PRINCIPAL_ID_PATTERN.test(value.principalId) &&
    STOREFRONT_CONVERSATION_ID_PATTERN.test(value.threadId) &&
    INSTANCE_ID_PATTERN.test(value.instanceId) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > now &&
    value.expiresAt <= now + MAX_AUTHORITY_LIFETIME_MS
  );
}

function hasForbiddenClientHeader(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "proxy-authorization" ||
      normalized.startsWith("x-scalius-")
    ) {
      return true;
    }
  }
  return false;
}

function isConfiguredServiceToken(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_SERVICE_TOKEN_CHARS &&
    value.length <= MAX_SERVICE_TOKEN_CHARS &&
    !/[\r\n]/u.test(value)
  );
}

function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown | "oversize"> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    return "oversize";
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return "oversize";
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        concatenate(chunks, total),
      ),
    ) as unknown;
  } catch {
    return null;
  }
}

async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        concatenate(chunks, total),
      ),
    ) as unknown;
  } catch {
    return null;
  }
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { success: false, error: { code, message } },
    {
      status,
      headers: { ...noStoreHeaders(), ...extraHeaders },
    },
  );
}

function noStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
