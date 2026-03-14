// apps/storefront/src/env.d.ts

/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// Vite / Astro build-time environment variables (import.meta.env).
// ONLY PUBLIC_ prefixed vars belong here — they are baked into the JS bundle at build time.
// Secrets (API_TOKEN, JWT_SECRET, PURGE_TOKEN) must NEVER be here — they come from
// Cloudflare Workers runtime bindings (env.* via wrangler secret put or .dev.vars).
interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
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

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Cloudflare Workers environment bindings (global Env interface).
// Must stay in sync with apps/storefront/wrangler.jsonc.
interface Env {
  // Static assets binding (required by @astrojs/cloudflare)
  ASSETS: Fetcher;

  // Cloudflare KV namespace for cache-busting control
  CACHE_CONTROL: KVNamespace;

  // Service binding to the standalone API worker
  BACKEND_API: Fetcher;

  // Secrets (set via `wrangler secret put`)
  API_TOKEN?: string;
  JWT_SECRET?: string;
  PURGE_TOKEN?: string;

  // Variables (set in wrangler.jsonc vars)
  PUBLIC_API_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  STOREFRONT_URL?: string;
  CDN_DOMAIN_URL?: string;

  [key: string]: unknown;
}

// Required by @astrojs/cloudflare -- provides the Worker `env` object at module level.
declare module "cloudflare:workers" {
  export const env: Env;
}

declare namespace App {
  interface Locals {
    cfContext: ExecutionContext;
  }
}

// Popover API TypeScript Declarations
// https://developer.mozilla.org/en-US/docs/Web/API/Popover_API

interface ToggleEvent extends Event {
  readonly oldState: "open" | "closed";
  readonly newState: "open" | "closed";
  readonly source?: HTMLElement;
}

interface HTMLElement {
  popover?: "auto" | "manual" | "hint" | null;
  showPopover(options?: { source?: HTMLElement }): void;
  hidePopover(): void;
  togglePopover(force?: boolean): void;
}

interface HTMLButtonElement {
  popoverTargetElement?: HTMLElement | null;
  popoverTargetAction?: "show" | "hide" | "toggle";
}

interface HTMLInputElement {
  popoverTargetElement?: HTMLElement | null;
  popoverTargetAction?: "show" | "hide" | "toggle";
}

interface GlobalEventHandlersEventMap {
  toggle: ToggleEvent;
  beforetoggle: ToggleEvent;
}
