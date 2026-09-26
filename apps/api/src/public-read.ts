import { applyBaselineSecurityHeaders } from "@scalius/shared/http-security";
import {
  PUBLIC_CACHE_MAX_AGE_SECONDS,
  readWorkerVersion,
  type WorkerVersionMetadataEnv,
} from "@scalius/shared/cache-generation";
import { hashCacheDep, type StorefrontBatchPartCache } from "@scalius/shared/cache-frontier";
import { cacheDepKind } from "@scalius/shared/cache-deps";
import type { PlatformConfig } from "@scalius/shared/platform-config";
import type { Database } from "@scalius/database/client";
import { withDependencyScope, type CacheDependencies } from "@scalius/core/cache-deps";
import { platformSettingsFromRow } from "@scalius/core/modules/platform";
import {
  decoratePublicApiResponse,
  dvcSnapshotKey,
  getPublicApiCachePolicy,
  withCacheIdentity,
  withDvcIdentity,
  type ApiPartCacheMode,
} from "./public-cache-policy";
import { readValidationSnapshot, type PlatformSettingsRow, type ValidationSnapshot } from "./cache-frontier";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";
import { runWithPublicRenderContext } from "./runtime/public-render-context";
import { queueRenditionsForRenderedOriginals } from "./utils/media-rendition-hints";

/**
 * One anonymous public read, rendered the same way wherever it is served:
 * the runtime app (routing, validation, error mapping), then the baseline
 * security headers, then the public cache headers. The `PublicApi` Workers
 * Cache entrypoint and the storefront batch both render through this, and
 * both key their caches with `publicReadCacheKey`, so the two paths cannot
 * drift apart. `runtimeEnv` is the invocation's composed env
 * (`composeApiRuntimeEnv`).
 */
export async function renderPublicRead(
  request: Request,
  runtimeEnv: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await fetchRuntimeApiApp(request, runtimeEnv, ctx);
  const decorated = decoratePublicApiResponse(
    applyBaselineSecurityHeaders(request, response, { frameProtection: "deny" }),
  );
  // A rendered read that still publishes an image original queues that
  // image's renditions (utils/media-rendition-hints.ts).
  if (isStorablePublicRead(decorated) && decorated.body) {
    ctx.waitUntil(queueRenditionsForRenderedOriginals(decorated.clone(), runtimeEnv));
  }
  return decorated;
}

/**
 * The cache key of a public read: canonical path, sorted query,
 * `__cg=<generation>` and `__cv=<Worker version>`. The generation changes on
 * every buyer-visible write; the version (`CF_VERSION_METADATA`) changes on
 * every deploy and every `wrangler dev` start or reload, so an entry never
 * outlives the code that rendered it, whatever that code changed. Null for
 * reads that are not publicly cacheable, or without a generation or a version
 * (then nothing is cached).
 */
export function publicReadCacheKey(
  request: Request,
  env: WorkerVersionMetadataEnv,
  generation: string | null,
): string | null {
  const version = readWorkerVersion(env);
  if (!generation || !version) return null;
  const policy = getPublicApiCachePolicy(request);
  return policy ? withCacheIdentity(policy.canonicalUrl, generation, version) : null;
}

/**
 * The dependency-validated key of a public read: canonical path, sorted
 * query and the Worker version, no generation (the entry carries its own
 * dependency proof). Null when the read is not publicly cacheable or the
 * version is unknown.
 */
export function dvcReadCacheKey(request: Request, env: WorkerVersionMetadataEnv): string | null {
  const version = readWorkerVersion(env);
  if (!version) return null;
  const policy = getPublicApiCachePolicy(request);
  return policy ? withDvcIdentity(policy.canonicalUrl, version) : null;
}

/** Headers `decoratePublicApiResponse` gives every cacheable public read. */
const PUBLIC_READ_CACHE_CONTROL = "public, max-age=0, no-cache, must-revalidate";

/**
 * Only a 200 that this Worker produced (it carries the baseline security
 * headers), that the app marked cacheable and that sets no cookie is stored.
 */
