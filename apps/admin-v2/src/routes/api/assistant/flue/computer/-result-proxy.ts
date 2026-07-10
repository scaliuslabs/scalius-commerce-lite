import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

const RESULT_PATH_PREFIX = "/computer/results/";
const AGENT_ORIGIN = "http://admin-flue-agent.internal";
const PUBLIC_RESULT_PATH = "/api/assistant/flue/computer/results";
const MAX_BODY_BYTES = 20_000;
const MAX_COOKIE_BYTES = 8_192;
const MAX_AGENT_RESPONSE_BYTES = 4_096;
const MIN_SERVICE_TOKEN_CHARS = 32;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const IDENTITY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,1600}\.[A-Za-z0-9_-]{43}$/u;

const SUCCESS_CODES = new Set(["OBSERVED", "HELP", "NAVIGATED", "REFRESHED", "EXECUTED"]);
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

export interface AdminFlueComputerAuthority {
  surface: "admin";
  tenantId: string;
  principalId: string;
  threadId: string;
  instanceId: string;
}

export type AdminFlueComputerAuthorityResolution =
  | { ok: true; authority: AdminFlueComputerAuthority }
  | { ok: false; reason: "unauthenticated" | "forbidden" | "unavailable" };

/**
 * Must authenticate the dashboard cookie, resolve its current tenant/principal,
 * authorize the requested thread, and return the HMAC-bound Flue instance.
 * Browser-provided identity headers or default/fallback tenant IDs are forbidden.
 */
export type ResolveAdminFlueComputerAuthority = (input: {
  request: Request;
  requestedThreadId: string;
}) => Promise<AdminFlueComputerAuthorityResolution>;

export interface AdminFlueComputerProxyDependencies {
  agent?: Pick<Fetcher, "fetch">;
  serviceToken?: string;
  resolveAuthority?: ResolveAdminFlueComputerAuthority;
}

interface BrowserResultBody {
  surface: "admin";
  threadId: string;
  requestId: string;
  ticket: string;
  program: string;
  result: Record<string, unknown>;
}

