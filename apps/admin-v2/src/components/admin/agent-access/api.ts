import { queryOptions } from "@tanstack/react-query";
import {
  deleteApiV1AdminAgentAccessConnectionsRevoked,
  deleteApiV1AdminAgentAccessGrantsByGrantId,
  getApiV1AdminAgentAccessAuthorizationRequestsByRequestId,
  getApiV1AdminAgentAccessConnections,
  getApiV1AdminAgentAccessConnectionsByGrantId,
  getApiV1AdminAgentAccessConnectionsByGrantIdEvents,
  patchApiV1AdminAgentAccessGrantsByGrantId,
  postApiV1AdminAgentAccessAuthorizationRequestsByRequestIdApprove,
  postApiV1AdminAgentAccessAuthorizationRequestsByRequestIdDeny,
  postApiV1AdminAgentAccessDeviceAuthorizationsByDeviceIdApprove,
  postApiV1AdminAgentAccessDeviceAuthorizationsByDeviceIdDeny,
  postApiV1AdminAgentAccessDeviceAuthorizationsLookup,
  postApiV1AdminAgentAccessRevokeAll,
  postApiV1AdminAgentAccessTokens,
  postApiV1AdminAgentAccessTokensByCredentialIdRotate,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";

import type {
  AgentAuditPage,
  AgentAuthorizationDecisionResult,
  AgentAuthorizationRequest,
  AgentClearableConnections,
  AgentConnection,
  AgentConnectionStatusFilter,
  AgentConnectionsPage,
  AgentDeviceDecisionResult,
  AgentDeviceAuthorization,
  AgentGrantKind,
  AgentGrantSelection,
  AgentPurgeRevokedResult,
  AgentResource,
  AgentSecretResult,
  AgentRotationResult,
  CreateAgentTokenInput,
  UpdateAgentGrantInput,
} from "./types";

/**
 * Contract gap: the Agent Access routes declare their responses as open
 * records, so this module keeps its own response types (./types) and states
 * them at each call. Requests are still checked against the contract.
 */
const typed = <T>(call: Promise<unknown>) => call as Promise<T>;

export interface AgentConnectionFilters {
  status?: AgentConnectionStatusFilter;
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
  status?: AgentConnectionStatusFilter;
  resource?: AgentResource;
  kind?: AgentGrantKind;
}): Promise<AgentConnectionsPage> {
  return typed(apiData(getApiV1AdminAgentAccessConnections({ query: params })));
}

/**
 * Counts the revoked and expired connections that "Clear revoked" would
 * permanently delete. Two `limit=1` reads keep this cheap; the API totals
 * come from the same status filters the purge route deletes.
 */
export const agentClearableConnectionsQueryOptions = () =>
  queryOptions({
    queryKey: ["agent-access", "clearable"] as const,
    queryFn: countClearableAgentConnections,
    staleTime: 15_000,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: "always" as const,
  });

export async function countClearableAgentConnections(): Promise<AgentClearableConnections> {
  const [revokedPage, expiredPage] = await Promise.all([
    listAgentConnections({ page: 1, limit: 1, status: "revoked" }),
    listAgentConnections({ page: 1, limit: 1, status: "expired" }),
  ]);
  const revoked = revokedPage.pagination.total;
  const expired = expiredPage.pagination.total;
  return { revoked, expired, total: revoked + expired };
}

/**
 * Permanently deletes every revoked and expired connection (optionally for one
 * resource) together with its credentials, artifacts, and audit history.
 */
export function purgeRevokedAgentConnections(
  resource?: AgentResource,
): Promise<AgentPurgeRevokedResult> {
  return apiData(deleteApiV1AdminAgentAccessConnectionsRevoked({ query: { resource } }));
}

export function getAgentConnection(grantId: string): Promise<AgentConnection> {
  return typed<{ connection: AgentConnection }>(
    apiData(getApiV1AdminAgentAccessConnectionsByGrantId({ path: { grantId } })),
  ).then((result) => result.connection);
}

