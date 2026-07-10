import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

import type {
  AdminFlueComputerAuthority,
  AdminFlueComputerAuthorityResolution,
  ResolveAdminFlueComputerAuthority,
} from "../computer/-result-proxy";

const PUBLIC_AGENT_PATH_PREFIX =
  "/api/assistant/flue/agents/admin-copilot/";
const AGENT_ORIGIN = "http://admin-flue-agent.internal";
const AGENT_PATH_PREFIX = "/agents/admin-copilot/";
const MAX_PROMPT_BODY_BYTES = 12 * 1024;
const MAX_PROMPT_CHARACTERS = 8_000;
const MAX_COOKIE_BYTES = 8 * 1024;
const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024;
const MIN_SERVICE_TOKEN_CHARACTERS = 32;
const MAX_UPDATES_QUERY_CHARACTERS = 512;
const THREAD_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22,64}$/u;
const PUBLIC_AGENT_PATH_PATTERN =
  /^\/api\/assistant\/flue\/agents\/admin-copilot\/(conv_[A-Za-z0-9_-]{22,64})(\/abort)?$/u;
const INSTANCE_ID_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/u;
const IDENTITY_PATTERN = /^(?:tenant|principal)_[A-Za-z0-9_-]{43}$/u;
const OFFSET_PATTERN = /^(?:-1|[0-9]{1,20}_[0-9]{1,20})$/u;
const CURSOR_PATTERN = /^[0-9]{1,20}$/u;
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const FORWARDED_RESPONSE_HEADERS = [
  "Content-Type",
  "Cache-Control",
  "ETag",
  "Stream-Next-Offset",
  "Stream-Up-To-Date",
  "Stream-Closed",
  "Stream-Cursor",
  "Stream-SSE-Data-Encoding",
] as const;

type AgentEndpoint =
  | {
      kind: "send" | "history" | "updates";
      threadId: string;
      normalizedSearch: string;
    }
  | { kind: "abort"; threadId: string; normalizedSearch: "" };

interface AgentSendBody {
  message: string;
}

interface AgentSendAdmission {
  streamUrl: string;
  offset: string;
  submissionId: string;
}

export interface AdminFlueAgentFacadeDependencies {
  agent?: Pick<Fetcher, "fetch">;
  serviceToken?: string;
  resolveAuthority?: ResolveAdminFlueComputerAuthority;
}

