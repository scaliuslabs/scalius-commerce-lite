import { basename } from "node:path";
import { open, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { writeAtomicOutput } from "./config.js";
import { CliError } from "./errors.js";
import { bearerHeaders, fetchWithNetworkErrors, responseError } from "./http.js";
import { findOperation, getIndexedOperations, searchOperations } from "./openapi.js";
import { parseFileAssignment } from "./input.js";
import { writeDiagnostic } from "./output.js";
import type {
  IndexedOperation,
  AgentArtifactOutput,
  OpenApiDocument,
  OpenApiRequestBody,
  OperationExecutionResult,
  ResolvedProfile,
  Runtime,
  StructuredInput,
} from "./types.js";

const MAX_MULTIPART_FILE_BYTES = 100 * 1024 * 1024;
const MAX_RAW_UPLOAD_ATTEMPTS = 2;
const MAX_BATCH_REFERENCES = 100;
const MAX_BATCH_REFERENCE_DEPTH = 32;
const MAX_BATCH_EXPANDED_BYTES = 1024 * 1024;
const FORBIDDEN_POINTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveRef(document: OpenApiDocument, value: unknown): unknown {
  if (!isObject(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return value;
  let current: unknown = document;
  for (const segment of value.$ref.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    current = current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

function requestBody(document: OpenApiDocument, operation: IndexedOperation): OpenApiRequestBody | undefined {
  return resolveRef(document, operation.operation.requestBody) as OpenApiRequestBody | undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new CliError(5, "invalid_input", `${field} must be an object.`);
  return value;
}

function serializeQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (["string", "number", "boolean"].includes(typeof item)) params.append(key, String(item));
      else throw new CliError(5, "invalid_query", `Query field '${key}' must contain primitive values.`);
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function validateQuery(operation: IndexedOperation, query: Record<string, unknown>): void {
  const declared = new Set(
    operation.pathParameters
      .filter((parameter) => parameter.in === "query" && parameter.name)
      .map((parameter) => parameter.name!),
  );
  for (const key of Object.keys(query)) {
    if (!declared.has(key)) throw new CliError(5, "unknown_query_parameter", `Unknown query parameter '${key}'.`);
  }
}

function buildPath(operation: IndexedOperation, input: StructuredInput): string {
  const values = requireRecord(input.path, "path");
  const declared = operation.pathParameters.filter((parameter) => parameter.in === "path" && parameter.name).map((parameter) => parameter.name!);
  for (const key of Object.keys(values)) {
    if (!declared.includes(key)) throw new CliError(5, "unknown_path_parameter", `Unknown path parameter '${key}'.`);
  }
  return operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || !["string", "number"].includes(typeof value)) {
      throw new CliError(5, "missing_path_parameter", `Path parameter '${name}' is required.`);
    }
    return encodeURIComponent(String(value));
  });
}

async function multipartBody(document: OpenApiDocument, operation: IndexedOperation, input: StructuredInput, fileValues: string[]): Promise<FormData> {
  const declaration = requestBody(document, operation);
  const multipart = declaration?.content?.["multipart/form-data"];
  if (!multipart) {
    throw new CliError(5, "multipart_not_supported", `Operation '${operation.id}' does not declare multipart/form-data.`);
  }
  const schema = resolveRef(document, multipart.schema);
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : undefined;
  if (!properties) {
    throw new CliError(8, "invalid_openapi", `Operation '${operation.id}' has no multipart field contract.`);
  }
  const form = new FormData();
  const body = requireRecord(input.body, "body");
  for (const [key, value] of Object.entries(body)) {
    if (!(key in properties)) throw new CliError(5, "unknown_multipart_field", `Unknown multipart field '${key}'.`);
    if (value === undefined || value === null) continue;
    if (typeof value === "string") form.append(key, value);
    else if (typeof value === "number" || typeof value === "boolean") form.append(key, String(value));
    else form.append(key, JSON.stringify(value));
  }
  for (const fileValue of fileValues) {
    const assignment = parseFileAssignment(fileValue);
    const property = resolveRef(document, properties[assignment.field]);
    const itemSchema = isObject(property) && property.type === "array" ? resolveRef(document, property.items) : property;
    if (!isObject(itemSchema) || itemSchema.type !== "string" || itemSchema.format !== "binary") {
      throw new CliError(5, "unknown_multipart_file", `Field '${assignment.field}' is not a contract-declared binary upload.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(assignment.path);
    } catch {
      throw new CliError(5, "file_read_failed", `Unable to read upload file '${assignment.path}'.`);
    }
    if (bytes.byteLength > MAX_MULTIPART_FILE_BYTES) {
      throw new CliError(5, "file_too_large", `File '${assignment.path}' exceeds 100 MiB.`);
    }
    const copy = Uint8Array.from(bytes);
    form.append(assignment.field, new globalThis.Blob([copy]), basename(assignment.path));
  }
  return form;
}

interface RawFilePolicy {
  contentType: "application/octet-stream";
  minimumBytes: number;
  maximumBytes: number;
}

function rawFilePolicy(document: OpenApiDocument, operation: IndexedOperation): RawFilePolicy {
  const declaration = requestBody(document, operation);
  const content = declaration?.content?.["application/octet-stream"];
  const schema = resolveRef(document, content?.schema);
  if (
    declaration?.required !== true ||
    !isObject(schema) ||
    schema.type !== "string" ||
    schema.format !== "binary" ||
    !Number.isSafeInteger(schema.minLength) ||
    !Number.isSafeInteger(schema.maxLength) ||
    (schema.minLength as number) < 1 ||
    (schema.maxLength as number) < (schema.minLength as number) ||
    schema.maxLength !== operation.agent.maxRequestBytes
  ) {
    throw new CliError(
      8,
      "invalid_openapi",
      `Raw operation '${operation.id}' requires a bounded application/octet-stream binary request schema.`,
    );
  }
  return {
    contentType: "application/octet-stream",
    minimumBytes: schema.minLength as number,
    maximumBytes: schema.maxLength as number,
  };
}

function serializeJsonBody(operation: IndexedOperation, value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CliError(5, "invalid_input", "Request body cannot be serialized as JSON.");
  }
  if (serialized === undefined) {
    throw new CliError(5, "invalid_input", "Request body cannot be serialized as JSON.");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  const maximumBytes = operation.agent.maxRequestBytes!;
  if (bytes > maximumBytes) {
    throw new CliError(5, "request_too_large", `Serialized JSON request exceeds the ${maximumBytes}-byte operation limit.`);
  }
  return serialized;
}

async function openRawFile(path: string, policy: RawFilePolicy, expectedSize?: number) {
  let handle;
  try {
    handle = await open(path, "r");
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new CliError(5, "file_not_regular", `Upload source '${path}' is not a regular file.`);
    if (!Number.isSafeInteger(fileStat.size) || fileStat.size < policy.minimumBytes || fileStat.size > policy.maximumBytes) {
      throw new CliError(
        5,
        "file_size_out_of_bounds",
        `Upload file must contain ${policy.minimumBytes}-${policy.maximumBytes} bytes.`,
      );
    }
    if (expectedSize !== undefined && fileStat.size !== expectedSize) {
      throw new CliError(5, "file_changed", "Upload file changed size between retry attempts.");
    }
    return { handle, size: fileStat.size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError(5, "file_read_failed", `Unable to read upload file '${path}'.`);
  }
}

async function executeRawFileRequest(
  runtime: Runtime,
  profile: ResolvedProfile,
  operation: IndexedOperation,
  url: URL,
  baseHeaders: Headers,
  filePath: string,
  policy: RawFilePolicy,
): Promise<Response> {
  let expectedSize: number | undefined;
  let lastError: CliError | undefined;
  const retryable = operation.agent.idempotency === "supported" || operation.agent.idempotency === "required";
  const attempts = retryable ? MAX_RAW_UPLOAD_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (runtime.signal?.aborted) throw new CliError(130, "interrupted", "Operation interrupted.");
    const { handle, size } = await openRawFile(filePath, policy, expectedSize);
    expectedSize ??= size;
    const stream = handle.createReadStream({ autoClose: true });
    const headers = new Headers(baseHeaders);
    headers.set("Content-Type", policy.contentType);
    headers.set("Content-Length", String(size));
    writeDiagnostic(runtime, `Uploading ${size} bytes${attempt > 1 ? ` (retry ${attempt - 1})` : ""}.`);
    try {
      const init = {
        method: operation.method,
        headers,
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        redirect: "error" as const,
        signal: runtime.signal,
        duplex: "half" as const,
      } satisfies RequestInit & { duplex: "half" };
      const response = await fetchWithNetworkErrors(runtime, url.toString(), init);
      if (response.ok || !retryable || ![408, 425, 429, 502, 503, 504].includes(response.status) || attempt === attempts) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      lastError = await responseError(response, `Operation '${operation.id}' temporarily failed.`);
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError(7, "network_error", "Upload request failed.");
      if (cliError.exitCode === 130 || !retryable || cliError.exitCode !== 7 || attempt === attempts) throw cliError;
      lastError = cliError;
    } finally {
      stream.destroy();
      await handle.close().catch(() => undefined);
    }
  }
  throw lastError ?? new CliError(7, "upload_failed", "Upload request failed.");
}

function responseHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "etag", "retry-after", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

async function responseData(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.status === 204) return null;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new CliError(5, "output_too_large", `Response exceeds the ${maximumBytes}-byte structured output limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new CliError(5, "output_too_large", `Response exceeds the ${maximumBytes}-byte structured output limit.`);
  }
  const type = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  const text = new TextDecoder().decode(bytes);
  if (type.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CliError(8, "invalid_server_response", "Server returned invalid JSON.");
    }
  }
  return text;
}

const SAFE_ARTIFACT_FILENAME = /^[\x20-\x7E]{1,160}$/;

function artifactMediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function validateArtifactDisposition(value: string | null, expected: AgentArtifactOutput["disposition"]): void {
  if (!value) throw new CliError(8, "invalid_artifact_response", "Artifact response is missing Content-Disposition.");
  const [rawDisposition, ...parameters] = value.split(";");
  if (rawDisposition?.trim().toLowerCase() !== expected) {
    throw new CliError(8, "invalid_artifact_response", "Artifact response disposition does not match its contract.");
  }
  const filenameParameter = parameters.find((parameter) => /^\s*filename\s*=/i.test(parameter));
  let filename = filenameParameter?.replace(/^\s*filename\s*=\s*/i, "").trim() ?? "";
  if (filename.startsWith('"') && filename.endsWith('"')) filename = filename.slice(1, -1);
  const unsafe = [...filename].some((character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || character === '"' || code < 32 || code === 127;
  });
  if (!SAFE_ARTIFACT_FILENAME.test(filename) || unsafe) {
    throw new CliError(8, "invalid_artifact_response", "Artifact response filename is invalid.");
  }
}

function validateArtifactResponse(
  response: Response,
  policy: AgentArtifactOutput,
): { expectedBytes?: number } {
  const mediaType = artifactMediaType(response.headers.get("Content-Type"));
  if (!policy.mediaTypes.includes(mediaType)) {
    throw new CliError(8, "invalid_artifact_response", "Artifact response media type does not match its contract.");
  }
  validateArtifactDisposition(response.headers.get("Content-Disposition"), policy.disposition);
  if (!response.body) throw new CliError(8, "invalid_artifact_response", "Artifact response is empty.");
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength === null) return {};
  if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
    throw new CliError(8, "invalid_artifact_response", "Artifact Content-Length is invalid.");
  }
  const expectedBytes = Number(declaredLength);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > policy.maxArtifactBytes) {
    throw new CliError(8, "invalid_artifact_response", "Artifact Content-Length is outside its contract bounds.");
  }
  return { expectedBytes };
}

