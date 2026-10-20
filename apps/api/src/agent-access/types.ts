export type AgentResource = "dashboard" | "storefront";
export type AgentGrantKind = "oauth" | "pat" | "cli";
export type AgentGrantPreset = "read" | "operator" | "full" | "custom";
export type AgentRisk = "read" | "write" | "destructive" | "financial" | "security";
import type { AgentOperationRbac } from "../openapi/agent-operation-manifest";
import type { ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";

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

/**
 * An installed plugin calling `/api/v1` operations through the same dispatch
 * and admin authorization path as agents (apps/api/src/plugins/authority.ts).
 * Its authority is the installation's approved grant intersected with the
 * live, plugin-grantable RBAC catalog; route writes are recorded as the Super
 * Admin who approved that grant, audit rows name the plugin.
 */
export interface PluginPrincipal {
  kind: "plugin";
  pluginId: string;
  version: string;
  pluginName: string;
  /** The approving Super Admin: the acting user of every route write. */
  actorUserId: string;
  /** A bundled first-party app (`scalius.*`): it may also call `beta` operations. */
  firstParty: boolean;
  /** The RBAC permissions its granted scopes confer (`PLUGIN_SCOPES`). */
  permissions: Set<string>;
  /** The protected customer data its granted scopes reveal; other contact fields read null. */
  protectedData: ReadonlySet<ProtectedCustomerData>;
  riskCeiling: AgentRisk;
  /**
   * Who its email and SMS may reach by `to` (apps/api/src/plugins/messaging.ts):
   * any address (`send_messages_any`), and the granted `messaging.recipients`
   * fields of its own records. Absent: neither (staff and customers by id only).
   */
  messaging?: { anyAddress: boolean; recipients: ReadonlyArray<{ object: string; field: string }> };
  /** Host-attested staff initiating this invocation; absent for background jobs. */
  operator?: { userId: string };
}

/** Every non-human principal the operation dispatcher serves. */
export type OperationPrincipal = AgentPrincipal | PluginPrincipal;

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
  /** An opt-in grant scope (`x-scalius-agent.grantScope`): only a Custom grant reaches it. */
  grantScope?: string | null;
}

export interface AgentAuditInput {
  eventId?: string;
  grantId: string | null;
  /** Set for plugin principals, which carry no grant. */
  pluginId?: string | null;
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