export function listAgentAuditEvents(
  grantId: string,
  params?: { page?: number; limit?: number },
): Promise<AgentAuditPage> {
  return typed(apiData(getApiV1AdminAgentAccessConnectionsByGrantIdEvents({
    path: { grantId },
    query: params,
  })));
}

export function createAgentToken(
  input: CreateAgentTokenInput,
): Promise<AgentSecretResult> {
  return typed(apiData(postApiV1AdminAgentAccessTokens({ body: input })));
}

export function rotateAgentToken(
  credentialId: string,
  expiresInDays?: number,
): Promise<AgentRotationResult> {
  return typed(apiData(postApiV1AdminAgentAccessTokensByCredentialIdRotate({
    path: { credentialId },
    body: expiresInDays ? { expiresInDays } : {},
  })));
}

export function updateAgentGrant(
  grantId: string,
  input: UpdateAgentGrantInput,
): Promise<AgentConnection> {
  return typed<{ connection: AgentConnection }>(
    apiData(patchApiV1AdminAgentAccessGrantsByGrantId({ path: { grantId }, body: input })),
  ).then((result) => result.connection);
}

export function revokeAgentGrant(
  grantId: string,
  reason?: string,
): Promise<void> {
  return apiData(deleteApiV1AdminAgentAccessGrantsByGrantId({
    path: { grantId },
    body: reason ? { reason } : {},
  })).then(() => undefined);
}

export function revokeAllAgentGrants(reason?: string): Promise<{
  count: number;
}> {
  return typed(apiData(postApiV1AdminAgentAccessRevokeAll({ body: reason ? { reason } : {} })));
}

export function getAgentAuthorizationRequest(
  requestId: string,
): Promise<AgentAuthorizationRequest> {
  return typed<{ authorizationRequest: AgentAuthorizationRequest }>(
    apiData(getApiV1AdminAgentAccessAuthorizationRequestsByRequestId({ path: { requestId } })),
  ).then((result) => result.authorizationRequest);
}

export function approveAgentAuthorizationRequest(
  requestId: string,
  selection: AgentGrantSelection & { label?: string },
): Promise<AgentAuthorizationDecisionResult> {
  const { resource: _resource, ...approval } = selection;
  return typed(apiData(postApiV1AdminAgentAccessAuthorizationRequestsByRequestIdApprove({
    path: { requestId },
    body: approval,
  })));
}

export function denyAgentAuthorizationRequest(
  requestId: string,
  reason?: string,
): Promise<AgentAuthorizationDecisionResult> {
  return typed(apiData(postApiV1AdminAgentAccessAuthorizationRequestsByRequestIdDeny({
    path: { requestId },
    body: reason ? { reason } : {},
  })));
}

export function lookupAgentDeviceAuthorization(
  userCode: string,
): Promise<AgentDeviceAuthorization> {
  return typed<{ deviceAuthorization: AgentDeviceAuthorization }>(
    apiData(postApiV1AdminAgentAccessDeviceAuthorizationsLookup({ body: { userCode } })),
  ).then((result) => result.deviceAuthorization);
}

export function approveAgentDeviceAuthorization(
  deviceId: string,
  selection: AgentGrantSelection & { label?: string },
): Promise<AgentDeviceDecisionResult> {
  const { resource: _resource, ...approval } = selection;
  return typed(apiData(postApiV1AdminAgentAccessDeviceAuthorizationsByDeviceIdApprove({
    path: { deviceId },
    body: approval,
  })));
}

export function denyAgentDeviceAuthorization(
  deviceId: string,
  reason?: string,
): Promise<AgentDeviceDecisionResult> {
  return typed(apiData(postApiV1AdminAgentAccessDeviceAuthorizationsByDeviceIdDeny({
    path: { deviceId },
    body: reason ? { reason } : {},
  })));
}
