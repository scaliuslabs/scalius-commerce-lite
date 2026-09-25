// apps/storefront/src/env.d.ts

/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// No build-time environment variables are declared here. Public origins are
// resolved per request from the API layout payload and secrets are derived
// from the single installed master secret; nothing is baked into the bundle.

// ---------------------------------------------------------------------------
// Minimal Cloudflare Workers type stubs
// These avoid importing @cloudflare/workers-types globally, which can conflict
// with DOM types (e.g. Response.json() overload changes).
// ---------------------------------------------------------------------------

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface KVNamespace {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
}

// The Workers Cache API's per-data-center default cache.
interface CacheStorage {
  readonly default: Cache;
}

// `astro dev` only: the local API origin from scripts/dev-ports.mjs, defined
// by astro.config.mjs. Undefined in tests; never a Worker var.
declare const __SCALIUS_DEV_API_ORIGIN__: string | undefined;

// Cloudflare Workers environment bindings (global Env interface).
// Must stay in sync with apps/storefront/wrangler.jsonc (checked by
// scripts/check-worker-env.mjs). The Worker has no vars: every runtime value
// is derived from SCALIUS_SECRET or fetched from the API per request.
interface Env {
  // Static assets binding (required by @astrojs/cloudflare)
  ASSETS: Fetcher;

  // Service binding to the standalone API worker
  BACKEND_API: Fetcher;

  // Shared with the API Worker; read only for the public cache generation.
  CACHE?: KVNamespace;

  // This Worker version (`version_metadata`), part of every page cache key
  // (src/lib/public-worker-cache.ts). Without it pages render uncached.
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };

  // The only installed secret (`wrangler secret put SCALIUS_SECRET`).
  // API_TOKEN is derived from it at request time.
  SCALIUS_SECRET?: string;

  [key: string]: unknown;
}

// Required by @astrojs/cloudflare -- provides the Worker `env` object at module level.
declare module "cloudflare:workers" {
  export const env: Env;
  export abstract class WorkerEntrypoint<Bindings = unknown> {
    protected readonly env: Bindings;
    protected readonly ctx: ExecutionContext;
  }
}

// Provided by integrations/deferred-partytown.mjs.
declare module "virtual:scalius/partytown" {
  export const partytownLoaderPath: string;
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

// Global window properties injected by the storefront layout at runtime.
// These are set via <script> tags in the base layout and read by client-side code.
interface Window {
  __API_BASE_URL__?: string;
  __CDN_DOMAIN__?: string;
  __IMAGE_CDN_BASE_URL__?: string;
  __IMAGE_CDN_CANONICAL_HOST_ALIASES__?: string[];
  __CURRENCY_SYMBOL__?: string;
  __CURRENCY_CODE__?: string;
  __CURRENCY_DECIMAL_PLACES__?: number;
  __META_CAPI_BROWSER_EVENTS_ENABLED__?: boolean;
  __TIKTOK_PIXEL_ENABLED__?: boolean;
  __BUILD_ID__?: string;
  __CHECKOUT_CONFIG__?: unknown;
  __CHECKOUT_LANGUAGE__?: unknown;
  __scaliusAuthModalOpenPending?: boolean;
  __scaliusAuthModalDetailPending?: import("@/components/AuthModal").AuthModalOpenDetail;
  __scaliusSearchPaletteOpenPending?: boolean;
  __scaliusCartPendingEvents?: Array<
    | { type: "open" }
    | {
        type: "add";
        detail: import("@/components/CartFlyout").AddToCartEventDetail;
      }
  >;
  __scaliusLazyGlobalUiInstalled?: boolean;
  __scaliusCartPageAbortController?: AbortController;
  dataLayer?: Record<string, unknown>[];
  fbq?: ((...args: unknown[]) => void) & { q?: unknown[] };
  ttq?: {
    load?: (...args: unknown[]) => void;
    page?: (...args: unknown[]) => void;
    track?: (eventName: string, parameters?: Record<string, unknown>) => void;
    [key: string]: unknown;
  };
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
  lastShippingEventDetail?: import("./lib/checkout/shipping-methods").ShippingMethodDetail;
  handleAbandonedCheckout?: () => void;
  validateCartSnapshot?: () => Promise<boolean>;
  hasCartValidationIssues?: () => boolean;
  getCartBlockedMessage?: () => string;
  updateCartQuantity?: (cartKey: string, quantity: number) => void;
  removeFromCart?: (cartKey: string) => void;
  /** Hands a line with buyer inputs to its product page; returns true to follow the link. */
  editCartLine?: (cartKey: string) => boolean;
  removeCartIssueItem?: (cartKey: string) => void;
  reduceCartIssueItem?: (cartKey: string) => void;
  refreshCartIssueItem?: (cartKey: string) => void;
  bulkRemoveCartIssueItems?: () => void;
  bulkReduceCartIssueItems?: () => void;
  bulkRefreshCartIssueItems?: () => void;

  // Note: Stripe type is declared in checkout/handlers/stripe.ts with its full interface

  // Browser APIs that may not be in all TS lib targets
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
}
