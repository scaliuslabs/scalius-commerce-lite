// apps/api/src/env.d.ts
// Cloudflare Workers type definitions for the API worker.
// Only worker-related types — no Astro-specific types.

// ---------------------------------------------------------------------------
// Minimal Cloudflare Workers type stubs
// These avoid importing @cloudflare/workers-types globally, which can conflict
// with DOM types (e.g. Response.json() overload changes).
// ---------------------------------------------------------------------------

interface KVNamespaceListKey<Metadata = unknown, Key extends string = string> {
  name: Key;
  expiration?: number;
  metadata?: Metadata;
}

interface KVNamespaceListResult<Metadata = unknown, Key extends string = string> {
  keys: KVNamespaceListKey<Metadata, Key>[];
  list_complete: boolean;
  cursor?: string;
  cacheStatus: string | null;
}

interface KVNamespace<Key extends string = string> {
  get(key: Key, options?: { cacheTtl?: number }): Promise<string | null>;
  get(key: Key, type: "text"): Promise<string | null>;
  get<T = unknown>(key: Key, type: "json"): Promise<T | null>;
  get(key: Key, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  get(key: Key, type: "stream"): Promise<ReadableStream | null>;
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expiration?: number; expirationTtl?: number; metadata?: object | null },
  ): Promise<void>;
  delete(key: Key): Promise<void>;
  list<Metadata = unknown>(options?: {
    prefix?: Key;
    limit?: number;
    cursor?: string;
  }): Promise<KVNamespaceListResult<Metadata, Key>>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  error?: string;
  meta: Record<string, unknown>;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  blob(): Promise<Blob>;
}

interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: Record<string, unknown>): Promise<R2ObjectBody | R2Object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: Record<string, unknown>,
  ): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
  list(options?: Record<string, unknown>): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }>;
}

interface CloudflareSendEmailBinding {
  send(message: {
    to: string | { email: string; name?: string } | Array<string | { email: string; name?: string }>;
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId: string }>;
}

interface WorkerEntrypointFetchOptions<Props = unknown> {
  props?: Props;
  cf?: { cacheControl?: string; cacheKey?: string };
}

interface WorkerEntrypointFetcher<Props = unknown> {
  fetch(
    request: Request,
    options?: WorkerEntrypointFetchOptions<Props>,
  ): Promise<Response>;
}

/** The data center's default cache (Cache API), used for public reads. */
interface CacheStorage {
  readonly default: Cache;
}

interface WorkerExports {
  PublicApi: WorkerEntrypointFetcher;
  [name: string]: WorkerEntrypointFetcher | undefined;
}

interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: Props;
  readonly exports: WorkerExports;
}

// Cloudflare Queue binding types
interface Queue<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: T; delaySeconds?: number }>): Promise<void>;
}

interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: Message<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

interface Message<T = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

// Cloudflare Workers environment bindings (global Env interface).
// Must stay in sync with wrangler.jsonc.
interface Env {
  // Service / resource bindings
  DB?: D1Database;
  // The only KV namespace. Other users share it by key prefix (OAuth: `oauth:`).
  CACHE: KVNamespace;
  // Public media plus sealed agent artifacts under `private/agent-artifacts/`.
  BUCKET: R2Bucket;
  // Store-scoped keys (src/utils/rate-limit.ts): strict 5/60s, standard 60/60s.
  RL_STRICT: RateLimit;
  RL_STANDARD: RateLimit;
  EMAIL?: CloudflareSendEmailBinding;
  /** One-time WebP renditions for non-dashboard uploads (agents, CLI, URL import). */
  IMAGES?: ImagesBinding;

  // Producer for the single `jobs` queue (DLQ `jobs-dlq`); routed by payload.type.
  JOBS_QUEUE: Queue;
  // The built dashboard SPA (apps/admin-v2/dist). Absent under `pnpm dev`,
  // where Vite serves the dashboard (src/dashboard/surface.ts).
  ASSETS?: { fetch(request: Request): Promise<Response> };
  // This Worker version (`version_metadata`). Part of every public cache key
  // so a cached read never outlives the code that rendered it
  // (`readWorkerVersion` in @scalius/shared/cache-generation). Without it
  // nothing is cached.
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };

  // Installed secrets (`wrangler secret put`). Exactly two per deployment.
  SCALIUS_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;

  // Optional relational provider selection (only for non-D1 deployments).
  DATABASE_PROVIDER?: "d1" | "turso" | "postgres";
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  POSTGRES_DATABASE_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  // Operations-only cutover switch.
  DATABASE_MIGRATION_FREEZE?: string;

  // Derived at Worker entry from SCALIUS_SECRET (src/runtime/runtime-env.ts).
  // Never installed as secrets.
  BETTER_AUTH_SECRET: string;
  JWT_SECRET?: string;
  API_TOKEN?: string;
  AGENT_TOKEN_PEPPER?: string;
  CUSTOMER_SESSION_HASH_KEY?: string;
  ADMIN_SETUP_TOKEN?: string;
  FRONT_PROXY_SECRET?: string;
  IDENTITY_HANDOFF_SECRET?: string;

  // Resolved at Worker entry from Platform settings (dashboard -> Settings ->
  // System -> Platform). Never Wrangler vars.
  PLATFORM_CONFIG?: import("@scalius/shared/platform-config").PlatformConfig;
  STOREFRONT_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  BETTER_AUTH_URL?: string;
  R2_PUBLIC_URL?: string;
  CDN_DOMAIN_URL?: string;
  CUSTOMER_AUTH_COOKIE_DOMAIN?: string;
  CORS_ALLOWED_ORIGINS?: string;

  // Local development only (apps/api/wrangler.local.jsonc).
  LOCAL_MAILPIT_URL?: string;
  [key: string]: unknown;
}

// Cloudflare Workers module declaration
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<E = unknown, Props = unknown> {
    protected env: E;
    protected ctx: ExecutionContext<Props>;
    fetch?(request: Request): Promise<Response>;
    queue?(batch: MessageBatch): Promise<void>;
  }
  export const env: Env;
}
