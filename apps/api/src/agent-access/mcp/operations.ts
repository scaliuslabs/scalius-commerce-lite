import { AGENT_OPERATIONS, AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { loadAgentAccessBackend } from "../backend";
import type { AgentResource, AgentPrincipal } from "../types";

export function isMcpOperationExposure(operation: AgentOperationManifestEntry): boolean {
  return operation.exposure === "execute" || operation.exposure === "continuation";
}

function authorizationInput(operation: AgentOperationManifestEntry) {
  return {
    rbac: operation.rbac,
    risk: operation.risk,
    surface: operation.surface,
    exposure: operation.exposure,
    principals: operation.principals,
  };
}

export async function listAuthorizedOperations(
  surface: AgentResource,
  principal: AgentPrincipal,
): Promise<AgentOperationManifestEntry[]> {
  const backend = await loadAgentAccessBackend();
  const candidates: readonly AgentOperationManifestEntry[] = AGENT_OPERATIONS;
  const surfaced = candidates.filter(
    (operation) => operation.surface === surface && isMcpOperationExposure(operation),
  );
  const allowed = await Promise.all(
    surfaced.map(async (operation): Promise<AgentOperationManifestEntry | null> =>
      (await backend.authorizeOperation(principal, authorizationInput(operation)))
        ? operation
        : null,
    ),
  );
  return allowed.filter((operation): operation is AgentOperationManifestEntry => operation !== null);
}

export async function getAuthorizedOperation(
  operationId: string,
  surface: AgentResource,
  principal: AgentPrincipal,
): Promise<AgentOperationManifestEntry | null> {
  const operation = AGENT_OPERATIONS_BY_ID[operationId];
  if (!operation || operation.surface !== surface || !isMcpOperationExposure(operation)) {
    return null;
  }
  const backend = await loadAgentAccessBackend();
  return (await backend.authorizeOperation(principal, authorizationInput(operation)))
    ? operation
    : null;
}

export function summarizeOperation(operation: AgentOperationManifestEntry) {
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    tags: operation.tags,
    risk: operation.risk,
    exposure: operation.exposure,
    idempotency: operation.idempotency,
    revision: operation.revision,
    batch: operation.batch,
    transport: operation.transport,
  };
}

export function describeOperation(operation: AgentOperationManifestEntry) {
  return {
    ...summarizeOperation(operation),
    method: operation.method,
    pathTemplate: operation.pathTemplate,
    principals: operation.principals,
    openWorld: operation.openWorld,
    maxResponseBytes: operation.maxResponseBytes,
    sensitiveOutput: operation.sensitiveOutput,
    oneTimeSecretOutput: operation.oneTimeSecretOutput,
    rbac: operation.rbac,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    input: {
      path: "Object containing only named path-template parameters",
      query: "Object containing query keys and primitive values or arrays",
      body: "JSON body when the operation contract permits it",
      idempotencyKey: "Required or optional only as declared by idempotency",
    },
  };
}
