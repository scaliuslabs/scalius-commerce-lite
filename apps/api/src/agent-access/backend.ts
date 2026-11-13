import { getDb } from "@scalius/database/client";
import type {
  AgentAuditInput,
  AgentResource,
  AgentManifestAuthorizationInput,
  AgentOAuthProps,
  AgentPrincipal,
  CompletedAuthorization,
  ClaimedAuthorizationCompletion,
  PendingAuthorization,
  ValidatedAuthorizationRequest,
} from "./types";
import { isAgentRiskAllowed } from "./types";
import { writeAgentAuditEvent } from "./audit";
import { revokeAgentGrant, SECURITY_REVOCATION_REFRESH_REUSE } from "@scalius/core/modules/agent-access";
import { sendAgentRefreshTokenReusedNotice } from "@scalius/core/modules/notifications";
import { agentGrants } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "@scalius/core/errors";
import { requiresOptInGrantScope } from "./grant-scopes";
import { resolveAgentPrincipalFromBearer, resolveAgentPrincipalFromGrant } from "./principal";
import {
  beginAgentAuthorization,
  claimAgentAuthorizationCompletion,
  completeAgentAuthorization,
  finishAgentAuthorizationCompletion,
  releaseAgentAuthorizationCompletion,
} from "./oauth-consent";

export interface AgentAccessBackend {
  beginAuthorization(
    request: ValidatedAuthorizationRequest,
    env: Env,
  ): Promise<PendingAuthorization>;
  completeAuthorization(
    requestId: string,
    env: Env,
  ): Promise<CompletedAuthorization>;
  claimAuthorizationCompletion(
    requestId: string,
    env: Env,
  ): Promise<ClaimedAuthorizationCompletion>;
  finishAuthorizationCompletion(
    requestId: string,
    claimToken: string,
    env: Env,
  ): Promise<void>;
  releaseAuthorizationCompletion(
    requestId: string,
    claimToken: string,
    env: Env,
  ): Promise<void>;
  resolveExternalToken(
    token: string,
    request: Request,
    env: Env,
  ): Promise<{ props: AgentOAuthProps; audience: string } | null>;
  refreshOAuthGrant(
    props: AgentOAuthProps,
    env: Env,
  ): Promise<AgentOAuthProps | null>;
  resolvePrincipal(
    props: Pick<AgentOAuthProps, "grantId" | "credentialId" | "resource">,
    env: Env,
  ): Promise<AgentPrincipal | null>;
  authorizeOperation(
    principal: AgentPrincipal,
    operation: AgentManifestAuthorizationInput,
    env?: Env,
  ): Promise<boolean>;
  writeAudit(event: AgentAuditInput, env: Env): Promise<void>;
  /**
   * A rotated OAuth refresh token of this connection was presented again: the
   * provider revoked its grant and tokens; the connection is revoked too and
   * the reuse recorded in the agent access audit, where the merchant sees it.
   */
  reportRefreshTokenReuse(connection: RefreshTokenReuse, env: Env): Promise<void>;
}

/** The connection whose rotated refresh token came back: from its props, else the grant's plain metadata. */
export interface RefreshTokenReuse {
  grantId: string;
  ownerUserId: string | null;
  resource: AgentResource | null;
  credentialId?: string | null;
}

/** The agent access audit's operation for a refresh token presented twice. */
export const REFRESH_TOKEN_REUSE_OPERATION = "oauth.refresh_token_reused";

function getCanonicalMcpResource(env: Env, resource: AgentPrincipal["resource"]): string {
  const configuredOrigin = env.PUBLIC_API_BASE_URL?.trim();
  if (!configuredOrigin) throw new Error("PUBLIC_API_BASE_URL is required for agent access");
  const origin = new URL(configuredOrigin).origin;
  return `${origin}/api/v1/mcp/${resource}`;
}

