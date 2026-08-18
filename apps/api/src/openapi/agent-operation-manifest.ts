import type { AgentWorkflowCatalog } from "../agent-access/workflows/types";

export const AGENT_OPERATION_ID_PATTERN =
  /^(dashboard|storefront|system)(\.[a-z][a-z0-9_]*){2,}$/;

export const AGENT_OPERATION_HTTP_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
] as const;

export type AgentOperationHttpMethod =
  (typeof AGENT_OPERATION_HTTP_METHODS)[number];

export type AgentOperationSurface = "dashboard" | "storefront" | "system";
export type AgentOperationExposure =
  | "execute"
  | "continuation"
  | "device"
  | "excluded";
export type AgentOperationPrincipal =
  | "admin"
  | "visitor"
  | "customer"
  | "internal";
export type AgentOperationRisk =
  | "read"
  | "write"
  | "destructive"
  | "financial"
  | "security";
export type AgentOperationIdempotency = "none" | "supported" | "required";
export type AgentOperationRevision = "none" | "optional" | "required";
export type AgentOperationBatch = "parallel" | "sequential" | "forbidden";
export type AgentOperationTransport =
  | "json"
  | "multipart"
  | "octet-stream"
  | "continuation";

export type AgentArtifactOutput = {
  mediaTypes: string[];
  disposition: "attachment" | "inline";
  filenamePolicy: "content-disposition";
  maxArtifactBytes: number;
  delivery: "direct-stream" | "authenticated-handle";
};

export type AgentContinuationOutput = {
  method: "POST";
  urlJsonPointer: string;
  fieldsJsonPointer: string;
  sensitiveFields: string[];
};

export type AgentOperationMetadata = {
  surface: AgentOperationSurface;
  exposure: AgentOperationExposure;
  principals: AgentOperationPrincipal[];
  risk: AgentOperationRisk;
  openWorld: boolean;
  idempotency: AgentOperationIdempotency;
  revision: AgentOperationRevision;
  batch: AgentOperationBatch;
  transport: AgentOperationTransport;
  maximumResponseBytes: number;
  maxRequestBytes: number;
  sensitiveOutput: boolean;
  oneTimeSecretOutput: boolean;
  requiredClientAction?: "direct-upload";
  artifactOutput?: AgentArtifactOutput;
  continuationOutput?: AgentContinuationOutput;
  exclusionReason?: string;
};

export type AgentOperationRbac =
  | { type: "public" }
  | { type: "agentGrant" }
  | { type: "allowAnyAdmin" }
  | { type: "permission"; permission: string }
  | { type: "anyOf"; permissions: string[] }
  | { type: "allOf"; permissions: string[] }
  | { type: "unmapped" };

export type AgentOperationManifestEntry = Omit<
  AgentOperationMetadata,
  | "maximumResponseBytes"
  | "requiredClientAction"
  | "artifactOutput"
  | "continuationOutput"
> & {
  operationId: string;
  method: AgentOperationHttpMethod;
  pathTemplate: string;
  summary: string;
  description?: string;
  tags: string[];
  maxResponseBytes: number;
  maxRequestBytes: number;
  requiredClientAction: "direct-upload" | null;
  artifactOutput: AgentArtifactOutput | null;
  continuationOutput: AgentContinuationOutput | null;
  rbac: AgentOperationRbac;
  inputSchema: unknown;
  outputSchema: unknown;
};

type OpenApiOperationLike = {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  tags?: unknown;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
  "x-scalius-agent"?: unknown;
  "x-scalius-rbac"?: unknown;
};

export type AgentOperationOpenApiDocument = {
  paths?: Record<string, Record<string, unknown> | unknown>;
  "x-scalius-workflows"?: AgentWorkflowCatalog;
};

