import {
  STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER,
  normalizeStorefrontChatClientIp,
} from "@scalius/shared/storefront-chat-boundary";

import {
  STOREFRONT_ASSISTANT_API_ORIGIN,
  STOREFRONT_ASSISTANT_AUTHORITY_PATHS,
  STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
  StorefrontConversationFacadeError,
  extractStorefrontAssistantCookie,
  parseStorefrontAuthorityIdentity,
  readBoundedResponseJson,
  rejectCrossOriginConversationRequest,
  requireAuthoritySetCookie,
} from "@/lib/storefront-assistant-facade-contract";
import {
  resolveStorefrontFlueComputerAuthority,
  type ResolveStorefrontFlueComputerAuthority,
  type StorefrontFlueComputerAuthority,
} from "@/lib/storefront-flue-computer-result-proxy";

const AGENT_NAME = "shopping-assistant";
const AGENT_ORIGIN = "http://storefront-flue-agent.internal";
const AGENT_PATH_PREFIX = `/agents/${AGENT_NAME}/`;
const PUBLIC_PATH_PATTERN =
  /^\/api\/assistant\/conversations\/(conv_[A-Za-z0-9_-]{22,64})\/flue\/agents\/shopping-assistant\/(conv_[A-Za-z0-9_-]{22,64})(\/abort)?$/u;
const PUBLIC_READINESS_PATH_PATTERN =
  /^\/api\/assistant\/conversations\/(conv_[A-Za-z0-9_-]{22,64})\/flue\/readyz$/u;
const MAX_PROMPT_BODY_BYTES = 16 * 1024;
const MAX_PROMPT_CHARACTERS = 2_000;
const MAX_CONTROL_RESPONSE_BYTES = 8 * 1024;
const MAX_UPDATES_QUERY_CHARACTERS = 512;
const MIN_SERVICE_TOKEN_CHARACTERS = 32;
const MAX_SERVICE_TOKEN_CHARACTERS = 512;
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ADMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RUNTIME_BASE =
  "http://api.internal/api/v1/internal/storefront-assistant/flue";
const STOP_SETTLEMENT_TIMEOUT_MS = 4_000;
const STOP_SETTLEMENT_POLL_MS = 50;

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
  | {
      kind: "abort" | "readiness";
      threadId: string;
      normalizedSearch: "";
    };

interface AgentSendAdmission {
  streamUrl: string;
  offset: string;
  submissionId: string;
}

interface BootstrappedSession {
  assistantCookie: string;
  setCookie: string;
}

export interface StorefrontFlueAgentFacadeDependencies {
  backend?: Pick<Fetcher, "fetch">;
  agent?: Pick<Fetcher, "fetch">;
  serviceToken?: string;
  now?: () => number;
  resolveAuthority?: ResolveStorefrontFlueComputerAuthority;
  bootstrapSession?: (input: {
    request: Request;
    threadId: string;
  }) => Promise<BootstrappedSession>;
}

/**
 * Same-origin, cookie-scoped SDK facade for one Storefront Flue thread. The
 * browser selects only its opaque per-tab thread id; API-owned admission binds
 * that id to the deployment, tenant, principal, authority session, and signed
 * Flue instance before any request reaches the Agent Worker.
 */
