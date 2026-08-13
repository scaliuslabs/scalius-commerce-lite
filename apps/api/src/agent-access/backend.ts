import { getDb } from "@scalius/database/client";
import type {
  AgentAuditInput,
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
  ): Promise<{ props: AgentOAuthProps; audience: string[] } | null>;
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
}

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
    const audience = [getCanonicalMcpResource(env, principal.resource)];
    return {
      props: {
        grantId: principal.grantId,
        ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
        ownerUserId: principal.ownerUserId,
        resource: principal.resource,
        permissions: [...principal.permissions].sort(),
        riskCeiling: principal.riskCeiling,
        audience,
      },
      audience,
    };
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
      operation.surface === "storefront" && !operation.principals.some((value) => value === "visitor" || value === "customer")
    ) return false;
    if (!isAgentRiskAllowed(principal.riskCeiling, operation.risk)) return false;
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
