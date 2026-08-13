import type { Context, Next } from "hono";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import type { AgentPrincipal } from "../agent-access/types";
import { writeAgentAuditEvent } from "../agent-access/audit";
import { RateLimitError, ServiceUnavailableError } from "../utils/api-error";

export async function enforceAgentRateLimit(
  c: Context,
  principal: AgentPrincipal,
): Promise<void> {
  const limiter = c.env.AGENT_RATE_LIMITER as RateLimit | undefined;
  if (!limiter) throw new ServiceUnavailableError("Agent request rate limiting is unavailable");
  const allowed = await limiter.limit({ key: `grant:${principal.grantId}` });
  if (!allowed.success) throw new RateLimitError("Agent request rate limit exceeded");
}

export async function writeDeniedAgentRequestAudit(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationManifestEntry | null,
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

export async function enforceAgentRequestBoundary(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationManifestEntry,
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