export async function proxyStorefrontFlueAgentFacade(
  request: Request,
  dependencies: StorefrontFlueAgentFacadeDependencies = {},
): Promise<Response> {
  const requestUrl = safeHttpUrl(request.url);
  if (!requestUrl || requestUrl.hash) {
    return jsonError(
      400,
      "STOREFRONT_FLUE_REQUEST_INVALID",
      "Invalid assistant request",
    );
  }

  const endpoint = matchAgentEndpoint(request, requestUrl);
  if (!endpoint) {
    return jsonError(
      404,
      "STOREFRONT_FLUE_ROUTE_NOT_FOUND",
      "Assistant route not found",
    );
  }
  if (endpoint instanceof Response) return endpoint;

  if (rejectCrossOriginConversationRequest(request, requestUrl)) {
    return jsonError(
      403,
      "CROSS_ORIGIN_STOREFRONT_FLUE_REQUEST",
      "Cross-origin assistant request denied",
    );
  }
  if (hasForbiddenClientHeader(request.headers)) {
    return jsonError(
      400,
      "STOREFRONT_FLUE_HEADER_FORBIDDEN",
      "Assistant request contains a forbidden header",
    );
  }

  let prompt: { message: string } | undefined;
  if (endpoint.kind === "send") {
    const promptResult = await readPrompt(request);
    if (promptResult instanceof Response) return promptResult;
    prompt = promptResult;
  } else if (request.body) {
    return jsonError(
      400,
      "STOREFRONT_FLUE_BODY_FORBIDDEN",
      "This assistant request does not accept a body",
    );
  }

  let assistantCookie: string | null;
  try {
    assistantCookie = extractStorefrontAssistantCookie(
      request.headers.get("cookie"),
    );
  } catch (error) {
    return facadeFailure(error);
  }

  let setCookie: string | undefined;
  if (!assistantCookie) {
    if (endpoint.kind === "abort") {
      return jsonError(
        401,
        "CONVERSATION_SESSION_REQUIRED",
        "Assistant session is required",
      );
    }
    try {
      const session = dependencies.bootstrapSession
        ? await dependencies.bootstrapSession({
            request,
            threadId: endpoint.threadId,
          })
        : await bootstrapStorefrontAssistantSession({
            request,
            threadId: endpoint.threadId,
            backend: dependencies.backend,
          });
      assistantCookie = session.assistantCookie;
      setCookie = session.setCookie;
    } catch (error) {
      return facadeFailure(error);
    }
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
      {},
      setCookie,
    );
  }

  let resolution;
  try {
    resolution = await resolveAuthority({
      assistantCookie,
      requestedThreadId: endpoint.threadId,
    });
  } catch {
    resolution = { ok: false as const, reason: "unavailable" as const };
  }
  if (!resolution.ok) {
    return authorityError(resolution.reason, setCookie);
  }
  const authority = resolution.authority;
  if (authority.threadId !== endpoint.threadId) {
    return jsonError(
      503,
      "STOREFRONT_FLUE_AUTHORITY_INVALID",
      "Assistant identity authority is unavailable",
      {},
      setCookie,
    );
  }
  if (
    !dependencies.agent ||
    ((endpoint.kind === "send" || endpoint.kind === "abort") &&
      !dependencies.backend) ||
    !isConfiguredServiceToken(dependencies.serviceToken)
  ) {
    return jsonError(
      503,
      "STOREFRONT_FLUE_SERVICE_UNAVAILABLE",
      "Assistant service is unavailable",
      {},
      setCookie,
    );
  }

  let admissionLease: AdmissionLease | null = null;
  let abortThroughGeneration: number | null = null;
  if (endpoint.kind === "send") {
    admissionLease = await beginAdmission(
      dependencies.backend!,
      authority.instanceId,
    );
    if (!admissionLease) {
      return jsonError(
        409,
        "STOREFRONT_FLUE_ADMISSION_BLOCKED",
        "Assistant Stop is in progress",
        {},
        setCookie,
      );
    }
  }
  if (endpoint.kind === "abort") {
    abortThroughGeneration = await beginStop(
      dependencies.backend!,
      authority.instanceId,
    );
    if (!abortThroughGeneration) {
      return jsonError(
        503,
        "STOREFRONT_FLUE_STOP_UNCONFIRMED",
        "Assistant work could not be safely stopped",
        {},
        setCookie,
      );
    }
  }

  const target =
    endpoint.kind === "readiness"
      ? `${AGENT_ORIGIN}/readyz/agents/${AGENT_NAME}/${authority.instanceId}`
      : `${AGENT_ORIGIN}${AGENT_PATH_PREFIX}${authority.instanceId}${
          endpoint.kind === "abort" ? "/abort" : ""
        }${endpoint.normalizedSearch}`;
  const init: RequestInit = {
    method: request.method,
    headers: createAgentHeaders(
      authority,
      dependencies.serviceToken,
      endpoint,
      admissionLease?.generation,
      abortThroughGeneration,
    ),
    redirect: "manual",
    signal: request.signal,
  };
  if (prompt) init.body = JSON.stringify(prompt);

  let agentResponse: Response;
  try {
    agentResponse = await dependencies.agent.fetch(target, init);
  } catch {
    if (admissionLease) {
      await finishAdmission(
        dependencies.backend!,
        authority.instanceId,
        admissionLease,
      );
    }
    return jsonError(
      502,
      "STOREFRONT_FLUE_PROXY_FAILED",
      "Assistant service request failed",
      {},
      setCookie,
    );
  }

  if (admissionLease) {
    const finished = await finishAdmission(
      dependencies.backend!,
      authority.instanceId,
      admissionLease,
    );
    if (!finished) {
      await agentResponse.body?.cancel();
      return jsonError(
        503,
        "STOREFRONT_FLUE_ADMISSION_UNSETTLED",
        "Assistant admission could not be settled",
        {},
        setCookie,
      );
    }
  }

  if (agentResponse.status >= 300 && agentResponse.status < 400) {
    await agentResponse.body?.cancel();
    return jsonError(
      502,
      "STOREFRONT_FLUE_REDIRECT_REJECTED",
      "Assistant service returned an invalid redirect",
      {},
      setCookie,
    );
  }
  if (!agentResponse.ok && endpoint.kind === "readiness") {
    await agentResponse.body?.cancel();
    return jsonError(
      503,
      "STOREFRONT_FLUE_NOT_READY",
      "Assistant service is not ready",
      {},
      setCookie,
    );
  }
  if (!agentResponse.ok) {
    return sanitizedAgentError(agentResponse, setCookie);
  }

  if (endpoint.kind === "readiness") {
    return sanitizeReadinessProbe(agentResponse, setCookie);
  }

  if (endpoint.kind === "send") {
    return sanitizeSendAdmission(
      agentResponse,
      requestUrl,
      endpoint.threadId,
      setCookie,
    );
  }
  if (endpoint.kind === "abort") {
    const sanitized = await sanitizeAbortResponse(agentResponse);
    if (!sanitized.ok) return sanitized.response;
    const reconciled = await callRuntimeGate(
      dependencies.backend!,
      "/stop/reconcile",
      {
        instanceId: authority.instanceId,
        stoppedThroughIssuedAtMs: abortThroughGeneration,
      },
    );
    if (!reconciled.ok) {
      return jsonError(
        503,
        "STOREFRONT_FLUE_STOP_UNCONFIRMED",
        "Assistant Stop could not be reconciled",
        {},
        setCookie,
      );
    }
    const settled = await awaitStopReadiness(
      dependencies.backend!,
      authority.instanceId,
      request.signal,
    );
    if (!settled) {
      return jsonError(
        503,
        "STOREFRONT_FLUE_STOP_UNCONFIRMED",
        "Assistant Stop could not be reconciled",
        {},
        setCookie,
      );
    }
    const finished = await callRuntimeGate(
      dependencies.backend!,
      "/stop/finish",
      { instanceId: authority.instanceId },
    );
    if (!finished.ok) {
      return jsonError(
        503,
        "STOREFRONT_FLUE_STOP_UNCONFIRMED",
        "Assistant Stop could not be confirmed",
        {},
        setCookie,
      );
    }
    return sanitized.response;
  }
  if (agentResponse.status !== 200) {
    await agentResponse.body?.cancel();
    return jsonError(
      502,
      "STOREFRONT_FLUE_RESPONSE_INVALID",
      "Assistant service returned an invalid response",
      {},
      setCookie,
    );
  }
  return streamingAgentResponse(agentResponse, endpoint.kind, setCookie);
}