export function isStorablePublicRead(response: Response): boolean {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  return (
    response.status === 200 &&
    response.headers.has("X-Content-Type-Options") &&
    !response.headers.has("Set-Cookie") &&
    cacheControl === PUBLIC_READ_CACHE_CONTROL
  );
}

/**
 * The Cache API stores by `Cache-Control`, so the stored copy carries the
 * same lifetime the CDN copy gets (`Cloudflare-CDN-Cache-Control`).
 */
function toStoredEntry(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}`);
  return new Response(response.body, { status: response.status, headers });
}

/** A stored entry, answered with the headers the read was rendered with. */
function fromStoredEntry(stored: Response): Response {
  const headers = new Headers(stored.headers);
  headers.set("Cache-Control", PUBLIC_READ_CACHE_CONTROL);
  for (const name of DVC_ENTRY_HEADERS) headers.delete(name);
  return new Response(stored.body, { status: stored.status, headers });
}

/**
 * Releases a body nobody reads. Never awaited: cancelling one branch of a
 * cloned (teed) body settles only when every branch is done.
 */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** Reads rendered at once; the rest wait (D1 allows six open connections). */
function renderSlots(maxConcurrentRenders: number) {
  let rendering = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (rendering < maxConcurrentRenders) rendering += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      // A finishing render hands its slot straight to the next waiter.
      const next = waiting.shift();
      if (next) next();
      else rendering -= 1;
    }
  };
}

export interface LocalPublicReadDeps {
  /** The invocation's env; its Worker version is part of every key. */
  env: WorkerVersionMetadataEnv;
  /** `caches.default` in production; null where the Cache API is missing. */
  cache: Pick<Cache, "match" | "put"> | null;
  render(request: Request): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
  /** Reads rendered at once; the rest wait (D1 allows six open connections). */
  maxConcurrentRenders: number;
}

/**
 * Serves public reads inside the calling invocation: the data center's Cache
 * API under `publicReadCacheKey`, else an in-process render that is stored
 * for the next page. Unlike a `PublicApi` entrypoint call, a miss never waits
 * for another (often cold) isolate.
 */
export function createLocalPublicReader(deps: LocalPublicReadDeps) {
  return createGenerationReader(deps, renderSlots(deps.maxConcurrentRenders));
}

function createGenerationReader(deps: LocalPublicReadDeps, slot: ReturnType<typeof renderSlots>) {
  return async (request: Request, generation: string | null, onStatus?: (hit: boolean) => void): Promise<Response> => {
    const key = deps.cache ? publicReadCacheKey(request, deps.env, generation) : null;
    if (key) {
      const stored = await deps.cache!.match(key).catch(() => undefined);
      if (stored) {
        onStatus?.(true);
        return fromStoredEntry(stored);
      }
    }
    onStatus?.(false);
    const response = await slot(() => deps.render(request));
    if (key && isStorablePublicRead(response)) {
      deps.waitUntil(deps.cache!.put(key, toStoredEntry(response.clone())).catch(() => undefined));
    }
    return response;
  };
}

// ---------------------------------------------------------------------------
// Dependency-validated part cache (CACHE-DESIGN §6.6)
// ---------------------------------------------------------------------------

/** What a dependency-validated entry carries besides its body. */
export interface DvcEntryMeta {
  /** Clock value the entry is known fresh at: every commit at or below it is reflected. */
  readonly s0: number;
  /** Sorted dependency keys (`store` included). */
  readonly deps: readonly string[];
  /** Epoch ms; never served at or after it. */
  readonly validUntil: number | null;
  /** Soft-ordering bound, seconds after `renderedAt`. */
  readonly softMaxAgeSeconds: number | null;
  /** Epoch ms of the render. */
  readonly renderedAt: number;
}

export type DvcVerdict =
  | { readonly valid: true; /** s0 raised to the validation clock. */ readonly s0: number }
  | { readonly valid: false; readonly reason: "changed" | "expired" | "floor" | "soft-age"; readonly keys?: readonly string[] };

const DEPS_HEADER = "X-Scalius-Deps";
const DEP_COUNT_HEADER = "X-Scalius-Dep-Count";
const DEP_SEQ_HEADER = "X-Scalius-Dep-Seq";
const VALID_UNTIL_HEADER = "X-Scalius-Valid-Until";
const SOFT_MAX_AGE_HEADER = "X-Scalius-Soft-Max-Age";
const RENDERED_AT_HEADER = "X-Scalius-Rendered-At";
/** Internal entry headers, never sent to a browser. */
const DVC_ENTRY_HEADERS = [DEPS_HEADER, DEP_COUNT_HEADER, DEP_SEQ_HEADER, VALID_UNTIL_HEADER, SOFT_MAX_AGE_HEADER, RENDERED_AT_HEADER] as const;
/** A key list above this does not fit a stored header comfortably: such an entry is not stored. */
const MAX_DEPS_HEADER_LENGTH = 16_384;

function optionalNumber(value: string | null): number | null | undefined {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The entry's metadata, or null when it is missing or malformed (then it is a miss). */
export function decodeDvcEntryMeta(stored: Response): DvcEntryMeta | null {
  const raw = stored.headers.get(DEPS_HEADER);
  const s0 = optionalNumber(stored.headers.get(DEP_SEQ_HEADER));
  const renderedAt = optionalNumber(stored.headers.get(RENDERED_AT_HEADER));
  const validUntil = optionalNumber(stored.headers.get(VALID_UNTIL_HEADER));
  const softMaxAgeSeconds = optionalNumber(stored.headers.get(SOFT_MAX_AGE_HEADER));
  const count = Number(stored.headers.get(DEP_COUNT_HEADER));
  if (raw === null || typeof s0 !== "number" || typeof renderedAt !== "number" || validUntil === undefined || softMaxAgeSeconds === undefined) return null;
  const deps = raw === "" ? [] : raw.split(" ");
  // A truncated or altered key list must never validate.
  if (!Number.isInteger(count) || deps.length !== count || !deps.includes("store")) return null;
  return { s0, deps, validUntil, softMaxAgeSeconds, renderedAt };
}

/** The stored form of a rendered read and its metadata. */
export function encodeDvcEntry(response: Response, meta: DvcEntryMeta): Response | null {
  const joined = meta.deps.join(" ");
  if (joined.length > MAX_DEPS_HEADER_LENGTH) return null;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}`);
  headers.set(DEPS_HEADER, joined);
  headers.set(DEP_COUNT_HEADER, String(meta.deps.length));
  headers.set(DEP_SEQ_HEADER, String(meta.s0));
  headers.set(RENDERED_AT_HEADER, String(meta.renderedAt));
  if (meta.validUntil !== null) headers.set(VALID_UNTIL_HEADER, String(meta.validUntil));
  if (meta.softMaxAgeSeconds !== null) headers.set(SOFT_MAX_AGE_HEADER, String(meta.softMaxAgeSeconds));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The hit rule for entries validated by one snapshot (§6.6, G2): an entry is
 * served only when no key it depends on has a seq above its s0 in the
 * snapshot, it is not at or past `validUntil`, not past its soft age, and not
 * below the pruning floor. A served entry's s0 rises to the snapshot clock.
 * The snapshot must have been read with `since <= min(s0)` over the entries.
 */
