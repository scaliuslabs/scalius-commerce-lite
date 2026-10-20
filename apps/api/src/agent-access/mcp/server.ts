import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  acceptedContent,
  inputRequired,
} from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { getDb } from "@scalius/database/client";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { loadAgentAccessBackend } from "../backend";
import {
  AgentDispatchError,
  buildAgentRequiredClientAction,
  buildInternalRequest,
  dispatchAgentOperation,
  type AgentConfirmation,
  type AgentOperationInput,
  type AgentOperationResult,
} from "../dispatch";
import {
  AGENT_MAX_BATCH_STEPS,
  AGENT_MAX_PARALLEL_READS,
  AGENT_MAX_RESULT_BYTES,
  checkAgentRateLimit,
} from "../limits";
import type { AgentOAuthProps, AgentPrincipal, AgentResource } from "../types";
import { isAgentOAuthProps } from "./auth";
import { createAgentBrowserHandoff } from "../browser-handoffs";
import {
  AgentApprovalPendingError,
  APPROVAL_ID_PATTERN,
  redeemAgentApproval,
  requestAgentApproval,
} from "../approvals";
import {
  confirmBinding,
  confirmSummary,
  consumeConfirmToken,
  isConfirmGated,
  mintConfirmToken,
  readAgentConfirmPolicy,
  type ConfirmStep,
} from "./confirm";
import { loadStoreContext, storeContextLine } from "./context";
import { describeForAgent, dryRunSupportOf } from "./describe";
import {
  agentErrorResult,
  buildAgentToolError,
  errorFromOperationResult,
  errorFromUnknown,
  type AgentToolError,
} from "./errors";
import { getAuthorizedOperation } from "./operations";
import { registerAgentPrompts } from "./prompts";
import {
  AGENT_STEP_ID_PATTERN,
  AGENT_STEP_POINTER_PATTERN,
  containsStepReference,
  resolveStepReferences,
} from "./references";
import { registerAgentResources } from "./resources";
import { searchCapabilities } from "./search";
import {
  AGENT_MAX_SELECT_POINTERS,
  AGENT_READ_BUDGET_BYTES,
  applyListControls,
  fitToBudget,
  jsonBytes,
  paginationMeta,
  selectPointers,
  unwrapRouteBody,
  type ShapedMeta,
} from "./shape";
import { executeAuthorizedWorkflowRead } from "./workflow-read";

// ─── Protocol ────────────────────────────────────────────────────────────────

/** 2026-07-28 first (stateless, per-request envelope); every 2025-era revision stays served. */
export const AGENT_MCP_PROTOCOL_VERSIONS = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];
const LIST_CACHE = { ttlMs: 3_600_000, cacheScope: "private" as const };
const INSTRUCTIONS_MAX_BYTES = 600;

export const AGENT_MCP_INSTRUCTIONS = "Scalius tools: scalius_search a goal, scalius_describe ids, then scalius_read or scalius_write; verify with a read. scalius_answer handles common data questions. Changes: dryRun:true first; destructive or financial ones need a person's approval (approvalUrl, then approvalId). Use only ids, revisions and amounts read from the store; money is decimal major units.";

/** The static loop plus one live store line, within 600 bytes. */
export function buildAgentInstructions(storeLine = ""): string {
  if (!storeLine) return AGENT_MCP_INSTRUCTIONS;
  const encoder = new TextEncoder();
  const room = INSTRUCTIONS_MAX_BYTES - encoder.encode(`${AGENT_MCP_INSTRUCTIONS}\n`).byteLength;
  if (room < 24) return AGENT_MCP_INSTRUCTIONS;
  let line = storeLine;
  if (encoder.encode(line).byteLength > room) {
    const characters = [...line];
    while (characters.length > 0 && encoder.encode(`${characters.join("")}...`).byteLength > room) characters.pop();
    line = `${characters.join("")}...`;
  }
  return `${AGENT_MCP_INSTRUCTIONS}\n${line}`;
}

// ─── Input schemas (listing) and strict validation (dispatch) ───────────────

const pathValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const queryValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100),
]);
const stepReferenceSchema = z.object({
  $step: z.string().regex(AGENT_STEP_ID_PATTERN),
  pointer: z.string().regex(AGENT_STEP_POINTER_PATTERN).optional(),
}).strict();
const strictInputSchema = z.object({
  path: z.record(z.string(), pathValueSchema)
    .refine((value) => Object.keys(value).length <= 50, "At most 50 path parameters are allowed").optional(),
  query: z.record(z.string(), queryValueSchema)
    .refine((value) => Object.keys(value).length <= 100, "At most 100 query parameters are allowed").optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
}).strict();
const strictStepInputSchema = z.object({
  path: z.record(z.string(), z.union([pathValueSchema, stepReferenceSchema]))
    .refine((value) => Object.keys(value).length <= 50, "At most 50 path parameters are allowed").optional(),
  query: z.record(z.string(), z.union([queryValueSchema, stepReferenceSchema]))
    .refine((value) => Object.keys(value).length <= 100, "At most 100 query parameters are allowed").optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.union([z.string().min(8).max(200), stepReferenceSchema]).optional(),
}).strict();