export async function proxyAdminFlueAgentFacade(
  request: Request,
  dependencies: AdminFlueAgentFacadeDependencies = {},
): Promise<Response> {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return jsonError(400, "ADMIN_FLUE_REQUEST_INVALID", "Invalid assistant request");
  }

  if (
    (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") ||
    requestUrl.username ||
    requestUrl.password ||
    requestUrl.hash
  ) {
    return jsonError(400, "ADMIN_FLUE_REQUEST_INVALID", "Invalid assistant request");
  }

  const endpoint = matchAgentEndpoint(request, requestUrl);
  if (!endpoint) {
    return jsonError(404, "ADMIN_FLUE_ROUTE_NOT_FOUND", "Assistant route not found");
  }
  if (endpoint instanceof Response) return endpoint;

  if (rejectCrossOriginRequest(request, requestUrl)) {
    return jsonError(
      403,
      "CROSS_ORIGIN_ADMIN_FLUE_REQUEST",
      "Cross-origin assistant request denied",
    );
  }
  if (hasForbiddenClientHeader(request.headers)) {
    return jsonError(
      400,
      "ADMIN_FLUE_HEADER_FORBIDDEN",
      "Assistant request contains a forbidden header",
    );
  }

  const cookie = request.headers.get("cookie")?.trim() ?? "";
  if (!cookie) {
    return jsonError(401, "ADMIN_SESSION_REQUIRED", "Dashboard session is required");
  }
  if (new TextEncoder().encode(cookie).byteLength > MAX_COOKIE_BYTES) {
    return jsonError(
      431,
      "ADMIN_SESSION_HEADER_TOO_LARGE",
      "Dashboard session header is too large",
    );
  }

  let prompt: AgentSendBody | undefined;
  if (endpoint.kind === "send") {
    const promptResult = await readPrompt(request);
    if (promptResult instanceof Response) return promptResult;
    prompt = promptResult;
  } else if (request.body) {
    return jsonError(
      400,
      "ADMIN_FLUE_BODY_FORBIDDEN",
      "This assistant request does not accept a body",
    );
  }

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
      requestedThreadId: endpoint.threadId,
    });
  } catch {
    resolution = { ok: false, reason: "unavailable" };
  }
  if (!resolution.ok) return authorityError(resolution.reason);

  const authority = resolution.authority;
  if (!isValidAuthority(authority) || authority.threadId !== endpoint.threadId) {
    return jsonError(
      503,
      "ADMIN_FLUE_AUTHORITY_INVALID",
      "Assistant identity authority is unavailable",
    );
  }
  if (
    !dependencies.agent ||
    !dependencies.serviceToken ||
    dependencies.serviceToken.length < MIN_SERVICE_TOKEN_CHARACTERS
  ) {
    return jsonError(
      503,
      "ADMIN_FLUE_SERVICE_UNAVAILABLE",
      "Assistant service is unavailable",
    );
  }

  const headers = createAgentHeaders(
    authority,
    dependencies.serviceToken,
    endpoint,
  );
  const target = `${AGENT_ORIGIN}${AGENT_PATH_PREFIX}${authority.instanceId}${
    endpoint.kind === "abort" ? "/abort" : ""
  }${endpoint.normalizedSearch}`;
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
  };
  if (prompt) init.body = JSON.stringify(prompt);

  let agentResponse: Response;
  try {
    agentResponse = await dependencies.agent.fetch(target, init);
  } catch {
    return jsonError(
      502,
      "ADMIN_FLUE_PROXY_FAILED",
      "Assistant service request failed",
    );
  }

  if (agentResponse.status >= 300 && agentResponse.status < 400) {
    await agentResponse.body?.cancel();
    return jsonError(
      502,
      "ADMIN_FLUE_REDIRECT_REJECTED",
      "Assistant service returned an invalid redirect",
    );
  }
  if (!agentResponse.ok) return sanitizedAgentError(agentResponse);

  if (endpoint.kind === "send") {
    return sanitizeSendAdmission(agentResponse, requestUrl, endpoint.threadId);
  }
  if (endpoint.kind === "abort") {
    return sanitizeAbortResponse(agentResponse);
  }
  if (agentResponse.status !== 200) {
    await agentResponse.body?.cancel();
    return jsonError(
      502,
      "ADMIN_FLUE_RESPONSE_INVALID",
      "Assistant service returned an invalid response",
    );
  }

  return streamingAgentResponse(agentResponse, endpoint.kind);
}

function matchAgentEndpoint(
  request: Request,
  url: URL,
): AgentEndpoint | Response | null {
  const match = PUBLIC_AGENT_PATH_PATTERN.exec(url.pathname);
  if (!match) return null;

  const threadId = match[1] ?? "";
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  const abort = match[2] === "/abort";

  if (abort) {
    if (request.method !== "POST") {
      return jsonError(405, "ADMIN_FLUE_METHOD_NOT_ALLOWED", "Method not allowed", {
        Allow: "POST",
      });
    }
    return url.search
      ? null
      : { kind: "abort", threadId, normalizedSearch: "" };
  }

  if (request.method === "POST") {
    return url.search
      ? null
      : { kind: "send", threadId, normalizedSearch: "" };
  }
  if (request.method !== "GET") {
    return jsonError(405, "ADMIN_FLUE_METHOD_NOT_ALLOWED", "Method not allowed", {
      Allow: "GET, POST",
    });
  }
  return parseReadEndpoint(threadId, url);
}

