/// <reference types="vite/client" />

// Vite build-time environment (import.meta.env) comes from vite/client only.
// The dashboard reads no VITE_* variables: runtime configuration is composed
// per request in src/server.ts (see src/lib/runtime-env.server.ts).

// Better Auth user type
interface BetterAuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  isSuperAdmin?: boolean | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
  twoFactorEnabled?: boolean | null;
  mustChangePassword?: boolean | null;
  mustEnrollTwoFactor?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

// Better Auth session type
interface BetterAuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  impersonatedBy?: string | null;
  twoFactorVerified?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Minimal Cloudflare Workers type stubs
// Avoids importing @cloudflare/workers-types globally, which can conflict with DOM types.

interface KVNamespaceListKey<Metadata = unknown, Key extends string = string> {
  name: Key;
  expiration?: number;
  metadata?: Metadata;
}

interface KVNamespaceListResult<
  Metadata = unknown,
  Key extends string = string,
> {
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
    options?: {
      expiration?: number;
      expirationTtl?: number;
      metadata?: object | null;
    },
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
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
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
  get(
    key: string,
    options?: Record<string, unknown>,
  ): Promise<R2ObjectBody | R2Object | null>;
  put(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: Record<string, unknown>,
  ): Promise<R2Object>;
  createMultipartUpload(
    key: string,
    options?: Record<string, unknown>,
  ): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
  delete(key: string | string[]): Promise<void>;
  list(options?: Record<string, unknown>): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes: string[];
  }>;
}

interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: Record<string, unknown>,
  ): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>;
}

interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface CloudflareSendEmailBinding {
  send(message: {
    to:
      | string
      | { email: string; name?: string }
      | Array<string | { email: string; name?: string }>;
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

interface Queue<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(
    messages: Array<{ body: T; delaySeconds?: number }>,
  ): Promise<void>;
}

// Cloudflare Workers environment bindings (global Env interface).
// Must stay in sync with apps/admin-v2/wrangler.jsonc. The `vars` block is
// empty: every URL is resolved from Platform settings at request time.
interface Env {
  // Resource bindings
  DB?: D1Database;
  CACHE: KVNamespace;
  SESSION: KVNamespace;
  BUCKET: R2Bucket;
  SHARED_AUTH_CACHE: KVNamespace;
  EMAIL?: CloudflareSendEmailBinding;

  // Service bindings
  API: Fetcher;
  // Static assets binding (wrangler.jsonc `assets.binding`). Used only when
  // the dashboard is served below a runtime base path; Cloudflare serves
  // root-level asset paths before the Worker runs.
  ASSETS?: Fetcher;

  // Installed secrets (`wrangler secret put`). Exactly two per deployment.
  SCALIUS_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;

  // Optional relational provider selection (only for non-D1 deployments).
  DATABASE_PROVIDER?: "d1" | "turso" | "postgres";
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  POSTGRES_DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  // Operations-only cutover switch.
  DATABASE_MIGRATION_FREEZE?: string;

  // Derived per request from SCALIUS_SECRET (src/server.ts). Never installed.
  BETTER_AUTH_SECRET: string;
  IDENTITY_HANDOFF_SECRET?: string;

  // Resolved per request from Platform settings (dashboard -> Settings ->
  // System -> Platform) through GET /api/v1/platform. Never Wrangler vars.
  PLATFORM_CONFIG?: import("@scalius/shared/platform-config").PlatformConfig;
  BETTER_AUTH_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  STOREFRONT_URL?: string;
  R2_PUBLIC_URL?: string;

  // Local development only (vite.config.ts dev vars).
  LOCAL_MAILPIT_URL?: string;
  [key: string]: unknown;
}

// Provides the raw Worker `env` object at module level. Server code reads the
// request-scoped composed env through `getRuntimeEnv()` instead.
declare module "cloudflare:workers" {
  export const env: Env;
}
