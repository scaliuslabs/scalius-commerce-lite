import { AGENT_OPERATIONS, AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { loadAgentAccessBackend } from "../backend";
import type { AgentResource, AgentPrincipal } from "../types";

export function isMcpOperationExposure(operation: AgentOperationManifestEntry): boolean {
  // A generic MCP tool result has no harness-independent secret channel. The
  // protocol's result `_meta` is client metadata, but hosts decide whether it
  // reaches the model. Keep browser bootstrap fields out of MCP entirely;
  // secure CLI/browser clients can consume these continuation contracts.
  return operation.exposure === "execute" ||
    operation.exposure === "continuation" && !operation.sensitiveOutput;
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

const MAX_COMPACT_SCHEMA_DEPTH = 7;

function compactSchemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((value): value is string => typeof value === "string");
    if (types.length > 0) return types.join("|");
  }
  if (Array.isArray(schema.enum)) return "enum";
  if (schema.const !== undefined) return "literal";
  if (Array.isArray(schema.oneOf)) return "oneOf";
  if (Array.isArray(schema.anyOf)) return "anyOf";
  return "unknown";
}

function compactSchemaDetails(schema: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const itemSchema = isRecord(schema.items) ? schema.items : null;
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : [];
  return {
    type: compactSchemaType(schema),
    ...(typeof schema.description === "string"
      ? { description: schema.description.slice(0, 240) }
      : {}),
    ...(schema.nullable === true ? { nullable: true } : {}),
    ...(Array.isArray(schema.enum) && schema.enum.length <= 20 ? { enum: schema.enum } : {}),
    ...(schema.const !== undefined ? { value: schema.const } : {}),
    ...(typeof schema.format === "string" ? { format: schema.format } : {}),
    ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}),
    ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
    ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
    ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
    ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
    ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
    ...(itemSchema ? {
      itemsType: compactSchemaType(itemSchema),
      ...(depth < MAX_COMPACT_SCHEMA_DEPTH && compactSchemaType(itemSchema) === "object"
        ? { items: compactSchema(itemSchema, depth + 1) }
        : {}),
    } : {}),
    ...(depth < MAX_COMPACT_SCHEMA_DEPTH && alternatives.length > 0 && alternatives.length <= 4
      ? { variants: alternatives.map((candidate) => compactSchema(candidate, depth + 1)) }
      : {}),
  };
}

function compactSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(schema)) return { type: "unknown" };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === "string")
      : [],
  );
  const fields = depth < MAX_COMPACT_SCHEMA_DEPTH && isRecord(schema.properties)
    ? Object.entries(schema.properties).map(([name, value]) => ({
      name,
      required: required.has(name),
      ...compactSchema(isRecord(value) ? value : {}, depth + 1),
    }))
    : null;
  return {
    ...compactSchemaDetails(schema, depth),
    ...(fields ? { fields } : {}),
  };
}

function compactInputContract(inputSchema: unknown) {
  if (!isRecord(inputSchema)) return null;
  const parameters = Array.isArray(inputSchema.parameters) ? inputSchema.parameters : [];
  const parameter = (location: "path" | "query") => parameters.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.in !== location || typeof candidate.name !== "string") return [];
    const schema = isRecord(candidate.schema) ? candidate.schema : {};
    return [{
      name: candidate.name,
      required: candidate.required === true,
      ...compactSchemaDetails(schema),
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    }];
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
        content: content
          ? Object.entries(content).map(([mediaType, declaration]) => ({
            mediaType,
            schema: compactSchema(isRecord(declaration) ? declaration.schema : null),
          }))
          : [],
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
