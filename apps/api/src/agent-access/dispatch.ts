import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import { loadAgentAccessBackend } from "./backend";
import {
  AGENT_MAX_REQUEST_BODY_BYTES,
  checkAgentRateLimit,
  clampAgentResultBytes,
  utf8ByteLength,
} from "./limits";
import type { AgentPrincipal } from "./types";
import { withAgentDispatchPrincipal } from "./dispatch-context";
import {
  AgentArtifactDeliveryError,
  stageAgentArtifact,
  type AgentArtifactResult,
} from "./artifact-delivery";

export type AgentInputPrimitive = string | number | boolean | null;

export interface AgentOperationInput {
  path?: Record<string, string | number | boolean>;
  query?: Record<string, AgentInputPrimitive | AgentInputPrimitive[]>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface AgentOperationResult {
  operationId: string;
  status: number;
  ok: boolean;
  requestId: string;
  contentType: string | null;
  data: unknown;
  artifact?: AgentArtifactResult;
  redacted?: true;
  oneTimeSecret?: true;
  sensitiveContinuation?: true;
}

export interface AgentRequiredClientActionResult {
  operationId: string;
  executed: false;
  requiredClientAction: {
    kind: "direct-upload";
    method: string;
    url: string;
    mediaType: "application/octet-stream";
    maxRequestBytes: number;
    requiresBearerHeader: true;
  };
}

export interface DispatchAgentOperationOptions {
  operation: AgentOperationManifestEntry;
  input: AgentOperationInput;
  principal: AgentPrincipal;
  env: Env;
  ctx: ExecutionContext;
}

export class AgentDispatchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AgentDispatchError";
    this.code = code;
    this.status = status;
  }
}

function manifestAuthorizationInput(operation: AgentOperationManifestEntry) {
  return {
    rbac: operation.rbac,
    risk: operation.risk,
    surface: operation.surface,
    exposure: operation.exposure,
    principals: operation.principals,
  };
}

