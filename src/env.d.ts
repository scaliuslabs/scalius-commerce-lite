// src/env.d.ts

/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// Vite / Astro build-time environment variables (import.meta.env).
// Runtime secrets (DB, CACHE, BUCKET …) come through Cloudflare Workers bindings.
interface ImportMetaEnv {
  readonly BETTER_AUTH_SECRET: string;
  readonly BETTER_AUTH_URL: string;
  readonly PUBLIC_API_BASE_URL: string;

  // Public Firebase vars (used in client-side code)
  readonly PUBLIC_FIREBASE_API_KEY: string;
  readonly PUBLIC_FIREBASE_AUTH_DOMAIN: string;
  readonly PUBLIC_FIREBASE_PROJECT_ID: string;
  readonly PUBLIC_FIREBASE_STORAGE_BUCKET: string;
  readonly PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly PUBLIC_FIREBASE_APP_ID: string;
  readonly PUBLIC_FIREBASE_MEASUREMENT_ID: string;
  readonly PUBLIC_VAPID_FIREBASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Add JSX type support for Astro components
declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

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

// This correctly types `context.locals` for your entire application
declare namespace App {
  interface Locals {
    user: BetterAuthUser | null;
    session: BetterAuthSession | null;
    permissions: Set<string>;
    runtime?: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

// Cloudflare Email Workers send binding type
interface SendEmail {
  send(message: EmailMessage): Promise<void>;
}

// EmailMessage class for Cloudflare Email Workers
declare class EmailMessage {
  constructor(from: string, to: string, raw: string | ReadableStream);
  readonly from: string;
  readonly to: string;
}

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

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Cloudflare Queue binding types
interface Queue<Body = unknown> {
  send(message: Body, options?: { contentType?: "text" | "bytes" | "json" | "v8" }): Promise<void>;
  sendBatch(messages: { body: Body; contentType?: string }[]): Promise<void>;
}

interface MessageBatch<Body = unknown> {
  queue: string;
  messages: Message<Body>[];
  ackAll(): void;
  retryAll(): void;
}

interface Message<Body = unknown> {
  id: string;
  timestamp: Date;
  body: Body;
  ack(): void;
  retry(): void;
}

// Cloudflare Workers environment bindings (global Env interface).
// Must stay in sync with wrangler.jsonc.
interface Env {
  // Service / resource bindings
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  BUCKET: R2Bucket;
  SHARED_AUTH_CACHE: KVNamespace;
  EMAIL?: SendEmail;

  // Cloudflare Queue bindings (optional until queues are created)
  PAYMENT_EVENTS_QUEUE?: Queue<{ type: string; payload: Record<string, unknown> }>;
  INVENTORY_QUEUE?: Queue<{ type: string; payload: Record<string, unknown> }>;

  // Secrets (set via `wrangler secret put`)
  BETTER_AUTH_SECRET: string;
  API_TOKEN?: string;
  JWT_SECRET?: string;
  FIREBASE_SERVICE_ACCOUNT_CRED_JSON?: string;

  // Note: Stripe and SSLCommerz credentials are stored in the DB settings table
  // and managed via the admin dashboard — NOT as environment variables.

  // Variables
  BETTER_AUTH_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  R2_PUBLIC_URL?: string;
  CDN_DOMAIN_URL?: string;
  PURGE_URL?: string;
  PURGE_TOKEN?: string;
  PROJECT_CACHE_PREFIX?: string;
  [key: string]: unknown;
}

// Required by @astrojs/cloudflare — provides the Worker `env` object at module level.
declare module "cloudflare:workers" {
  export const env: Env;
}