/** Tool arguments are shape-checked here; `strictInputSchema` validates each input before dispatch. */
const inputArgSchema = z.object({
  path: z.record(z.string(), z.unknown()).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.string().optional(),
});
const stepArgSchema = z.object({
  id: z.string().max(64),
  operationId: z.string().max(240),
  input: inputArgSchema.optional(),
});

/** One small output schema shared by every tool (2026-07-28 allows any JSON). */
const toolOutputSchema = z.object({ ok: z.boolean() }).passthrough();

type JsonSchema = Record<string, unknown>;

/**
 * A zod schema that validates, advertised in `tools/list` by a hand-written
 * JSON Schema: the listing is the token cost of every session, so it carries
 * only what a model needs to form a call; zod and the strict per-input
 * schemas still reject anything malformed.
 */
function listed<T extends z.ZodType>(schema: T, json: JsonSchema): T {
  const standard = schema["~standard"];
  return Object.create(schema, {
    "~standard": { value: { ...standard, jsonSchema: { input: () => json, output: () => json } } },
  }) as T;
}

const INPUT_JSON: JsonSchema = {
  type: "object",
  description: "{path, query, body} as scalius_describe shows",
  properties: { path: { type: "object" }, query: { type: "object" }, body: {}, idempotencyKey: { type: "string" } },
};
const stepsJson = (description: string): JsonSchema => ({
  type: "array",
  maxItems: AGENT_MAX_BATCH_STEPS,
  description,
  items: {
    type: "object",
    required: ["id", "operationId"],
    properties: {
      id: { type: "string" },
      operationId: { type: "string" },
      input: { type: "object", description: "As input; a value may be {$step: id, pointer: \"/data/..\"}" },
    },
  },
});
const OUTPUT_JSON: JsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const sharedOutputSchema = listed(toolOutputSchema, OUTPUT_JSON);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

interface McpServerDependencies {
  surface: AgentResource;
  env: Env;
  ctx: ExecutionContext;
}

// ─── Principal ───────────────────────────────────────────────────────────────

function readVerifiedProps(surface: AgentResource): AgentOAuthProps | null {
  // The handler passes the props the OAuth resource server verified into
  // createMcpHandler's authContext; getMcpAuthContext reads them back here.
  const props = getMcpAuthContext()?.props;
  if (!isAgentOAuthProps(props) || props.resource !== surface) return null;
  return props;
}

async function resolveToolPrincipal(deps: McpServerDependencies): Promise<AgentPrincipal | null> {
  const props = readVerifiedProps(deps.surface);
  if (!props) return null;
  const configuredOrigin = deps.env.PUBLIC_API_BASE_URL?.trim();
  if (!configuredOrigin) return null;
  const canonicalAudience = `${new URL(configuredOrigin).origin}/api/v1/mcp/${deps.surface}`;
  if (props.audience.length !== 1 || props.audience[0] !== canonicalAudience) return null;
  const backend = await loadAgentAccessBackend();
  return backend.resolvePrincipal(
    { grantId: props.grantId, credentialId: props.credentialId, resource: props.resource },
    deps.env,
  );
}

async function principalOrThrow(deps: McpServerDependencies): Promise<AgentPrincipal> {
  let principal: AgentPrincipal | null;
  try {
    principal = await resolveToolPrincipal(deps);
  } catch {
    principal = null;
  }
  if (!principal) throw new AgentDispatchError("unauthorized", "Agent grant is inactive", 401);
  return principal;
}

async function chargeRateLimit(deps: McpServerDependencies, principal: AgentPrincipal): Promise<void> {
  if (!(await checkAgentRateLimit(deps.env, `grant:${principal.grantId}`))) {
    throw new AgentDispatchError("rate_limited", "Agent request rate limit exceeded", 429);
  }
}

/** A principal for a tool call that dispatches nothing itself: charged once here. */
async function requireToolPrincipal(deps: McpServerDependencies): Promise<AgentPrincipal> {
  const principal = await principalOrThrow(deps);
  await chargeRateLimit(deps, principal);
  return principal;
}

// ─── Result formatting ───────────────────────────────────────────────────────

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error: unknown, operationId?: string) {
  return agentErrorResult(errorFromUnknown(error, operationId));
}

export function formatAgentBrowserHandoffResult(handoff: {
  handoffId: string;
  url: string;
  expiresAt: string;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text: "A secure browser step is ready. Open the linked Scalius page to continue; no credential is present in the URL.",
      },
      {
        type: "resource_link" as const,
        uri: handoff.url,
        name: "Continue securely in Scalius",
        mimeType: "text/html",
        description: "Short-lived, one-use handoff requiring the same 2FA-verified Scalius administrator",
      },
    ],
    structuredContent: {
      ok: true,
      status: "browser_action_required",
      handoffId: handoff.handoffId,
      expiresAt: handoff.expiresAt,
    },
  };
}

function artifactResult(result: AgentOperationResult) {
  const artifact = result.artifact!;
  return {
    content: [
      {
        type: "text" as const,
        text: `Artifact ready: ${artifact.filename} (${artifact.sizeBytes} bytes, sha256 ${artifact.sha256})`,
      },
      {
        type: "resource_link" as const,
        uri: artifact.uri,
        name: artifact.filename,
        mimeType: artifact.mediaType,
        size: artifact.sizeBytes,
        description: "One-use authenticated Scalius artifact; send the same Bearer credential",
      },
    ],
    structuredContent: {
      ok: true,
      artifact: {
        artifactId: artifact.artifactId,
        filename: artifact.filename,
        mediaType: artifact.mediaType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        expiresInSeconds: artifact.expiresInSeconds,
      },
      meta: { operationId: result.operationId, requestId: result.requestId, status: result.status },
    },
  };
}

