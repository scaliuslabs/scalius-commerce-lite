import type { Readable, Writable } from "node:stream";

export type OutputMode = "human" | "json";

export interface Runtime {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  homedir: () => string;
  now: () => number;
  openUrl: (url: string) => Promise<unknown>;
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
  stdin: Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
}

export interface Profile {
  server: string;
}

export interface ConfigFile {
  version: 1;
  activeProfile?: string;
  activeProfiles?: Partial<Record<"dashboard" | "storefront", string>>;
  profiles: Record<string, Profile>;
}

export interface PendingAcknowledgement {
  deviceCode: string;
}

export interface StoredCredential {
  token: string;
  resource?: "dashboard" | "storefront";
  createdAt: string;
  credentialId?: string;
  expiresAt?: string;
  pendingAcknowledgement?: PendingAcknowledgement;
}

export interface CredentialsFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

export interface ResolvedProfile {
  name: string;
  server: string;
  token?: string;
  tokenSource?: "environment" | "disk";
  credential?: StoredCredential;
}

export interface AgentMetadata {
  surface?: "dashboard" | "storefront" | "system";
  exposure?: "execute" | "continuation" | "device" | "excluded";
  principals?: Array<"admin" | "visitor" | "customer" | "internal">;
  risk?: "read" | "write" | "destructive" | "financial" | "security";
  openWorld?: boolean;
  idempotency?: "none" | "supported" | "required";
  revision?: "none" | "optional" | "required";
  batch?: "parallel" | "sequential" | "forbidden";
  transport?: "json" | "multipart" | "octet-stream" | "continuation";
  maximumResponseBytes?: number;
  maxRequestBytes?: number;
  sensitiveOutput?: boolean;
  oneTimeSecretOutput?: boolean;
  requiredClientAction?: "direct-upload";
  artifactOutput?: AgentArtifactOutput;
  continuationOutput?: AgentContinuationOutput;
  exclusionReason?: string;
}

export interface AgentArtifactOutput {
  mediaTypes: string[];
  disposition: "attachment" | "inline";
  filenamePolicy: "content-disposition";
  maxArtifactBytes: number;
  delivery: "direct-stream" | "authenticated-handle";
}

export interface AgentContinuationOutput {
  method: "POST";
  urlJsonPointer: string;
  fieldsJsonPointer: string;
  sensitiveFields: string[];
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, unknown>;
  security?: unknown;
  [key: string]: unknown;
  "x-scalius-agent"?: AgentMetadata;
  "x-scalius-rbac"?: unknown;
}

export interface OpenApiParameter {
  name?: string;
  in?: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: unknown;
  $ref?: string;
}

export interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, { schema?: unknown }>;
  $ref?: string;
}

export interface OpenApiDocument {
  openapi?: string;
  paths?: Record<string, OpenApiPathItem>;
  components?: Record<string, unknown>;
  "x-scalius-workflows"?: unknown;
}

export interface OpenApiPathItem {
  parameters?: OpenApiParameter[];
  [method: string]: OpenApiOperation | OpenApiParameter[] | unknown;
}

export interface IndexedOperation {
  id: string;
  method: string;
  path: string;
  pathParameters: OpenApiParameter[];
  operation: OpenApiOperation;
  agent: AgentMetadata;
}

export interface StructuredInput {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface FileAssignment {
  field: string;
  path: string;
}

export interface OperationExecutionResult {
  operationId: string;
  status: number;
  headers: Record<string, string>;
  data?: unknown;
  savedTo?: string;
  bytesWritten?: number;
}