export function judgeDvcEntries(
  entries: readonly DvcEntryMeta[],
  snapshot: Pick<ValidationSnapshot, "S" | "floor" | "changed">,
  now: number,
): DvcVerdict[] {
  return entries.map((entry): DvcVerdict => {
    if (entry.validUntil !== null && now >= entry.validUntil) return { valid: false, reason: "expired" };
    if (entry.softMaxAgeSeconds !== null && now - entry.renderedAt >= entry.softMaxAgeSeconds * 1000) {
      return { valid: false, reason: "soft-age" };
    }
    if (entry.s0 < snapshot.floor) return { valid: false, reason: "floor" };
    const keys = entry.deps.filter((dep) => (snapshot.changed.get(dep) ?? -Infinity) > entry.s0);
    return keys.length > 0 ? { valid: false, reason: "changed", keys } : { valid: true, s0: Math.max(entry.s0, snapshot.S) };
  });
}

/** The keys and the smallest s0 one validation statement needs for these entries. */
function validationInput(entries: readonly DvcEntryMeta[]): { deps: string[]; since: number } {
  const deps = new Set<string>();
  let since = Infinity;
  for (const entry of entries) {
    for (const dep of entry.deps) deps.add(dep);
    since = Math.min(since, entry.s0);
  }
  return { deps: [...deps], since: Number.isFinite(since) ? since : 0 };
}

