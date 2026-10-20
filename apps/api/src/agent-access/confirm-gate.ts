// The one confirmation gate every agent request to a dashboard operation
// passes (decision D2): MCP's in-process dispatch and the direct REST lane
// (a PAT or CLI credential calling /api/v1/admin/... itself) both reach the
// admin boundary, which calls this before the route runs.
//
// A destructive, financial or security operation (or one the registry marks
// `confirmation: "required"`), under a grant whose confirm policy is on,
// runs only when:
//   - the dispatcher already settled it (MCP redeemed the owner's dashboard
//     approval, or a client dialog approved it), or
//   - it is a native dry run (`dryRun: true`, which writes nothing), or
//   - on the REST lane, the request carries a `Scalius-Approval` header naming
//     an approval the grant's owner gave in the dashboard for exactly this
//     grant, operation and input (one use; audit R2 F3).
// Otherwise nothing runs: the answer is 428 `confirmation_required` with the
// summary and an approval link for the owner. The agent never receives
// anything it could redeem by itself.
import type { Context } from "hono";
import { AppError } from "@scalius/core/errors";
import { getDb } from "@scalius/database/client";
import type { AgentOperationPolicy } from "../openapi/agent-operation-manifest";
import type { OperationDispatchClearance } from "./dispatch-context";
import { AgentDispatchError, type AgentOperationInput } from "./dispatch-error";
import type { AgentPrincipal } from "./types";

function pathParams(template: string, pathname: string): Record<string, string> {
  const templateSegments = template.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  templateSegments.forEach((segment, index) => {
    const name = /^\{([^}]+)\}$/.exec(segment)?.[1];
    if (name && pathSegments[index] !== undefined) params[name] = decodeURIComponent(pathSegments[index]!);
  });
  return params;
}

/** The request as the operation input an approval binds (path, query, JSON body). */
async function requestInput(c: Context, operation: AgentOperationPolicy, pathname: string): Promise<AgentOperationInput> {
  const url = new URL(c.req.url);
  const query = Object.fromEntries(url.searchParams.entries());
  let body: unknown;
  if (c.req.raw.body !== null && (c.req.header("Content-Type") ?? "").toLowerCase().includes("application/json")) {
    try {
      body = await c.req.raw.clone().json();
    } catch {
      body = undefined;
    }
  }
  return {
    path: pathParams(operation.pathTemplate, pathname),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  } as AgentOperationInput;
}

function isNativeDryRun(operation: AgentOperationPolicy, input: AgentOperationInput): boolean {
  if (operation.dryRun !== "native") return false;
  const body = input.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body) && (body as Record<string, unknown>).dryRun === true) return true;
  return (input.query as Record<string, unknown> | undefined)?.dryRun === "true";
}

/**
 * Refuses a confirmation-gated agent request that nobody approved. `clearance`
 * is the in-process dispatcher's (MCP); null on the direct REST lane.
 */
export async function enforceAgentConfirmation(
  c: Context,
  principal: AgentPrincipal,
  operation: AgentOperationPolicy,
  pathname: string,
  clearance: OperationDispatchClearance | null,
): Promise<void> {
  const confirm = await import("./mcp/confirm");
  if (!confirm.isConfirmGated(operation)) return;
  if (clearance?.confirmed) return;
  if (clearance?.dryRun && operation.dryRun === "native") return;
  const env = c.env as Env;
  if (await confirm.readAgentConfirmPolicy(env, principal) === "none") return;
  if (clearance) {
    // The dispatcher sent a gated write it did not settle: refuse, never guess.
    throw new AppError(428, "confirmation_required", "This change needs the merchant's approval before it runs.");
  }
  const input = await requestInput(c, operation, pathname);
  if (isNativeDryRun(operation, input)) return;
  const approvals = await import("./approvals");
  const steps = [{ operation, input }];
  const binding = await confirm.confirmBinding(steps);
  const db = getDb(env);
  const approvalId = c.req.header(approvals.APPROVAL_HEADER)?.trim();
  if (approvalId) {
    try {
      await approvals.redeemAgentApproval(db, env, principal, approvalId, binding);
    } catch (error) {
      if (error instanceof approvals.AgentApprovalPendingError) {
        throw new AppError(428, "confirmation_required", error.message, {
          confirmation: { ...error.confirmation, header: approvals.APPROVAL_HEADER },
        });
      }
      const status = (error as { status?: number }).status;
      const code = (error as { code?: string }).code ?? "approval_invalid";
      throw new AppError(status === 409 ? 409 : 400, code, error instanceof Error ? error.message : "The approval is not valid");
    }
    return;
  }
  const summary = confirm.confirmSummary(steps);
  let link: Awaited<ReturnType<typeof approvals.requestAgentApproval>>;
  try {
    link = await approvals.requestAgentApproval(db, env, principal, {
      binding,
      summary,
      operationIds: [operation.operationId],
    });
  } catch (error) {
    if (error instanceof AgentDispatchError) throw new AppError(error.status, error.code, error.message);
    throw error;
  }
  throw new AppError(
    428,
    "confirmation_required",
    `This change needs the merchant's approval. Ask them to open confirmation.approvalUrl and approve it, then repeat the same request with the ${approvals.APPROVAL_HEADER} header set to confirmation.approvalId.`,
    { confirmation: { summary, ...link, header: approvals.APPROVAL_HEADER } },
  );
}
