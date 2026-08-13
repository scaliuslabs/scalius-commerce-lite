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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactInputContract(inputSchema: unknown) {
  if (!isRecord(inputSchema)) return null;
  const parameters = Array.isArray(inputSchema.parameters) ? inputSchema.parameters : [];
  const parameter = (location: "path" | "query") => parameters.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.in !== location || typeof candidate.name !== "string") return [];
    return [{ name: candidate.name, required: candidate.required === true }];
  });
  const requestBody = isRecord(inputSchema.requestBody) ? inputSchema.requestBody : null;
  const content = requestBody && isRecord(requestBody.content) ? requestBody.content : null;
  const contentTypes = content ? Object.keys(content) : [];
  const jsonMedia = content && isRecord(content["application/json"])
    ? content["application/json"]
    : null;
  const bodySchema = jsonMedia && isRecord(jsonMedia.schema) ? jsonMedia.schema : null;
  const properties = bodySchema && isRecord(bodySchema.properties)
    ? Object.keys(bodySchema.properties)
    : [];
  const required = bodySchema && Array.isArray(bodySchema.required)
    ? bodySchema.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    path: parameter("path"),
    query: parameter("query"),
    body: requestBody
      ? {
        required: requestBody.required === true,
        contentTypes,
        requiredProperties: required,
        optionalProperties: properties.filter((name) => !required.includes(name)),
      }
      : null,
  };
}

export function describeOperation(operation: AgentOperationManifestEntry, full: true): ReturnType<typeof describeOperationFull>;
export function describeOperation(operation: AgentOperationManifestEntry, full?: false): ReturnType<typeof describeOperationCompact>;
export function describeOperation(operation: AgentOperationManifestEntry, full = false) {
  return full ? describeOperationFull(operation) : describeOperationCompact(operation);
}

function describeOperationCompact(operation: AgentOperationManifestEntry) {
  const description = {
    ...summarizeOperation(operation),
    description: operation.description ?? null,
    method: operation.method,
    pathTemplate: operation.pathTemplate,
    principals: operation.principals,
    openWorld: operation.openWorld,
    maxResponseBytes: operation.maxResponseBytes,
    maxRequestBytes: operation.maxRequestBytes,
    sensitiveOutput: operation.sensitiveOutput,
    oneTimeSecretOutput: operation.oneTimeSecretOutput,
    requiredClientAction: operation.requiredClientAction,
    artifactOutput: operation.artifactOutput,
    continuationOutput: operation.continuationOutput,
    rbac: operation.rbac,
    inputContract: compactInputContract(operation.inputSchema),
    input: {
      path: "Object containing only named path-template parameters",
      query: "Object containing query keys and primitive values or arrays",
      body: "JSON body when the operation contract permits it",
      idempotencyKey: "Required or optional only as declared by idempotency",
    },
  };
  return description;
}

function describeOperationFull(operation: AgentOperationManifestEntry) {
  return {
    ...describeOperationCompact(operation),
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
  };
}
