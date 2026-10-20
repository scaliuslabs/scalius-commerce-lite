// `ctx.api.call(operationId, input)`: a plugin's `/api/v1` operation call,
// dispatched in-process exactly as an agent's (agent-access/dispatch.ts) but
// as the plugin principal. The result is the route's own response, unwrapped
// from the `{ success, data }` envelope; refusals are results, not throws.
// A third-party app reaches the stable app API only (`x-scalius-agent.stability`);
// anything else refuses with `api.operation_not_stable`. Buyer contact fields
// the grant does not reveal read null (protected-response.ts, H5). The input's
// `idempotencyKey` is sent as the Idempotency-Key header: the one retry key
// every stable mutation takes.

import type { Database } from "@scalius/database/client";
import type { PluginApiCallInput, PluginApiResult } from "@scalius/plugin-sdk";
import {
  AgentDispatchError,
  dispatchOperationAs,
  type AgentInputPrimitive,
  type AgentOperationInput,
  type OperationDispatchAuthority,
} from "../agent-access/dispatch";
import { writeAgentAuditEvent } from "../agent-access/audit";
import { resolveAgentOperationById } from "../agent-access/direct-operation";
import type { PluginPrincipal } from "../agent-access/types";
import { authorizePluginOperation, pluginTierAllows, pluginWithinRateLimit, resolvePluginPrincipal } from "./authority";
import { redactOperationResponse } from "./protected-response";
import { IDEMPOTENCY_KEY_PATTERN } from "../routes/admin/idempotency";

const OPERATION_ID = /^(?:dashboard(\.[a-z][a-z0-9_]*){2,}|objects\.(?:types\.(?:list|get|create|update|delete)|list|get|upsert|delete))$/;

function refusal(status: number, code: string, message: string): PluginApiResult<never> {
  return { ok: false, status, data: null, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The plugin's input as the dispatcher takes it, or a message saying what is wrong. */
export function normalizePluginApiInput(input: unknown): AgentOperationInput | string {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) return "The input is an object with path, query, body and idempotencyKey.";
  const allowed = new Set(["path", "query", "body", "idempotencyKey"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) return `Unknown input property "${extra}".`;
  const normalized: AgentOperationInput = {};
  if (input.path !== undefined) {
    if (!isRecord(input.path)) return "path is an object of strings and numbers.";
    const path: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(input.path)) {
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return `path.${key} must be a string or number.`;
      path[key] = value;
    }
    normalized.path = path;
  }
  if (input.query !== undefined) {
    if (!isRecord(input.query)) return "query is an object of strings, numbers and booleans.";
    const query: Record<string, AgentInputPrimitive> = {};
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
        return `query.${key} must be a string, number, boolean or null.`;
      }
      query[key] = value;
    }
    normalized.query = query;
  }
  if (input.body !== undefined) normalized.body = input.body;
  // The operation's Idempotency-Key header: every stable mutation takes it
  // and replays its first response for 24 hours (routes/admin/idempotency.ts).
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      return "idempotencyKey is 8 to 200 printable characters.";
    }
    normalized.idempotencyKey = input.idempotencyKey;
  }
  return normalized;
}

export function createPluginDispatchAuthority(db: Database): OperationDispatchAuthority<PluginPrincipal> {
  return {
    refresh: async (principal) => {
      const fresh = await resolvePluginPrincipal(db, principal.pluginId);
      return fresh && fresh.version === principal.version ? { ...fresh, operator: principal.operator } : null;
    },
    authorize: async (principal, operation) => authorizePluginOperation(principal, operation),
    surface: () => "dashboard",
    withinRateLimit: (principal, env) => pluginWithinRateLimit(env, "api", principal.pluginId),
    inactive: { code: "plugin_inactive", message: "The plugin is not active." },
    auditActor: (principal) => ({
      grantId: null,
      credentialId: null,
      ownerUserId: principal.actorUserId,
      resource: "dashboard",
      pluginId: principal.pluginId,
    }),
    writeAudit: (event) => writeAgentAuditEvent(db, event),
  };
}

/** The route's JSON envelope as the plugin sees it. */
function unwrap(status: number, ok: boolean, body: unknown): PluginApiResult {
  if (isRecord(body) && typeof body.success === "boolean") {
    if (body.success) return { ok, status, data: body.data ?? null, error: null };
    const error = isRecord(body.error) ? body.error : {};
    return {
      ok: false,
      status,
      data: null,
      error: {
        // A route's schema refusal carries no code, only the ZodError name;
        // name it as the MCP and the SDK's createContractApi do.
        code: typeof error.code === "string"
          ? error.code
          : error.name === "ZodError" ? "VALIDATION_ERROR" : "ERROR",
        message: typeof error.message === "string" ? error.message : "The operation failed.",
      },
    };
  }
  return ok
    ? { ok, status, data: body ?? null, error: null }
    : { ok, status, data: null, error: { code: "ERROR", message: "The operation failed." } };
}

export async function callPluginOperation(options: {
  pluginId: string;
  version: string;
  operator?: PluginPrincipal["operator"];
  operationId: unknown;
  input: PluginApiCallInput | unknown;
  db: Database;
  env: Env;
  ctx: ExecutionContext;
}): Promise<PluginApiResult> {
  if (typeof options.operationId !== "string" || !OPERATION_ID.test(options.operationId)) {
    return refusal(404, "api.unknown_operation", "Plugins call dashboard or objects operations by their reviewed id.");
  }
  const operation = resolveAgentOperationById(options.operationId);
  if (!operation) return refusal(404, "api.unknown_operation", `Unknown operation ${options.operationId}.`);
  const input = normalizePluginApiInput(options.input);
  if (typeof input === "string") return refusal(400, "api.invalid_input", input);
  const principal = await resolvePluginPrincipal(options.db, options.pluginId);
  if (!principal || principal.version !== options.version) {
    return refusal(401, "installation.inactive", "The plugin is not active.");
  }
  try {
    const result = await dispatchOperationAs(createPluginDispatchAuthority(options.db), {
      operation,
      input,
      principal: { ...principal, operator: options.operator },
      env: options.env,
      ctx: options.ctx,
    });
    // Buyer contact fields the grant does not reveal read as null (H5).
    const body = result.ok ? redactOperationResponse(operation, result.data, principal.protectedData) : result.data;
    return unwrap(result.status, result.ok, body);
  } catch (error) {
    if (error instanceof AgentDispatchError) {
      if (error.code === "operation_forbidden" && !pluginTierAllows(principal.firstParty, operation.stability)) {
        return refusal(403, "api.operation_not_stable", `${operation.operationId} is not part of the stable app API.`);
      }
      const code = error.code === "operation_forbidden" ? "api.operation_forbidden" : error.code;
      return refusal(error.status, code, error.message);
    }
    return refusal(500, "internal", "The operation could not be completed.");
  }
}