function parseReadEndpoint(threadId: string, url: URL): AgentEndpoint | null {
  if (!url.search || url.search.length > MAX_UPDATES_QUERY_CHARACTERS) return null;
  const allowed = new Set(["view", "offset", "live", "cursor"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return null;
  }

  const views = url.searchParams.getAll("view");
  if (views.length !== 1) return null;
  if (views[0] === "history") {
    return [...url.searchParams.keys()].every((key) => key === "view")
      ? { kind: "history", threadId, normalizedSearch: "?view=history" }
      : null;
  }
  if (views[0] !== "updates") return null;

  const offsets = url.searchParams.getAll("offset");
  const liveValues = url.searchParams.getAll("live");
  const cursorValues = url.searchParams.getAll("cursor");
  if (
    offsets.length !== 1 ||
    !OFFSET_PATTERN.test(offsets[0] ?? "") ||
    liveValues.length > 1 ||
    cursorValues.length > 1
  ) {
    return null;
  }
  const live = liveValues[0];
  if (live !== undefined && live !== "long-poll" && live !== "sse") return null;
  const cursor = cursorValues[0];
  if (cursor !== undefined && !CURSOR_PATTERN.test(cursor)) return null;

  const normalized = new URLSearchParams({
    view: "updates",
    offset: offsets[0] ?? "-1",
  });
  if (live) normalized.set("live", live);
  if (cursor) normalized.set("cursor", cursor);
  return {
    kind: "updates",
    threadId,
    normalizedSearch: `?${normalized.toString()}`,
  };
}

async function readPrompt(request: Request): Promise<AgentSendBody | Response> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return jsonError(
      415,
      "ADMIN_FLUE_CONTENT_TYPE_INVALID",
      "Assistant prompts require application/json",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && !/^\d+$/u.test(declaredLength)) {
    return jsonError(
      400,
      "ADMIN_FLUE_CONTENT_LENGTH_INVALID",
      "Assistant prompt content length is invalid",
    );
  }
  if (declaredLength && Number(declaredLength) > MAX_PROMPT_BODY_BYTES) {
    return jsonError(413, "ADMIN_FLUE_PROMPT_TOO_LARGE", "Assistant prompt is too large");
  }

  const value = await readBoundedJson(request, MAX_PROMPT_BODY_BYTES);
  if (value === "oversize") {
    return jsonError(413, "ADMIN_FLUE_PROMPT_TOO_LARGE", "Assistant prompt is too large");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.message !== "string" ||
    value.message.length > MAX_PROMPT_CHARACTERS ||
    value.message.trim().length === 0
  ) {
    return jsonError(400, "ADMIN_FLUE_PROMPT_INVALID", "Assistant prompt is invalid");
  }
  return { message: value.message };
}

function createAgentHeaders(
  authority: AdminFlueComputerAuthority,
  serviceToken: string,
  endpoint: AgentEndpoint,
): Headers {
  const accept = endpoint.kind === "updates" &&
      endpoint.normalizedSearch.includes("live=sse")
    ? "text/event-stream"
    : "application/json";
  const headers = new Headers({
    Accept: accept,
    Authorization: `Bearer ${serviceToken}`,
    "X-Scalius-Tenant-Id": authority.tenantId,
    "X-Scalius-Principal-Id": authority.principalId,
    "X-Scalius-Thread-Id": authority.threadId,
  });
  if (endpoint.kind === "send") headers.set("Content-Type", "application/json");
  return headers;
}

async function sanitizeSendAdmission(
  response: Response,
  requestUrl: URL,
  threadId: string,
): Promise<Response> {
  if (response.status !== 202) {
    await response.body?.cancel();
    return jsonError(
      502,
      "ADMIN_FLUE_ADMISSION_INVALID",
      "Assistant prompt was not admitted",
    );
  }
  const value = await readBoundedResponseJson(response, MAX_CONTROL_RESPONSE_BYTES);
  const admission = parseSendAdmission(value);
  const headerOffset = response.headers.get("stream-next-offset");
  if (!admission || (headerOffset !== null && headerOffset !== admission.offset)) {
    return jsonError(
      502,
      "ADMIN_FLUE_ADMISSION_INVALID",
      "Assistant prompt was not admitted",
    );
  }

  const publicStreamUrl = new URL(
    `${PUBLIC_AGENT_PATH_PREFIX}${threadId}`,
    requestUrl.origin,
  ).toString();
  return Response.json(
    {
      streamUrl: publicStreamUrl,
      offset: admission.offset,
      submissionId: admission.submissionId,
    },
    {
      status: 202,
      headers: {
        "Cache-Control": "no-store",
        "Stream-Next-Offset": admission.offset,
      },
    },
  );
}