function requiresConfirmation(operation: IndexedOperation): boolean {
  return ["write", "destructive", "financial", "security"].includes(operation.agent.risk ?? "read");
}

export interface RunOperationOptions {
  input: StructuredInput;
  files: string[];
  idempotencyKey?: string;
  yes: boolean;
  save?: string;
  overwrite: boolean;
}

export async function executeOperation(
  runtime: Runtime,
  profile: ResolvedProfile,
  document: OpenApiDocument,
  operation: IndexedOperation,
  options: RunOperationOptions,
): Promise<OperationExecutionResult> {
  if (!profile.token) throw new CliError(3, "not_authenticated", "Authentication is required.");
  if (operation.agent.exposure === "continuation" && operation.agent.sensitiveOutput === true) {
    throw new CliError(
      5,
      "browser_continuation_required",
      `Operation '${operation.id}' requires a protected browser continuation and cannot be emitted by the CLI.`,
    );
  }
  if (requiresConfirmation(operation) && !options.yes) {
    throw new CliError(2, "confirmation_required", `Operation '${operation.id}' has ${operation.agent.risk} risk. Re-run with --yes after reviewing the input.`);
  }
  const idempotency = operation.agent.idempotency ?? "none";
  if (idempotency === "required" && !options.idempotencyKey) {
    throw new CliError(5, "idempotency_key_required", `Operation '${operation.id}' requires --idempotency-key.`);
  }
  if (options.idempotencyKey && idempotency === "none") {
    throw new CliError(5, "idempotency_not_supported", `Operation '${operation.id}' does not support idempotency keys.`);
  }
  if (options.idempotencyKey && (!/^[\x21-\x7E]{1,200}$/.test(options.idempotencyKey))) {
    throw new CliError(5, "invalid_idempotency_key", "Idempotency keys must contain 1-200 visible ASCII characters.");
  }
  if (options.files.length > 0 && operation.agent.transport !== "multipart" && operation.agent.transport !== "octet-stream") {
    throw new CliError(5, "file_not_supported", `Operation '${operation.id}' does not declare a file request transport.`);
  }
  if (operation.agent.transport === "octet-stream" && options.files.length !== 1) {
    throw new CliError(5, "raw_file_required", `Raw operation '${operation.id}' requires exactly one --file path.`);
  }
  if (operation.agent.artifactOutput && !options.save) {
    throw new CliError(5, "save_required", `Artifact operation '${operation.id}' requires --save.`);
  }
  if (options.save && !operation.agent.artifactOutput) {
    throw new CliError(5, "save_not_supported", `Operation '${operation.id}' does not declare an artifact output.`);
  }
  const declaration = requestBody(document, operation);
  if (options.input.body !== undefined && operation.agent.transport !== "multipart" && operation.agent.transport !== "octet-stream" && !declaration?.content?.["application/json"]) {
    throw new CliError(5, "body_not_supported", `Operation '${operation.id}' does not declare an application/json body.`);
  }
  if (declaration?.required && options.input.body === undefined && operation.agent.transport !== "multipart" && operation.agent.transport !== "octet-stream") {
    throw new CliError(5, "body_required", `Operation '${operation.id}' requires a request body.`);
  }

  const query = requireRecord(options.input.query, "query");
  validateQuery(operation, query);
  const relative = `${buildPath(operation, options.input)}${serializeQuery(query)}`;
  const url = new URL(relative, `${profile.server}/api/v1/`);
  if (url.origin !== profile.server || !url.pathname.startsWith("/api/v1/")) {
    throw new CliError(8, "invalid_openapi", "Server contract attempted to escape the configured API origin.");
  }
  const headers = bearerHeaders(profile.token);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  let body: BodyInit | undefined;
  let response: Response;
  if (options.files.length > 0 || operation.agent.transport === "multipart") {
    if (operation.agent.transport === "octet-stream") {
      if (options.input.body !== undefined) throw new CliError(5, "body_not_supported", "Raw file operations cannot also send JSON body input.");
      response = await executeRawFileRequest(
        runtime,
        profile,
        operation,
        url,
        headers,
        options.files[0]!,
        rawFilePolicy(document, operation),
      );
    } else {
      body = await multipartBody(document, operation, options.input, options.files);
      response = await fetchWithNetworkErrors(runtime, url.toString(), {
        method: operation.method,
        headers,
        body,
        redirect: "error",
        signal: runtime.signal,
      });
    }
  } else if (options.input.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = serializeJsonBody(operation, options.input.body);
    response = await fetchWithNetworkErrors(runtime, url.toString(), {
      method: operation.method,
      headers,
      body,
      redirect: "error",
      signal: runtime.signal,
    });
  } else {
    response = await fetchWithNetworkErrors(runtime, url.toString(), {
      method: operation.method,
      headers,
      redirect: "error",
      signal: runtime.signal,
    });
  }
  if (!response.ok) throw await responseError(response, `Operation '${operation.id}' failed.`);
  const result: OperationExecutionResult = {
    operationId: operation.id,
    status: response.status,
    headers: responseHeaders(response),
  };
  if (options.save) {
    const artifact = operation.agent.artifactOutput!;
    const { expectedBytes } = validateArtifactResponse(response, artifact);
    const bytesWritten = await writeAtomicOutput(options.save, response.body, options.overwrite, {
      maximumBytes: artifact.maxArtifactBytes,
      minimumBytes: 1,
      expectedBytes,
    });
    result.savedTo = options.save;
    result.bytesWritten = bytesWritten;
  } else {
    const maximumBytes = operation.agent.maximumResponseBytes ?? 10 * 1024 * 1024;
    result.data = await responseData(response, maximumBytes);
  }
  return result;
}