interface ShapeOptions {
  select?: readonly string[];
  budget: number;
}

interface ShapedStep {
  ok: boolean;
  data?: unknown;
  error?: AgentToolError;
  meta: ShapedMeta & { operationId: string; requestId?: string; status?: number; replayed?: true; idempotencyKey?: string };
}

/** The route's payload, projected and bounded, with pagination as one cursor. */
function shapeOperationResult(
  operation: AgentOperationManifestEntry,
  result: AgentOperationResult,
  options: ShapeOptions,
): ShapedStep {
  if (!result.ok) {
    return { ok: false, error: errorFromOperationResult(result), meta: { operationId: operation.operationId } };
  }
  if (result.artifact) {
    const { artifact } = result;
    return {
      ok: true,
      data: { artifact: { artifactId: artifact.artifactId, filename: artifact.filename, uri: artifact.uri, sizeBytes: artifact.sizeBytes } },
      meta: { operationId: operation.operationId, requestId: result.requestId, status: result.status },
    };
  }
  const meta: ShapedStep["meta"] = {
    operationId: operation.operationId,
    requestId: result.requestId,
    status: result.status,
    ...(result.replayed ? { replayed: true as const } : {}),
  };
  if (result.oneTimeSecret) return { ok: true, data: unwrapRouteBody(result.data), meta };
  let data = unwrapRouteBody(result.data);
  Object.assign(meta, paginationMeta(operation, data));
  if (options.select && options.select.length > 0) data = selectPointers(data, options.select);
  const fitted = fitToBudget(data, options.budget, { paged: meta.nextCursor !== undefined || meta.hasMore !== undefined });
  return { ok: true, data: fitted.data, meta: { ...meta, ...fitted.meta } };
}

function stepResultValue(step: ShapedStep): Record<string, unknown> {
  return step.ok
    ? { ok: true, data: step.data, meta: step.meta }
    : { ok: false, error: step.error, meta: step.meta };
}

// ─── Operations ──────────────────────────────────────────────────────────────

type ToolMode = "read" | "write";

async function authorizedOperationFor(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  operationId: string,
  mode: ToolMode,
): Promise<AgentOperationManifestEntry> {
  const operation = await getAuthorizedOperation(operationId, deps.surface, principal);
  if (!operation) {
    throw new AgentDispatchError("operation_not_found", "Operation is unavailable or not authorized", 404);
  }
  if (mode === "read" ? operation.risk !== "read" : operation.risk === "read") {
    throw new AgentDispatchError(
      "operation_risk_mismatch",
      mode === "read"
        ? "scalius_read accepts only operations declared with risk read"
        : "scalius_write rejects operations declared with risk read",
      400,
    );
  }
  return operation;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  throw new AgentDispatchError(
    "invalid_input",
    `${label}${path ? `.${path}` : ""}: ${issue?.message ?? "invalid input"}`,
    400,
  );
}

/** Generates the idempotency key a supporting operation needs, stable for one confirmation. */
async function withIdempotencyKey(
  operation: AgentOperationManifestEntry,
  input: AgentOperationInput,
  seed?: string,
): Promise<AgentOperationInput> {
  if (operation.idempotency === "none" || input.idempotencyKey) return input;
  if (!seed) return { ...input, idempotencyKey: `agk_${crypto.randomUUID()}` };
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ...input, idempotencyKey: `agk_${hex}` };
}

interface PreparedStep {
  id: string;
  operation: AgentOperationManifestEntry;
  input: AgentOperationInput;
}

async function prepareSteps(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  steps: Array<{ id: string; operationId: string; input?: unknown }>,
  mode: ToolMode,
): Promise<PreparedStep[]> {
  if (new Set(steps.map((step) => step.id)).size !== steps.length) {
    throw new AgentDispatchError("duplicate_step_id", "Step ids must be unique", 400);
  }
  const prepared: PreparedStep[] = [];
  for (const step of steps) {
    if (!AGENT_STEP_ID_PATTERN.test(step.id)) {
      throw new AgentDispatchError("invalid_input", `Step id '${step.id.slice(0, 64)}' must start with a letter`, 400);
    }
    const operation = await authorizedOperationFor(deps, principal, step.operationId, mode);
    if (operation.batch === "forbidden" || operation.requiredClientAction || operation.exposure === "continuation") {
      throw new AgentDispatchError("batch_forbidden", `Step ${step.id} cannot run inside steps[]`, 400);
    }
    prepared.push({
      id: step.id,
      operation,
      input: parseInput(strictStepInputSchema, step.input, `steps.${step.id}.input`) as AgentOperationInput,
    });
  }
  return prepared;
}

