export type AgentResource = "dashboard" | "storefront";
export type AgentGrantKind = "oauth" | "pat" | "cli";
export type AgentPreset = "read" | "operator" | "full" | "custom";
export type AgentGrantStatus = "pending" | "active" | "revoked" | "expired";

export interface AgentCredentialSummary {
  id: string;
  kind: "pat" | "cli";
  tokenHint: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentConnection {
  id: string;
  kind: AgentGrantKind;
  resource: AgentResource;
  label: string;
  clientName: string | null;
  clientId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  preset: AgentPreset;
  status: AgentGrantStatus;
  permissions: string[];
  riskCeiling: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastOperationId: string | null;
  credentials: AgentCredentialSummary[];
}

export interface AgentPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AgentConnectionsPage {
  connections: AgentConnection[];
  pagination: AgentPagination;
}

export interface AgentAuditEvent {
  id: string;
  operationId: string | null;
  resource: AgentResource;
  risk: string;
  outcome: string;
  httpStatus: number | null;
  errorClass: string | null;
  durationMs: number | null;
  requestId: string | null;
  resourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentAuditPage {
  events: AgentAuditEvent[];
  pagination: AgentPagination;
}

export interface AgentSecretResult {
  token: string;
  connection: AgentConnection;
}

export interface AgentRotationResult extends AgentSecretResult {
  credentialId: string;
}

export interface AgentGrantSelection {
  resource: AgentResource;
  preset: AgentPreset;
  permissions: string[];
  expiresInDays: number;
  riskCeiling?: AgentRisk;
}

export type AgentRisk =
  | "read"
  | "write"
  | "destructive"
  | "financial"
  | "security";

export interface CreateAgentTokenInput extends AgentGrantSelection {
  label: string;
}

export interface UpdateAgentGrantInput {
  permissions?: string[];
  expiresAt?: string;
  riskCeiling?: AgentRisk;
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

export const AGENT_PRESETS: ReadonlyArray<{
  id: AgentPreset;
  label: string;
  description: string;
  warning?: string;
}> = [
  {
    id: "read",
    label: "Read only",
    description: "Inspect data without changing the store.",
  },
  {
    id: "operator",
    label: "Operator",
    description: "Read data and perform ordinary day-to-day updates.",
  },
  {
    id: "full",
    label: "Full automation",
    description: "Use every action available to your current Super Admin account.",
    warning: "Includes destructive, financial, security, and agent-access actions.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Choose an exact permission set.",
  },
];

export const AGENT_RESOURCE_COPY: Record<
  AgentResource,
  { label: string; description: string }
> = {
  dashboard: {
    label: "Dashboard",
    description: "Merchant and Super Admin operations.",
  },
  storefront: {
    label: "Storefront",
    description: "Visitor operations plus hosted customer authorization.",
  },
};

export function isAgentPreset(value: string): value is AgentPreset {
  return AGENT_PRESETS.some((preset) => preset.id === value);
}

export function permissionLabel(permission: string): string {
  return permission
    .split(/[._-]/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
