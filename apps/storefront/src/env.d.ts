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

  // Astro session storage for storefront SSR
  SESSION: KVNamespace;

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
  CACHE_NAMESPACE?: string;
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

// SSR-only globalThis properties set by middleware for cross-module access
declare let __SCALIUS_CDN_DOMAIN__: string | undefined;

// Global window properties injected by the storefront layout at runtime.
// These are set via <script> tags in the base layout and read by client-side code.
interface Window {
  __API_BASE_URL__?: string;
  __CDN_DOMAIN__?: string;
  __IMAGE_OPTIMIZATION_ENABLED__?: boolean;
  __IMAGE_CDN_BASE_URL__?: string;
  __IMAGE_CDN_HOSTS__?: string[];
  __IMAGE_CDN_CANONICAL_HOST_ALIASES__?: string[];
  __CURRENCY_SYMBOL__?: string;
  __CURRENCY_CODE__?: string;
  __CURRENCY_DECIMAL_PLACES__?: number;
  __BUILD_ID__?: string;
  __CHECKOUT_CONFIG__?: unknown;
  __scaliusAuthModalOpenPending?: boolean;
  dataLayer?: Record<string, unknown>[];
  fbq?: ((...args: unknown[]) => void) & { q?: unknown[] };
  zaraz?: {
    ecommerce?: (
      eventName: string,
      parameters?: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    track?: (
      eventName: string,
      properties?: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
  };

  // Cart interaction handlers (set by lib/cart/client.ts initCartFunctionality)
  lastShippingEventDetail?: { id: string; fee: number; name?: string };
  handleAbandonedCheckout?: () => void;
  validateCartSnapshot?: () => Promise<boolean>;
  hasCartValidationIssues?: () => boolean;
  getCartBlockedMessage?: () => string;
  updateCartQuantity?: (
    id: string,
    variantId: string,
    quantity: number,
  ) => void;
  removeFromCart?: (id: string, variantId: string) => void;
  removeCartIssueItem?: (cartKey: string) => void;
  reduceCartIssueItem?: (cartKey: string) => void;
  refreshCartIssueItem?: (cartKey: string) => void;
  removeDiscountCode?: () => void;

  // Note: Stripe type is declared in checkout/handlers/stripe.ts with its full interface

  // Browser APIs that may not be in all TS lib targets
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
}
