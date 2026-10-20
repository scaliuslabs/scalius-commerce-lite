// The one error envelope every MCP tool failure carries (MCP `isError: true`,
// the same JSON the CLI prints on stderr): what failed, whether retrying can
// help, the next call that fixes it, and on a 409 the current state to retry
// against. Bounded to 600 bytes so an error never costs more than its answer.

import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { AgentDispatchError, type AgentOperationResult } from "../dispatch";
import { utf8ByteLength } from "../limits";

export const AGENT_ERROR_MAX_BYTES = 600;

export interface AgentToolError {
  code: string;
  status: number;
  message: string;
  retryable: boolean;
  hint: string;
  /** Present on every 409: the current state to retry against, or null when the route did not say. */
  current?: Record<string, unknown> | null;
  /** The input field at fault (`body.name`, `path.id`, `query.limit`). */
  field?: string | null;
  retryAfterMs?: number;
  requestId?: string;
  operationId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A sibling operation of the same resource (`dashboard.products.get` for `dashboard.products.update`). */
function siblingOperation(operationId: string | undefined, names: readonly string[]): string | null {
  if (!operationId) return null;
  const prefix = operationId.slice(0, operationId.lastIndexOf("."));
  for (const name of names) {
    const candidate = AGENT_OPERATIONS_BY_ID[`${prefix}.${name}`];
    if (candidate && candidate.risk === "read") return candidate.operationId;
  }
  return null;
}

const READ_SIBLINGS = ["get", "get_section", "get_status", "list"] as const;
const LIST_SIBLINGS = ["list", "search", "lookup", "get"] as const;

function lowerCode(code: string): string {
  return code.toLowerCase();
}

/** Current-state facts a conflict body carries (`currentRevision`, `currentVersion`, ids). */
function conflictCurrent(details: unknown): Record<string, unknown> | null {
  if (!isRecord(details)) return null;
  const current: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^current[A-Z]/.test(key) && key !== "current") continue;
    if (value === undefined) continue;
    const name = key === "current" ? "value" : key.charAt(7).toLowerCase() + key.slice(8);
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean" || value === null) {
      current[name] = value;
    } else if (isRecord(value)) {
      for (const [inner, innerValue] of Object.entries(value).slice(0, 6)) {
        if (["number", "string", "boolean"].includes(typeof innerValue)) current[inner] = innerValue;
      }
    }
  }
  return Object.keys(current).length > 0 ? current : null;
}

interface ValidationIssue {
  path?: unknown;
  message?: unknown;
  expected?: unknown;
  received?: unknown;
}

function validationIssue(error: Record<string, unknown>): { field: string; message: string } | null {
  const sources = [error, isRecord(error.details) ? error.details : null, isRecord(error.error) ? error.error : null];
  for (const source of sources) {
    if (!source) continue;
    const issues = Array.isArray(source.issues) ? source.issues as ValidationIssue[] : null;
    const issue = issues?.find((candidate) => isRecord(candidate));
    if (issue) {
      const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
      const expected = typeof issue.expected === "string" ? issue.expected : null;
      const received = typeof issue.received === "string" ? issue.received : null;
      const message = typeof issue.message === "string" ? issue.message : "Invalid value";
      return {
        field: path ? `body.${path}` : "body",
        message: expected && received ? `${message} (expected ${expected}, got ${received})` : message,
      };
    }
    if (isRecord(source.fieldErrors)) {
      const [name, messages] = Object.entries(source.fieldErrors)[0] ?? [];
      if (name) {
        return {
          field: `body.${name}`,
          message: Array.isArray(messages) && typeof messages[0] === "string" ? messages[0] : "Invalid value",
        };
      }
    }
    if (typeof source.field === "string") {
      return { field: `body.${source.field}`, message: typeof source.message === "string" ? source.message : "Invalid value" };
    }
  }
  return null;
}

function permissionOf(operation: AgentOperationManifestEntry | undefined): string | null {
  if (!operation) return null;
  const rbac = operation.rbac;
  if (rbac.type === "permission") return rbac.permission;
  if (rbac.type === "allOf") return rbac.permissions.join(" + ");
  if (rbac.type === "anyOf") return rbac.permissions.slice(0, 2).join(" or ");
  if (rbac.type === "allowAnyAdmin") return "Super Admin";
  return null;
}

