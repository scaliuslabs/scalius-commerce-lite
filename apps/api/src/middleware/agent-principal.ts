import type { MiddlewareHandler } from "hono";
import { resolveAgentPrincipalFromBearer, resolveAgentPrincipalFromGrant } from "../agent-access/principal";
import { getBearerToken, parseAgentCredential } from "../agent-access/pat";
import { ForbiddenError, UnauthorizedError } from "../utils/api-error";
import { resolveDirectAgentOperation } from "../agent-access/direct-operation";
import { isAgentRiskAllowed } from "../agent-access/types";
import {
  enforceAgentRateLimit,
  enforceAgentRequestBoundary,
  writeDeniedAgentRequestAudit,
} from "./agent-request-boundary";
import { getAgentDispatchPrincipal } from "../agent-access/dispatch-context";
import { enforceDirectAgentRequestBodyLimit } from "./direct-agent-request-body";

function hasAnyCookie(cookieHeader: string | null | undefined): boolean {
  return Boolean(cookieHeader?.trim());
}

export const agentPrincipalMiddleware: MiddlewareHandler = async (c, next) => {
  const dispatchPrincipal = getAgentDispatchPrincipal(c.env);
  const token = getBearerToken(c.req.header("Authorization"));
  if (dispatchPrincipal && (c.req.header("Authorization")?.trim() || hasAnyCookie(c.req.header("Cookie")))) {
    throw new ForbiddenError("Internal agent dispatch cannot be combined with request credentials");
  }
  if (!dispatchPrincipal && (!token || !parseAgentCredential(token))) {
    throw new UnauthorizedError("Agent access requires a valid Bearer credential");
  }
  if (!dispatchPrincipal && hasAnyCookie(c.req.header("Cookie"))) {
    throw new ForbiddenError("Cookie and agent credentials cannot be combined");
  }

  const principal = dispatchPrincipal
    ? await resolveAgentPrincipalFromGrant(c.get("db"), {
        grantId: dispatchPrincipal.grantId,
        credentialId: dispatchPrincipal.credentialId,
        resource: dispatchPrincipal.resource,
      })
    : await resolveAgentPrincipalFromBearer(
        c.get("db"),
        token!,
        c.env.AGENT_TOKEN_PEPPER,
      );
  if (!principal) throw new UnauthorizedError("Agent credential is invalid, expired, or revoked");
  if (
    dispatchPrincipal &&
    (principal.ownerUserId !== dispatchPrincipal.ownerUserId ||
      principal.grantKind !== dispatchPrincipal.grantKind)
  ) {
    throw new UnauthorizedError("Agent dispatch authority is no longer active");
  }

  const startedAt = Date.now();
  const operation = resolveDirectAgentOperation(c.req.method, new URL(c.req.url).pathname);
  if (!dispatchPrincipal) await enforceAgentRateLimit(c, principal);
  try {
    if (
      !operation ||
      (operation.exposure !== "execute" && operation.exposure !== "continuation") ||
      operation.surface !== principal.resource ||
      operation.surface !== "storefront" ||
      !operation.principals.some((value) => value === "visitor" || value === "customer") ||
      !isAgentRiskAllowed(principal.riskCeiling, operation.risk) ||
      (operation.rbac.type !== "agentGrant" && operation.rbac.type !== "public")
    ) {
      throw new ForbiddenError(
        "This storefront operation is not available to direct agent credentials",
      );
    }
    if (!dispatchPrincipal) {
      await enforceDirectAgentRequestBodyLimit(c, operation);
    }
  } catch (error) {
    if (!dispatchPrincipal) {
      await writeDeniedAgentRequestAudit(c, principal, operation, startedAt, error);
    }
    throw error;
  }

  if (!operation) {
    throw new ForbiddenError(
      "This storefront operation is not available to direct agent credentials",
    );
  }

  c.set("agentPrincipal", principal);
  c.header("Cache-Control", "private, no-store");
  if (dispatchPrincipal) {
    await next();
  } else {
    await enforceAgentRequestBoundary(c, principal, operation, next, true);
  }
};
