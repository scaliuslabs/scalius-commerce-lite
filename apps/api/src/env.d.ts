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

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
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

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
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
  DB: D1Database;
  CACHE: KVNamespace;
  BUCKET: R2Bucket;
  SHARED_AUTH_CACHE: KVNamespace;
  AI?: Ai;
  WidgetDesignAgent: DurableObjectNamespace;
  EMAIL?: CloudflareSendEmailBinding;

  // Cloudflare Queue bindings
  PAYMENT_EVENTS_QUEUE: Queue;
  ORDER_NOTIFICATIONS_QUEUE: Queue;
  AUTH_OTP_QUEUE: Queue;
  ORDER_INGEST_QUEUE: Queue;

  // Secrets (set via `wrangler secret put`)
  BETTER_AUTH_SECRET: string;
  API_TOKEN?: string;
  JWT_SECRET?: string;
  FIREBASE_SERVICE_ACCOUNT_CRED_JSON?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;

  // Note: Stripe and SSLCommerz credentials are stored in the DB settings table
  // and managed via the admin dashboard — NOT as environment variables.

  // Variables
  BETTER_AUTH_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  STOREFRONT_URL?: string;
  R2_PUBLIC_URL?: string;
  CDN_DOMAIN_URL?: string;
  PURGE_URL?: string;
  PURGE_TOKEN?: string;
  PROJECT_CACHE_PREFIX?: string;
  FCM_SEND_CONCURRENCY?: string | number;
  [key: string]: unknown;
}

// Cloudflare Workers module declaration
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<E = unknown> {
    protected env: E;
    protected ctx: ExecutionContext;
    fetch?(request: Request): Promise<Response>;
    queue?(batch: MessageBatch): Promise<void>;
  }
  export const env: Env;
}