function matchAgentEndpoint(
  request: Request,
  url: URL,
): AgentEndpoint | Response | null {
  const readinessMatch = PUBLIC_READINESS_PATH_PATTERN.exec(url.pathname);
  if (readinessMatch) {
    if (url.search) return null;
    if (request.method !== "GET") {
      return jsonError(
        405,
        "STOREFRONT_FLUE_METHOD_NOT_ALLOWED",
        "Method not allowed",
        { Allow: "GET" },
      );
    }
    return {
      kind: "readiness",
      threadId: readinessMatch[1] ?? "",
      normalizedSearch: "",
    };
  }
  const match = PUBLIC_PATH_PATTERN.exec(url.pathname);
  if (!match || match[1] !== match[2]) return null;
  const threadId = match[1] ?? "";
  const abort = match[3] === "/abort";

  if (abort) {
    if (request.method !== "POST") {
      return jsonError(
        405,
        "STOREFRONT_FLUE_METHOD_NOT_ALLOWED",
        "Method not allowed",
        { Allow: "POST" },
      );
    }
    return url.search
      ? null
      : { kind: "abort", threadId, normalizedSearch: "" };
  }

  if (request.method === "POST") {
    return url.search ? null : { kind: "send", threadId, normalizedSearch: "" };
  }
  if (request.method !== "GET") {
    return jsonError(
      405,
      "STOREFRONT_FLUE_METHOD_NOT_ALLOWED",
      "Method not allowed",
      { Allow: "GET, POST" },
    );
  }
  return parseReadEndpoint(threadId, url);
}