export async function operationsSearch(runtime: Runtime, profile: ResolvedProfile, query?: string): Promise<Record<string, unknown>> {
  const { operations } = await getIndexedOperations(runtime, profile);
  const matches = searchOperations(operations, query).map(({ id, method, path, operation, agent }) => ({
    operationId: id,
    summary: operation.summary ?? null,
    tags: operation.tags ?? [],
    method,
    path,
    surface: agent.surface,
    exposure: agent.exposure,
    risk: agent.risk,
    openWorld: agent.openWorld,
    transport: agent.transport,
  }));
  return { query: query ?? null, count: matches.length, operations: matches };
}

export async function operationsDescribe(runtime: Runtime, profile: ResolvedProfile, id: string): Promise<Record<string, unknown>> {
  const { document, operations } = await getIndexedOperations(runtime, profile);
  const selected = findOperation(operations, id);
  return {
    operationId: selected.id,
    summary: selected.operation.summary ?? null,
    description: selected.operation.description ?? null,
    tags: selected.operation.tags ?? [],
    method: selected.method,
    path: selected.path,
    agent: selected.agent,
    rbac: selected.operation["x-scalius-rbac"] ?? null,
    parameters: selected.pathParameters,
    requestBody: requestBody(document, selected) ?? null,
    responses: selected.operation.responses ?? {},
  };
}