/** The recovery fields for one failure: everything but code/status/message. */
export function recoveryFor(input: {
  code: string;
  status: number;
  operationId?: string;
  details?: unknown;
  retryAfterMs?: number;
}): Pick<AgentToolError, "retryable" | "hint" | "current" | "field" | "retryAfterMs"> {
  const { status, operationId } = input;
  const code = lowerCode(input.code);
  const operation = operationId ? AGENT_OPERATIONS_BY_ID[operationId] : undefined;
  const read = siblingOperation(operationId, READ_SIBLINGS);

  if (code === "confirmation_required") {
    return {
      retryable: true,
      hint: "Ask the merchant to open confirmation.approvalUrl and approve confirmation.summary. After they approve, call scalius_write again with the same input and approvalId.",
    };
  }
  if (code === "confirmation_declined") {
    return { retryable: false, hint: "The merchant did not approve. Do not retry unless they ask for the change again." };
  }
  if (code.startsWith("approval_")) {
    return {
      retryable: false,
      hint: code === "approval_used"
        ? "An approval works once. Repeat the change without approvalId for a new approval link."
        : "The approval does not match this connection, operation and input, was declined, or expired. Repeat the change without approvalId for a new approval link.",
      ...(status === 409 ? { current: null } : {}),
    };
  }
  if (status === 401 || code === "unauthorized" || code === "grant_inactive") {
    return { retryable: false, hint: "The connection is inactive or expired. Reconnect (scalius auth login, or the client's OAuth sign-in)." };
  }
  if (status === 403 || code === "operation_forbidden" || code === "wrong_resource") {
    const permission = permissionOf(operation);
    return {
      retryable: false,
      hint: permission
        ? `This grant lacks ${permission}. A Super Admin can widen it in Settings > Agent access.`
        : "This grant cannot run this operation. A Super Admin can widen it in Settings > Agent access.",
    };
  }
  if (code === "operation_not_found") {
    return { retryable: false, hint: "Call scalius_search for an operation this connection can run; never guess ids." };
  }
  if (code === "operation_risk_mismatch") {
    return { retryable: false, hint: "Run risk read operations with scalius_read and every other operation with scalius_write." };
  }
  if (code === "dry_run_unsupported") {
    return { retryable: false, hint: read ? `Read ${read} to see the current state, then write.` : "Read the current state first, then write." };
  }
  if (code === "rate_limited" || status === 429) {
    const wait = input.retryAfterMs ?? retryAfterFromDetails(input.details) ?? 60_000;
    return { retryable: true, retryAfterMs: wait, hint: `Wait ${Math.ceil(wait / 1000)} s, then retry the same call.` };
  }
  if (code === "idempotency_in_progress") {
    return {
      retryable: true,
      retryAfterMs: 2_000,
      current: null,
      hint: "The same request is still running. Wait 2 s and retry with the same idempotencyKey.",
    };
  }
  if (code === "idempotency_key_reused") {
    return { retryable: false, field: "idempotencyKey", hint: "This key was used for a different request. Omit idempotencyKey (one is generated) or use a new one." };
  }
  if (status === 409) {
    const current = conflictCurrent(input.details);
    const revisionConflict = /revision|version|stale/.test(code) || (current !== null && Object.keys(current).some((key) => /revision|version/i.test(key)));
    if (revisionConflict) {
      return {
        retryable: true,
        current,
        hint: read
          ? `Read ${read} for the current revision, reapply only the requested change, and retry with it.`
          : "Reread the resource for its current revision, reapply only the requested change, and retry with it.",
      };
    }
    return {
      retryable: false,
      current,
      hint: read ? `The resource is in a conflicting state. Read ${read}, then decide with the merchant.` : "The resource is in a conflicting state. Reread it, then decide with the merchant.",
    };
  }
  if (code === "missing_path_parameter" || code === "unknown_path_parameter") {
    return { retryable: false, hint: `Pass exactly the path parameters scalius_describe lists for ${operationId ?? "the operation"}.` };
  }
  if (code === "unknown_body_property") {
    return { retryable: false, hint: "Remove the property; scalius_describe lists the accepted body fields." };
  }
  if (code === "body_too_large" || status === 413) {
    return { retryable: false, hint: "Send at most 1 MiB per call; split the change into smaller steps." };
  }
  if (code === "invalid_step_reference" || code === "duplicate_step_id") {
    return { retryable: false, hint: "A $step reference must name an earlier step id and a JSON pointer into its data." };
  }
  if (code === "response_too_large") {
    return { retryable: false, hint: "The result is over its limit. Narrow it with select, limit or filters." };
  }
  if (status === 404) {
    const list = siblingOperation(operationId, LIST_SIBLINGS);
    return { retryable: false, hint: list ? `Nothing has that id. Resolve the id with ${list}.` : "Nothing has that id. Resolve it with a list or search read first." };
  }
  if (status === 400 || status === 422) {
    return { retryable: false, hint: `Fix the input; scalius_describe ${operationId ?? "<operationId>"} shows the accepted shape and an example.` };
  }
  if (status >= 500) {
    const write = operation ? operation.risk !== "read" : false;
    return {
      retryable: true,
      retryAfterMs: 2_000,
      hint: write
        ? "Temporary failure. Reread before retrying a write, or retry with the same idempotencyKey."
        : "Temporary failure. Retry in a few seconds.",
    };
  }
  return { retryable: false, hint: "See message." };
}