function parseReadEndpoint(threadId: string, url: URL): AgentEndpoint | null {
  if (!url.search || url.search.length > MAX_UPDATES_QUERY_CHARACTERS) {
    return null;
  }
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
    !isOpaqueStreamToken(offsets[0] ?? "") ||
    liveValues.length > 1 ||
    cursorValues.length > 1
  ) {
    return null;
  }
  const live = liveValues[0];
  if (live !== undefined && live !== "long-poll" && live !== "sse") {
    return null;
  }
  const cursor = cursorValues[0];
  if (cursor !== undefined && !isOpaqueStreamToken(cursor)) return null;

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

async function readPrompt(
  request: Request,
): Promise<{ message: string } | Response> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return jsonError(
      415,
      "STOREFRONT_FLUE_CONTENT_TYPE_INVALID",
      "Assistant prompts require application/json",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && !/^\d+$/u.test(declaredLength)) {
    return jsonError(
      400,
      "STOREFRONT_FLUE_CONTENT_LENGTH_INVALID",
      "Assistant prompt content length is invalid",
    );
  }
  if (declaredLength && Number(declaredLength) > MAX_PROMPT_BODY_BYTES) {
    return jsonError(
      413,
      "STOREFRONT_FLUE_PROMPT_TOO_LARGE",
      "Assistant prompt is too large",
    );
  }

  const value = await readBoundedJson(request, MAX_PROMPT_BODY_BYTES);
  if (value === "oversize") {
    return jsonError(
      413,
      "STOREFRONT_FLUE_PROMPT_TOO_LARGE",
      "Assistant prompt is too large",
    );
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.message !== "string" ||
    value.message.length > MAX_PROMPT_CHARACTERS ||
    value.message.trim().length === 0
  ) {
    return jsonError(
      400,
      "STOREFRONT_FLUE_PROMPT_INVALID",
      "Assistant prompt is invalid",
    );
  }
  return { message: value.message };
}

