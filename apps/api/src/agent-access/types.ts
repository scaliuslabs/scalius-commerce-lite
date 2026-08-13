export type AgentResource = "dashboard" | "storefront";
export type AgentGrantKind = "oauth" | "pat" | "cli";
export type AgentGrantPreset = "read" | "operator" | "full" | "custom";
export type AgentRisk = "read" | "write" | "destructive" | "financial" | "security";
import type { AgentOperationRbac } from "../openapi/agent-operation-manifest";

export interface AgentPrincipal {
  kind: "agent";
  grantId: string;
  credentialId: string | null;
  ownerUserId: string;
  isSuperAdmin: boolean;
  resource: AgentResource;
  grantKind: AgentGrantKind;
  preset: AgentGrantPreset;
  permissions: Set<string>;
  riskCeiling: AgentRisk;
  authorityRevision: number;
  expiresAt: Date;
}

export interface AgentOAuthProps {
  grantId: string;
  credentialId?: string;
  ownerUserId: string;
  resource: AgentResource;
  permissions: string[];
  riskCeiling: AgentRisk;
  audience: string[];
}

export interface ValidatedAuthorizationRequest {
  responseType: "code";
  resource: string;
  clientId: string;
  clientName?: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  issuer?: string;
}

export interface PendingAuthorization {
  requestId: string;
  dashboardUrl: string;
  expiresAt: string;
}

export interface CompletedAuthorization {
  request: ValidatedAuthorizationRequest;
  userId: string;
  metadata: {
    grantId: string;
    resource: AgentResource;
    clientName: string | null;
  };
  scope: ["agent:access"];
  props: AgentOAuthProps;
  revokeExistingGrants: false;
}

export type ClaimedAuthorizationCompletion =
  | {
      kind: "approved";
      claimToken: string;
      authorization: CompletedAuthorization;
    }
  | {
      kind: "denied";
      claimToken: string;
      request: ValidatedAuthorizationRequest;
    };

export interface AgentManifestAuthorizationInput {
  rbac: AgentOperationRbac;
  risk: AgentRisk;
  surface: AgentResource | "system";
  exposure: "execute" | "continuation" | "device" | "excluded";
  principals: Array<"admin" | "visitor" | "customer" | "internal">;
}

export interface AgentAuditInput {
  eventId?: string;
  grantId: string | null;
  credentialId?: string | null;
  ownerUserId?: string | null;
  resource?: AgentResource | null;
  operationId: string;
  risk: AgentRisk;
  outcome: "success" | "denied" | "failed";
  httpStatus?: number | null;
  errorClass?: string | null;
  durationMs?: number | null;
  requestId?: string | null;
  idempotencyKeyHashPrefix?: string | null;
  resourceIds?: string[];
  metadata?: Record<string, string | number | boolean | null>;
}

const RISK_RANK: Record<AgentRisk, number> = {
  read: 0,
  write: 1,
  destructive: 2,
  financial: 3,
  security: 4,
};

export function isAgentRiskAllowed(ceiling: AgentRisk, requested: AgentRisk): boolean {
  return RISK_RANK[requested] <= RISK_RANK[ceiling];
}
