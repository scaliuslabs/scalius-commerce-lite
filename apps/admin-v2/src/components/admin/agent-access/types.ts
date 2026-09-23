import type {
  DeleteApiV1AdminAgentAccessConnectionsRevokedResponses,
  GetApiV1AdminAgentAccessConnectionsData,
} from "@scalius/api-client/types";

export type AgentResource = "dashboard" | "storefront";
export type AgentGrantKind = "oauth" | "pat" | "cli";
export type AgentPreset = "read" | "operator" | "full" | "custom";
export type AgentGrantStatus = "pending" | "active" | "revoked" | "expired";
/** Connection list filter; `revoked` + `expired` are what "Clear old connections" deletes. */
export type AgentConnectionStatusFilter = NonNullable<
  NonNullable<GetApiV1AdminAgentAccessConnectionsData["query"]>["status"]
>;

export interface AgentClearableConnections {
  revoked: number;
  expired: number;
  total: number;
}

export type AgentPurgeRevokedResult =
  DeleteApiV1AdminAgentAccessConnectionsRevokedResponses[200]["data"];

/** One key behind a connection. The key itself is never returned after it is shown once. */
export interface AgentCredential {
  id: string;
  kind: AgentGrantKind;
  tokenHint: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentConnection {
  id: string;
  kind: AgentGrantKind;
  resource: AgentResource;
  label: string;
  clientName: string | null;
  ownerName: string | null;
  preset: AgentPreset;
  /** Permission names this connection holds (what "custom" access means). */
  permissions?: string[];
  riskCeiling?: AgentRisk | null;
  credentials?: AgentCredential[];
  status: AgentGrantStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface AgentConnectionsPage {
  connections: AgentConnection[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AgentSecretResult {
  token: string;
  connection: AgentConnection;
}

export type AgentRisk = "read" | "write" | "destructive" | "financial" | "security";

export interface AgentAuditEvent {
  id: string;
  operationId: string;
  risk: AgentRisk;
  outcome: "success" | "denied" | "failed";
  createdAt: string;
}

export interface AgentAuditEventsPage {
  events: AgentAuditEvent[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AgentRotateResult {
  token: string;
  credentialId: string;
  connection: AgentConnection;
}

export interface AgentGrantSelection {
  resource: AgentResource;
  preset: AgentPreset;
  permissions: string[];
  expiresInDays: number;
  riskCeiling?: AgentRisk;
}

export interface CreateAgentTokenInput extends AgentGrantSelection {
  label: string;
}

export interface AgentAuthorizationRequest {
  id: string;
  resource: AgentResource;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestedPermissions: string[];
}

export interface AgentDeviceAuthorization {
  id: string;
  clientName: string | null;
  profileName: string | null;
  resource: AgentResource;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired" | "acknowledged";
}

export type AgentAuthorizationDecisionResult =
  | { status: "approved"; grantId: string; completionUrl: string }
  | { status: "denied"; completionUrl: string };

export type AgentDeviceDecisionResult =
  | { status: "approved"; grantId: string; credentialId: string }
  | { status: "denied" };