async function bootstrapStorefrontAssistantSession(input: {
  request: Request;
  threadId: string;
  backend?: Pick<Fetcher, "fetch">;
}): Promise<BootstrappedSession> {
  if (!input.backend) {
    throw new StorefrontConversationFacadeError(
      503,
      "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE",
      "Assistant identity authority is unavailable",
    );
  }
  const clientIp = normalizeStorefrontChatClientIp(
    input.request.headers.get("cf-connecting-ip"),
  );
  if (!clientIp) {
    throw new StorefrontConversationFacadeError(
      503,
      "CONVERSATION_CLIENT_IDENTITY_UNAVAILABLE",
      "Assistant session is temporarily unavailable",
    );
  }

  let response: Response;
  try {
    response = await input.backend.fetch(
      `${STOREFRONT_ASSISTANT_API_ORIGIN}${STOREFRONT_ASSISTANT_AUTHORITY_PATHS.create}`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [STOREFRONT_CHAT_FORWARDED_CLIENT_IP_HEADER]: clientIp,
        },
        body: JSON.stringify({ conversationId: input.threadId }),
      },
    );
  } catch {
    throw new StorefrontConversationFacadeError(
      503,
      "CONVERSATION_SESSION_UNAVAILABLE",
      "Assistant session is temporarily unavailable",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
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

  const setCookie = requireAuthoritySetCookie(
    response.headers.get("set-cookie"),
    "create",
    input.threadId,
  );
  const payload = await readBoundedResponseJson(
    response,
    STOREFRONT_AUTHORITY_MAX_RESPONSE_BYTES,
  );
  const identity = parseStorefrontAuthorityIdentity(payload);
  if (identity.conversationId !== input.threadId) {
    throw new StorefrontConversationFacadeError(
      502,
      "CONVERSATION_AUTHORITY_INVALID",
      "Assistant session authority is unavailable",
    );
  }
  const assistantCookie = extractStorefrontAssistantCookie(
    setCookie.split(";", 1)[0] ?? null,
  );
  if (!assistantCookie) {
    throw new StorefrontConversationFacadeError(
      502,
      "CONVERSATION_AUTHORITY_INVALID",
      "Assistant session authority is unavailable",
    );
  }
  return { assistantCookie, setCookie };
}

function createAgentHeaders(
  authority: StorefrontFlueComputerAuthority,
  serviceToken: string,
  endpoint: AgentEndpoint,
  admissionGeneration?: number,
  abortThroughGeneration?: number | null,
): Headers {
  const accept =
    endpoint.kind === "updates" &&
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
  if (endpoint.kind === "send") {
    headers.set("Content-Type", "application/json");
    if (admissionGeneration) {
      headers.set("X-Flue-Admission-Generation", String(admissionGeneration));
    }
  }
  if (endpoint.kind === "abort" && abortThroughGeneration) {
    headers.set(
      "X-Flue-Abort-Through-Generation",
      String(abortThroughGeneration),
    );
  }
  return headers;
}

async function sanitizeSendAdmission(
  response: Response,
  requestUrl: URL,
  threadId: string,
  setCookie?: string,
): Promise<Response> {
  if (response.status !== 202) {
    await response.body?.cancel();
    return jsonError(
      502,
      "STOREFRONT_FLUE_ADMISSION_INVALID",
      "Assistant prompt was not admitted",
      {},
      setCookie,
    );
  }
  const value = await readBoundedResponseJsonValue(
    response,
    MAX_CONTROL_RESPONSE_BYTES,
  );
  const admission = parseSendAdmission(value);
  const headerOffset = response.headers.get("stream-next-offset");
  if (
    !admission ||
    (headerOffset !== null && headerOffset !== admission.offset)
  ) {
    return jsonError(
      502,
      "STOREFRONT_FLUE_ADMISSION_INVALID",
      "Assistant prompt was not admitted",
      {},
      setCookie,
    );
  }

  const publicStreamUrl = new URL(
    `/api/assistant/conversations/${threadId}/flue/agents/${AGENT_NAME}/${threadId}`,
    requestUrl.origin,
  ).toString();
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Stream-Next-Offset": admission.offset,
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return Response.json(
    {
      streamUrl: publicStreamUrl,
      offset: admission.offset,
      submissionId: admission.submissionId,
    },
    { status: 202, headers },
  );
}

function parseSendAdmission(value: unknown): AgentSendAdmission | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.streamUrl !== "string" ||
    value.streamUrl.length > 2_048 ||
    typeof value.offset !== "string" ||
    !isOpaqueStreamToken(value.offset) ||
    typeof value.submissionId !== "string" ||
    !SUBMISSION_ID_PATTERN.test(value.submissionId)
  ) {
    return null;
  }
  try {
    const streamUrl = new URL(value.streamUrl);
    if (streamUrl.protocol !== "http:" && streamUrl.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return {
    streamUrl: value.streamUrl,
    offset: value.offset,
    submissionId: value.submissionId,
  };
}

async function sanitizeAbortResponse(
  response: Response,
): Promise<{ ok: true; response: Response } | { ok: false; response: Response }> {
  if (response.status !== 200) {
    await response.body?.cancel();
    return { ok: false, response: jsonError(
      502,
      "STOREFRONT_FLUE_ABORT_INVALID",
      "Assistant abort returned an invalid response",
    ) };
  }
  const value = await readBoundedResponseJsonValue(
    response,
    MAX_CONTROL_RESPONSE_BYTES,
  );
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.aborted !== "boolean"
  ) {
    return { ok: false, response: jsonError(
      502,
      "STOREFRONT_FLUE_ABORT_INVALID",
      "Assistant abort returned an invalid response",
    ) };
  }
  return { ok: true, response: Response.json(
    { aborted: value.aborted },
    { headers: { "Cache-Control": "no-store" } },
  ) };
}

