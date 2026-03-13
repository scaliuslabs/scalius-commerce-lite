/// <reference types="@cloudflare/workers-types" />
/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_API_BASE_URL: string;
  readonly API_TOKEN: string;
  readonly JWT_SECRET: string;
  readonly PURGE_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Add types for Cloudflare runtime environment
type KVNamespace = import("@cloudflare/workers-types").KVNamespace;
type Fetcher = import("@cloudflare/workers-types").Fetcher;

type Runtime = import("@astrojs/cloudflare").Runtime<{
  // This makes the KV binding available on `locals.runtime.env`
  CACHE_CONTROL: KVNamespace;
  BACKEND_API: Fetcher;
}>;

declare namespace App {
  interface Locals extends Runtime {
    // you can define other locals properties here
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
