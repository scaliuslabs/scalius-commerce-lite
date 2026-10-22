// apps/api/src/env.d.ts
// Cloudflare Workers type definitions for the API worker.
// Only worker-related types — no Astro-specific types.

// ---------------------------------------------------------------------------
// Minimal Cloudflare Workers type stubs
// These avoid importing @cloudflare/workers-types globally, which can conflict
// with DOM types (e.g. Response.json() overload changes).
// ---------------------------------------------------------------------------

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
  [name: string]: WorkerEntrypointFetcher | undefined;
}

interface ExecutionContext<Props = unknown> {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: Props;
  readonly exports: WorkerExports;
}

// Durable Objects and hibernatable WebSockets: only what the realtime hub
// (src/realtime/hub.ts) uses.
interface HibernatableWebSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readonly readyState: number;
}

declare const WebSocketPair: {
  new (): { 0: HibernatableWebSocket; 1: HibernatableWebSocket };
};

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

interface DurableObjectState {
  acceptWebSocket(socket: HibernatableWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableWebSocket[];
  getTags(socket: HibernatableWebSocket): string[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

type DurableObjectStub<T = unknown> = {
  fetch(request: Request): Promise<Response>;
} & {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

interface ResponseInit {
  /** workerd: the client end of a WebSocketPair on a 101 response. */
  webSocket?: HibernatableWebSocket | null;
}

interface Response {
  /** workerd: set on a 101 response that carries a WebSocket. */
  readonly webSocket?: HibernatableWebSocket | null;
}

// Cloudflare Workers environment bindings (global Env interface).
// Must stay in sync with wrangler.jsonc.
interface Env {
  // Service / resource bindings
  DB?: D1Database;
  // Public media plus sealed agent artifacts under `private/agent-artifacts/`.
  BUCKET: R2Bucket;
  // Store-scoped keys (src/utils/rate-limit.ts): strict 5/60s, standard 60/60s.
  RL_STRICT: RateLimit;
  RL_STANDARD: RateLimit;
  EMAIL?: CloudflareSendEmailBinding;
  // Dynamic Worker loader for sandboxed plugins (Workers Paid). Operator-enabled
  // and never in the committed Wrangler configs, so Workers Free deploys
  // unchanged: `pnpm run deploy --plugin-sandbox` (or `pnpm plugin sandbox on`)
  // adds it to a generated config. Absent, only bundled plugins run.
  LOADER?: WorkerLoader;

  // The realtime hub: one Durable Object per store that fans out change
  // notices, presence and save notices to staff dashboards over hibernatable
  // WebSockets (src/realtime/hub.ts, docs/platform/REALTIME.md).
  REALTIME_HUB?: DurableObjectNamespace<import("./realtime/hub").RealtimeHub>;

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

  // Resolved at Worker entry from Platform settings (dashboard -> Settings >
  // Store details > Web addresses). Never Wrangler vars.
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
  }
  export const env: Env;
  export abstract class DurableObject<E = unknown> {
    protected ctx: DurableObjectState;
    protected env: E;
    constructor(ctx: DurableObjectState, env: E);
    fetch?(request: Request): Promise<Response>;
    webSocketMessage?(ws: HibernatableWebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: HibernatableWebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(ws: HibernatableWebSocket, error: unknown): void | Promise<void>;
  }
}
