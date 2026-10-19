// The one confirmation gate every agent request to a dashboard operation
// passes (decision D2): MCP's in-process dispatch and the direct REST lane
// (a PAT or CLI credential calling /api/v1/admin/... itself) both reach the
// admin boundary, which calls this before the route runs.
//
// A destructive or financial operation (or one the registry marks
// `confirmation: "required"`), under a grant whose confirm policy is on,
// runs only when:
//   - the dispatcher already settled it (MCP consumed the merchant's confirm
//     token or a client dialog approved it), or
//   - it is a native dry run (`dryRun: true`, which writes nothing), or
//   - on the REST lane, the request carries a `Scalius-Confirm-Token` header
//     minted for exactly this grant, operation and input (one use, 10 minutes).
// Otherwise nothing runs: the answer is 428 `confirmation_required` with the
// summary the merchant approves and a fresh token for the retry.
import type { Context } from "hono";
import { AppError } from "@scalius/core/errors";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import type { OperationDispatchClearance } from "./dispatch-context";
import type { AgentOperationInput } from "./dispatch";
import type { AgentPrincipal } from "./types";

export const CONFIRM_TOKEN_HEADER = "Scalius-Confirm-Token";

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

/** The request as the operation input a confirm token binds (path, query, JSON body). */
async function requestInput(c: Context, operation: AgentOperationManifestEntry, pathname: string): Promise<AgentOperationInput> {
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

function isNativeDryRun(operation: AgentOperationManifestEntry, input: AgentOperationInput): boolean {
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
  operation: AgentOperationManifestEntry,
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
    throw new AppError(428, "confirmation_required", "This change needs the merchant's approval: dry-run it, then send the confirmToken.");
  }
  const input = await requestInput(c, operation, pathname);
  if (isNativeDryRun(operation, input)) return;
  const steps = [{ operation, input }];
  const binding = await confirm.confirmBinding(steps);
  const token = c.req.header(CONFIRM_TOKEN_HEADER)?.trim();
  if (token) {
    try {
      await confirm.consumeConfirmToken(env, principal, binding, token);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const code = (error as { code?: string }).code ?? "confirm_token_invalid";
      throw new AppError(status === 409 ? 409 : 400, code, error instanceof Error ? error.message : "The confirm token is not valid");
    }
    return;
  }
  const minted = await confirm.mintConfirmToken(env, principal, binding);
  throw new AppError(
    428,
    "confirmation_required",
    `This change needs the merchant's approval. Show them the summary, then repeat the same request with the ${CONFIRM_TOKEN_HEADER} header.`,
    { confirmation: { summary: confirm.confirmSummary(steps), ...minted, header: CONFIRM_TOKEN_HEADER } },
  );
}
