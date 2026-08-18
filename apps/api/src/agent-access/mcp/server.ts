import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { getDb } from "@scalius/database/client";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { loadAgentAccessBackend } from "../backend";
import {
  AgentDispatchError,
  buildAgentRequiredClientAction,
  dispatchAgentOperation,
  type AgentOperationInput,
  type AgentOperationResult,
} from "../dispatch";
import {
  AGENT_MAX_BATCH_STEPS,
  AGENT_MAX_PARALLEL_READS,
  checkAgentRateLimit,
  utf8ByteLength,
  AGENT_MAX_RESULT_BYTES,
} from "../limits";
import type { AgentOAuthProps, AgentPrincipal, AgentResource } from "../types";
import { isAgentOAuthProps } from "./auth";
import { createAgentBrowserHandoff } from "../browser-handoffs";
import {
  describeOperation,
  getAuthorizedOperation,
} from "./operations";
import {
  AGENT_STEP_ID_PATTERN,
  AGENT_STEP_POINTER_PATTERN,
  containsStepReference,
  resolveStepReferences,
} from "./references";
import { resolveAuthorizedWorkflow } from "./workflows";
import { executeAuthorizedWorkflowRead } from "./workflow-read";

const pathValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const queryValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100),
]);
const pathRecordSchema = z.record(z.string(), pathValueSchema).refine(
  (value) => Object.keys(value).length <= 50,
  "At most 50 path parameters are allowed",
);
const queryRecordSchema = z.record(z.string(), queryValueSchema).refine(
  (value) => Object.keys(value).length <= 100,
  "At most 100 query parameters are allowed",
);
const operationInputSchema = z.object({
  path: pathRecordSchema.optional(),
  query: queryRecordSchema.optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
}).strict();
const stepReferenceSchema = z.object({
  $step: z.string().regex(AGENT_STEP_ID_PATTERN),
  pointer: z.string().regex(AGENT_STEP_POINTER_PATTERN).optional(),
}).strict();
const batchOperationInputSchema = z.object({
  path: z.record(z.string(), z.union([pathValueSchema, stepReferenceSchema]))
    .refine((value) => Object.keys(value).length <= 50, "At most 50 path parameters are allowed")
    .optional(),
  query: z.record(z.string(), z.union([queryValueSchema, stepReferenceSchema]))
    .refine((value) => Object.keys(value).length <= 100, "At most 100 query parameters are allowed")
    .optional(),
  body: z.unknown().optional(),
  idempotencyKey: z.union([z.string().min(8).max(200), stepReferenceSchema]).optional(),
}).strict();
const batchStepSchema = z.object({
  id: z.string().regex(AGENT_STEP_ID_PATTERN),
  operationId: z.string().min(1).max(240),
  input: batchOperationInputSchema.optional(),
}).strict();
const toolErrorSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(1_024),
}).strict();
const batchStepResultSchema = z.object({
  id: z.string().regex(AGENT_STEP_ID_PATTERN),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: toolErrorSchema.optional(),
}).strict();
const agentToolOutputSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  results: z.array(batchStepResultSchema).max(AGENT_MAX_BATCH_STEPS).optional(),
  operation: z.unknown().optional(),
  error: toolErrorSchema.optional(),
  truncated: z.boolean().optional(),
  summary: z.string().max(240).optional(),
}).strict();
const projectedScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const projectedRecordSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  projectedScalarSchema,
).refine((value) => Object.keys(value).length <= 32, "At most 32 projected fields are allowed");
const projectedValueSchema = z.union([
  projectedScalarSchema,
  z.array(projectedScalarSchema).max(100),
  projectedRecordSchema,
  z.array(projectedRecordSchema).max(100),
]);
const projectedStepSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  projectedValueSchema,
).refine((value) => Object.keys(value).length <= 24, "At most 24 projected selectors are allowed");
const workflowReadResultSchema = z.union([
  z.object({
    kind: z.literal("result"),
    disposition: z.literal("execute"),
    version: z.string().max(64),
    workflowId: z.string().max(160),
    rules: z.array(z.string().min(1).max(300)).min(1).max(6),
    outputs: z.record(z.string().max(129), projectedStepSchema)
      .refine((value) => Object.keys(value).length <= 50, "At most 50 workflow steps are allowed"),
  }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    disposition: z.literal("unavailable"),
    classification: z.object({
      code: z.literal("workflow_read_unavailable"),
      reason: z.literal("The requested workflow read is unavailable."),
    }).strict(),
  }).strict(),
]);
const workflowReadToolOutputSchema = z.object({
  ok: z.boolean(),
  result: workflowReadResultSchema.optional(),
  error: toolErrorSchema.optional(),
}).strict();
const MCP_TEXT_COMPATIBILITY_BYTES = 4 * 1024;
const MCP_TOOL_ERROR_CODE_CHARS = 120;
const MCP_TOOL_ERROR_MESSAGE_CHARS = 1_024;

