import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigStore } from "./config.js";
import { CliError } from "./errors.js";
import { bearerHeaders, fetchWithNetworkErrors, responseError } from "./http.js";
import type {
  AgentArtifactOutput,
  AgentMetadata,
  IndexedOperation,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  ResolvedProfile,
  Runtime,
} from "./types.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const OPERATION_ID = /^(?:dashboard|storefront|system)(?:\.[a-z][a-z0-9_]*){2,}$/;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const ARTIFACT_MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

interface CachedContract {
  version: 1;
  server: string;
  etag?: string;
  fetchedAt: string;
  document: OpenApiDocument;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function agentMetadata(value: unknown): AgentMetadata | undefined {
  if (!isObject(value)) return undefined;
  return value as AgentMetadata;
}

function artifactOutput(id: string, value: unknown): AgentArtifactOutput | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new CliError(8, "invalid_openapi", `Executable operation '${id}' has invalid artifact output metadata.`);
  }
  const mediaTypes = value.mediaTypes;
  if (
    !Array.isArray(mediaTypes) ||
    mediaTypes.length === 0 ||
    mediaTypes.some((mediaType) => typeof mediaType !== "string" || !ARTIFACT_MEDIA_TYPE.test(mediaType)) ||
    new Set(mediaTypes).size !== mediaTypes.length ||
    !["attachment", "inline"].includes(String(value.disposition)) ||
    value.filenamePolicy !== "content-disposition" ||
    !["direct-stream", "authenticated-handle"].includes(String(value.delivery)) ||
    !Number.isSafeInteger(value.maxArtifactBytes) ||
    (value.maxArtifactBytes as number) < 1 ||
    (value.maxArtifactBytes as number) > MAX_ARTIFACT_BYTES
  ) {
    throw new CliError(8, "invalid_openapi", `Executable operation '${id}' has invalid artifact output metadata.`);
  }
  return {
    mediaTypes: [...mediaTypes].sort() as string[],
    disposition: value.disposition as AgentArtifactOutput["disposition"],
    filenamePolicy: "content-disposition",
    maxArtifactBytes: value.maxArtifactBytes as number,
    delivery: value.delivery as AgentArtifactOutput["delivery"],
  };
}

function executableMetadata(id: string, value: unknown): AgentMetadata | undefined {
  const metadata = agentMetadata(value);
  if (metadata?.exposure !== "execute") return undefined;
  const allowedSurface = ["dashboard", "storefront", "system"].includes(metadata.surface ?? "");
  const allowedRisk = ["read", "write", "destructive", "financial", "security"].includes(metadata.risk ?? "");
  const allowedIdempotency = ["none", "supported", "required"].includes(metadata.idempotency ?? "");
  const allowedBatch = ["parallel", "sequential", "forbidden"].includes(metadata.batch ?? "");
  const allowedTransport = ["json", "multipart", "octet-stream"].includes(metadata.transport ?? "");
  if (!allowedSurface || !allowedRisk || !allowedIdempotency || !allowedBatch || !allowedTransport || typeof metadata.openWorld !== "boolean") {
    throw new CliError(8, "invalid_openapi", `Executable operation '${id}' has invalid agent metadata.`);
  }
  if (metadata.maximumResponseBytes !== undefined && (!Number.isSafeInteger(metadata.maximumResponseBytes) || metadata.maximumResponseBytes < 1)) {
    throw new CliError(8, "invalid_openapi", `Executable operation '${id}' has an invalid response limit.`);
  }
  if (
    !Number.isSafeInteger(metadata.maxRequestBytes) ||
    (metadata.maxRequestBytes as number) < 1 ||
    (metadata.maxRequestBytes as number) > MAX_REQUEST_BYTES
  ) {
    throw new CliError(8, "invalid_openapi", `Executable operation '${id}' has an invalid request limit.`);
  }
  const artifact = artifactOutput(id, metadata.artifactOutput);
  if (artifact && (metadata.batch !== "forbidden" || metadata.sensitiveOutput === true || metadata.transport === "continuation")) {
    throw new CliError(8, "invalid_openapi", `Executable operation '${id}' has an invalid artifact output policy.`);
  }
  return { ...metadata, ...(artifact ? { artifactOutput: artifact } : {}) };
}

function parameters(value: unknown): OpenApiParameter[] {
  return Array.isArray(value) ? value.filter(isObject) as OpenApiParameter[] : [];
}