export function buildAgentOperationPath(
  pathTemplate: string,
  pathInput: AgentOperationInput["path"] = {},
): string {
  const expected = new Set<string>();
  const pathname = pathTemplate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    expected.add(key);
    const value = pathInput[key];
    if (value === undefined || value === "") {
      throw new AgentDispatchError("missing_path_parameter", `Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });

  const extras = Object.keys(pathInput).filter((key) => !expected.has(key));
  if (extras.length > 0) {
    throw new AgentDispatchError(
      "unknown_path_parameter",
      `Unknown path parameter: ${extras.sort()[0]}`,
    );
  }
  if (pathname.includes("{") || pathname.includes("}")) {
    throw new AgentDispatchError("invalid_path_template", "Operation path template is invalid", 500);
  }
  return pathname;
}

function appendQueryValue(url: URL, key: string, value: AgentInputPrimitive): void {
  if (value === null) return;
  url.searchParams.append(key, String(value));
}

export function buildAgentOperationUrl(
  canonicalApiOrigin: string,
  pathTemplate: string,
  input: AgentOperationInput,
): URL {
  const origin = new URL(canonicalApiOrigin).origin;
  const url = new URL(buildAgentOperationPath(pathTemplate, input.path), origin);
  for (const [key, value] of Object.entries(input.query ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (Array.isArray(value)) {
      for (const item of value) appendQueryValue(url, key, item);
    } else {
      appendQueryValue(url, key, value);
    }
  }
  return url;
}

export function buildAgentRequiredClientAction(
  operation: AgentOperationManifestEntry,
  input: AgentOperationInput,
  env: Env,
): AgentRequiredClientActionResult {
  if (
    operation.requiredClientAction !== "direct-upload" ||
    operation.transport !== "octet-stream" ||
    operation.batch !== "forbidden" ||
    operation.idempotency !== "none" ||
    operation.sensitiveOutput ||
    operation.oneTimeSecretOutput ||
    operation.maxRequestBytes < 1 ||
    operation.maxRequestBytes > 16 * 1024 * 1024
  ) {
    throw new AgentDispatchError(
      "invalid_client_action_policy",
      "Operation client-action policy is invalid",
      500,
    );
  }
  if (input.body !== undefined || input.idempotencyKey) {
    throw new AgentDispatchError(
      "direct_upload_required",
      "Upload bytes must be transferred directly by an MCP client",
      409,
    );
  }
  return {
    operationId: operation.operationId,
    executed: false,
    requiredClientAction: {
      kind: "direct-upload",
      method: operation.method,
      url: buildAgentOperationUrl(
        requireCanonicalApiOrigin(env),
        operation.pathTemplate,
        input,
      ).href,
      mediaType: "application/octet-stream",
      maxRequestBytes: operation.maxRequestBytes,
      requiresBearerHeader: true,
    },
  };
}

function requireCanonicalApiOrigin(env: Env): string {
  const configured = env.PUBLIC_API_BASE_URL?.trim();
  if (!configured) {
    throw new AgentDispatchError(
      "agent_runtime_unconfigured",
      "Agent access is not configured",
      503,
    );
  }
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
    return url.origin;
  } catch {
    throw new AgentDispatchError(
      "agent_runtime_unconfigured",
      "Agent access is not configured",
      503,
    );
  }
}

function declaredJsonBodyProperties(operation: AgentOperationManifestEntry): Set<string> | undefined {
  const input = operation.inputSchema;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const requestBody = (input as Record<string, unknown>).requestBody;
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return undefined;
  const content = (requestBody as Record<string, unknown>).content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const json = (content as Record<string, unknown>)["application/json"];
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const schema = (json as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const root = schema as Record<string, unknown>;
  if (root.additionalProperties !== undefined && root.additionalProperties !== false) return undefined;
  const candidates: Record<string, unknown>[] = [root];
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const alternatives = root[key];
    if (Array.isArray(alternatives)) {
      for (const candidate of alternatives) {
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          candidates.push(candidate as Record<string, unknown>);
        }
      }
    }
  }
  const declared = new Set<string>();
  for (const candidate of candidates) {
    const properties = candidate.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      Object.keys(properties).forEach((key) => declared.add(key));
    }
  }
  return declared.size > 0 ? declared : undefined;
}

function validateAgentJsonBodyProperties(
  operation: AgentOperationManifestEntry,
  body: unknown,
): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const declared = declaredJsonBodyProperties(operation);
  if (!declared) return;
  const unknown = Object.keys(body).filter((key) => !declared.has(key)).sort();
  if (unknown.length === 0) return;
  throw new AgentDispatchError(
    "unknown_body_property",
    `Unknown body property '${unknown[0]}'. Allowed properties: ${[...declared].sort().join(", ")}.`,
  );
}

export function buildInternalRequest(
  operation: AgentOperationManifestEntry,
  input: AgentOperationInput,
  env: Env,
  requestId: string,
): Request {
  // `continuation` describes a typed response handoff. Its initiating HTTP
  // request is still the operation's ordinary JSON request; only raw uploads
  // require a separate request transport.
  if (operation.transport !== "json" && operation.transport !== "continuation") {
    throw new AgentDispatchError(
      "unsupported_transport",
      "This operation requires a dedicated transport flow",
      409,
    );
  }
  if (operation.idempotency === "required" && !input.idempotencyKey) {
    throw new AgentDispatchError(
      "idempotency_key_required",
      "This operation requires an idempotency key",
    );
  }
  if (input.idempotencyKey && operation.idempotency === "none") {
    throw new AgentDispatchError(
      "idempotency_not_supported",
      "This operation does not support an idempotency key",
    );
  }

  const method = operation.method.toUpperCase();
  if ((method === "GET" || method === "HEAD") && input.body !== undefined) {
    throw new AgentDispatchError("body_not_allowed", `${method} operations do not accept a body`);
  }

  let body: string | undefined;
  if (input.body !== undefined) {
    validateAgentJsonBodyProperties(operation, input.body);
    try {
      body = JSON.stringify(input.body);
    } catch {
      throw new AgentDispatchError("invalid_json_body", "Operation body must be JSON serializable");
    }
    if (body === undefined) {
      throw new AgentDispatchError("invalid_json_body", "Operation body must be JSON serializable");
    }
    if (utf8ByteLength(body) > AGENT_MAX_REQUEST_BODY_BYTES) {
      throw new AgentDispatchError("body_too_large", "Operation body exceeds the 1 MiB limit", 413);
    }
  }

  const url = buildAgentOperationUrl(
    requireCanonicalApiOrigin(env),
    operation.pathTemplate,
    input,
  );
  const headers = new Headers({
    Accept: "application/json",
    "X-Request-ID": requestId,
  });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (input.idempotencyKey) headers.set("Idempotency-Key", input.idempotencyKey);

  return new Request(url, { method, headers, body });
}

async function readBoundedResponse(
  response: Response,
  limit: number,
): Promise<{ text: string; contentType: string | null }> {
  if (response.body === null) {
    return { text: "", contentType: response.headers.get("Content-Type") };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new AgentDispatchError(
          "response_too_large",
          "Operation result exceeds its declared response limit",
          502,
        );
      }
      chunks.push(value);
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
  return {
    text: new TextDecoder().decode(bytes),
    contentType: response.headers.get("Content-Type"),
  };
}

function parseBoundedResponseBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentDispatchError(
        "invalid_operation_response",
        "Operation returned invalid JSON",
        502,
      );
    }
  }
  return text;
}

export type AgentOperationOutputPolicy = "normal" | "redacted" | "one-time-secret";

const ONE_TIME_SECRET_OPERATION_IDS = new Set([
  "dashboard.agent_access.tokens.create",
  "dashboard.agent_access.tokens.rotate",
]);
const ONE_TIME_SECRET_MAX_RESPONSE_BYTES = 16 * 1024;

export function getAgentOperationOutputPolicy(
  operation: AgentOperationManifestEntry,
): AgentOperationOutputPolicy {
  if (!operation.oneTimeSecretOutput) {
    return operation.sensitiveOutput ? "redacted" : "normal";
  }
  if (
    !ONE_TIME_SECRET_OPERATION_IDS.has(operation.operationId) ||
    !operation.sensitiveOutput ||
    operation.surface !== "dashboard" ||
    operation.exposure !== "execute" ||
    operation.principals.length !== 1 ||
    operation.principals[0] !== "admin" ||
    operation.transport !== "json" ||
    operation.idempotency !== "none" ||
    operation.revision !== "none" ||
    operation.batch !== "forbidden" ||
    operation.maxResponseBytes > ONE_TIME_SECRET_MAX_RESPONSE_BYTES
  ) {
    throw new AgentDispatchError(
      "invalid_one_time_secret_policy",
      "Operation output policy is invalid",
      500,
    );
  }
  return "one-time-secret";
}

export function shapeAgentOperationOutput(
  operation: AgentOperationManifestEntry,
  responseOk: boolean,
  text: string,
  contentType: string | null,
): Pick<AgentOperationResult, "data" | "redacted" | "oneTimeSecret"> {
  const policy = getAgentOperationOutputPolicy(operation);
  if (policy === "redacted" || (policy === "one-time-secret" && !responseOk)) {
    return { data: null, redacted: true };
  }
  const data = parseBoundedResponseBody(text, contentType);
  return policy === "one-time-secret"
    ? { data, oneTimeSecret: true }
    : { data };
}

export function shapeSensitiveContinuation(
  operation: AgentOperationManifestEntry,
  responseOk: boolean,
  text: string,
  contentType: string | null,
  env: Pick<Env, "STOREFRONT_URL">,
): Pick<AgentOperationResult, "data" | "redacted" | "sensitiveContinuation"> {
  const policy = operation.continuationOutput;
  if (
    !policy ||
    operation.exposure !== "continuation" ||
    operation.transport !== "continuation" ||
    operation.batch !== "forbidden" ||
    !operation.sensitiveOutput ||
    operation.oneTimeSecretOutput ||
    operation.artifactOutput ||
    operation.requiredClientAction ||
    policy.method !== "POST"
  ) {
    throw new AgentDispatchError(
      "invalid_continuation_policy",
      "Operation continuation policy is invalid",
      500,
    );
  }
  if (!responseOk) return { data: null, redacted: true };
  const parsed = parseBoundedResponseBody(text, contentType);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentDispatchError(
      "invalid_continuation_response",
      "Operation returned an invalid continuation",
      502,
    );
  }
  const envelope = parsed as { data?: unknown };
  const readPointer = (value: unknown, pointer: string): unknown => {
    if (!pointer.startsWith("/")) return undefined;
    let current = value;
    for (const rawSegment of pointer.slice(1).split("/")) {
      const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (["__proto__", "prototype", "constructor"].includes(segment)) return undefined;
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  };
  const actionUrl = readPointer(envelope, policy.urlJsonPointer);
  const actionFields = readPointer(envelope, policy.fieldsJsonPointer);
  if (
    typeof actionUrl !== "string" ||
    typeof actionFields !== "object" ||
    actionFields === null ||
    Array.isArray(actionFields)
  ) {
    throw new AgentDispatchError(
      "invalid_continuation_response",
      "Operation returned an invalid continuation",
      502,
    );
  }
  let url: URL;
  let storefrontOrigin: string;
  try {
    url = new URL(actionUrl);
    const storefront = new URL(env.STOREFRONT_URL?.trim() ?? "");
    if (storefront.protocol !== "https:" && storefront.hostname !== "localhost") throw new Error();
    storefrontOrigin = storefront.origin;
  } catch {
    throw new AgentDispatchError(
      "invalid_continuation_response",
      "Operation returned an unsafe continuation URL",
      502,
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.protocol !== "https:" ||
    url.origin !== storefrontOrigin
  ) {
    throw new AgentDispatchError(
      "invalid_continuation_response",
      "Operation returned an unsafe continuation URL",
      502,
    );
  }
  const fields = actionFields as Record<string, unknown>;
  if (policy.sensitiveFields.some((field) => typeof fields[field] !== "string")) {
    throw new AgentDispatchError(
      "invalid_continuation_response",
      "Operation returned invalid continuation fields",
      502,
    );
  }
  for (const value of Object.values(fields)) {
    const hasUnsafeControl = typeof value === "string" && [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13;
    });
    if (typeof value !== "string" || value.length > 512 || hasUnsafeControl) {
      throw new AgentDispatchError(
        "invalid_continuation_response",
        "Operation returned invalid continuation fields",
        502,
      );
    }
  }
  return {
    data: {
      continuation: {
        url: url.href,
        method: "POST",
        fields,
      },
    },
    sensitiveContinuation: true,
  };
}

async function hashIdempotencyPrefix(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export async function dispatchAgentOperation(
  options: DispatchAgentOperationOptions,
): Promise<AgentOperationResult> {
  const { operation, input, env, ctx } = options;
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const backend = await loadAgentAccessBackend();
  let principal = options.principal;
  let auditOutcome: "success" | "denied" | "failed" = "failed";
  let auditStatus: number | null = null;
  let auditErrorClass: string | null = null;

  try {
    if (operation.exposure !== "execute" && operation.exposure !== "continuation") {
      throw new AgentDispatchError("operation_not_executable", "Operation is not executable", 404);
    }
    if (operation.surface !== principal.resource) {
      throw new AgentDispatchError("wrong_resource", "Operation is not available on this resource", 403);
    }
    // Generated-manifest validation is authoritative, but re-check the
    // one-time response shape here so a malformed runtime entry fails before
    // any credential mutation can execute.
    if (!(operation.exposure === "continuation" && operation.sensitiveOutput)) {
      getAgentOperationOutputPolicy(operation);
    }

    // Search/describe authorization is only advisory. Resolve relational
    // authority again immediately before every actual Hono dispatch.
    const freshPrincipal = await backend.resolvePrincipal(
      {
        grantId: principal.grantId,
        credentialId: principal.credentialId ?? undefined,
        resource: principal.resource,
      },
      env,
    );
    if (!freshPrincipal) {
      throw new AgentDispatchError("grant_inactive", "Agent grant is inactive", 401);
    }
    principal = freshPrincipal;
    if (!(await backend.authorizeOperation(
      principal,
      manifestAuthorizationInput(operation),
      env,
    ))) {
      throw new AgentDispatchError("operation_forbidden", "Operation is not authorized", 403);
    }
    if (!(await checkAgentRateLimit(env, `grant:${principal.grantId}`))) {
      throw new AgentDispatchError("rate_limited", "Agent request rate limit exceeded", 429);
    }

    const internalRequest = buildInternalRequest(operation, input, env, requestId);
    const { default: app } = await import("../app");
    // No bearer/cookie is forwarded. The Worker-created ExecutionContext is
    // the non-spoofable bridge; Hono auth resolves its verified OAuth props
    // to a fresh principal instead of accepting a synthetic HTTP header.
    let response: Response;
    try {
      response = await app.fetch(
        internalRequest,
        withAgentDispatchPrincipal(env, principal),
        ctx,
      );
    } catch {
      throw new AgentDispatchError(
        "operation_dispatch_failed",
        "Operation dispatch is temporarily unavailable",
        502,
      );
    }
    auditStatus = response.status;
    auditOutcome = response.ok ? "success" : response.status === 401 || response.status === 403
      ? "denied"
      : "failed";

    if (operation.artifactOutput) {
      if (!response.ok) {
        // Error bodies from export routes may contain sensitive implementation
        // details and are not useful as artifacts.
        return {
          operationId: operation.operationId,
          status: response.status,
          ok: false,
          requestId,
          contentType: response.headers.get("Content-Type"),
          data: null,
          redacted: true,
        };
      }
      const artifact = await stageAgentArtifact(operation, response, principal, env);
      return {
        operationId: operation.operationId,
        status: response.status,
        ok: true,
        requestId,
        contentType: artifact.mediaType,
        data: null,
        artifact,
      };
    }

    const { text, contentType } = await readBoundedResponse(
      response,
      clampAgentResultBytes(operation.maxResponseBytes),
    );

    return {
      operationId: operation.operationId,
      status: response.status,
      ok: response.ok,
      requestId,
      contentType,
      ...(operation.exposure === "continuation" && operation.sensitiveOutput
        ? shapeSensitiveContinuation(operation, response.ok, text, contentType, env)
        : shapeAgentOperationOutput(operation, response.ok, text, contentType)),
    };
  } catch (error) {
    const dispatchError = error instanceof AgentDispatchError
      ? error
      : error instanceof AgentArtifactDeliveryError
        ? new AgentDispatchError(error.code, error.message, error.status)
      : new AgentDispatchError("operation_failed", "Operation execution failed", 500);
    auditStatus = dispatchError.status;
    auditOutcome = dispatchError.status === 401 || dispatchError.status === 403
      ? "denied"
      : "failed";
    auditErrorClass = dispatchError.code;
    throw dispatchError;
  } finally {
    try {
      await backend.writeAudit({
        grantId: principal.grantId,
        credentialId: principal.credentialId,
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        operationId: operation.operationId,
        risk: operation.risk,
        outcome: auditOutcome,
        httpStatus: auditStatus,
        errorClass: auditErrorClass,
        durationMs: Date.now() - startedAt,
        requestId,
        idempotencyKeyHashPrefix: await hashIdempotencyPrefix(input.idempotencyKey),
        metadata: { transport: operation.transport },
      }, env);
    } catch {
      // Never turn an already-committed domain operation into an apparent
      // execution failure because its secondary audit write was unavailable.
    }
  }
}