const AGENT_OPERATION_SURFACES = new Set<AgentOperationSurface>([
  "dashboard",
  "storefront",
  "system",
]);
const AGENT_OPERATION_EXPOSURES = new Set<AgentOperationExposure>([
  "execute",
  "continuation",
  "device",
  "excluded",
]);
const AGENT_OPERATION_PRINCIPALS = new Set<AgentOperationPrincipal>([
  "admin",
  "visitor",
  "customer",
  "internal",
]);
const AGENT_OPERATION_RISKS = new Set<AgentOperationRisk>([
  "read",
  "write",
  "destructive",
  "financial",
  "security",
]);
const AGENT_OPERATION_IDEMPOTENCY = new Set<AgentOperationIdempotency>([
  "none",
  "supported",
  "required",
]);
const AGENT_OPERATION_REVISIONS = new Set<AgentOperationRevision>([
  "none",
  "optional",
  "required",
]);
const AGENT_OPERATION_BATCH = new Set<AgentOperationBatch>([
  "parallel",
  "sequential",
  "forbidden",
]);
const AGENT_OPERATION_TRANSPORTS = new Set<AgentOperationTransport>([
  "json",
  "multipart",
  "octet-stream",
  "continuation",
]);
const AGENT_OPERATION_METHOD_SET = new Set<string>(
  AGENT_OPERATION_HTTP_METHODS,
);
const ONE_TIME_SECRET_OPERATION_IDS = new Set([
  "dashboard.agent_access.tokens.create",
  "dashboard.agent_access.tokens.rotate",
]);
const ONE_TIME_SECRET_MAXIMUM_RESPONSE_BYTES = 16_384;
const AGENT_MAX_REQUEST_BYTES = 1024 * 1024;
const AGENT_ARTIFACT_DELIVERIES = new Set<AgentArtifactOutput["delivery"]>([
  "direct-stream",
  "authenticated-handle",
]);
const AGENT_ARTIFACT_DISPOSITIONS = new Set<AgentArtifactOutput["disposition"]>([
  "attachment",
  "inline",
]);
const AGENT_ARTIFACT_MEDIA_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const AGENT_JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/;
const AGENT_CONTINUATION_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MERCHANT_DESTRUCTIVE_ACTION_PATTERN =
  /(?:^|_)(?:trash|archive|delete)(?:_|$)/;
const MERCHANT_RESTORE_ACTION_PATTERN = /(?:^|_)restore(?:_|$)/;
const REVIEWED_MERCHANT_RESOURCE_RISK_EXCEPTIONS = new Set<string>();
const REVIEWED_CONTINUATION_OUTPUTS: Readonly<
  Record<string, AgentContinuationOutput>
> = {
  "dashboard.theme.preview_session_create": {
    method: "POST",
    urlJsonPointer: "/data/continuation/url",
    fieldsJsonPointer: "/data/continuation/fields",
    sensitiveFields: ["continuationCode"],
  },
  "storefront.customer_auth.begin": {
    method: "POST",
    urlJsonPointer: "/data/browser/url",
    fieldsJsonPointer: "/data/browser/fields",
    sensitiveFields: ["continuationCode"],
  },
  "storefront.orders.payment.begin": {
    method: "POST",
    urlJsonPointer: "/data/browser/url",
    fieldsJsonPointer: "/data/browser/fields",
    sensitiveFields: ["continuationCode"],
  },
  "storefront.payment_recovery.begin": {
    method: "POST",
    urlJsonPointer: "/data/browser/url",
    fieldsJsonPointer: "/data/browser/fields",
    sensitiveFields: ["continuationCode"],
  },
};

const REVIEWED_DEVICE_OPERATION_IDS = new Set([
  "system.agent_auth.device_start",
  "system.agent_auth.device_token",
  "system.agent_auth.device_ack",
  "system.agent_auth.revoke",
  "dashboard.account.password_change",
  "dashboard.account.two_factor.method_challenge",
  "dashboard.account.two_factor.method_update",
  "dashboard.account.two_factor.verify",
  "dashboard.scanner_device.create_link",
  "dashboard.notifications.fcm_device_register",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  field: string,
  operationLabel: string,
): T {
  if (typeof value === "string" && allowed.has(value as T)) {
    return value as T;
  }
  throw new Error(`${operationLabel} has invalid x-scalius-agent.${field}.`);
}

function asBoolean(
  value: unknown,
  field: string,
  operationLabel: string,
): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${operationLabel} has invalid x-scalius-agent.${field}.`);
}

function asPrincipals(value: unknown, operationLabel: string): AgentOperationPrincipal[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${operationLabel} requires a non-empty x-scalius-agent.principals array.`,
    );
  }

  const principals = value.map((principal) =>
    asEnum(
      principal,
      AGENT_OPERATION_PRINCIPALS,
      "principals",
      operationLabel,
    ),
  );
  const uniquePrincipals = Array.from(new Set(principals));
  if (uniquePrincipals.length !== principals.length) {
    throw new Error(`${operationLabel} has duplicate x-scalius-agent.principals.`);
  }
  return uniquePrincipals.sort();
}