interface McpServerDependencies {
  surface: AgentResource;
  env: Env;
  ctx: ExecutionContext;
}

export const AGENT_MCP_INSTRUCTIONS = "For data questions try workflows.read; on unavailable, or for changes, use workflows.resolve. Describe only selected IDs, then use operations.read/read_batch or operations.write/write_batch; confirm and verify writes. Fixed reviewed operations only—never arbitrary code, HTTP, or SQL. Never invent IDs, revisions, money, stock, or secrets.";

export function formatAgentToolResult(value: Record<string, unknown>) {
  const oneTimeResult = typeof value.result === "object" && value.result !== null
    ? value.result as Partial<AgentOperationResult>
    : null;
  if (oneTimeResult?.oneTimeSecret === true) {
    return {
      content: [{
        type: "text" as const,
        text: "One-time secret returned in structured content",
      }],
      structuredContent: value,
    };
  }
  if (oneTimeResult?.sensitiveContinuation === true) {
    const safe = {
      ok: false,
      error: {
        code: "sensitive_continuation_not_supported",
        message: "Sensitive browser continuations are unavailable through generic MCP clients; use the Scalius CLI or dashboard browser flow",
      },
    };
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify(safe),
      }],
      structuredContent: safe,
    };
  }
  if (oneTimeResult?.artifact) {
    const artifact = oneTimeResult.artifact;
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
        ok: value.ok === true,
        result: {
          operationId: oneTimeResult.operationId,
          status: oneTimeResult.status,
          ok: oneTimeResult.ok === true,
          requestId: oneTimeResult.requestId,
          artifact: {
            artifactId: artifact.artifactId,
            filename: artifact.filename,
            mediaType: artifact.mediaType,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            expiresInSeconds: artifact.expiresInSeconds,
          },
        },
      },
    };
  }
  const text = JSON.stringify(value);
  if (utf8ByteLength(text) > AGENT_MAX_RESULT_BYTES) {
    const compactOperation = (candidate: unknown) => {
      if (typeof candidate !== "object" || candidate === null) return null;
      const result = candidate as Partial<AgentOperationResult>;
      if (!result.operationId || !result.requestId || typeof result.status !== "number") return null;
      return {
        operationId: result.operationId,
        status: result.status,
        ok: result.ok === true,
        requestId: result.requestId,
        truncated: true,
      };
    };
    const direct = compactOperation(value.result);
    const batch = Array.isArray(value.results)
      ? value.results.slice(0, AGENT_MAX_BATCH_STEPS).map((item) => {
        const record = typeof item === "object" && item !== null
          ? item as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }
          : {};
        return {
          id: typeof record.id === "string" ? record.id : "unknown",
          ok: record.ok === true,
          result: compactOperation(record.result),
          ...(!record.result && record.error ? { error: record.error } : {}),
        };
      })
      : undefined;
    const bounded = direct
      ? { ok: value.ok === true, result: direct }
      : batch
        ? { ok: value.ok === true, results: batch, truncated: true }
        : {
          ok: value.ok === true,
          truncated: true,
          summary: "Tool result data omitted because the MCP envelope exceeded 64 KiB",
        };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(bounded) }],
      structuredContent: bounded,
    };
  }
  return {
    content: [{
      type: "text" as const,
      text: utf8ByteLength(text) <= MCP_TEXT_COMPATIBILITY_BYTES
        ? text
        : `Structured result returned (${utf8ByteLength(text)} UTF-8 bytes)`,
    }],
    structuredContent: value,
  };
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
      result: {
        status: "browser_action_required",
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
      },
    },
  };
}

