import { apiDelete, apiGet, apiPatch, apiPost } from "~/lib/api";
import { queryOptions } from "@tanstack/react-query";

import type {
  AgentAuditPage,
  AgentAuthorizationDecisionResult,
  AgentAuthorizationRequest,
  AgentConnection,
  AgentConnectionsPage,
  AgentDeviceDecisionResult,
  AgentDeviceAuthorization,
  AgentGrantKind,
  AgentGrantStatus,
  AgentGrantSelection,
  AgentResource,
  AgentSecretResult,
  AgentRotationResult,
  CreateAgentTokenInput,
  UpdateAgentGrantInput,
} from "./types";

const BASE = "/agent-access";

export interface AgentConnectionFilters {
  status?: AgentGrantStatus;
  resource?: AgentResource;
  kind?: AgentGrantKind;
}

export const agentConnectionsQueryOptions = (
  page = 1,
  limit = 20,
  filters: AgentConnectionFilters = {},
) =>
  queryOptions({
    queryKey: ["agent-access", "connections", page, limit, filters] as const,
    queryFn: () => listAgentConnections({ page, limit, ...filters }),
    staleTime: 15_000,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: "always" as const,
  });

export function listAgentConnections(params?: {
  page?: number;
  limit?: number;
  status?: AgentGrantStatus;
  resource?: AgentResource;
  kind?: AgentGrantKind;
}): Promise<AgentConnectionsPage> {
  return apiGet<AgentConnectionsPage>(`${BASE}/connections`, {
    ...(params?.page ? { page: String(params.page) } : {}),
    ...(params?.limit ? { limit: String(params.limit) } : {}),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.resource ? { resource: params.resource } : {}),
    ...(params?.kind ? { kind: params.kind } : {}),
  });
}

export function getAgentConnection(grantId: string): Promise<AgentConnection> {
  return apiGet<{ connection: AgentConnection }>(
    `${BASE}/connections/${encodeURIComponent(grantId)}`,
  ).then((result) => result.connection);
}

export function listAgentAuditEvents(
  grantId: string,
  params?: { page?: number; limit?: number },
): Promise<AgentAuditPage> {
  return apiGet<AgentAuditPage>(
    `${BASE}/connections/${encodeURIComponent(grantId)}/events`,
    {
      ...(params?.page ? { page: String(params.page) } : {}),
      ...(params?.limit ? { limit: String(params.limit) } : {}),
    },
  );
}

export function createAgentToken(
  input: CreateAgentTokenInput,
): Promise<AgentSecretResult> {
  return apiPost<AgentSecretResult>(`${BASE}/tokens`, input);
}

export function rotateAgentToken(
  credentialId: string,
  expiresInDays?: number,
): Promise<AgentRotationResult> {
  return apiPost<AgentRotationResult>(
    `${BASE}/tokens/${encodeURIComponent(credentialId)}/rotate`,
    expiresInDays ? { expiresInDays } : {},
  );
}

export function updateAgentGrant(
  grantId: string,
  input: UpdateAgentGrantInput,
): Promise<AgentConnection> {
  return apiPatch<{ connection: AgentConnection }>(
    `${BASE}/grants/${encodeURIComponent(grantId)}`,
    input,
  ).then((result) => result.connection);
}

export function revokeAgentGrant(
  grantId: string,
  reason?: string,
): Promise<void> {
  return apiDelete<{ status: "revoked"; grantId: string }>(`${BASE}/grants/${encodeURIComponent(grantId)}`, {
    ...(reason ? { reason } : {}),
  }).then(() => undefined);
}

export function revokeAllAgentGrants(reason?: string): Promise<{
  count: number;
}> {
  return apiPost<{ status: "revoked"; count: number }>(`${BASE}/revoke-all`, {
    ...(reason ? { reason } : {}),
  });
}

export function getAgentAuthorizationRequest(
  requestId: string,
): Promise<AgentAuthorizationRequest> {
  return apiGet<{ authorizationRequest: AgentAuthorizationRequest }>(
    `${BASE}/authorization-requests/${encodeURIComponent(requestId)}`,
  ).then((result) => result.authorizationRequest);
}

export function approveAgentAuthorizationRequest(
  requestId: string,
  selection: AgentGrantSelection & { label?: string },
): Promise<AgentAuthorizationDecisionResult> {
  const { resource: _resource, ...approval } = selection;
  return apiPost<AgentAuthorizationDecisionResult>(
    `${BASE}/authorization-requests/${encodeURIComponent(requestId)}/approve`,
    approval,
  );
}

export function denyAgentAuthorizationRequest(
  requestId: string,
  reason?: string,
): Promise<AgentAuthorizationDecisionResult> {
  return apiPost<AgentAuthorizationDecisionResult>(
    `${BASE}/authorization-requests/${encodeURIComponent(requestId)}/deny`,
    reason ? { reason } : {},
  );
}

export function lookupAgentDeviceAuthorization(
  userCode: string,
): Promise<AgentDeviceAuthorization> {
  return apiPost<{ deviceAuthorization: AgentDeviceAuthorization }>(
    `${BASE}/device-authorizations/lookup`,
    { userCode },
  ).then((result) => result.deviceAuthorization);
}

export function approveAgentDeviceAuthorization(
  deviceId: string,
  selection: AgentGrantSelection & { label?: string },
): Promise<AgentDeviceDecisionResult> {
  const { resource: _resource, ...approval } = selection;
  return apiPost<AgentDeviceDecisionResult>(
    `${BASE}/device-authorizations/${encodeURIComponent(deviceId)}/approve`,
    approval,
  );
}

export function denyAgentDeviceAuthorization(
  deviceId: string,
  reason?: string,
): Promise<AgentDeviceDecisionResult> {
  return apiPost<AgentDeviceDecisionResult>(
    `${BASE}/device-authorizations/${encodeURIComponent(deviceId)}/deny`,
    reason ? { reason } : {},
  );
}
