import type { Context, Next } from "hono";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";
import type { AgentPrincipal } from "../agent-access/types";
import { writeAgentAuditEvent } from "../agent-access/audit";
import { requireWithinRateLimit } from "../utils/rate-limit";

export async function enforceAgentRateLimit(
  c: Context,
  principal: AgentPrincipal,
): Promise<void> {
  await requireWithinRateLimit(c.env, "RL_STANDARD", "agent", `grant:${principal.grantId}`, "Agent request rate limit exceeded");
}

export async function writeDeniedAgentRequestAudit(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationPolicy | null,
  startedAt: number,
  error: unknown,
): Promise<void> {
  const status = (error as { status?: unknown })?.status;
  try {
    await writeAgentAuditEvent(c.get("db"), {
      grantId: principal.grantId,
      credentialId: principal.credentialId,
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
      operationId: operation?.operationId ?? "system.agent_access.denied",
      risk: operation?.risk ?? "security",
      outcome: "denied",
      httpStatus: typeof status === "number" ? status : 403,
      errorClass: error instanceof Error ? error.name : "AuthorizationDenied",
      durationMs: Date.now() - startedAt,
      requestId: c.req.header("X-Request-Id") ?? null,
    });
  } catch {
    // Audit writes never disclose request data or replace the denial outcome.
  }
}

/**
 * What an agent's credential reads on any route it can call, MCP or direct:
 * the JSON response with every buyer-written value its schema marks labelled
 * `{"untrusted": ...}` (agent-access/mcp/untrusted.ts), so a note that reads
 * like an instruction stays data.
 */
async function labelBuyerTextForAgent(c: Context, operation: AgentOperationPolicy): Promise<void> {
  const response = c.res;
  if (!response || !/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(response.headers.get("Content-Type") ?? "")) return;
  const [{ AGENT_OPERATIONS_BY_ID }, { labelUntrustedResponse, operationUntrustedPaths }] = await Promise.all([
    import("../generated/agent-operations.gen"),
    import("../agent-access/mcp/untrusted"),
  ]);
  const entry = AGENT_OPERATIONS_BY_ID[operation.operationId];
  if (!entry || operationUntrustedPaths(entry).length === 0) return;
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return;
  }
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  c.res = undefined;
  c.res = new Response(JSON.stringify(labelUntrustedResponse(entry, body)), { status: response.status, statusText: response.statusText, headers });
}

export async function enforceAgentRequestBoundary(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationPolicy,
  next: Next,
  rateLimitAlreadyEnforced = false,
): Promise<void> {
  if (!rateLimitAlreadyEnforced) await enforceAgentRateLimit(c, principal);

  const startedAt = Date.now();
  let outcome: "success" | "failed" = "success";
  let httpStatus: number | null = null;
  try {
    await next();
    httpStatus = c.res?.status ?? 200;
    if (httpStatus >= 400) outcome = "failed";
    await labelBuyerTextForAgent(c, operation);
  } catch (error) {
    outcome = "failed";
    const status = (error as { status?: unknown })?.status;
    httpStatus = typeof status === "number" ? status : 500;
    throw error;
  } finally {
    try {
      await writeAgentAuditEvent(c.get("db"), {
        grantId: principal.grantId,
        credentialId: principal.credentialId,
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        operationId: operation.operationId,
        risk: operation.risk,
        outcome,
        httpStatus,
        durationMs: Date.now() - startedAt,
        requestId: c.req.header("X-Request-Id") ?? null,
      });
    } catch {
      // Audit outages do not disclose request data or rewrite domain outcomes.
    }
  }
}
