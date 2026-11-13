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
  revokedAt?: string | null;
  /** `security:refresh_token_reused`: the platform revoked it for a reused sign-in key (no person did). */
  revokedReason?: string | null;
  /** The staff member who disconnected it; null when the platform or the tool itself did. */
  revokedByUserId?: string | null;
  revokedByName?: string | null;
}

/** The revocation reason the platform writes when a connection's refresh token is used twice. */
export const SECURITY_REVOCATION_REFRESH_REUSE = "security:refresh_token_reused";
/** The tool disconnected itself (the CLI's sign-out); core `REVOCATION_BY_TOOL`. */
export const REVOCATION_BY_TOOL = "Revoked by credential owner";
/** A CLI pairing never picked up before it expired; core `REVOCATION_PAIRING_UNFINISHED`. */
export const REVOCATION_PAIRING_UNFINISHED = "Unacknowledged CLI pairing expired";

/** Why a connection is disconnected, as staff read it. */
export type DisconnectionCause = "staff" | "security" | "tool" | "unfinished" | "other";

export function disconnectionCause(connection: Pick<AgentConnection, "revokedByUserId" | "revokedReason">): DisconnectionCause {
  if (connection.revokedByUserId) return "staff";
  const reason = connection.revokedReason ?? "";
  if (reason.startsWith("security:")) return "security";
  if (reason === REVOCATION_BY_TOOL) return "tool";
  if (reason === REVOCATION_PAIRING_UNFINISHED) return "unfinished";
  return "other";
}

/** The agent access audit's operation for that reuse. */
export const REFRESH_TOKEN_REUSE_OPERATION = "oauth.refresh_token_reused";

export interface AgentConnectionsPage {
  connections: AgentConnection[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  /** This session may create, change and remove access (store owner, two-step verified). */
  canManage: boolean;
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
  /** Custom keys only: whether deletes and money actions wait for the merchant's approval (on by default). */
  confirmPolicy?: "destructive_financial" | "none";
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