async function dispatchStep(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  step: PreparedStep,
  input: AgentOperationInput,
  options: ShapeOptions,
  confirmedBy?: AgentConfirmation,
): Promise<ShapedStep> {
  try {
    const result = await dispatchAgentOperation({
      operation: step.operation,
      input,
      principal,
      env: deps.env,
      ctx: deps.ctx,
      ...(confirmedBy && isConfirmGated(step.operation) ? { confirmedBy } : {}),
    });
    const shaped = shapeOperationResult(step.operation, result, options);
    if (input.idempotencyKey && step.operation.idempotency !== "none") shaped.meta.idempotencyKey = input.idempotencyKey;
    return shaped;
  } catch (error) {
    return { ok: false, error: errorFromUnknown(error, step.operation.operationId), meta: { operationId: step.operation.operationId } };
  }
}

/** The value a later step's `$step` reference reads: `{ok, data}` of the earlier step. */
function referenceValue(step: ShapedStep): unknown {
  return step.ok ? { ok: true, data: step.data } : { ok: false, error: step.error };
}

async function runReadSteps(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  prepared: PreparedStep[],
  options: ShapeOptions,
  stopOnError: boolean,
): Promise<Array<[string, ShapedStep]>> {
  const completed = new Map<string, unknown>();
  const results: Array<[string, ShapedStep]> = [];
  let index = 0;
  while (index < prepared.length) {
    const wave: PreparedStep[] = [];
    while (index < prepared.length && wave.length < AGENT_MAX_PARALLEL_READS) {
      const candidate = prepared[index]!;
      if (candidate.operation.batch !== "parallel" || containsStepReference(candidate.input)) break;
      wave.push(candidate);
      index += 1;
    }
    let shaped: Array<[string, ShapedStep]>;
    if (wave.length > 0) {
      shaped = await Promise.all(wave.map(async (step) =>
        [step.id, await dispatchStep(deps, principal, step, step.input, options)] as [string, ShapedStep]));
    } else {
      const step = prepared[index]!;
      index += 1;
      let item: ShapedStep;
      try {
        const input = resolveStepReferences(step.input, completed) as AgentOperationInput;
        item = await dispatchStep(deps, principal, step, input, options);
      } catch (error) {
        item = { ok: false, error: errorFromUnknown(error, step.operation.operationId), meta: { operationId: step.operation.operationId } };
      }
      shaped = [[step.id, item]];
    }
    for (const [id, item] of shaped) {
      results.push([id, item]);
      completed.set(id, referenceValue(item));
    }
    if (stopOnError && shaped.some(([, item]) => !item.ok)) break;
  }
  return results;
}

async function runWriteSteps(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  prepared: PreparedStep[],
  options: ShapeOptions,
  confirmation: { by: AgentConfirmation; token: string } | null,
): Promise<Array<[string, ShapedStep]>> {
  const completed = new Map<string, unknown>();
  const results: Array<[string, ShapedStep]> = [];
  for (const step of prepared) {
    let item: ShapedStep;
    try {
      const resolved = resolveStepReferences(step.input, completed) as AgentOperationInput;
      const input = await withIdempotencyKey(step.operation, resolved, confirmation ? `${confirmation.token}:${step.id}` : undefined);
      item = await dispatchStep(deps, principal, step, input, options, confirmation?.by);
    } catch (error) {
      item = { ok: false, error: errorFromUnknown(error, step.operation.operationId), meta: { operationId: step.operation.operationId } };
    }
    results.push([step.id, item]);
    completed.set(step.id, referenceValue(item));
    if (!item.ok) break;
  }
  return results;
}

function stepsResult(results: Array<[string, ShapedStep]>, budget: number) {
  const steps = results.map(([id, item]) => ({ id, ...stepResultValue(item) }));
  const value: Record<string, unknown> = { ok: results.every(([, item]) => item.ok), steps };
  if (jsonBytes(value) > AGENT_MAX_RESULT_BYTES) {
    const fitted = fitToBudget(steps, Math.min(budget * 2, AGENT_MAX_RESULT_BYTES));
    return toolResult({ ok: value.ok, steps: fitted.data, meta: fitted.meta });
  }
  return toolResult(value);
}

/** A single operation's response: browser handoffs, artifacts, client actions and errors keep their own shape. */
async function singleResult(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  operation: AgentOperationManifestEntry,
  input: AgentOperationInput,
  options: ShapeOptions,
  confirmedBy?: AgentConfirmation,
) {
  if (operation.requiredClientAction) {
    await chargeRateLimit(deps, principal);
    return toolResult({ ok: true, ...buildAgentRequiredClientAction(operation, input, deps.env) });
  }
  const result = await dispatchAgentOperation({
    operation,
    input,
    principal,
    env: deps.env,
    ctx: deps.ctx,
    ...(confirmedBy ? { confirmedBy } : {}),
  });
  if (result.sensitiveContinuation === true) {
    const continuation = result.data && typeof result.data === "object"
      ? (result.data as { continuation?: unknown }).continuation
      : null;
    if (!continuation || typeof continuation !== "object") {
      throw new AgentDispatchError("invalid_continuation_response", "Operation returned an invalid continuation", 502);
    }
    const handoff = await createAgentBrowserHandoff(
      getDb(deps.env),
      principal,
      operation.operationId,
      continuation as { url: string; method: "POST"; fields: Record<string, string> },
      deps.env,
    );
    return formatAgentBrowserHandoffResult(handoff);
  }
  if (result.ok && result.artifact) return artifactResult(result);
  const shaped = shapeOperationResult(operation, result, options);
  if (!shaped.ok) return agentErrorResult(shaped.error!);
  if (input.idempotencyKey && operation.idempotency !== "none") shaped.meta.idempotencyKey = input.idempotencyKey;
  if (result.oneTimeSecret) {
    const value = { ok: true, data: shaped.data, meta: shaped.meta };
    return {
      content: [{ type: "text" as const, text: "One-time secret returned in structured content" }],
      structuredContent: value,
    };
  }
  return toolResult({ ok: true, data: shaped.data, meta: shaped.meta });
}