export function indexOperations(document: OpenApiDocument): IndexedOperation[] {
  const operations: IndexedOperation[] = [];
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!isObject(item)) continue;
    const sharedParameters = parameters(item.parameters);
    for (const method of METHODS) {
      const raw = item[method];
      if (!isObject(raw)) continue;
      const operation = raw as OpenApiOperation;
      const id = operation.operationId;
      const rawMetadata = operation["x-scalius-agent"];
      const hasExecutableExposure = isObject(rawMetadata) && rawMetadata.exposure === "execute";
      if (!id || !OPERATION_ID.test(id) || !hasExecutableExposure) continue;
      const agent = executableMetadata(id, rawMetadata)!;
      const fullPath = path.startsWith("/api/v1/") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
      if (!fullPath.startsWith("/api/v1/") || fullPath.includes("\\")) {
        throw new CliError(8, "invalid_openapi", `Operation '${id}' contains an invalid API path.`);
      }
      if (seen.has(id)) throw new CliError(8, "invalid_openapi", `Server contract contains duplicate operation ID '${id}'.`);
      seen.add(id);
      operations.push({
        id,
        method: method.toUpperCase(),
        path: fullPath,
        pathParameters: [...sharedParameters, ...parameters(operation.parameters)],
        operation,
        agent,
      });
    }
  }
  return operations.sort((left, right) => left.id.localeCompare(right.id));
}

async function readCache(path: string, server: string): Promise<CachedContract | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as CachedContract;
    if (parsed.version !== 1 || parsed.server !== server || !isObject(parsed.document)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, cache: CachedContract): Promise<void> {
  // The public contract cache uses an isolated atomic write.
  const { mkdir, open, rename, unlink } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(cache), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function loadOpenApi(runtime: Runtime, profile: ResolvedProfile): Promise<OpenApiDocument> {
  if (!profile.token) throw new CliError(3, "not_authenticated", "Authentication is required.");
  const store = new ConfigStore(runtime);
  const path = store.cachePath(profile.name);
  const cached = await readCache(path, profile.server);
  const headers = bearerHeaders(profile.token);
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  const url = `${profile.server}/api/v1/openapi.json`;
  try {
    const response = await fetchWithNetworkErrors(runtime, url, { headers });
    if (response.status === 304 && cached) return cached.document;
    if (!response.ok) throw await responseError(response, "Unable to load the operation contract.");
    let document: OpenApiDocument;
    try {
      document = await response.json() as OpenApiDocument;
    } catch {
      throw new CliError(8, "invalid_openapi", "Server operation contract is not valid JSON.");
    }
    if (!isObject(document) || !isObject(document.paths)) {
      throw new CliError(8, "invalid_openapi", "Server operation contract has no paths.");
    }
    const cache: CachedContract = {
      version: 1,
      server: profile.server,
      etag: response.headers.get("ETag") ?? undefined,
      fetchedAt: new Date(runtime.now()).toISOString(),
      document,
    };
    await writeCache(path, cache).catch(() => undefined);
    return document;
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 7 && cached) {
      const age = runtime.now() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(age) && age <= CACHE_MAX_AGE_MS) return cached.document;
    }
    throw error;
  }
}

export async function getIndexedOperations(runtime: Runtime, profile: ResolvedProfile): Promise<{ document: OpenApiDocument; operations: IndexedOperation[] }> {
  const document = await loadOpenApi(runtime, profile);
  return { document, operations: indexOperations(document) };
}

export function findOperation(operations: IndexedOperation[], id: string): IndexedOperation {
  if (!OPERATION_ID.test(id)) throw new CliError(2, "invalid_operation_id", "Operation ID has an invalid format.");
  const operation = operations.find((candidate) => candidate.id === id);
  if (!operation) throw new CliError(5, "operation_not_found", `Executable operation '${id}' is not in the live server contract.`);
  return operation;
}

export function searchOperations(operations: IndexedOperation[], query?: string): IndexedOperation[] {
  const needle = query?.trim().toLocaleLowerCase();
  if (!needle) return operations;
  return operations.filter(({ id, operation }) => {
    const text = [id, operation.summary, operation.description, ...(operation.tags ?? [])].filter(Boolean).join("\n").toLocaleLowerCase();
    return text.includes(needle);
  });
}