export async function proxyAdminFlueComputerResult(
  request: Request,
  dependencies: AdminFlueComputerProxyDependencies = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed", { Allow: "POST" });
  }
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return jsonError(400, "COMPUTER_RESULT_REQUEST_INVALID", "Invalid computer result request");
  }
  if (
    (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") ||
    requestUrl.username ||
    requestUrl.password ||
    requestUrl.pathname !== PUBLIC_RESULT_PATH ||
    requestUrl.search ||
    requestUrl.hash
  ) {
    return jsonError(400, "COMPUTER_RESULT_REQUEST_INVALID", "Invalid computer result request");
  }
  if (rejectCrossOriginRequest(request, requestUrl)) {
    return jsonError(403, "CROSS_ORIGIN_COMPUTER_RESULT", "Cross-origin request denied");
  }
  if (hasForbiddenClientHeader(request.headers)) {
    return jsonError(400, "COMPUTER_RESULT_HEADER_FORBIDDEN", "Forbidden request header");
  }
  const cookie = request.headers.get("cookie")?.trim() ?? "";
  if (!cookie) {
    return jsonError(401, "ADMIN_SESSION_REQUIRED", "Dashboard session is required");
  }
  if (new TextEncoder().encode(cookie).byteLength > MAX_COOKIE_BYTES) {
    return jsonError(431, "ADMIN_SESSION_HEADER_TOO_LARGE", "Dashboard session header is too large");
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type")?.trim() ?? "")) {
    return jsonError(415, "COMPUTER_RESULT_CONTENT_TYPE_INVALID", "Computer results require application/json");
  }

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (body === "oversize") {
    return jsonError(413, "COMPUTER_RESULT_TOO_LARGE", "Computer result is too large");
  }
  const parsedBody = parseBrowserResultBody(body);
  if (!parsedBody) {
    return jsonError(400, "COMPUTER_RESULT_INVALID", "Computer result is invalid");
  }

  // Authority is intentionally required. Until the API-owned admission slice
  // supplies it, this public route is inert rather than guessing a tenant.
  if (!dependencies.resolveAuthority) {
    return jsonError(
      503,
      "ADMIN_FLUE_AUTHORITY_UNAVAILABLE",
      "Assistant identity authority is unavailable",
    );
  }
  let resolution: AdminFlueComputerAuthorityResolution;
  try {
    resolution = await dependencies.resolveAuthority({
      request,
      requestedThreadId: parsedBody.threadId,
    });
  } catch {
    resolution = { ok: false, reason: "unavailable" };
  }
  if (!resolution.ok) {
    if (resolution.reason === "unauthenticated") {
      return jsonError(401, "ADMIN_SESSION_REQUIRED", "Dashboard session is required");
    }
    if (resolution.reason === "forbidden") {
      return jsonError(403, "ADMIN_FLUE_THREAD_FORBIDDEN", "Assistant thread access denied");
    }
    return jsonError(
      503,
      "ADMIN_FLUE_AUTHORITY_UNAVAILABLE",
      "Assistant identity authority is unavailable",
    );
  }
  const authority = resolution.authority;
  if (!isValidAuthority(authority) || authority.threadId !== parsedBody.threadId) {
    return jsonError(
      503,
      "ADMIN_FLUE_AUTHORITY_INVALID",
      "Assistant identity authority is unavailable",
    );
  }
  if (
    !dependencies.agent ||
    !dependencies.serviceToken ||
    dependencies.serviceToken.length < MIN_SERVICE_TOKEN_CHARS
  ) {
    return jsonError(503, "ADMIN_FLUE_SERVICE_UNAVAILABLE", "Assistant service is unavailable");
  }

  const outboundHeaders = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${dependencies.serviceToken}`,
    "Content-Type": "application/json",
    "X-Scalius-Tenant-Id": authority.tenantId,
    "X-Scalius-Principal-Id": authority.principalId,
    "X-Scalius-Thread-Id": authority.threadId,
  });
  const target = `${AGENT_ORIGIN}${RESULT_PATH_PREFIX}${authority.instanceId}`;
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
    return jsonError(502, "ADMIN_FLUE_RESULT_PROXY_FAILED", "Assistant service request failed");
  }

  const responseBody = await readBoundedResponseJson(agentResponse, MAX_AGENT_RESPONSE_BYTES);
  if (
    agentResponse.status !== 202 ||
    !isRecord(responseBody) ||
    responseBody.accepted !== true ||
    responseBody.authoritative !== false ||
    responseBody.status !== "queued_for_agent_interpretation" ||
    responseBody.requestId !== parsedBody.requestId
  ) {
    const status = agentResponse.status === 413 ? 413 :
      agentResponse.status === 400 ? 400 :
        agentResponse.status === 503 ? 503 : 502;
    return jsonError(
      status,
      status === 413 ? "COMPUTER_RESULT_TOO_LARGE" : "ADMIN_FLUE_RESULT_REJECTED",
      status === 503 ? "Assistant service is unavailable" : "Computer result was rejected",
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

function rejectCrossOriginRequest(request: Request, url: URL): boolean {
  if (shouldRejectCrossOriginCookieRequest(request)) return true;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== url.origin) {
        return true;
      }
    } catch {
      return true;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite !== null && fetchSite.toLowerCase() !== "same-origin";
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

function parseBrowserResultBody(value: unknown): BrowserResultBody | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "surface", "threadId", "requestId", "ticket", "program", "result",
  ])) return null;
  if (
    value.surface !== "admin" ||
    typeof value.threadId !== "string" || !THREAD_ID_PATTERN.test(value.threadId) ||
    typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.ticket !== "string" || !TICKET_PATTERN.test(value.ticket) ||
    typeof value.program !== "string" || value.program.length > 4_096 ||
    !isComputerResult(value.result)
  ) return null;
  return value as unknown as BrowserResultBody;
}

function isComputerResult(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.ok !== "boolean" ||
      typeof value.output !== "string" || value.output.length > 12_000) return false;
  if (value.ok) {
    if (!hasOnlyKeys(value, ["ok", "code", "output", "changed"], ["revision"])) {
      return false;
    }
    return SUCCESS_CODES.has(String(value.code)) &&
      typeof value.changed === "boolean" &&
      (value.revision === undefined ||
        (typeof value.revision === "string" && /^r[1-9][0-9]{0,9}$/u.test(value.revision)));
  }
  return hasOnlyKeys(value, ["ok", "code", "output", "retryable"]) &&
    FAILURE_CODES.has(String(value.code)) && typeof value.retryable === "boolean";
}

function isValidAuthority(value: AdminFlueComputerAuthority): boolean {
  return value.surface === "admin" &&
    IDENTITY_SEGMENT_PATTERN.test(value.tenantId) &&
    IDENTITY_SEGMENT_PATTERN.test(value.principalId) &&
    THREAD_ID_PATTERN.test(value.threadId) &&
    INSTANCE_ID_PATTERN.test(value.instanceId);
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown | "oversize"> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maxBytes) return "oversize";
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
  const bytes = concatenate(chunks, total);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

async function readBoundedResponseJson(response: Response, maxBytes: number): Promise<unknown> {
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
    return JSON.parse(new TextDecoder().decode(concatenate(chunks, total))) as unknown;
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
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers: { ...noStoreHeaders(), ...extraHeaders } },
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