interface AdmissionLease {
  admissionId: string;
  admissionClaimToken: string;
  generation: number;
}

async function beginAdmission(
  api: Pick<Fetcher, "fetch">,
  instanceId: string,
): Promise<AdmissionLease | null> {
  const result = await callRuntimeGate(api, "/admission/begin", { instanceId });
  const data = result.data;
  if (
    !result.ok ||
    !isRecord(data) ||
    data.status !== "started" ||
    typeof data.admissionId !== "string" ||
    !ADMISSION_ID_PATTERN.test(data.admissionId) ||
    typeof data.admissionClaimToken !== "string" ||
    !CLAIM_TOKEN_PATTERN.test(data.admissionClaimToken) ||
    typeof data.generation !== "number" ||
    !Number.isSafeInteger(data.generation) ||
    data.generation <= 0
  ) return null;
  return {
    admissionId: data.admissionId,
    admissionClaimToken: data.admissionClaimToken,
    generation: data.generation,
  };
}

async function finishAdmission(
  api: Pick<Fetcher, "fetch">,
  instanceId: string,
  lease: AdmissionLease,
): Promise<boolean> {
  const result = await callRuntimeGate(api, "/admission/finish", {
    instanceId,
    admissionId: lease.admissionId,
    admissionClaimToken: lease.admissionClaimToken,
  });
  return result.ok && isRecord(result.data) &&
    (result.data.status === "finished" || result.data.status === "replayed");
}

async function beginStop(
  api: Pick<Fetcher, "fetch">,
  instanceId: string,
): Promise<number | null> {
  const result = await callRuntimeGate(api, "/stop/begin", { instanceId });
  return stopCutoff(result);
}

async function awaitStopReadiness(
  api: Pick<Fetcher, "fetch">,
  instanceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + STOP_SETTLEMENT_TIMEOUT_MS;
  let result: RuntimeGateResult = { ok: false };
  while (Date.now() < deadline && !signal.aborted) {
    result = await callRuntimeGate(api, "/stop/status", { instanceId });
    if (isReadyStop(result)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_SETTLEMENT_POLL_MS));
  }
  return isReadyStop(result);
}