export async function operationsRun(runtime: Runtime, profile: ResolvedProfile, id: string, options: RunOperationOptions): Promise<OperationExecutionResult> {
  const { document, operations } = await getIndexedOperations(runtime, profile);
  return executeOperation(runtime, profile, document, findOperation(operations, id), options);
}

interface BatchStep {
  operationId: string;
  input?: StructuredInput;
  idempotencyKey?: string;
}

interface BatchInput {
  steps: BatchStep[];
  stopOnError?: boolean;
}

interface BatchReferenceBudget {
  count: number;
}

function pointerSegments(value: string, currentIndex: number): string[] {
  if (!value.startsWith("#/results/")) {
    throw new CliError(5, "invalid_batch_reference", `Batch reference '${value}' must start with #/results/.`);
  }
  const rawSegments = value.slice(2).split("/");
  if (rawSegments.some((segment) => /~(?:[^01]|$)/.test(segment))) {
    throw new CliError(5, "invalid_batch_reference", `Batch reference '${value}' has invalid JSON Pointer escaping.`);
  }
  const segments = rawSegments.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const index = Number(segments[1]);
  if (!Number.isSafeInteger(index) || index < 0 || index >= currentIndex) {
    throw new CliError(5, "invalid_batch_reference", `Batch reference '${value}' must target a completed prior result.`);
  }
  if (segments.some((segment) => FORBIDDEN_POINTER_SEGMENTS.has(segment))) {
    throw new CliError(5, "invalid_batch_reference", `Batch reference '${value}' contains a forbidden property.`);
  }
  return segments;
}