// ─── Confirmation ────────────────────────────────────────────────────────────

const confirmAnswerSchema = z.object({ confirm: z.boolean() });

interface ToolContextLike {
  mcpReq?: {
    envelope?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    requestState?: () => unknown;
  };
}

/** A 2026-07-28 client that declared form elicitation can show a native confirm dialog. */
function supportsFormElicitation(ctx: ToolContextLike | undefined): boolean {
  const capabilities = ctx?.mcpReq?.envelope?.["io.modelcontextprotocol/clientCapabilities"];
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const elicitation = (capabilities as { elicitation?: unknown }).elicitation;
  if (typeof elicitation !== "object" || elicitation === null) return false;
  const modes = elicitation as Record<string, unknown>;
  return Object.keys(modes).length === 0 || (typeof modes.form === "object" && modes.form !== null);
}

async function auditConfirmationRequired(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  steps: readonly ConfirmStep[],
): Promise<void> {
  const backend = await loadAgentAccessBackend();
  for (const { operation } of steps.filter((step) => isConfirmGated(step.operation))) {
    try {
      await backend.writeAudit({
        grantId: principal.grantId,
        credentialId: principal.credentialId,
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        operationId: operation.operationId,
        risk: operation.risk,
        outcome: "denied",
        httpStatus: 428,
        errorClass: "confirmation_required",
        durationMs: 0,
        requestId: crypto.randomUUID(),
        metadata: { transport: operation.transport },
      }, deps.env);
    } catch {
      // The refusal itself is the safety property; a lost audit row never turns it into a write.
    }
  }
}

type ConfirmOutcome =
  | { kind: "confirmed"; by: AgentConfirmation; token: string }
  | { kind: "respond"; result: unknown };

/**
 * Resolves the confirmation for gated steps (audit R2 F3): an approval the
 * grant's owner gave in the dashboard (redeemed once, for exactly these
 * steps), or an accepted native client dialog. A dialog counts only for an
 * OAuth app or the paired CLI, whose client shows it to a person; a personal
 * access key always gets the dashboard link. Without either, nothing is
 * dispatched: the call answers `confirmation_required` (audited) with the
 * summary and an approval link for the owner, never anything the agent could
 * redeem by itself.
 */