/**
 * The strict validator as one function: one statement for all entries. The
 * S6 property harness drives exactly this (harness-adapters.ts).
 */
export async function validateDvcEntries(
  db: Database,
  entries: readonly DvcEntryMeta[],
  now: number,
): Promise<{ verdicts: DvcVerdict[]; snapshot: ValidationSnapshot }> {
  const { deps, since } = validationInput(entries);
  const snapshot = await readValidationSnapshot(db, deps, since);
  return { verdicts: judgeDvcEntries(entries, snapshot, now), snapshot };
}

/** The storefront's view of an entry: hashed keys only (names never leave the API). */
export function batchPartCache(meta: DvcEntryMeta, status: StorefrontBatchPartCache["status"]): StorefrontBatchPartCache {
  return {
    status,
    s0: meta.s0,
    deps: meta.deps.map(hashCacheDep),
    validUntil: meta.validUntil,
    softMaxAgeSeconds: meta.softMaxAgeSeconds,
    renderedAt: meta.renderedAt,
  };
}

/** `p:12 lm:3 set:4`: the key kinds of an entry, never ids (log lines). */
export function maskedDepsSummary(deps: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const dep of deps) {
    const kind = cacheDepKind(dep) ?? "?";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort().map(([kind, count]) => `${kind}:${count}`).join(" ");
}

/**
 * The data center's latest clock snapshot: the clock, the floor and the
 * Platform settings row, all from one validation statement. A render may take
 * its s0 from any snapshot, however old: the clock never decreases, so an
 * older value is a lower bound of the clock when the render's first data read
 * starts, and every commit at or below it is visible to that read (§6.8 L2).
 * The platform row in it is exactly the row at that clock. An older s0 only
 * makes the entry reject more.
 */
interface ClockSnapshot {
  readonly S: number;
  readonly floor: number;
  readonly platform: PlatformSettingsRow | null;
}

async function readStoredSnapshot(cache: Pick<Cache, "match">, key: string): Promise<ClockSnapshot | null> {
  const stored = await cache.match(key).catch(() => undefined);
  if (!stored) return null;
  try {
    const value = await stored.json() as Partial<ClockSnapshot>;
    if (typeof value.S !== "number" || !Number.isFinite(value.S) || typeof value.floor !== "number") return null;
    const platform = value.platform && typeof value.platform.value === "string" && typeof value.platform.revision === "number"
      ? { value: value.platform.value, revision: value.platform.revision }
      : null;
    return { S: value.S, floor: value.floor, platform };
  } catch {
    return null;
  }
}

function storedSnapshot(snapshot: ClockSnapshot): Response {
  return new Response(JSON.stringify(snapshot), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}` },
  });
}

/** Stale-if-error (owner decision 3) never applies to the cart shell or checkout settings. */
const NEVER_STALE_PREFIXES = ["/api/v1/checkout", "/api/v1/shipping-methods", "/api/v1/locations"];
export const STALE_IF_ERROR_MAX_AGE_MS = 15 * 60_000;

function staleIfErrorAllowed(request: Request, meta: DvcEntryMeta, now: number): boolean {
  const pathname = new URL(request.url).pathname;
  if (NEVER_STALE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}-`))) return false;
  return now - meta.renderedAt <= STALE_IF_ERROR_MAX_AGE_MS;
}