function readBatchPointer(results: unknown[], pointer: string, currentIndex: number): unknown {
  const segments = pointerSegments(pointer, currentIndex);
  let current: unknown = { results };
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) throw new CliError(5, "batch_reference_not_found", `Batch reference '${pointer}' was not found.`);
      current = current[Number(segment)];
      continue;
    }
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      throw new CliError(5, "batch_reference_not_found", `Batch reference '${pointer}' was not found.`);
    }
    current = current[segment];
  }
  return current;
}

function cloneBatchInput(
  value: unknown,
  results: unknown[],
  currentIndex: number,
  budget: BatchReferenceBudget,
  depth = 0,
): unknown {
  if (depth > MAX_BATCH_REFERENCE_DEPTH) throw new CliError(5, "batch_reference_too_deep", "Batch reference expansion is too deeply nested.");
  if (Array.isArray(value)) return value.map((item) => cloneBatchInput(item, results, currentIndex, budget, depth + 1));
  if (!isObject(value)) return value;
  if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
    budget.count += 1;
    if (budget.count > MAX_BATCH_REFERENCES) throw new CliError(5, "too_many_batch_references", `A batch can contain at most ${MAX_BATCH_REFERENCES} references.`);
    return structuredClone(readBatchPointer(results, value.$ref, currentIndex));
  }
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_POINTER_SEGMENTS.has(key)) throw new CliError(5, "invalid_batch_input", `Batch input contains forbidden property '${key}'.`);
    clone[key] = cloneBatchInput(child, results, currentIndex, budget, depth + 1);
  }
  return clone;
}