function parseArtifactOutput(
  value: unknown,
  operationLabel: string,
): AgentArtifactOutput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${operationLabel} has invalid x-scalius-agent.artifactOutput.`);
  }
  if (
    !Array.isArray(value.mediaTypes) ||
    value.mediaTypes.length === 0 ||
    value.mediaTypes.some(
      (mediaType) =>
        typeof mediaType !== "string" ||
        !AGENT_ARTIFACT_MEDIA_TYPE_PATTERN.test(mediaType),
    )
  ) {
    throw new Error(
      `${operationLabel} requires valid x-scalius-agent.artifactOutput.mediaTypes.`,
    );
  }
  const mediaTypes = Array.from(new Set(value.mediaTypes as string[])).sort();
  if (mediaTypes.length !== value.mediaTypes.length) {
    throw new Error(
      `${operationLabel} has duplicate x-scalius-agent.artifactOutput.mediaTypes.`,
    );
  }
  if (
    typeof value.disposition !== "string" ||
    !AGENT_ARTIFACT_DISPOSITIONS.has(
      value.disposition as AgentArtifactOutput["disposition"],
    ) ||
    value.filenamePolicy !== "content-disposition" ||
    typeof value.delivery !== "string" ||
    !AGENT_ARTIFACT_DELIVERIES.has(
      value.delivery as AgentArtifactOutput["delivery"],
    ) ||
    typeof value.maxArtifactBytes !== "number" ||
    !Number.isSafeInteger(value.maxArtifactBytes) ||
    value.maxArtifactBytes < 1 ||
    value.maxArtifactBytes > 16 * 1024 * 1024
  ) {
    throw new Error(`${operationLabel} has invalid x-scalius-agent.artifactOutput policy.`);
  }
  return {
    mediaTypes,
    disposition: value.disposition as AgentArtifactOutput["disposition"],
    filenamePolicy: "content-disposition",
    maxArtifactBytes: value.maxArtifactBytes,
    delivery: value.delivery as AgentArtifactOutput["delivery"],
  };
}

function parseContinuationOutput(
  value: unknown,
  operationLabel: string,
): AgentContinuationOutput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(
      `${operationLabel} has invalid x-scalius-agent.continuationOutput.`,
    );
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys.join(",") !==
      "fieldsJsonPointer,method,sensitiveFields,urlJsonPointer" ||
    value.method !== "POST" ||
    typeof value.urlJsonPointer !== "string" ||
    value.urlJsonPointer.length > 128 ||
    !AGENT_JSON_POINTER_PATTERN.test(value.urlJsonPointer) ||
    typeof value.fieldsJsonPointer !== "string" ||
    value.fieldsJsonPointer.length > 128 ||
    !AGENT_JSON_POINTER_PATTERN.test(value.fieldsJsonPointer) ||
    value.fieldsJsonPointer === value.urlJsonPointer ||
    !Array.isArray(value.sensitiveFields) ||
    value.sensitiveFields.length === 0 ||
    value.sensitiveFields.length > 8 ||
    value.sensitiveFields.some(
      (field) =>
        typeof field !== "string" ||
        !AGENT_CONTINUATION_FIELD_PATTERN.test(field),
    )
  ) {
    throw new Error(
      `${operationLabel} has invalid x-scalius-agent.continuationOutput.`,
    );
  }
  const sensitiveFields = Array.from(
    new Set(value.sensitiveFields as string[]),
  ).sort();
  if (sensitiveFields.length !== value.sensitiveFields.length) {
    throw new Error(
      `${operationLabel} has duplicate x-scalius-agent.continuationOutput.sensitiveFields.`,
    );
  }
  return {
    method: "POST",
    urlJsonPointer: value.urlJsonPointer,
    fieldsJsonPointer: value.fieldsJsonPointer,
    sensitiveFields,
  };
}

export function parseAgentOperationMetadata(
  value: unknown,
  operationLabel: string,
): AgentOperationMetadata {
  if (!isRecord(value)) {
    throw new Error(`${operationLabel} is missing x-scalius-agent metadata.`);
  }

  const exposure = asEnum(
    value.exposure,
    AGENT_OPERATION_EXPOSURES,
    "exposure",
    operationLabel,
  );
  const maximumResponseBytes = value.maximumResponseBytes;
  if (
    typeof maximumResponseBytes !== "number" ||
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > 65_536
  ) {
    throw new Error(
      `${operationLabel} requires x-scalius-agent.maximumResponseBytes from 1 through 65536.`,
    );
  }

  const exclusionReason = value.exclusionReason;
  if (
    exposure === "excluded" &&
    (typeof exclusionReason !== "string" || exclusionReason.trim().length === 0)
  ) {
    throw new Error(
      `${operationLabel} requires x-scalius-agent.exclusionReason when excluded.`,
    );
  }
  if (
    exposure !== "excluded" &&
    exclusionReason !== undefined
  ) {
    throw new Error(
      `${operationLabel} must omit x-scalius-agent.exclusionReason when ${exposure}.`,
    );
  }

  const artifactOutput = parseArtifactOutput(value.artifactOutput, operationLabel);
  const continuationOutput = parseContinuationOutput(
    value.continuationOutput,
    operationLabel,
  );
  const transport = asEnum(
    value.transport,
    AGENT_OPERATION_TRANSPORTS,
    "transport",
    operationLabel,
  );
  const maxRequestBytes = value.maxRequestBytes ?? AGENT_MAX_REQUEST_BYTES;
  if (
    typeof maxRequestBytes !== "number" ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    maxRequestBytes > 16 * 1024 * 1024
  ) {
    throw new Error(
      `${operationLabel} requires x-scalius-agent.maxRequestBytes from 1 through 16777216.`,
    );
  }
  const requiredClientAction = value.requiredClientAction;
  if (
    requiredClientAction !== undefined &&
    requiredClientAction !== "direct-upload"
  ) {
    throw new Error(
      `${operationLabel} has invalid x-scalius-agent.requiredClientAction.`,
    );
  }
  const metadata: AgentOperationMetadata = {
    surface: asEnum(
      value.surface,
      AGENT_OPERATION_SURFACES,
      "surface",
      operationLabel,
    ),
    exposure,
    principals: asPrincipals(value.principals, operationLabel),
    risk: asEnum(value.risk, AGENT_OPERATION_RISKS, "risk", operationLabel),
    openWorld: asBoolean(value.openWorld, "openWorld", operationLabel),
    idempotency: asEnum(
      value.idempotency,
      AGENT_OPERATION_IDEMPOTENCY,
      "idempotency",
      operationLabel,
    ),
    revision: asEnum(
      value.revision,
      AGENT_OPERATION_REVISIONS,
      "revision",
      operationLabel,
    ),
    batch: asEnum(value.batch, AGENT_OPERATION_BATCH, "batch", operationLabel),
    transport,
    maximumResponseBytes,
    maxRequestBytes,
    sensitiveOutput: asBoolean(
      value.sensitiveOutput,
      "sensitiveOutput",
      operationLabel,
    ),
    oneTimeSecretOutput:
      value.oneTimeSecretOutput === undefined
        ? false
        : asBoolean(
            value.oneTimeSecretOutput,
            "oneTimeSecretOutput",
            operationLabel,
          ),
    ...(artifactOutput ? { artifactOutput } : {}),
    ...(continuationOutput ? { continuationOutput } : {}),
    ...(requiredClientAction === "direct-upload"
      ? { requiredClientAction }
      : {}),
    ...(typeof exclusionReason === "string"
      ? { exclusionReason: exclusionReason.trim() }
      : {}),
  };

  if (
    metadata.surface === "dashboard" &&
    metadata.exposure !== "excluded" &&
    !REVIEWED_MERCHANT_RESOURCE_RISK_EXCEPTIONS.has(operationLabel)
  ) {
    const action = operationLabel.split(".").at(-1) ?? "";
    const expectedRisk = MERCHANT_DESTRUCTIVE_ACTION_PATTERN.test(action)
      ? "destructive"
      : MERCHANT_RESTORE_ACTION_PATTERN.test(action)
        ? "write"
        : null;
    if (expectedRisk && metadata.risk !== expectedRisk) {
      throw new Error(
        `${operationLabel} merchant resource ${action} must use ${expectedRisk} risk.`,
      );
    }
  }

  if (metadata.oneTimeSecretOutput) {
    const validOneTimeSecretPolicy =
      ONE_TIME_SECRET_OPERATION_IDS.has(operationLabel) &&
      metadata.sensitiveOutput &&
      metadata.surface === "dashboard" &&
      metadata.exposure === "execute" &&
      metadata.principals.length === 1 &&
      metadata.principals[0] === "admin" &&
      metadata.transport === "json" &&
      metadata.idempotency === "none" &&
      metadata.revision === "none" &&
      metadata.batch === "forbidden" &&
      metadata.maximumResponseBytes <= ONE_TIME_SECRET_MAXIMUM_RESPONSE_BYTES;
    if (!validOneTimeSecretPolicy) {
      throw new Error(
        `${operationLabel} has invalid x-scalius-agent.oneTimeSecretOutput policy.`,
      );
    }
  }
  if (
    metadata.exposure === "device" &&
    (
      !REVIEWED_DEVICE_OPERATION_IDS.has(operationLabel) ||
      metadata.risk !== "security" ||
      metadata.batch !== "forbidden" ||
      metadata.transport !== "json" ||
      metadata.maximumResponseBytes > 16_384 ||
      metadata.oneTimeSecretOutput ||
      metadata.requiredClientAction !== undefined ||
      metadata.artifactOutput !== undefined ||
      metadata.continuationOutput !== undefined
    )
  ) {
    throw new Error(
      `${operationLabel} has invalid x-scalius-agent device operation policy.`,
    );
  }
  if (metadata.risk !== "read" && metadata.batch === "parallel") {
    throw new Error(
      `${operationLabel} cannot use parallel batching for a ${metadata.risk} operation.`,
    );
  }
  if (
    metadata.artifactOutput &&
    (
      metadata.batch !== "forbidden" ||
      metadata.sensitiveOutput ||
      metadata.oneTimeSecretOutput ||
      metadata.transport === "continuation" ||
      !["execute", "excluded"].includes(metadata.exposure)
    )
  ) {
    throw new Error(
      `${operationLabel} has invalid x-scalius-agent.artifactOutput operation policy.`,
    );
  }
  if (metadata.continuationOutput) {
    const reviewedPolicy = REVIEWED_CONTINUATION_OUTPUTS[operationLabel];
    const validContinuationPolicy =
      reviewedPolicy !== undefined &&
      metadata.exposure === "continuation" &&
      metadata.transport === "continuation" &&
      metadata.batch === "forbidden" &&
      metadata.sensitiveOutput &&
      !metadata.oneTimeSecretOutput &&
      metadata.requiredClientAction === undefined &&
      metadata.artifactOutput === undefined &&
      metadata.maximumResponseBytes <= 8_192 &&
      JSON.stringify(metadata.continuationOutput) ===
        JSON.stringify(reviewedPolicy);
    if (!validContinuationPolicy) {
      throw new Error(
        `${operationLabel} has invalid x-scalius-agent.continuationOutput operation policy.`,
      );
    }
  }
  if (
    metadata.exposure === "continuation" &&
    metadata.sensitiveOutput &&
    metadata.continuationOutput === undefined
  ) {
    throw new Error(
      `${operationLabel} requires reviewed x-scalius-agent.continuationOutput for sensitive continuation output.`,
    );
  }
  if (
    (metadata.transport === "octet-stream" || metadata.requiredClientAction) &&
    (
      metadata.transport !== "octet-stream" ||
      metadata.requiredClientAction !== "direct-upload" ||
      metadata.batch !== "forbidden" ||
      metadata.idempotency !== "none" ||
      metadata.sensitiveOutput ||
      metadata.oneTimeSecretOutput
    )
  ) {
    throw new Error(
      `${operationLabel} has invalid octet-stream direct-upload policy.`,
    );
  }

  return metadata;
}

function parseRbac(value: unknown, operationLabel: string): AgentOperationRbac {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`${operationLabel} is missing x-scalius-rbac metadata.`);
  }

  switch (value.type) {
    case "public":
    case "agentGrant":
    case "allowAnyAdmin":
    case "unmapped":
      return { type: value.type };
    case "permission":
      if (typeof value.permission !== "string" || value.permission.length === 0) {
        break;
      }
      return { type: "permission", permission: value.permission };
    case "anyOf":
    case "allOf": {
      if (
        !Array.isArray(value.permissions) ||
        value.permissions.length === 0 ||
        value.permissions.some(
          (permission) => typeof permission !== "string" || permission.length === 0,
        )
      ) {
        break;
      }
      return {
        type: value.type,
        permissions: Array.from(new Set(value.permissions as string[])).sort(),
      };
    }
  }

  throw new Error(`${operationLabel} has invalid x-scalius-rbac metadata.`);
}

function successOutputSchema(responses: unknown): unknown {
  if (!isRecord(responses)) return null;
  for (const status of Object.keys(responses).sort()) {
    if (!/^2\d\d$/.test(status)) continue;
    const response = responses[status];
    if (!isRecord(response)) return null;
    const content = response.content;
    if (!isRecord(content)) return null;
    const jsonContent = content["application/json"];
    if (!isRecord(jsonContent)) return null;
    return jsonContent.schema ?? null;
  }
  return null;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function assertRequiredJsonSchemaPointer(
  schema: unknown,
  pointer: string,
  operationLabel: string,
): unknown {
  let current = schema;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment);
    if (
      !isRecord(current) ||
      !isRecord(current.properties) ||
      !Array.isArray(current.required) ||
      !current.required.includes(segment)
    ) {
      throw new Error(
        `${operationLabel} continuationOutput pointer ${pointer} must resolve through required output fields.`,
      );
    }
    current = current.properties[segment];
  }
  return current;
}

function isBoundedStringSchema(
  value: unknown,
  maximumAllowedLength: number,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === "string" &&
    typeof value.maxLength === "number" &&
    Number.isSafeInteger(value.maxLength) &&
    value.maxLength >= 1 &&
    value.maxLength <= maximumAllowedLength
  );
}

function assertContinuationOutputSchema(
  outputSchema: unknown,
  policy: AgentContinuationOutput,
  operationLabel: string,
): void {
  const urlSchema = assertRequiredJsonSchemaPointer(
    outputSchema,
    policy.urlJsonPointer,
    operationLabel,
  );
  if (!isBoundedStringSchema(urlSchema, 2_048) || urlSchema.format !== "uri") {
    throw new Error(
      `${operationLabel} continuationOutput URL must be a required URI string bounded to 2048 characters.`,
    );
  }

  const fieldsSchema = assertRequiredJsonSchemaPointer(
    outputSchema,
    policy.fieldsJsonPointer,
    operationLabel,
  );
  if (!isRecord(fieldsSchema) || fieldsSchema.type !== "object") {
    throw new Error(
      `${operationLabel} continuationOutput fields pointer must resolve to a required object.`,
    );
  }
  for (const sensitiveField of policy.sensitiveFields) {
    const sensitiveSchema = isRecord(fieldsSchema.properties)
      ? fieldsSchema.properties[sensitiveField]
      : undefined;
    if (
      !Array.isArray(fieldsSchema.required) ||
      !fieldsSchema.required.includes(sensitiveField) ||
      !isBoundedStringSchema(sensitiveSchema, 4_096)
    ) {
      throw new Error(
        `${operationLabel} continuationOutput sensitive field ${sensitiveField} must be a required bounded string.`,
      );
    }
  }

  const fieldsSegments = policy.fieldsJsonPointer.split("/");
  const methodPointer = `${fieldsSegments.slice(0, -1).join("/")}/method`;
  const methodSchema = assertRequiredJsonSchemaPointer(
    outputSchema,
    methodPointer,
    operationLabel,
  );
  if (
    !isRecord(methodSchema) ||
    methodSchema.type !== "string" ||
    !Array.isArray(methodSchema.enum) ||
    methodSchema.enum.length !== 1 ||
    methodSchema.enum[0] !== policy.method
  ) {
    throw new Error(
      `${operationLabel} continuationOutput method must be the required literal ${policy.method}.`,
    );
  }


  if (operationLabel === "dashboard.theme.preview_session_create") {
    if ((urlSchema as Record<string, unknown>).maxLength !== 512) {
      throw new Error(
        `${operationLabel} continuationOutput URL must have maxLength 512.`,
      );
    }
    if (!isRecord(fieldsSchema.properties)) {
      throw new Error(
        `${operationLabel} continuationOutput fields require a closed reviewed schema.`,
      );
    }
    const fieldNames = Object.keys(fieldsSchema.properties).sort();
    const requiredFields = Array.isArray(fieldsSchema.required)
      ? [...fieldsSchema.required].sort()
      : [];
    if (
      fieldNames.join(",") !== "continuationCode,device,path" ||
      requiredFields.join(",") !== "continuationCode,device,path"
    ) {
      throw new Error(
        `${operationLabel} continuationOutput fields must match the reviewed form contract.`,
      );
    }
    const continuationCode = fieldsSchema.properties.continuationCode;
    const path = fieldsSchema.properties.path;
    const device = fieldsSchema.properties.device;
    if (
      !isRecord(continuationCode) ||
      continuationCode.type !== "string" ||
      continuationCode.minLength !== 52 ||
      continuationCode.maxLength !== 52 ||
      continuationCode.pattern !== "^tpc_[A-Za-z0-9_-]{48}$" ||
      !isRecord(path) ||
      path.type !== "string" ||
      path.minLength !== 1 ||
      path.maxLength !== 512 ||
      !isRecord(device) ||
      device.type !== "string" ||
      !Array.isArray(device.enum) ||
      device.enum.join(",") !== "full,desktop,mobile"
    ) {
      throw new Error(
        `${operationLabel} continuationOutput fields must remain bounded by the reviewed form grammar.`,
      );
    }
  }
}

function inputSchema(operation: OpenApiOperationLike): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (operation.parameters !== undefined) input.parameters = operation.parameters;
  if (operation.requestBody !== undefined) input.requestBody = operation.requestBody;
  return input;
}

function assertSurfaceMatchesOperationId(
  operationId: string,
  surface: AgentOperationSurface,
): void {
  const operationIdSurface = operationId.split(".", 1)[0];
  if (operationIdSurface !== surface) {
    throw new Error(
      `${operationId} has surface ${surface}; its operationId prefix must match.`,
    );
  }
}

export function buildAgentOperationManifest(
  document: AgentOperationOpenApiDocument,
): AgentOperationManifestEntry[] {
  const manifest: AgentOperationManifestEntry[] = [];
  const operationIds = new Set<string>();

  for (const pathTemplate of Object.keys(document.paths ?? {}).sort()) {
    const pathItem = document.paths?.[pathTemplate];
    if (!isRecord(pathItem)) continue;

    for (const rawMethod of Object.keys(pathItem).sort()) {
      const method = rawMethod.toUpperCase();
      if (!AGENT_OPERATION_METHOD_SET.has(method)) continue;
      const operation = pathItem[rawMethod] as OpenApiOperationLike;
      const operationLabel = `${method} ${pathTemplate}`;
      if (!isRecord(operation)) continue;

      if (
        typeof operation.operationId !== "string" ||
        !AGENT_OPERATION_ID_PATTERN.test(operation.operationId)
      ) {
        throw new Error(`${operationLabel} has an invalid operationId.`);
      }
      if (operationIds.has(operation.operationId)) {
        throw new Error(`Duplicate OpenAPI operationId ${operation.operationId}.`);
      }
      operationIds.add(operation.operationId);

      const metadata = parseAgentOperationMetadata(
        operation["x-scalius-agent"],
        operation.operationId,
      );
      assertSurfaceMatchesOperationId(operation.operationId, metadata.surface);
      const operationOutputSchema = successOutputSchema(operation.responses);
      if (metadata.continuationOutput) {
        assertContinuationOutputSchema(
          operationOutputSchema,
          metadata.continuationOutput,
          operation.operationId,
        );
      }
      const rbac = parseRbac(
        operation["x-scalius-rbac"],
        operation.operationId,
      );
      if (metadata.exposure !== "excluded" && rbac.type === "unmapped") {
        throw new Error(
          `${operation.operationId} cannot be ${metadata.exposure} with unmapped RBAC.`,
        );
      }
      if (
        (metadata.exposure === "execute" || metadata.exposure === "continuation") &&
        metadata.surface === "dashboard" &&
        (
          metadata.principals.length !== 1 ||
          metadata.principals[0] !== "admin" ||
          ["public", "agentGrant", "unmapped"].includes(rbac.type)
        )
      ) {
        throw new Error(
          `${operation.operationId} has invalid dashboard executable authority metadata.`,
        );
      }
      if (
        (metadata.exposure === "execute" || metadata.exposure === "continuation") &&
        metadata.surface === "storefront"
      ) {
        const validPrincipals =
          (metadata.principals.length === 1 &&
            ["visitor", "customer"].includes(metadata.principals[0] ?? "")) ||
          (metadata.principals.length === 2 &&
            metadata.principals[0] === "customer" &&
            metadata.principals[1] === "visitor");
        const validRbac = rbac.type === "public" || rbac.type === "agentGrant";
        if (!validPrincipals || !validRbac) {
          throw new Error(
            `${operation.operationId} has invalid storefront executable authority metadata.`,
          );
        }
      }
      if (
        (metadata.exposure === "execute" || metadata.exposure === "continuation") &&
        metadata.surface === "system"
      ) {
        throw new Error(
          `${operation.operationId} cannot expose a system operation for general execution.`,
        );
      }

      const summary =
        typeof operation.summary === "string" && operation.summary.length > 0
          ? operation.summary
          : `${method} ${pathTemplate}`;
      if (
        operation.description !== undefined &&
        (typeof operation.description !== "string" || operation.description.length > 4_096)
      ) {
        throw new Error(`${operation.operationId} requires a description of at most 4096 characters.`);
      }
      if (
        operation.tags !== undefined &&
        (!Array.isArray(operation.tags) ||
        operation.tags.some((tag) => typeof tag !== "string")
        )
      ) {
        throw new Error(`${operation.operationId} requires string tags.`);
      }

      manifest.push({
        operationId: operation.operationId,
        method: method as AgentOperationHttpMethod,
        pathTemplate,
        summary,
        ...(typeof operation.description === "string" && operation.description.length > 0
          ? { description: operation.description }
          : {}),
        tags: [...((operation.tags as string[] | undefined) ?? [])].sort(),
        surface: metadata.surface,
        exposure: metadata.exposure,
        principals: metadata.principals,
        risk: metadata.risk,
        openWorld: metadata.openWorld,
        idempotency: metadata.idempotency,
        revision: metadata.revision,
        batch: metadata.batch,
        transport: metadata.transport,
        maxResponseBytes: metadata.maximumResponseBytes,
        maxRequestBytes: metadata.maxRequestBytes,
        sensitiveOutput: metadata.sensitiveOutput,
        oneTimeSecretOutput: metadata.oneTimeSecretOutput,
        requiredClientAction: metadata.requiredClientAction ?? null,
        artifactOutput: metadata.artifactOutput ?? null,
        continuationOutput: metadata.continuationOutput ?? null,
        ...(metadata.exclusionReason
          ? { exclusionReason: metadata.exclusionReason }
          : {}),
        rbac,
        inputSchema:
          metadata.exposure === "excluded" ? null : inputSchema(operation),
        outputSchema:
          metadata.exposure === "excluded"
            ? null
            : operationOutputSchema,
      });
    }
  }

  return manifest.sort((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );
}

export function renderAgentOperationManifestModule(
  entries: readonly AgentOperationManifestEntry[],
  workflowCatalog: AgentWorkflowCatalog,
): string {
  return `// This file is generated from the finalized /api/v1 OpenAPI contract.\n// Do not edit by hand.\n\nimport type { AgentWorkflowCatalog } from "../agent-access/workflows/types";\nimport type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";\n\nexport const AGENT_OPERATIONS: readonly AgentOperationManifestEntry[] = ${JSON.stringify(entries, null, 2)};\n\nexport const AGENT_OPERATIONS_BY_ID: Readonly<Record<string, AgentOperationManifestEntry>> = Object.freeze(\n  Object.fromEntries(AGENT_OPERATIONS.map((operation) => [operation.operationId, operation])),\n);\n\nexport const AGENT_WORKFLOW_CATALOG: AgentWorkflowCatalog = ${JSON.stringify(workflowCatalog, null, 2)};\n`;
}