/** Sampled rates (code constants; see public-cache-policy.ts for the mode switch). */
export const DVC_AUDIT_RATE = 1 / 1000;
export const DVC_SHADOW_SAMPLE_RATE = 1;
export const DVC_SUMMARY_LOG_RATE = 1 / 100;
/** Fresh renders a shadow comparison may spend per batch on mismatches. */
const SHADOW_MAX_CHECKS = 2;

export interface PublicPartReaderDeps {
  readonly mode: ApiPartCacheMode;
  /** The invocation's env; its Worker version is part of every key. */
  readonly env: WorkerVersionMetadataEnv;
  /** `caches.default` in production; null where the Cache API is missing. */
  readonly cache: Pick<Cache, "match" | "put" | "delete"> | null;
  /** The request database (validation statement, audits). */
  db(): Database;
  /** Renders one read (`renderPublicRead` with the invocation's env and ctx). */
  render(request: Request): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
  readonly maxConcurrentRenders: number;
  now?(): number;
  random?(): number;
  log?(line: string): void;
  /** Strict mode: each batch's hit, miss and refresh counts and validation time (metrics, load tests). */
  onSummary?(summary: Readonly<BatchCacheSummary>): void;
}

export interface PublicPartRead {
  readonly response: Response;
  /** Strict mode: the part's proof for the storefront page cache; null means none. */
  readonly cache: StorefrontBatchPartCache | null;
}

/** Internal result of one strict part: its raw keys stay inside the API. */
interface StrictPart {
  readonly response: Response;
  readonly meta: DvcEntryMeta | null;
  readonly status: StorefrontBatchPartCache["status"] | "stale-if-error" | "uncached";
  readonly key: string | null;
  /** The clock the hit was validated at. */
  readonly validatedAt?: number;
}

interface RenderBase {
  readonly S: number;
  readonly platform: PlatformConfig | null;
}

export interface BatchCacheSummary {
  hits: number;
  misses: number;
  refreshes: number;
  uncached: number;
  stale: number;
  validationMs: number | null;
}

/**
 * Serves public reads inside the calling invocation, per `mode`:
 *
 * - `generation`: `createLocalPublicReader`.
 * - `shadow`: the same, then (in `waitUntil`) the strict reader over the
 *   same parts under its own keys, comparing what it would have served.
 * - `strict`: every part's entry is matched first (Cache API only). One
 *   statement then validates every hit and reads the clock and the Platform
 *   row; parts with no entry do not wait for it, they render at once from the
 *   data center's clock snapshot. A rejected hit re-renders from the
 *   statement's clock. So a batch costs at most one D1 statement more than
 *   its renders, and no D1 wave more: a hit-only batch is one statement.
 */