function retryAfterFromDetails(details: unknown): number | undefined {
  if (!isRecord(details)) return undefined;
  const seconds = details.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

/** Fits the envelope into its byte budget: message first, then hint, then current. */
function bounded(error: AgentToolError): AgentToolError {
  const fits = (candidate: AgentToolError) => utf8ByteLength(JSON.stringify({ ok: false, error: candidate })) <= AGENT_ERROR_MAX_BYTES;
  let candidate = { ...error, code: error.code.slice(0, 64) };
  if (fits(candidate)) return candidate;
  for (const length of [240, 160, 96, 48]) {
    candidate = { ...candidate, message: candidate.message.slice(0, length) };
    if (fits(candidate)) return candidate;
  }
  candidate = { ...candidate, hint: candidate.hint.slice(0, 160) };
  if (fits(candidate)) return candidate;
  if (candidate.current) candidate = { ...candidate, current: null };
  if (fits(candidate)) return candidate;
  return { ...candidate, hint: candidate.hint.slice(0, 80), field: candidate.field?.slice(0, 48) ?? null };
}

export function buildAgentToolError(input: {
  code: string;
  status: number;
  message: string;
  operationId?: string;
  requestId?: string;
  details?: unknown;
  field?: string | null;
  retryAfterMs?: number;
}): AgentToolError {
  const recovery = recoveryFor(input);
  const error: AgentToolError = {
    code: input.code || "agent_tool_failed",
    status: input.status,
    message: input.message || "Agent tool execution failed",
    retryable: recovery.retryable,
    hint: recovery.hint,
    ...(input.status === 409 ? { current: recovery.current ?? null } : {}),
    ...(input.field ?? recovery.field ? { field: input.field ?? recovery.field } : {}),
    ...(recovery.retryAfterMs !== undefined ? { retryAfterMs: recovery.retryAfterMs } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
  };
  return bounded(error);
}

const FIELD_FROM_MESSAGE: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^Missing path parameter: (\w+)/, (match) => `path.${match[1]}`],
  [/^Unknown path parameter: (\w+)/, (match) => `path.${match[1]}`],
  [/^Unknown body property '([^']+)'/, (match) => `body.${match[1]}`],
];

export function errorFromDispatch(error: AgentDispatchError, operationId?: string): AgentToolError {
  let field: string | null = null;
  for (const [pattern, toField] of FIELD_FROM_MESSAGE) {
    const match = error.message.match(pattern);
    if (match) field = toField(match);
  }
  if (error.code === "idempotency_key_required") field = "idempotencyKey";
  return buildAgentToolError({
    code: error.code,
    status: error.status,
    message: error.message,
    operationId,
    field,
  });
}

/** A failed route response (`ok:false`): the route's own code and details mapped to the envelope. */
export function errorFromOperationResult(result: AgentOperationResult): AgentToolError {
  const body = isRecord(result.data) ? result.data : null;
  const routeError = body && isRecord(body.error) ? body.error : null;
  const code = routeError && typeof routeError.code === "string"
    ? routeError.code
    : routeError && routeError.name === "ZodError"
      ? "VALIDATION_ERROR"
      : `http_${result.status}`;
  const message = routeError && typeof routeError.message === "string"
    ? routeError.message
    : result.redacted
      ? "The operation failed; its error body is withheld."
      : `The operation failed with HTTP ${result.status}.`;
  const issue = routeError ? validationIssue(routeError) : null;
  return buildAgentToolError({
    code,
    status: result.status,
    message: issue && /^invalid|validation/i.test(message) ? `${message}: ${issue.message}` : message,
    operationId: result.operationId,
    requestId: result.requestId,
    details: routeError?.details,
    field: issue?.field ?? null,
    retryAfterMs: result.retryAfterMs,
  });
}

export function errorFromUnknown(error: unknown, operationId?: string): AgentToolError {
  if (error instanceof AgentDispatchError) return errorFromDispatch(error, operationId);
  if (error instanceof Error && error.message.startsWith("Reference ")) {
    return buildAgentToolError({ code: "invalid_step_reference", status: 400, message: error.message, operationId });
  }
  return buildAgentToolError({ code: "agent_tool_failed", status: 500, message: "Agent tool execution failed", operationId });
}

export function agentErrorResult(error: AgentToolError, extra: Record<string, unknown> = {}) {
  const value = { ok: false as const, error, ...extra };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