function stopCutoff(result: RuntimeGateResult): number | null {
  const value = isRecord(result.data) ? result.data.stoppedThroughIssuedAtMs : null;
  return result.ok && typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isReadyStop(result: RuntimeGateResult): boolean {
  return result.ok && isRecord(result.data) && result.data.status === "ready" &&
    result.data.pendingAdmissions === 0 && result.data.pendingDispatches === 0;
}

interface RuntimeGateResult { ok: boolean; data?: unknown }

async function callRuntimeGate(
  api: Pick<Fetcher, "fetch">,
  path: string,
  body: Record<string, unknown>,
): Promise<RuntimeGateResult> {
  try {
    const response = await api.fetch(`${RUNTIME_BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await readBoundedResponseJsonValue(response, MAX_CONTROL_RESPONSE_BYTES);
    if (!response.ok || !isRecord(value) || value.success !== true) return { ok: false };
    return { ok: true, data: value.data };
  } catch {
    return { ok: false };
  }
}

async function sanitizeReadinessProbe(
  response: Response,
  setCookie?: string,
): Promise<Response> {
  if (
    response.status !== 204 ||
    response.headers.get("x-scalius-readiness") !== "facade-authenticated"
  ) {
    await response.body?.cancel();
    return jsonError(
      502,
      "STOREFRONT_FLUE_READINESS_INVALID",
      "Assistant readiness response was invalid",
      {},
      setCookie,
    );
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return Response.json(
    {
      ok: true,
      endToEnd: true,
      readiness: "facade_authenticated",
    },
    { status: 200, headers },
  );
}

function streamingAgentResponse(
  response: Response,
  kind: "history" | "updates",
  setCookie?: string,
): Response {
  const headers = copyAllowedResponseHeaders(response.headers);
  headers.set(
    "Cache-Control",
    kind === "updates" &&
      response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("text/event-stream")
      ? "no-cache"
      : "no-store",
  );
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(response.body, { status: response.status, headers });
}

async function sanitizedAgentError(
  response: Response,
  setCookie?: string,
): Promise<Response> {
  const status =
    response.status >= 400 && response.status <= 599 ? response.status : 502;
  await response.body?.cancel();
  return jsonError(
    status,
    "STOREFRONT_FLUE_SERVICE_REJECTED",
    status === 404
      ? "Assistant thread was not found"
      : "Assistant service rejected the request",
    {},
    setCookie,
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
  reason: "unauthenticated" | "forbidden" | "unavailable",
  setCookie?: string,
): Response {
  if (reason === "unauthenticated") {
    return jsonError(
      401,
      "CONVERSATION_SESSION_REQUIRED",
      "Assistant session is required",
      {},
      setCookie,
    );
  }
  if (reason === "forbidden") {
    return jsonError(
      403,
      "STOREFRONT_FLUE_THREAD_FORBIDDEN",
      "Assistant thread access denied",
      {},
      setCookie,
    );
  }
  return jsonError(
    503,
    "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE",
    "Assistant identity authority is unavailable",
    {},
    setCookie,
  );
}

function facadeFailure(error: unknown): Response {
  if (error instanceof StorefrontConversationFacadeError) {
    return jsonError(error.status, error.code, error.message);
  }
  return jsonError(
    503,
    "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE",
    "Assistant identity authority is unavailable",
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
    value.length >= MIN_SERVICE_TOKEN_CHARACTERS &&
    value.length <= MAX_SERVICE_TOKEN_CHARACTERS &&
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
  if (!request.body) return null;
  return readBoundedJsonStream(request.body, maxBytes, true);
}

async function readBoundedResponseJsonValue(
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
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
  setCookie?: string,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Durable Streams offsets and cursors are opaque. Bound transport characters
 * and length, but never parse or reconstruct their internal format. */
function isOpaqueStreamToken(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint < 0x21 ||
      codePoint > 0x7e ||
      character === "\\" ||
      character === "&" ||
      character === "#" ||
      character === "?"
    ) {
      return false;
    }
  }
  return true;
}
