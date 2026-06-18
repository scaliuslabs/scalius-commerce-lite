import { deleteCache, toProjectCacheKey } from "./kv-cache";

export const API_CACHE_FENCE_GLOBAL_SCOPE = "api:";

const API_CACHE_FENCE_SCHEMA = 1;
const API_CACHE_FENCE_PREFIX = "_api_cache_fence:";
const API_CACHE_FENCE_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_FENCE_VERSION = "0";

export interface ApiCacheFence {
  schema: typeof API_CACHE_FENCE_SCHEMA;
  scope: string;
  version: string;
  updatedAt: number;
}

export interface ApiCacheFenceSnapshot {
  scopes: string[];
  versions: Record<string, string>;
  token: string;
}

function canReadKv(kv: KVNamespace | undefined): kv is KVNamespace {
  return typeof kv?.get === "function";
}

function canWriteKv(kv: KVNamespace | undefined): kv is KVNamespace {
  return typeof kv?.put === "function";
}

function canListKv(kv: KVNamespace | undefined): kv is KVNamespace {
  return typeof kv?.list === "function" && typeof kv?.delete === "function";
}

function normalizeScope(scope: string): string | null {
  const trimmed = scope.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fenceKey(scope: string): string {
  return toProjectCacheKey(`${API_CACHE_FENCE_PREFIX}${encodeURIComponent(scope)}`);
}

function defaultFence(scope: string): ApiCacheFence {
  return {
    schema: API_CACHE_FENCE_SCHEMA,
    scope,
    version: DEFAULT_FENCE_VERSION,
    updatedAt: 0,
  };
}

function isApiCacheFence(value: unknown, scope: string): value is ApiCacheFence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiCacheFence>;
  return (
    candidate.schema === API_CACHE_FENCE_SCHEMA &&
    candidate.scope === scope &&
    typeof candidate.version === "string" &&
    typeof candidate.updatedAt === "number"
  );
}

