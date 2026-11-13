import type { Context, Next } from "hono";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";
import type { AgentPrincipal } from "../agent-access/types";
import { nanoid } from "nanoid";
import { AppError } from "@scalius/core/errors";
import type { AgentAttribution } from "@scalius/core/utils/agent-attribution";
import {
  AGENT_WRITE_IN_PROGRESS,
  agentWriteResourceIds,
  attributionMetadata,
  readAgentConnection,
  writeAgentAuditEvent,
} from "../agent-access/audit";
import type { OperationDispatchClearance } from "../agent-access/dispatch-context";
import { routedApiPath } from "../utils/routed-path";
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

/** An agent's write as its audit row records it before it runs. */
export interface AgentWriteRecord {
  eventId: string;
  attribution: AgentAttribution;
  /** The ids the request's path names. */
  pathValues: string[];
}

/** The values a request path gives an operation's `{param}` segments, in order. */
export function pathParamValues(template: string | undefined, pathname: string): string[] {
  if (!template) return [];
  const names = template.split("/");
  const values = pathname.split("/");
  if (names.length !== values.length) return [];
  return names.flatMap((name, index) => (/^\{[^}]+\}$/.test(name) && values[index] ? [decodeURIComponent(values[index]!)] : []));
}

/**
 * Records an agent's write before it runs: one audit row (the dispatcher's
 * own id on the MCP lane, so the lane completes the same row) naming the
 * grant, its connection and client, the approval it runs on and the records
 * its path names. A write whose row cannot be written does not run, so no
 * agent write completes without its row.
 */
export async function recordAgentWriteStart(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationPolicy,
  clearance: OperationDispatchClearance | null,
): Promise<AgentWriteRecord> {
  const db = c.get("db");
  const redeemed = c.get("agentApproval") as { approvalId: string; approvedBy: string } | undefined;
  // Only the grant's owner approves a change (approvals.ts), on either lane.
  const approval = clearance?.approvalId
    ? { approvalId: clearance.approvalId, approvedBy: principal.ownerUserId }
    : redeemed ?? null;
  const pathValues = pathParamValues(operation.pathTemplate, routedApiPath(c));
  const eventId = clearance?.auditEventId ?? `aae_${nanoid(20)}`;
  try {
    const connection = await readAgentConnection(db, principal.grantId);
    const attribution: AgentAttribution = {
      grantId: principal.grantId,
      connection: connection?.name ?? "",
      client: connection?.client ?? null,
      approvalId: approval?.approvalId ?? null,
      approvedBy: approval?.approvedBy ?? null,
    };
    await writeAgentAuditEvent(db, {
      eventId,
      grantId: principal.grantId,
      credentialId: principal.credentialId,
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
      operationId: operation.operationId,
      risk: operation.risk,
      outcome: "failed",
      errorClass: AGENT_WRITE_IN_PROGRESS,
      requestId: c.req.header("X-Request-Id") ?? null,
      resourceIds: pathValues,
      metadata: attributionMetadata(attribution),
    });
    return { eventId, attribution, pathValues };
  } catch {
    throw new AppError(503, "agent_audit_unavailable", "Nothing ran: this change could not be recorded in the agent audit log. Try again in a moment.");
  }
}

/** A JSON answer's body, for the ids it names (bounded: a large answer names none). */
async function answerJson(response: Response | undefined): Promise<unknown> {
  if (!response || !/json/i.test(response.headers.get("Content-Type") ?? "")) return null;
  const length = Number(response.headers.get("Content-Length") ?? "0");
  if (length > 262_144) return null;
  try {
    const text = await response.clone().text();
    return text.length > 262_144 ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

export async function enforceAgentRequestBoundary(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationPolicy,
  next: Next,
  rateLimitAlreadyEnforced = false,
  write: AgentWriteRecord | null = null,
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
        ...(write ? {
          eventId: write.eventId,
          resourceIds: agentWriteResourceIds(write.pathValues, outcome === "success" ? await answerJson(c.res) : null),
          metadata: attributionMetadata(write.attribution),
        } : {}),
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
