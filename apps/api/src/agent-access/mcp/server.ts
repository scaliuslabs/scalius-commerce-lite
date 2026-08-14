import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
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
  AGENT_DEFAULT_SEARCH_RESULTS,
  AGENT_MAX_BATCH_STEPS,
  AGENT_MAX_PARALLEL_READS,
  AGENT_MAX_SEARCH_RESULTS,
  checkAgentRateLimit,
  utf8ByteLength,
  AGENT_MAX_RESULT_BYTES,
} from "../limits";
import type { AgentOAuthProps, AgentPrincipal, AgentResource } from "../types";
import { isAgentOAuthProps } from "./auth";
import {
  describeOperation,
  getAuthorizedOperation,
  listAuthorizedOperations,
  summarizeOperation,
} from "./operations";
import { containsStepReference, resolveStepReferences } from "./references";
import { merchantOperationQueryScore } from "./merchant-search";

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
const batchStepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  operationId: z.string().min(1).max(240),
  input: operationInputSchema.optional(),
}).strict();
const MCP_TEXT_COMPATIBILITY_BYTES = 4 * 1024;

interface McpServerDependencies {
  surface: AgentResource;
  env: Env;
  ctx: ExecutionContext;
}

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
    return {
      content: [{
        type: "text" as const,
        text: "Secure continuation returned in structured content; submit its POST fields without placing them in a URL",
      }],
      structuredContent: value,
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

function toolError(code: string, message: string) {
  const value = { ok: false, error: { code, message } };
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

function operationQueryScore(operation: AgentOperationManifestEntry, query: string): number | null {
  const haystack = [
    operation.operationId,
    operation.summary,
    operation.description,
    ...operation.tags,
  ].filter(Boolean).join(" ").toLowerCase();
  return merchantOperationQueryScore(haystack, query);
}

async function executeOne(
  deps: McpServerDependencies,
  principal: AgentPrincipal,
  operationId: string,
  input: AgentOperationInput,
): Promise<AgentOperationResult> {
  const operation = await getAuthorizedOperation(operationId, deps.surface, principal);
  if (!operation) {
    throw new AgentDispatchError(
      "operation_not_found",
      "Operation is unavailable or not authorized",
      404,
    );
  }
  return dispatchAgentOperation({ operation, input, principal, env: deps.env, ctx: deps.ctx });
}

export function createAgentMcpServer(deps: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: `scalius-${deps.surface}`,
    title: `Scalius ${deps.surface} operations`,
    version: "1.0.0",
  });

  server.registerTool(
    "operations.search",
    {
      title: "Search operations",
      description: "Search operations allowed for this exact resource and live grant.",
      inputSchema: z.object({
        query: z.string().max(240).default(""),
        limit: z.number().int().min(1).max(AGENT_MAX_SEARCH_RESULTS)
          .default(AGENT_DEFAULT_SEARCH_RESULTS),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      try {
        const principal = await requireToolPrincipal(deps);
        const rankedOperations = (await listAuthorizedOperations(deps.surface, principal))
          .map((operation, index) => {
            const matchScore = operationQueryScore(operation, query);
            return { operation, index, score: matchScore === null ? null : matchScore + (operation.risk === "read" ? 25 : 0) };
          })
          .filter(({ score }) => score !== null)
          .sort((left, right) => right.score! - left.score! || left.index - right.index);
        const hasReadMatch = rankedOperations.some(({ operation }) => operation.risk === "read");
        const preferReadMatches = query.trim().split(/\s+/).length > 1 && hasReadMatch;
        const operations = rankedOperations
          .filter(({ operation }) => !preferReadMatches || operation.risk === "read")
          .slice(0, limit)
          .map(({ operation }) => summarizeOperation(operation));
        return formatAgentToolResult({ ok: true, operations, count: operations.length });
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
    "operations.execute",
    {
      title: "Execute operation",
      description: "Execute one fixed, authorized OpenAPI operation in-process.",
      inputSchema: z.object({
        operationId: z.string().min(1).max(240),
        input: operationInputSchema.optional(),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operationId, input }) => {
      try {
        // The dispatch boundary charges the single execute operation. Batch
        // requests charge once here plus once for every step below.
        const principal = await resolveToolPrincipal(deps);
        if (!principal) {
          throw new AgentDispatchError("unauthorized", "Agent grant is inactive", 401);
        }
        const operation = await getAuthorizedOperation(operationId, deps.surface, principal);
        if (!operation) {
          throw new AgentDispatchError(
            "operation_not_found",
            "Operation is unavailable or not authorized",
            404,
          );
        }
        if (operation.requiredClientAction) {
          if (!(await checkAgentRateLimit(deps.env, `grant:${principal.grantId}`))) {
            throw new AgentDispatchError(
              "rate_limited",
              "Agent request rate limit exceeded",
              429,
            );
          }
          const result = buildAgentRequiredClientAction(operation, input ?? {}, deps.env);
          return formatAgentToolResult({ ok: true, result });
        }
        const result = await dispatchAgentOperation({
          operation,
          input: input ?? {},
          principal,
          env: deps.env,
          ctx: deps.ctx,
        });
        return formatAgentToolResult({ ok: result.ok, result });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  server.registerTool(
    "operations.batch",
    {
      title: "Execute operation batch",
      description: "Execute up to 20 authorized operations; writes are sequential and reads use at most two lanes.",
      inputSchema: z.object({
        steps: z.array(batchStepSchema).min(1).max(AGENT_MAX_BATCH_STEPS),
        stopOnError: z.boolean().default(true),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ steps, stopOnError }) => {
      try {
        const principal = await requireToolPrincipal(deps);
        if (new Set(steps.map((step) => step.id)).size !== steps.length) {
          return toolError("duplicate_step_id", "Batch step IDs must be unique");
        }

        const completed = new Map<string, unknown>();
        const results: Array<{ id: string; ok: boolean; result?: unknown; error?: unknown }> = [];
        let index = 0;
        while (index < steps.length) {
          const step = steps[index]!;
          const operation = await getAuthorizedOperation(step.operationId, deps.surface, principal);
          if (!operation || operation.batch === "forbidden") {
            const failed = { id: step.id, ok: false, error: { code: "batch_forbidden", message: "Operation cannot run in a batch" } };
            results.push(failed);
            if (stopOnError) break;
            index += 1;
            continue;
          }

          const candidates: typeof steps = [];
          while (index < steps.length && candidates.length < AGENT_MAX_PARALLEL_READS) {
            const candidate = steps[index]!;
            const candidateOperation = await getAuthorizedOperation(candidate.operationId, deps.surface, principal);
            if (
              !candidateOperation ||
              candidateOperation.risk !== "read" ||
              candidateOperation.batch !== "parallel" ||
              containsStepReference(candidate.input)
            ) break;
            candidates.push(candidate);
            index += 1;
          }

          if (candidates.length > 0) {
            const wave = await Promise.all(candidates.map(async (candidate) => {
              try {
                const result = await executeOne(deps, principal, candidate.operationId, candidate.input ?? {});
                return { id: candidate.id, ok: result.ok, result };
              } catch (error) {
                const safe = safeToolError(error).structuredContent;
                return { id: candidate.id, ok: false, error: safe.error };
              }
            }));
            for (const item of wave) {
              results.push(item);
              completed.set(item.id, item.result ?? item.error);
            }
            if (stopOnError && wave.some((item) => !item.ok)) break;
            continue;
          }

          index += 1;
          try {
            const resolvedInput = resolveStepReferences(step.input ?? {}, completed) as AgentOperationInput;
            const result = await executeOne(deps, principal, step.operationId, resolvedInput);
            const item = { id: step.id, ok: result.ok, result };
            results.push(item);
            completed.set(step.id, result);
            if (stopOnError && !result.ok) break;
          } catch (error) {
            const safe = safeToolError(error).structuredContent;
            const item = { id: step.id, ok: false, error: safe.error };
            results.push(item);
            completed.set(step.id, safe.error);
            if (stopOnError) break;
          }
        }
        return formatAgentToolResult({ ok: results.every((result) => result.ok), results });
      } catch (error) {
        return safeToolError(error);
      }
    },
  );

  return server;
}