export function createPublicPartReader(deps: PublicPartReaderDeps) {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const slot = renderSlots(deps.maxConcurrentRenders);
  const generationRead = createGenerationReader(deps, slot);

  async function renderRecorded(request: Request, base: RenderBase): Promise<{ response: Response; dependencies: CacheDependencies }> {
    const label = new URL(request.url).pathname;
    const { value, dependencies } = await slot(() => withDependencyScope(
      () => runWithPublicRenderContext({ platform: base.platform }, () => deps.render(request)),
      { label },
    ));
    return { response: value, dependencies };
  }

  async function renderAndStore(request: Request, key: string, base: RenderBase, status: "miss" | "refresh"): Promise<StrictPart> {
    const renderedAt = now();
    const { response, dependencies } = await renderRecorded(request, base);
    const meta: DvcEntryMeta = {
      s0: base.S,
      deps: dependencies.keys,
      validUntil: dependencies.validUntil,
      softMaxAgeSeconds: dependencies.softMaxAgeSeconds,
      renderedAt,
    };
    const cacheable = isStorablePublicRead(response)
      && dependencies.uncacheable.length === 0
      && (meta.validUntil === null || meta.validUntil > renderedAt);
    const stored = cacheable ? encodeDvcEntry(response.clone(), meta) : null;
    if (stored && deps.cache) deps.waitUntil(deps.cache.put(key, stored).catch(() => undefined));
    return { response, meta: stored ? meta : null, status: stored ? status : "uncached", key };
  }

  async function renderUncached(request: Request): Promise<StrictPart> {
    return { response: await slot(() => deps.render(request)), meta: null, status: "uncached", key: null };
  }

  /** Platform rows parse once per snapshot object. */
  const parsedPlatform = new WeakMap<object, Promise<PlatformConfig | null>>();
  function renderBase(snapshot: ClockSnapshot): Promise<RenderBase> {
    let parsed = parsedPlatform.get(snapshot);
    if (!parsed) {
      parsed = platformSettingsFromRow(snapshot.platform).catch(() => null);
      parsedPlatform.set(snapshot, parsed);
    }
    return parsed.then((platform) => ({ S: snapshot.S, platform }));
  }

  async function readStrictParts(parts: readonly Request[], summary: BatchCacheSummary, audit: boolean): Promise<Array<Promise<StrictPart>>> {
    const keys = parts.map((part) => (deps.cache ? dvcReadCacheKey(part, deps.env) : null));
    const version = readWorkerVersion(deps.env);
    const snapshotKey = deps.cache && version && parts.length > 0 ? dvcSnapshotKey(new URL(parts[0]!.url).origin, version) : null;
    const [stored, colo] = await Promise.all([
      Promise.all(keys.map((key) => (key ? deps.cache!.match(key).catch(() => undefined) : Promise.resolve(undefined)))),
      snapshotKey ? readStoredSnapshot(deps.cache!, snapshotKey) : Promise.resolve(null),
    ]);
    const metas = stored.map((entry) => (entry ? decodeDvcEntryMeta(entry) : null));
    const hits = metas.filter((meta): meta is DvcEntryMeta => meta !== null);

    let statement: Promise<{ snapshot: ValidationSnapshot; verdicts: DvcVerdict[] }> | null = null;
    const startStatement = () => {
      if (statement) return statement;
      const began = performance.now();
      statement = (async () => {
        const { deps: keysToCheck, since } = validationInput(hits);
        const snapshot = await readValidationSnapshot(deps.db(), keysToCheck, since);
        summary.validationMs = Math.round((performance.now() - began) * 100) / 100;
        return { snapshot, verdicts: judgeDvcEntries(hits, snapshot, now()) };
      })();
      // Keep the data center's snapshot current for the next batch's misses.
      if (snapshotKey) {
        deps.waitUntil(statement.then(({ snapshot }) => {
          if (colo && colo.S >= snapshot.S && colo.floor >= snapshot.floor && colo.platform?.revision === snapshot.platform?.revision) return;
          return deps.cache!.put(snapshotKey, storedSnapshot({ S: snapshot.S, floor: snapshot.floor, platform: snapshot.platform }));
        }).catch(() => undefined));
      }
      return statement;
    };
    if (hits.length > 0 || !colo) startStatement();
    const statementBase = async () => renderBase((await startStatement()).snapshot);

    let hitIndex = 0;
    return parts.map((part, index) => {
      const key = keys[index] ?? null;
      const meta = metas[index] ?? null;
      const verdictIndex = meta ? hitIndex++ : -1;
      return (async (): Promise<StrictPart> => {
        if (!key) {
          summary.uncached += 1;
          return renderUncached(part);
        }
        if (!meta) {
          const base = colo ? await renderBase(colo) : await statementBase();
          const result = await renderAndStore(part, key, base, "miss");
          if (result.status === "miss") summary.misses += 1;
          else summary.uncached += 1;
          return result;
        }
        let validated: { snapshot: ValidationSnapshot; verdicts: DvcVerdict[] };
        try {
          validated = await startStatement();
        } catch (error) {
          return staleOrThrow(part, key, meta, stored[index]!, summary, error);
        }
        const verdict = validated.verdicts[verdictIndex]!;
        if (verdict.valid) {
          summary.hits += 1;
          const served = { ...meta, s0: verdict.s0 };
          const body = stored[index]!;
          if (audit && random() < DVC_AUDIT_RATE) {
            deps.waitUntil(auditHit(part, key, served, body.clone(), validated.snapshot.S).catch(() => undefined));
          }
          return { response: fromStoredEntry(body), meta: served, status: "hit", key, validatedAt: validated.snapshot.S };
        }
        discardBody(stored[index]!);
        summary.refreshes += 1;
        return renderAndStore(part, key, await renderBase(validated.snapshot), "refresh");
      })();
    });
  }

  /**
   * The validation read failed (database outage): re-render; if that fails
   * too, a catalogue or content entry at most 15 minutes old is served stale
   * (owner decision 3), without proof, so it carries no cache metadata.
   */
  async function staleOrThrow(part: Request, key: string, meta: DvcEntryMeta, stored: Response, summary: BatchCacheSummary, cause: unknown): Promise<StrictPart> {
    const pathname = new URL(part.url).pathname;
    try {
      const response = await slot(() => deps.render(part));
      if (response.status < 500) {
        summary.uncached += 1;
        discardBody(stored);
        return { response, meta: null, status: "uncached", key };
      }
      if (!staleIfErrorAllowed(part, meta, now())) return { response, meta: null, status: "uncached", key };
      discardBody(response);
    } catch (error) {
      if (!staleIfErrorAllowed(part, meta, now())) throw error;
    }
    summary.stale += 1;
    log(`[CacheDVC] stale-if-error ${pathname} (${cause instanceof Error ? cause.name : "error"})`);
    return { response: fromStoredEntry(stored), meta: null, status: "stale-if-error", key };
  }

  /**
   * Production audit (CACHE-DESIGN §7 item 7): a sampled validated hit is
   * rendered again after the response. A different body whose keys did not
   * move since the validation is a missed dependency: the entry is evicted
   * and one masked line is logged.
   */
  async function auditHit(part: Request, key: string, meta: DvcEntryMeta, body: Response, validatedAt: number): Promise<void> {
    if (meta.softMaxAgeSeconds !== null) {
      discardBody(body);
      return;
    }
    const [cachedText, fresh] = await Promise.all([body.text(), renderRecorded(part, { S: 0, platform: null })]);
    const freshText = await fresh.response.text();
    if (fresh.response.status === body.status && freshText === cachedText) return;
    const moved = await readValidationSnapshot(deps.db(), meta.deps, validatedAt);
    if (moved.changed.size > 0) return;
    await deps.cache?.delete(key).catch(() => false);
    log(`[CacheAudit] stale ${new URL(part.url).pathname} ${maskedDepsSummary(meta.deps)}`);
  }

  function toPublic(part: StrictPart): PublicPartRead {
    const proven = part.meta !== null && part.status !== "uncached" && part.status !== "stale-if-error";
    return { response: part.response, cache: proven ? batchPartCache(part.meta!, part.status as StorefrontBatchPartCache["status"]) : null };
  }

  function logSummary(prefix: string, summary: BatchCacheSummary, extra = ""): void {
    if (random() >= DVC_SUMMARY_LOG_RATE) return;
    log(`${prefix} hits=${summary.hits} misses=${summary.misses} refreshes=${summary.refreshes} uncached=${summary.uncached} stale=${summary.stale}`
      + `${summary.validationMs === null ? "" : ` validateMs=${summary.validationMs}`}${extra}`);
  }

  /**
   * P1: what the strict reader would have served for the same parts, against
   * what the generation path served. A strict hit that differs from the
   * served body is checked against a fresh render (bounded per batch):
   * - fresh equals the strict entry: the generation path served stale;
   * - the entry's keys moved since its validation, or it is soft: a race;
   * - otherwise the entry missed a dependency: evicted and logged, masked.
   */
  async function shadow(parts: readonly Request[], served: ReadonlyArray<{ response: Response; hit: boolean }>): Promise<void> {
    const summary: BatchCacheSummary = { hits: 0, misses: 0, refreshes: 0, uncached: 0, stale: 0, validationMs: null };
    const servedBodies = await Promise.all(served.map(async ({ response }) => ({ status: response.status, text: await response.text() })));
    const strict = await Promise.allSettled(await readStrictParts(parts, summary, false));
    let agree = 0;
    let generationStale = 0;
    let raced = 0;
    let missed = 0;
    let checks = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const outcome = strict[index]!;
      if (outcome.status !== "fulfilled") continue;
      const result = outcome.value;
      const text = await result.response.text();
      if (result.status !== "hit" || !result.meta) continue;
      const servedBody = servedBodies[index]!;
      if (servedBody.status === result.response.status && servedBody.text === text) {
        agree += 1;
        continue;
      }
      if (checks >= SHADOW_MAX_CHECKS) continue;
      checks += 1;
      const fresh = await renderRecorded(parts[index]!, { S: 0, platform: null });
      const freshText = await fresh.response.text();
      if (fresh.response.status === result.response.status && freshText === text) {
        generationStale += 1;
        continue;
      }
      const moved = await readValidationSnapshot(deps.db(), result.meta.deps, result.validatedAt ?? result.meta.s0);
      if (moved.changed.size > 0 || result.meta.softMaxAgeSeconds !== null) {
        raced += 1;
        continue;
      }
      missed += 1;
      if (result.key) await deps.cache?.delete(result.key).catch(() => false);
      log(`[CacheShadow] missed-dep ${new URL(parts[index]!.url).pathname} ${maskedDepsSummary(result.meta.deps)}`);
    }
    const generationHits = served.filter((each) => each.hit).length;
    logSummary("[CacheShadow]", summary, ` generationHits=${generationHits} agree=${agree} generationStale=${generationStale} raced=${raced} missedDep=${missed}`);
  }

  return {
    /**
     * Every part of one batch (or the one part of a direct read). A part
     * whose read throws is a rejected entry, so one failure never fails the
     * others.
     */
    async readParts(parts: readonly Request[], generation: string | null): Promise<Array<PromiseSettledResult<PublicPartRead>>> {
      if (deps.mode === "strict") {
        const summary: BatchCacheSummary = { hits: 0, misses: 0, refreshes: 0, uncached: 0, stale: 0, validationMs: null };
        const results = await Promise.allSettled(await readStrictParts(parts, summary, true));
        logSummary("[CacheDVC]", summary);
        deps.onSummary?.(summary);
        return results.map((result) => (result.status === "fulfilled" ? { status: "fulfilled", value: toPublic(result.value) } : result));
      }
      const statuses: boolean[] = parts.map(() => false);
      const results = await Promise.allSettled(parts.map((part, index) =>
        generationRead(part, generation, (hit) => {
          statuses[index] = hit;
        })));
      if (deps.mode === "shadow" && deps.cache && random() < DVC_SHADOW_SAMPLE_RATE) {
        const copies = results.map((result, index) => (result.status === "fulfilled"
          ? { response: result.value.clone(), hit: statuses[index]! }
          : { response: new Response(null, { status: 599 }), hit: false }));
        deps.waitUntil(shadow(parts, copies).catch((error) => {
          log(`[CacheShadow] evaluation failed (${error instanceof Error ? error.name : "error"})`);
        }));
      }
      return results.map((result) => (result.status === "fulfilled" ? { status: "fulfilled", value: { response: result.value, cache: null } } : result));
    },
  };
}

/** Removes the internal entry headers from a response a browser receives. */
export function withoutInternalCacheHeaders(response: Response): Response {
  if (!DVC_ENTRY_HEADERS.some((name) => response.headers.has(name))) return response;
  const headers = new Headers(response.headers);
  for (const name of DVC_ENTRY_HEADERS) headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