function parseSendAdmission(value: unknown): AgentSendAdmission | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.streamUrl !== "string" ||
    value.streamUrl.length > 2_048 ||
    typeof value.offset !== "string" ||
    !OFFSET_PATTERN.test(value.offset) ||
    typeof value.submissionId !== "string" ||
    !SUBMISSION_ID_PATTERN.test(value.submissionId)
  ) {
    return null;
  }
  try {
    const streamUrl = new URL(value.streamUrl);
    if (streamUrl.protocol !== "http:" && streamUrl.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    streamUrl: value.streamUrl,
    offset: value.offset,
    submissionId: value.submissionId,
  };
}

async function sanitizeAbortResponse(response: Response): Promise<Response> {
  if (response.status !== 200) {
    await response.body?.cancel();
    return jsonError(
      502,
      "ADMIN_FLUE_ABORT_INVALID",
      "Assistant abort returned an invalid response",
    );
  }
  const value = await readBoundedResponseJson(response, MAX_CONTROL_RESPONSE_BYTES);
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.aborted !== "boolean"
  ) {
    return jsonError(
      502,
      "ADMIN_FLUE_ABORT_INVALID",
      "Assistant abort returned an invalid response",
    );
  }
  return Response.json(
    { aborted: value.aborted },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function streamingAgentResponse(
  response: Response,
  kind: "history" | "updates",
): Response {
  const headers = copyAllowedResponseHeaders(response.headers);
  headers.set(
    "Cache-Control",
    kind === "updates" &&
      response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
      ? "no-cache"
      : "no-store",
  );
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

async function sanitizedAgentError(response: Response): Promise<Response> {
  const status = response.status >= 400 && response.status <= 599
    ? response.status
    : 502;
  await response.body?.cancel();
  return jsonError(
    status,
    "ADMIN_FLUE_SERVICE_REJECTED",
    status === 404 ? "Assistant thread was not found" : "Assistant service rejected the request",
  );
}

function copyAllowedResponseHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function authorityError(
  reason: Exclude<AdminFlueComputerAuthorityResolution, { ok: true }>["reason"],
): Response {
  if (reason === "unauthenticated") {
    return jsonError(401, "ADMIN_SESSION_REQUIRED", "Dashboard session is required");
  }
  if (reason === "forbidden") {
    return jsonError(
      403,
      "ADMIN_FLUE_THREAD_FORBIDDEN",
      "Assistant thread access denied",
    );
  }
  return jsonError(
    503,
    "ADMIN_FLUE_AUTHORITY_UNAVAILABLE",
    "Assistant identity authority is unavailable",
  );
}

function rejectCrossOriginRequest(request: Request, requestUrl: URL): boolean {
  if (shouldRejectCrossOriginCookieRequest(request)) return true;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.origin !== requestUrl.origin
      ) {
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

function isValidAuthority(authority: AdminFlueComputerAuthority): boolean {
  return authority.surface === "admin" &&
    IDENTITY_PATTERN.test(authority.tenantId) &&
    IDENTITY_PATTERN.test(authority.principalId) &&
    THREAD_ID_PATTERN.test(authority.threadId) &&
    INSTANCE_ID_PATTERN.test(authority.instanceId);
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown | "oversize"> {
  if (!request.body) return null;
  return readBoundedJsonStream(request.body, maxBytes, true);
}

async function readBoundedResponseJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const value = await readBoundedJsonStream(response.body, maxBytes, false);
  return value === "oversize" ? null : value;
}

async function readBoundedJsonStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  reportOversize: boolean,
): Promise<unknown | "oversize"> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return reportOversize ? "oversize" : null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
      headers: {
        "Cache-Control": "no-store",
        ...extraHeaders,
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