async function resolveConfirmation(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  steps: readonly ConfirmStep[],
  approvalId: string | undefined,
  ctx: ToolContextLike | undefined,
): Promise<ConfirmOutcome> {
  const binding = await confirmBinding(steps);
  const summary = confirmSummary(steps);
  if (approvalId) {
    try {
      await redeemAgentApproval(getDb(deps.env), deps.env, principal, approvalId, binding);
    } catch (error) {
      if (!(error instanceof AgentApprovalPendingError)) throw error;
      return {
        kind: "respond",
        result: agentErrorResult(
          buildAgentToolError({ code: "confirmation_required", status: 428, message: error.message }),
          { confirmation: error.confirmation },
        ),
      };
    }
    return { kind: "confirmed", by: "approval", token: approvalId };
  }
  const trustsClientDialog = principal.grantKind !== "pat" && supportsFormElicitation(ctx);
  if (trustsClientDialog) {
    const state = ctx?.mcpReq?.requestState?.();
    const answer = acceptedContent(ctx?.mcpReq?.inputResponses, "confirm", confirmAnswerSchema);
    if (typeof state === "string" && answer?.confirm === true) {
      await consumeConfirmToken(deps.env, principal, binding, state);
      return { kind: "confirmed", by: "elicitation", token: state };
    }
    if (typeof state === "string" && ctx?.mcpReq?.inputResponses) {
      await auditConfirmationRequired(deps, principal, steps);
      return {
        kind: "respond",
        result: agentErrorResult(buildAgentToolError({
          code: "confirmation_declined",
          status: 403,
          message: "The merchant did not approve this change.",
        })),
      };
    }
    await chargeRateLimit(deps, principal);
    // The dialog's request state: the client returns it with the person's answer.
    const minted = await mintConfirmToken(deps.env, principal, binding);
    return {
      kind: "respond",
      result: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Approve: ${summary}`,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Approve this change" } },
              required: ["confirm"],
            },
          }),
        },
        requestState: minted.confirmToken,
      }),
    };
  }
  await chargeRateLimit(deps, principal);
  await auditConfirmationRequired(deps, principal, steps);
  const link = await requestAgentApproval(getDb(deps.env), deps.env, principal, {
    binding,
    summary,
    operationIds: steps.filter((step) => isConfirmGated(step.operation)).map((step) => step.operation.operationId),
  });
  return {
    kind: "respond",
    result: agentErrorResult(
      buildAgentToolError({
        code: "confirmation_required",
        status: 428,
        message: "This change needs the merchant's approval before it runs. Ask them to open confirmation.approvalUrl, then repeat the same call with approvalId.",
      }),
      { confirmation: { summary, ...link } },
    ),
  };
}

// ─── Dry run ─────────────────────────────────────────────────────────────────

async function dryRunStep(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  step: PreparedStep,
): Promise<Record<string, unknown>> {
  const support = dryRunSupportOf(step.operation);
  if (containsStepReference(step.input)) {
    return { id: step.id, operationId: step.operation.operationId, support, validated: false, note: "Depends on an earlier step; validated when it runs." };
  }
  const input = await withIdempotencyKey(step.operation, step.input);
  // Validates path, body properties, transport and idempotency exactly as dispatch will, without sending.
  buildInternalRequest(step.operation, input, deps.env, "dry-run");
  if (support === "none") {
    const read = siblingRead(step.operation);
    return {
      id: step.id,
      operationId: step.operation.operationId,
      support: "none",
      validated: true,
      note: "Input is valid. This operation has no route preview: nothing was sent.",
      ...(read ? { verifyWith: read } : {}),
    };
  }
  const options: ShapeOptions = { budget: AGENT_READ_BUDGET_BYTES };
  if (support === "native") {
    const result = await dispatchAgentOperation({ operation: step.operation, input, principal, env: deps.env, ctx: deps.ctx, dryRun: "native" });
    const shaped = shapeOperationResult(step.operation, result, options);
    return { id: step.id, operationId: step.operation.operationId, support: "native", preview: stepResultValue(shaped) };
  }
  const previewId = support.slice("preview:".length);
  const preview = await getAuthorizedOperation(previewId, deps.surface, principal);
  if (!preview || preview.risk !== "read") {
    return { id: step.id, operationId: step.operation.operationId, support, validated: true, note: "The preview operation is not authorized for this grant." };
  }
  const { idempotencyKey: _key, ...previewInput } = input;
  const result = await dispatchAgentOperation({ operation: preview, input: previewInput, principal, env: deps.env, ctx: deps.ctx });
  const shaped = shapeOperationResult(preview, result, options);
  return { id: step.id, operationId: step.operation.operationId, support, preview: stepResultValue(shaped) };
}

function siblingRead(operation: AgentOperationManifestEntry): string | null {
  const prefix = operation.operationId.slice(0, operation.operationId.lastIndexOf("."));
  for (const name of ["get", "get_section", "list"]) {
    const candidate = AGENT_OPERATIONS_BY_ID[`${prefix}.${name}`];
    if (candidate?.risk === "read") return candidate.operationId;
  }
  return null;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const readArgsSchema = z.object({
  operationId: z.string().max(240).optional(),
  input: inputArgSchema.optional(),
  steps: z.array(stepArgSchema).max(AGENT_MAX_BATCH_STEPS).optional(),
  select: z.array(z.string().max(200)).max(AGENT_MAX_SELECT_POINTERS).optional(),
  limit: z.number().int().min(1).max(250).optional(),
  cursor: z.string().max(2048).optional(),
  maxBytes: z.number().int().min(1024).max(AGENT_MAX_RESULT_BYTES).optional(),
});
const writeArgsSchema = z.object({
  operationId: z.string().max(240).optional(),
  input: inputArgSchema.optional(),
  steps: z.array(stepArgSchema).max(AGENT_MAX_BATCH_STEPS).optional(),
  dryRun: z.boolean().optional(),
  approvalId: z.string().regex(APPROVAL_ID_PATTERN).optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});
const READ_ARGS_JSON: JsonSchema = {
  type: "object",
  properties: {
    operationId: { type: "string" },
    input: INPUT_JSON,
    steps: stepsJson("Instead of operationId: up to 20 reads"),
    select: { type: "array", maxItems: AGENT_MAX_SELECT_POINTERS, items: { type: "string" }, description: "JSON pointers to keep, e.g. /items/*/id" },
    limit: { type: "integer", minimum: 1 },
    cursor: { type: "string", description: "meta.nextCursor" },
    maxBytes: { type: "integer", description: "Result budget, default 8192, max 65536" },
  },
};
const WRITE_ARGS_JSON: JsonSchema = {
  type: "object",
  properties: {
    operationId: { type: "string" },
    input: INPUT_JSON,
    steps: stepsJson("Instead of operationId: up to 20 writes in order; stops at the first failure"),
    dryRun: { type: "boolean", description: "Validate and preview; writes nothing" },
    approvalId: { type: "string", description: "confirmation.approvalId, after the merchant approved the change at confirmation.approvalUrl" },
    idempotencyKey: { type: "string" },
  },
};

type ReadArgs = z.infer<typeof readArgsSchema>;
type WriteArgs = z.infer<typeof writeArgsSchema>;

function exactlyOne(args: { operationId?: string; steps?: unknown[] }): void {
  if ((args.operationId === undefined) === (args.steps === undefined)) {
    throw new AgentDispatchError("invalid_input", "Pass either operationId (with input) or steps", 400);
  }
  if (args.steps && args.steps.length === 0) throw new AgentDispatchError("invalid_input", "steps must not be empty", 400);
}

async function runRead(deps: McpServerDependencies, args: ReadArgs) {
  exactlyOne(args);
  const budget = args.maxBytes ?? AGENT_READ_BUDGET_BYTES;
  if (args.steps) {
    if (args.limit !== undefined || args.cursor !== undefined) {
      throw new AgentDispatchError("invalid_input", "limit and cursor apply to a single operationId; set them in each step's query", 400);
    }
    const principal = await principalOrThrow(deps);
    const prepared = await prepareSteps(deps, principal, args.steps, "read");
    const perStep = Math.max(2048, Math.floor(budget / prepared.length));
    const results = await runReadSteps(deps, principal, prepared, { select: args.select, budget: perStep }, true);
    return stepsResult(results, budget);
  }
  const principal = await principalOrThrow(deps);
  const operation = await authorizedOperationFor(deps, principal, args.operationId!, "read");
  const parsed = parseInput(strictInputSchema, args.input, "input") as AgentOperationInput;
  const input = applyListControls(operation, parsed, { limit: args.limit, cursor: args.cursor });
  return singleResult(deps, principal, operation, input, { select: args.select, budget });
}

async function runWrite(deps: McpServerDependencies, args: WriteArgs, ctx: ToolContextLike | undefined) {
  exactlyOne(args);
  const principal = await principalOrThrow(deps);
  const options: ShapeOptions = { budget: AGENT_READ_BUDGET_BYTES };
  let prepared: PreparedStep[];
  if (args.steps) {
    if (args.idempotencyKey) {
      throw new AgentDispatchError("invalid_input", "Set idempotencyKey inside each step's input", 400);
    }
    prepared = await prepareSteps(deps, principal, args.steps, "write");
  } else {
    const operation = await authorizedOperationFor(deps, principal, args.operationId!, "write");
    const input = parseInput(strictInputSchema, args.input, "input") as AgentOperationInput;
    prepared = [{
      id: "main",
      operation,
      input: args.idempotencyKey ? { ...input, idempotencyKey: args.idempotencyKey } : input,
    }];
  }
  const gated = prepared.some((step) => isConfirmGated(step.operation));
  const policy = gated ? await readAgentConfirmPolicy(deps.env, principal) : "none";
  const confirmSteps: ConfirmStep[] = prepared.map(({ operation, input }) => ({ operation, input }));

  if (args.dryRun) {
    await chargeRateLimit(deps, principal);
    const steps = [];
    for (const step of prepared) {
      try {
        steps.push(await dryRunStep(deps, principal, step));
      } catch (error) {
        return agentErrorResult(errorFromUnknown(error, step.operation.operationId));
      }
    }
    const confirmation = gated && policy !== "none"
      ? { summary: confirmSummary(confirmSteps), approvalRequired: true }
      : null;
    return toolResult({
      ok: true,
      dryRun: true,
      written: false,
      ...(args.steps ? { steps } : (({ id: _id, ...single }) => single)(steps[0]!)),
      ...(confirmation ? { confirmation } : {}),
    });
  }

  let confirmation: { by: AgentConfirmation; token: string } | null = null;
  if (gated && policy !== "none") {
    const outcome = await resolveConfirmation(deps, principal, confirmSteps, args.approvalId, ctx);
    if (outcome.kind === "respond") return outcome.result;
    confirmation = { by: outcome.by, token: outcome.token };
  }

  if (args.steps) {
    const results = await runWriteSteps(deps, principal, prepared, options, confirmation);
    return stepsResult(results, options.budget);
  }
  const step = prepared[0]!;
  const input = await withIdempotencyKey(step.operation, step.input, confirmation ? `${confirmation.token}:main` : undefined);
  return singleResult(deps, principal, step.operation, input, options, confirmation?.by);
}

export interface AgentMcpServerOptions {
  /** Instructions with the live store line; the static loop when omitted. */
  instructions?: string;
}

export function createAgentMcpServer(deps: McpServerDependencies, options: AgentMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: `scalius-${deps.surface}`,
    title: `Scalius ${deps.surface}`,
    version: "2.0.0",
  }, {
    instructions: options.instructions ?? AGENT_MCP_INSTRUCTIONS,
    supportedProtocolVersions: AGENT_MCP_PROTOCOL_VERSIONS,
    // A stateless 2025-era request cannot hold a server-to-client dialog open,
    // so confirmation falls back to the dashboard approval link there;
    // 2026-07-28 clients (not personal access keys) get the native dialog
    // through input_required.
    inputRequired: { legacyShim: false },
    cacheHints: {
      "tools/list": LIST_CACHE,
      "prompts/list": LIST_CACHE,
      "resources/list": LIST_CACHE,
      "resources/templates/list": LIST_CACHE,
      "server/discover": { ttlMs: 300_000, cacheScope: "private" },
    },
  });

  server.registerTool("scalius_search", {
    description: "Find how to do a goal: ranked reviewed workflows (a confident one inlines its plan) and operations this connection can run. Honour control hits that ask or refuse.",
    inputSchema: listed(z.object({
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(10).optional(),
    }), {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } },
    }),
    outputSchema: sharedOutputSchema,
    annotations: READ_ONLY,
  }, async ({ query, limit }) => {
    try {
      const principal = await requireToolPrincipal(deps);
      return toolResult({ ok: true, ...(await searchCapabilities({ query, limit, surface: deps.surface, principal })) });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("scalius_describe", {
    description: "How to call up to 5 operations: purpose, inputs (! = required), write rules, one example input, response fields. detail full gives the exact schemas.",
    inputSchema: listed(z.object({
      ids: z.array(z.string().max(240)).min(1).max(5),
      detail: z.enum(["compact", "full", "examples"]).optional(),
    }), {
      type: "object",
      required: ["ids"],
      properties: {
        ids: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
        detail: { enum: ["compact", "full", "examples"] },
      },
    }),
    outputSchema: sharedOutputSchema,
    annotations: READ_ONLY,
  }, async ({ ids, detail }) => {
    try {
      const principal = await requireToolPrincipal(deps);
      const operations: unknown[] = [];
      const links: Array<{ type: "resource_link"; uri: string; name: string; mimeType: string }> = [];
      for (const id of [...new Set(ids)]) {
        const operation = await getAuthorizedOperation(id, deps.surface, principal);
        if (!operation) {
          operations.push({ operationId: id, error: buildAgentToolError({ code: "operation_not_found", status: 404, message: "Operation is unavailable or not authorized" }) });
          continue;
        }
        const described = describeForAgent(operation, detail ?? "compact");
        operations.push(described.value);
        if (described.kind === "resource") links.push({ type: "resource_link", uri: described.uri, name: id, mimeType: "application/json" });
      }
      const value = { ok: true, operations };
      const result = toolResult(value);
      return links.length > 0 ? { ...result, content: [...result.content, ...links] } : result;
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("scalius_answer", {
    description: "Answer a common store-data question in one bounded call. If unavailable, the top scalius_search hits come back instead.",
    inputSchema: listed(z.object({ question: z.string().trim().min(1).max(4_000) }), {
      type: "object",
      required: ["question"],
      properties: { question: { type: "string" } },
    }),
    outputSchema: sharedOutputSchema,
    annotations: READ_ONLY,
  }, async ({ question }) => {
    try {
      const principal = await requireToolPrincipal(deps);
      const answer = await executeAuthorizedWorkflowRead({
        prompt: question,
        surface: deps.surface,
        principal,
        env: deps.env,
        ctx: deps.ctx,
      });
      if (answer.kind === "result") return toolResult({ ok: true, ...answer });
      const search = await searchCapabilities({ query: question, limit: 3, surface: deps.surface, principal });
      return toolResult({ ok: true, kind: "unavailable", hits: search.hits });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("scalius_read", {
    description: "Run read operations: operationId + input, or steps. Results keep to 8 KB: narrow with select, page with limit and meta.nextCursor.",
    inputSchema: listed(readArgsSchema, READ_ARGS_JSON),
    outputSchema: sharedOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      return await runRead(deps, args);
    } catch (error) {
      return errorResult(error, args.operationId);
    }
  });

  server.registerTool("scalius_write", {
    description: "Run changes: operationId + input, or steps in order. dryRun:true validates and previews. Destructive or financial changes need the merchant's approval: they open confirmation.approvalUrl, then repeat the call with approvalId.",
    inputSchema: listed(writeArgsSchema, WRITE_ARGS_JSON),
    outputSchema: sharedOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    try {
      return await runWrite(deps, args, ctx as ToolContextLike | undefined) as ReturnType<typeof toolResult>;
    } catch (error) {
      return errorResult(error, args.operationId);
    }
  });

  registerAgentResources(server, { surface: deps.surface, env: deps.env, ctx: deps.ctx, principal: () => requireToolPrincipal(deps) });
  if (deps.surface === "dashboard") registerAgentPrompts(server);
  return server;
}

/**
 * The server for one HTTP request. For the handshake methods (`initialize`,
 * `server/discover`) the instructions carry the live store line; every other
 * request skips those reads.
 */
export async function createAgentMcpServerForRequest(
  deps: McpServerDependencies,
  method: string | null,
): Promise<McpServer> {
  if (method !== "initialize" && method !== "server/discover") return createAgentMcpServer(deps);
  let line = "";
  try {
    const principal = await resolveToolPrincipal(deps);
    if (principal) line = storeContextLine(await loadStoreContext({ surface: deps.surface, principal, env: deps.env, ctx: deps.ctx }));
  } catch {
    line = "";
  }
  return createAgentMcpServer(deps, { instructions: buildAgentInstructions(line) });
}

const HANDSHAKE_PEEK_MAX_BYTES = 8 * 1024;

/**
 * The JSON-RPC method of a request: the 2026-07-28 `Mcp-Method` header, or,
 * for a small 2025-era body (a handshake is a few hundred bytes), the body's
 * `method`. Larger bodies are tool calls and are never read twice.
 */
export async function peekMcpMethod(request: Request): Promise<string | null> {
  const header = request.headers.get("Mcp-Method")?.trim();
  if (header) return header;
  if (request.method !== "POST" || request.body === null) return null;
  const length = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (!Number.isFinite(length) || length > HANDSHAKE_PEEK_MAX_BYTES) return null;
  try {
    const body = JSON.parse(await request.clone().text()) as { method?: unknown };
    return typeof body?.method === "string" ? body.method : null;
  } catch {
    return null;
  }
}