const backend: AgentAccessBackend = {
  beginAuthorization: beginAgentAuthorization,
  completeAuthorization: completeAgentAuthorization,
  claimAuthorizationCompletion: claimAgentAuthorizationCompletion,
  finishAuthorizationCompletion: finishAgentAuthorizationCompletion,
  releaseAuthorizationCompletion: releaseAgentAuthorizationCompletion,

  async resolveExternalToken(token, _request, env) {
    const principal = await resolveAgentPrincipalFromBearer(getDb(env), token, env.AGENT_TOKEN_PEPPER);
    if (!principal) return null;
    const audience = getCanonicalMcpResource(env, principal.resource);
    return {
      props: {
        grantId: principal.grantId,
        ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        permissions: [...principal.permissions].sort(),
        riskCeiling: principal.riskCeiling,
        audience: [audience],
      },
      audience,
    };
  },

  async reportRefreshTokenReuse(connection, env) {
    const db = getDb(env);
    // Revoked by the platform (no person), with the reason the agent access screen keeps in view.
    const revoked = await revokeAgentGrant(db, connection.grantId, null, SECURITY_REVOCATION_REFRESH_REUSE).then(() => true, (error: unknown) => {
      // Already revoked or gone: the audit still records the reuse.
      if (error instanceof NotFoundError) return false;
      throw error;
    });
    await writeAgentAuditEvent(db, {
      grantId: connection.grantId,
      credentialId: connection.credentialId ?? null,
      ownerUserId: connection.ownerUserId,
      resource: connection.resource,
      operationId: REFRESH_TOKEN_REUSE_OPERATION,
      risk: "security",
      outcome: "denied",
      httpStatus: 400,
      errorClass: "refresh_token_reused",
    });
    if (!revoked) return;
    // Staff hear it now; the revocation and the audit row are the durable record.
    const named = await db.select({ label: agentGrants.label, clientName: agentGrants.oauthClientName })
      .from(agentGrants).where(eq(agentGrants.id, connection.grantId)).get();
    await sendAgentRefreshTokenReusedNotice(db, env, { grantId: connection.grantId, name: named?.clientName || named?.label || null })
      .catch((error: unknown) => console.warn("[agent-access] Refresh token reuse notice failed:", error instanceof Error ? error.message : "unknown"));
  },

  async refreshOAuthGrant(props, env) {
    const principal = await resolveAgentPrincipalFromGrant(getDb(env), {
      grantId: props.grantId,
      credentialId: props.credentialId ?? null,
      resource: props.resource,
    });
    if (!principal) return null;
    return {
      grantId: principal.grantId,
      ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
      ownerUserId: principal.ownerUserId,
      resource: principal.resource,
      permissions: [...principal.permissions].sort(),
      riskCeiling: principal.riskCeiling,
      audience: [getCanonicalMcpResource(env, principal.resource)],
    };
  },

  async resolvePrincipal(props, env) {
    return resolveAgentPrincipalFromGrant(getDb(env), {
      grantId: props.grantId,
      credentialId: props.credentialId ?? null,
      resource: props.resource,
    });
  },

  async authorizeOperation(principal, operation) {
    // The runtime resolves a fresh principal once per tool request and again
    // immediately before dispatch. Keep manifest filtering pure so search and
    // describe do not multiply relational reads per candidate operation.
    if (operation.exposure !== "execute" && operation.exposure !== "continuation") return false;
    if (operation.surface === "system") return false;
    if (operation.surface !== principal.resource) return false;
    if (
      operation.surface === "dashboard" && !operation.principals.includes("admin") ||
      operation.surface === "storefront" && !operation.principals.some((value) => value === "admin" || value === "visitor" || value === "customer")
    ) return false;
    if (!isAgentRiskAllowed(principal.riskCeiling, operation.risk)) return false;
    // Opt-in grant scopes (inbox, review moderation): no preset reaches them,
    // only a Custom grant that selected their permissions.
    if (
      (operation.grantScope || requiresOptInGrantScope(operation.rbac)) &&
      principal.preset !== "custom"
    ) return false;
    switch (operation.rbac.type) {
      case "public":
      case "agentGrant":
        return true;
      case "allowAnyAdmin":
        return principal.isSuperAdmin;
      case "permission":
        return principal.permissions.has(operation.rbac.permission);
      case "anyOf":
        return operation.rbac.permissions.some((permission) =>
          principal.permissions.has(permission),
        );
      case "allOf":
        return operation.rbac.permissions.every((permission) =>
          principal.permissions.has(permission),
        );
      case "unmapped":
        return false;
    }
  },

  async writeAudit(event, env) {
    await writeAgentAuditEvent(getDb(env), event);
  },
};

export async function loadAgentAccessBackend(): Promise<AgentAccessBackend> {
  return backend;
}
