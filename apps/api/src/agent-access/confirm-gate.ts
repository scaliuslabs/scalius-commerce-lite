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
//     grant, operation and request: its parsed input plus the raw query
//     string, Content-Type and body bytes, so a retry that parses alike but
//     differs runs nothing (one use; audit R2 F3, N2).
// Otherwise nothing runs: the answer is 428 `confirmation_required` with the
// summary and an approval link for the owner. The agent never receives
// anything it could redeem by itself.
import type { Context } from "hono";
import { AppError } from "@scalius/core/errors";
import { getDb } from "@scalius/database/client";
import { sha256Hex } from "@scalius/shared/hash";
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

/**
 * Every content type a route's JSON validator parses (`application/json` and
 * any `application/<x>+json`, as Hono and @hono/zod-openapi match it).
 */
const JSON_CONTENT_TYPE = /^application\/([a-z0-9!#$&^_.+-]+\+)?json\s*(;|$)/i;

interface RequestFacts {
  /** What the owner reads: path, query and the parsed JSON body. */
  input: AgentOperationInput;
  /** What runs, byte for byte: the raw query string, the content type and the body's SHA-256. */
  raw: { search: string; contentType: string; bodySha256: string | null; bodyBytes: number };
}

/**
 * The request an approval binds (security audit N2): the parsed input the
 * owner is shown, plus the raw query string and the exact body bytes,
 * whatever the Content-Type, so the request that runs after approval is the
 * one that was approved, not one that only parses alike.
 */
async function requestFacts(c: Context, operation: AgentOperationPolicy, pathname: string): Promise<RequestFacts> {
  const url = new URL(c.req.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const contentType = (c.req.header("Content-Type") ?? "").trim().toLowerCase();
  let body: unknown;
  let bodySha256: string | null = null;
  let bodyBytes = 0;
  if (c.req.raw.body !== null) {
    const buffer = await c.req.raw.clone().arrayBuffer();
    const bytes = new Uint8Array(buffer);
    bodyBytes = bytes.byteLength;
    if (bytes.byteLength > 0) {
      bodySha256 = await sha256Hex(buffer);
      if (JSON_CONTENT_TYPE.test(contentType)) {
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          body = undefined;
        }
      }
    }
  }
  return {
    input: {
      path: pathParams(operation.pathTemplate, pathname),
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
    } as AgentOperationInput,
    raw: { search: url.search, contentType, bodySha256, bodyBytes },
  };
}

/**
 * A native dry run, read where the route reads it: the JSON body's `dryRun`
 * for a request with a body, the query only for a bodyless method (the
 * dispatcher's `withNativeDryRun` sends it the same way). A `?dryRun=true`
 * on a POST would preview here and run for real in the route.
 */
function isNativeDryRun(operation: AgentOperationPolicy, method: string, input: AgentOperationInput): boolean {
  if (operation.dryRun !== "native") return false;
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "DELETE") {
    return (input.query as Record<string, unknown> | undefined)?.dryRun === "true";
  }
  const body = input.body;
  return typeof body === "object" && body !== null && !Array.isArray(body) && (body as Record<string, unknown>).dryRun === true;
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
  const { input, raw } = await requestFacts(c, operation, pathname);
  if (isNativeDryRun(operation, c.req.method, input)) return;
  const approvals = await import("./approvals");
  const steps = [{ operation, input }];
  const binding = await sha256Hex(JSON.stringify([
    await confirm.confirmBinding(steps),
    raw.search,
    raw.contentType,
    raw.bodySha256,
  ]));
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
  // A body the dashboard cannot show is still bound; the owner is told it is there.
  const summary = raw.bodySha256 && input.body === undefined
    ? `${confirm.confirmSummary(steps)} (with a ${raw.bodyBytes}-byte ${raw.contentType.slice(0, 60) || "untyped"} body)`
    : confirm.confirmSummary(steps);
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
