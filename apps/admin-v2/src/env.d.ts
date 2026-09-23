/// <reference types="vite/client" />

// The dashboard is a static browser app. It reads no VITE_* variables:
// runtime configuration (base path, platform origins) comes from the API
// Worker that serves it (see src/lib/dashboard-base-path.ts).

// Core modules the dashboard imports for shared types also declare Worker
// signatures. These stubs satisfy type-checking only; the build's client
// boundary check guarantees no server code reaches browser bundles.
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