function toolError(code: string, message: string) {
  const value = {
    ok: false,
    error: {
      code: code.slice(0, MCP_TOOL_ERROR_CODE_CHARS) || "agent_tool_failed",
      message: message.slice(0, MCP_TOOL_ERROR_MESSAGE_CHARS) || "Agent tool execution failed",
    },
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeToolError(error: unknown) {
  if (error instanceof AgentDispatchError) return toolError(error.code, error.message);
  if (error instanceof Error && error.message.startsWith("Reference ")) {
    return toolError("invalid_step_reference", error.message);
  }
  return toolError("agent_tool_failed", "Agent tool execution failed");
}

function readVerifiedProps(surface: AgentResource): AgentOAuthProps | null {
  // OAuthProvider 0.10.3 passes verified props through the Worker execution
  // context. agents 0.20.1 exposes those supported props here, even though
  // its richer SDK authInfo bridge requires a newer provider Symbol seam.
  const props = getMcpAuthContext()?.props;
  if (!isAgentOAuthProps(props) || props.resource !== surface) return null;
  return props;
}

async function resolveToolPrincipal(
  deps: McpServerDependencies,
): Promise<AgentPrincipal | null> {
  const props = readVerifiedProps(deps.surface);
  if (!props) return null;
  const configuredOrigin = deps.env.PUBLIC_API_BASE_URL?.trim();
  if (!configuredOrigin) return null;
  const canonicalAudience = `${new URL(configuredOrigin).origin}/api/v1/mcp/${deps.surface}`;
  if (props.audience.length !== 1 || props.audience[0] !== canonicalAudience) return null;
  const backend = await loadAgentAccessBackend();
  return backend.resolvePrincipal(
    {
      grantId: props.grantId,
      credentialId: props.credentialId,
      resource: props.resource,
    },
    deps.env,
  );
}

async function requireToolPrincipal(deps: McpServerDependencies): Promise<AgentPrincipal> {
  let principal: AgentPrincipal | null;
  try {
    principal = await resolveToolPrincipal(deps);
  } catch {
    principal = null;
  }
  if (!principal) throw new AgentDispatchError("unauthorized", "Agent grant is inactive", 401);
  if (!(await checkAgentRateLimit(deps.env, `grant:${principal.grantId}`))) {
    throw new AgentDispatchError("rate_limited", "Agent request rate limit exceeded", 429);
  }
  return principal;
}

type AgentOperationToolMode = "read" | "write";
type BatchStep = z.infer<typeof batchStepSchema>;
type BatchStepResult = z.infer<typeof batchStepResultSchema>;

interface PreparedBatchStep {
  step: BatchStep;
  operation: AgentOperationManifestEntry;
}

function assertOperationRisk(
  operation: AgentOperationManifestEntry,
  mode: AgentOperationToolMode,
): void {
  const allowed = mode === "read" ? operation.risk === "read" : operation.risk !== "read";
  if (allowed) return;
  throw new AgentDispatchError(
    "operation_risk_mismatch",
    mode === "read"
      ? "Read tools accept only operations declared with risk read"
      : "Write tools reject operations declared with risk read",
    400,
  );
}

async function getAuthorizedOperationForMode(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  operationId: string,
  mode: AgentOperationToolMode,
): Promise<AgentOperationManifestEntry> {
  const operation = await getAuthorizedOperation(operationId, deps.surface, principal);
  if (!operation) {
    throw new AgentDispatchError(
      "operation_not_found",
      "Operation is unavailable or not authorized",
      404,
    );
  }
  assertOperationRisk(operation, mode);
  return operation;
}

async function dispatchPreparedOperation(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  operation: AgentOperationManifestEntry,
  input: AgentOperationInput,
): Promise<AgentOperationResult> {
  return dispatchAgentOperation({ operation, input, principal, env: deps.env, ctx: deps.ctx });
}

async function prepareBatchSteps(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  steps: BatchStep[],
  mode: AgentOperationToolMode,
): Promise<PreparedBatchStep[]> {
  if (new Set(steps.map((step) => step.id)).size !== steps.length) {
    throw new AgentDispatchError("duplicate_step_id", "Batch step IDs must be unique", 400);
  }
  const prepared: PreparedBatchStep[] = [];
  for (const step of steps) {
    const operation = await getAuthorizedOperationForMode(
      deps,
      principal,
      step.operationId,
      mode,
    );
    if (operation.batch === "forbidden") {
      throw new AgentDispatchError(
        "batch_forbidden",
        `Step ${step.id} cannot run in a batch`,
        400,
      );
    }
    prepared.push({ step, operation });
  }
  return prepared;
}

async function executeBatchStep(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  prepared: PreparedBatchStep,
  input: AgentOperationInput,
): Promise<BatchStepResult> {
  try {
    const result = await dispatchPreparedOperation(
      deps,
      principal,
      prepared.operation,
      input,
    );
    return { id: prepared.step.id, ok: result.ok, result };
  } catch (error) {
    return {
      id: prepared.step.id,
      ok: false,
      error: safeToolError(error).structuredContent.error,
    };
  }
}

async function executeReadBatch(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  prepared: PreparedBatchStep[],
  stopOnError: boolean,
): Promise<BatchStepResult[]> {
  const completed = new Map<string, unknown>();
  const results: BatchStepResult[] = [];
  let index = 0;
  while (index < prepared.length) {
    const current = prepared[index]!;
    const wave: PreparedBatchStep[] = [];
    while (index < prepared.length && wave.length < AGENT_MAX_PARALLEL_READS) {
      const candidate = prepared[index]!;
      if (
        candidate.operation.batch !== "parallel" ||
        containsStepReference(candidate.step.input)
      ) break;
      wave.push(candidate);
      index += 1;
    }

    if (wave.length > 0) {
      const waveResults = await Promise.all(wave.map((candidate) =>
        executeBatchStep(
          deps,
          principal,
          candidate,
          (candidate.step.input ?? {}) as AgentOperationInput,
        )
      ));
      for (const item of waveResults) {
        results.push(item);
        completed.set(item.id, item.result ?? item.error);
      }
      if (stopOnError && waveResults.some((item) => !item.ok)) break;
      continue;
    }

    index += 1;
    let item: BatchStepResult;
    try {
      const resolvedInput = resolveStepReferences(
        current.step.input ?? {},
        completed,
      ) as AgentOperationInput;
      item = await executeBatchStep(deps, principal, current, resolvedInput);
    } catch (error) {
      item = {
        id: current.step.id,
        ok: false,
        error: safeToolError(error).structuredContent.error,
      };
    }
    results.push(item);
    completed.set(item.id, item.result ?? item.error);
    if (stopOnError && !item.ok) break;
  }
  return results;
}

async function executeWriteBatch(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  prepared: PreparedBatchStep[],
): Promise<BatchStepResult[]> {
  const completed = new Map<string, unknown>();
  const results: BatchStepResult[] = [];
  for (const current of prepared) {
    let item: BatchStepResult;
    try {
      const resolvedInput = resolveStepReferences(
        current.step.input ?? {},
        completed,
      ) as AgentOperationInput;
      item = await executeBatchStep(deps, principal, current, resolvedInput);
    } catch (error) {
      item = {
        id: current.step.id,
        ok: false,
        error: safeToolError(error).structuredContent.error,
      };
    }
    results.push(item);
    completed.set(item.id, item.result ?? item.error);
    if (!item.ok) break;
  }
  return results;
}

async function executeSingleTool(
  deps: McpServerDependencies,
  mode: AgentOperationToolMode,
  operationId: string,
  input: AgentOperationInput,
) {
  // The dispatch boundary charges normal operations. Required client actions
  // do not dispatch, so they charge explicitly before returning their contract.
  const principal = await resolveToolPrincipal(deps);
  if (!principal) {
    throw new AgentDispatchError("unauthorized", "Agent grant is inactive", 401);
  }
  const operation = await getAuthorizedOperationForMode(
    deps,
    principal,
    operationId,
    mode,
  );
  if (operation.requiredClientAction) {
    if (!(await checkAgentRateLimit(deps.env, `grant:${principal.grantId}`))) {
      throw new AgentDispatchError(
        "rate_limited",
        "Agent request rate limit exceeded",
        429,
      );
    }
    const result = buildAgentRequiredClientAction(operation, input, deps.env);
    return formatAgentToolResult({ ok: true, result });
  }
  const result = await dispatchPreparedOperation(deps, principal, operation, input);
  if (result.sensitiveContinuation !== true) {
    return formatAgentToolResult({ ok: result.ok, result });
  }
  const continuation = result.data && typeof result.data === "object"
    ? (result.data as { continuation?: unknown }).continuation
    : null;
  if (!continuation || typeof continuation !== "object") {
    throw new AgentDispatchError(
      "invalid_continuation_response",
      "Operation returned an invalid continuation",
      502,
    );
  }
  const handoff = await createAgentBrowserHandoff(
    getDb(deps.env),
    principal,
    operation.operationId,
    continuation as {
      url: string;
      method: "POST";
      fields: Record<string, string>;
    },
    deps.env,
  );
  return formatAgentBrowserHandoffResult(handoff);
}

export function createAgentMcpServer(deps: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: `scalius-${deps.surface}`,
    title: `Scalius ${deps.surface} operations`,
    version: "1.0.0",
  }, {
    instructions: AGENT_MCP_INSTRUCTIONS,
  });

  server.registerTool(
    "workflows.resolve",
    {
      title: "Resolve workflow",
      description: "Resolve a natural-language merchant or buyer goal into one compact reviewed plan, up to three choices, a safety control, or an explicit unsupported result.",
      inputSchema: z.object({
        request: z.string().trim().min(1).max(4_000),
      }).strict(),
      outputSchema: agentToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ request }) => {
      try {
        const principal = await requireToolPrincipal(deps);
        const resolution = await resolveAuthorizedWorkflow({
          prompt: request,
          surface: deps.surface,
          principal,
        });
        return formatAgentToolResult({ ok: true, result: resolution });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "workflows.read",
    {
      title: "Read workflow",
      description: "Answer a supported natural-language store-data question in one call using only fixed reviewed inputs and bounded output projections. If unavailable, use workflows.resolve.",
      inputSchema: z.object({
        request: z.string().trim().min(1).max(4_000),
      }).strict(),
      outputSchema: workflowReadToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ request }) => {
      try {
        const principal = await requireToolPrincipal(deps);
        const result = await executeAuthorizedWorkflowRead({
          prompt: request,
          surface: deps.surface,
          principal,
          env: deps.env,
          ctx: deps.ctx,
        });
        return formatAgentToolResult({ ok: true, result });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "operations.describe",
    {
      title: "Describe operation",
      description: "Describe one authorized operation compactly. Set full=true only when constructing its exact input.",
      inputSchema: z.object({
        operationId: z.string().min(1).max(240),
        full: z.boolean().default(false),
      }).strict(),
      outputSchema: agentToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operationId, full }) => {
      try {
        const principal = await requireToolPrincipal(deps);
        const operation = await getAuthorizedOperation(operationId, deps.surface, principal);
        if (!operation) return toolError("operation_not_found", "Operation is unavailable or not authorized");
        return formatAgentToolResult({
          ok: true,
          operation: full ? describeOperation(operation, true) : describeOperation(operation),
        });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "operations.read",
    {
      title: "Read operation",
      description: "Run one fixed, authorized operation declared with risk read.",
      inputSchema: z.object({
        operationId: z.string().min(1).max(240),
        input: operationInputSchema.optional(),
      }).strict(),
      outputSchema: agentToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, input }) => {
      try {
        return await executeSingleTool(deps, "read", operationId, input ?? {});
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "operations.read_batch",
    {
      title: "Read operation batch",
      description: "Run up to 20 authorized read operations. Independent parallel-eligible reads use at most two lanes; $step references create ordered waves.",
      inputSchema: z.object({
        steps: z.array(batchStepSchema).min(1).max(AGENT_MAX_BATCH_STEPS),
        stopOnError: z.boolean().default(true),
      }).strict(),
      outputSchema: agentToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ steps, stopOnError }) => {
      try {
        // Batch requests charge once here plus once in each dispatched step.
        const principal = await requireToolPrincipal(deps);
        const prepared = await prepareBatchSteps(deps, principal, steps, "read");
        const results = await executeReadBatch(deps, principal, prepared, stopOnError);
        return formatAgentToolResult({ ok: results.every((result) => result.ok), results });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "operations.write",
    {
      title: "Write operation",
      description: "Run one fixed, authorized write, destructive, financial, or security operation.",
      inputSchema: z.object({
        operationId: z.string().min(1).max(240),
        input: operationInputSchema.optional(),
      }).strict(),
      outputSchema: agentToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, input }) => {
      try {
        return await executeSingleTool(deps, "write", operationId, input ?? {});
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "operations.write_batch",
    {
      title: "Write operation batch",
      description: "Run up to 20 authorized non-read operations sequentially, stopping on the first failed step. Later inputs may use $step references.",
      inputSchema: z.object({
        steps: z.array(batchStepSchema).min(1).max(AGENT_MAX_BATCH_STEPS),
      }).strict(),
      outputSchema: agentToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ steps }) => {
      try {
        // All steps are authorized and risk-checked before the first mutation.
        const principal = await requireToolPrincipal(deps);
        const prepared = await prepareBatchSteps(deps, principal, steps, "write");
        const results = await executeWriteBatch(deps, principal, prepared);
        return formatAgentToolResult({ ok: results.every((result) => result.ok), results });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  return server;
}