function createFenceVersion(now: number): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${now.toString(36)}:${random}`;
}

function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}

export async function getApiCacheFence(
  scope: string,
  kv?: KVNamespace,
): Promise<ApiCacheFence> {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope || !canReadKv(kv)) {
    return defaultFence(normalizedScope ?? scope);
  }

  try {
    const raw = await kv.get(fenceKey(normalizedScope));
    if (!raw) return defaultFence(normalizedScope);
    const parsed = JSON.parse(raw) as unknown;
    return isApiCacheFence(parsed, normalizedScope)
      ? parsed
      : defaultFence(normalizedScope);
  } catch (error) {
    console.error("[Cache] Failed to read API cache fence:", error);
    return defaultFence(normalizedScope);
  }
}

export async function bumpApiCacheFence(
  scope: string,
  kv?: KVNamespace,
): Promise<ApiCacheFence> {
  const normalizedScope = normalizeScope(scope);
  const now = Date.now();
  const fence: ApiCacheFence = {
    schema: API_CACHE_FENCE_SCHEMA,
    scope: normalizedScope ?? scope,
    version: createFenceVersion(now),
    updatedAt: now,
  };

  if (!normalizedScope || !canWriteKv(kv)) {
    return fence;
  }

  try {
    await kv.put(fenceKey(normalizedScope), JSON.stringify(fence), {
      expirationTtl: API_CACHE_FENCE_TTL_SECONDS,
    });
  } catch (error) {
    console.error("[Cache] Failed to bump API cache fence:", error);
  }

  return fence;
}

export async function bumpApiCacheFences(
  scopes: readonly string[],
  kv?: KVNamespace,
): Promise<ApiCacheFence[]> {
  const uniqueScopes = normalizeScopes(scopes);
  return Promise.all(uniqueScopes.map((scope) => bumpApiCacheFence(scope, kv)));
}

export function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => normalizeScope(scope)).filter(Boolean) as string[])].sort();
}

export async function captureApiCacheFenceSnapshot(
  scopes: readonly string[],
  kv?: KVNamespace,
): Promise<ApiCacheFenceSnapshot> {
  const normalizedScopes = normalizeScopes(scopes);
  const fences = await Promise.all(
    normalizedScopes.map((scope) => getApiCacheFence(scope, kv)),
  );
  const versions = Object.fromEntries(
    fences.map((fence) => [fence.scope, fence.version]),
  );
  const serialized = normalizedScopes
    .map((scope) => `${scope}=${versions[scope] ?? DEFAULT_FENCE_VERSION}`)
    .join("|");

  return {
    scopes: normalizedScopes,
    versions,
    token: fnv1a64Hex(serialized),
  };
}

export async function isApiCacheFenceSnapshotCurrent(
  snapshot: ApiCacheFenceSnapshot,
  kv?: KVNamespace,
): Promise<boolean> {
  if (!canReadKv(kv)) return true;

  const current = await captureApiCacheFenceSnapshot(snapshot.scopes, kv);
  return snapshot.scopes.every(
    (scope) => current.versions[scope] === snapshot.versions[scope],
  );
}

function scopeMatchesCacheKey(cacheKey: string, scope: string): boolean {
  if (!cacheKey.startsWith(scope)) return false;
  if (scope.endsWith(":") || scope.endsWith("?") || scope.endsWith("/")) {
    return true;
  }
  const next = cacheKey.charAt(scope.length);
  return next === "" || next === "/" || next === "?" || next === ":" || next === "#";
}

export function getApiCacheFenceScopesForKey(
  cacheKey: string,
  keyPrefix: string,
  knownPrefixes: readonly string[] = [],
): string[] {
  const scopes = new Set<string>([API_CACHE_FENCE_GLOBAL_SCOPE, keyPrefix]);

  const queryIndex = cacheKey.indexOf("?");
  if (queryIndex >= 0) {
    const baseKey = cacheKey.slice(0, queryIndex);
    scopes.add(baseKey);
    scopes.add(`${baseKey}?`);
  } else {
    scopes.add(cacheKey);
  }

  for (const prefix of knownPrefixes) {
    if (scopeMatchesCacheKey(cacheKey, prefix)) {
      scopes.add(prefix);
    }
  }

  return normalizeScopes([...scopes]);
}

export function getApiCacheFenceScopeForPattern(pattern: string): string | null {
  return normalizeScope(pattern.replace(/\*$/, ""));
}

export function withApiCacheFenceToken(
  cacheKey: string,
  snapshot: Pick<ApiCacheFenceSnapshot, "token">,
): string {
  return `${cacheKey}#f:${snapshot.token}`;
}

export async function deleteVersionedCacheKeyFamily(
  cacheKey: string,
  kv?: KVNamespace,
): Promise<void> {
  await deleteCache(cacheKey, kv);

  if (!canListKv(kv)) return;

  const prefix = toProjectCacheKey(`${cacheKey}#f:`);
  const keysToDelete: string[] = [];
  let cursor: string | undefined;

  try {
    do {
      const result: KVNamespaceListResult<unknown, string> = await kv.list({
        prefix,
        ...(cursor ? { cursor } : {}),
      });
      for (const key of result.keys) keysToDelete.push(key.name);
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    await Promise.all(keysToDelete.map((key) => kv.delete(key)));
  } catch (error) {
    console.error("[Cache] Failed to delete versioned API cache key family:", error);
  }
}

export async function getMaxApiCacheFenceUpdatedAt(
  scopes: readonly string[],
  kv?: KVNamespace,
): Promise<number | null> {
  const uniqueScopes = normalizeScopes(scopes);
  if (uniqueScopes.length === 0) return null;

  const fences = await Promise.all(
    uniqueScopes.map((scope) => getApiCacheFence(scope, kv)),
  );
  const updatedAt = Math.max(...fences.map((fence) => fence.updatedAt));
  return updatedAt > 0 ? updatedAt : null;
}