function resolveBatchInput(step: BatchStep, results: unknown[], currentIndex: number, budget: BatchReferenceBudget): StructuredInput {
  const resolved = cloneBatchInput(step.input ?? {}, results, currentIndex, budget) as StructuredInput;
  const bytes = Buffer.byteLength(JSON.stringify(resolved));
  if (bytes > MAX_BATCH_EXPANDED_BYTES) {
    throw new CliError(5, "batch_expansion_too_large", `Expanded batch input exceeds ${MAX_BATCH_EXPANDED_BYTES} bytes.`);
  }
  return resolved;
}

function parseBatch(value: StructuredInput): BatchInput {
  const raw = value.body ?? value;
  if (!isObject(raw) || !Array.isArray(raw.steps)) throw new CliError(5, "invalid_batch", "Batch input must contain a steps array.");
  if (raw.steps.length < 1 || raw.steps.length > 20) throw new CliError(5, "invalid_batch", "A batch must contain 1-20 steps.");
  const steps = raw.steps.map((candidate, index) => {
    if (!isObject(candidate) || typeof candidate.operationId !== "string") {
      throw new CliError(5, "invalid_batch", `Batch step ${index + 1} requires operationId.`);
    }
    return candidate as unknown as BatchStep;
  });
  return { steps, stopOnError: raw.stopOnError !== false };
}

export async function operationsBatch(runtime: Runtime, profile: ResolvedProfile, input: StructuredInput, yes: boolean): Promise<Record<string, unknown>> {
  const { document, operations } = await getIndexedOperations(runtime, profile);
  const batch = parseBatch(input);
  const selectedSteps = batch.steps.map((step) => {
    const selected = findOperation(operations, step.operationId);
    if (selected.agent.batch === "forbidden") throw new CliError(5, "batch_forbidden", `Operation '${selected.id}' cannot run in a batch.`);
    if (selected.agent.transport === "octet-stream") throw new CliError(5, "batch_forbidden", `Raw file operation '${selected.id}' cannot run in a batch.`);
    return { step, selected };
  });
  const hasRisk = selectedSteps.some(({ selected }) => requiresConfirmation(selected));
  if (hasRisk && !yes) {
    throw new CliError(2, "confirmation_required", "Batch contains write, destructive, financial, or security operations. Re-run with --yes after reviewing every step.");
  }
  const results: unknown[] = [];
  let firstError: CliError | undefined;
  const referenceBudget = { count: 0 };
  for (const [index, { step, selected }] of selectedSteps.entries()) {
    try {
      const result = await executeOperation(runtime, profile, document, selected, {
        input: resolveBatchInput(step, results, index, referenceBudget),
        files: [],
        idempotencyKey: step.idempotencyKey,
        yes,
        overwrite: false,
      });
      results.push({ index, ok: true, ...result });
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError(8, "unexpected_error", error instanceof Error ? error.message : "Unexpected error.");
      firstError ??= cliError;
      results.push({ index, ok: false, operationId: step.operationId, error: { code: cliError.errorCode, message: cliError.message } });
      if (batch.stopOnError) throw new CliError(cliError.exitCode, "batch_step_failed", `Batch stopped at step ${index + 1}: ${cliError.message}`, { results });
    }
  }
  if (firstError) {
    throw new CliError(firstError.exitCode, "batch_steps_failed", "One or more batch steps failed.", { results });
  }
  return { count: results.length, results };
}
