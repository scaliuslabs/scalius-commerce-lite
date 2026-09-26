/**
 * What the public part reader already read for a render, handed to it through
 * the render's async context (request-scoped AsyncLocalStorage, never a module
 * global).
 *
 * The one value today is the Platform settings document. A render inside a
 * dependency scope must take the platform origins from the tracked settings
 * row, not the KV hint (`withTrackedPlatformEnv`); the part reader reads that
 * row in the same statement as the change clock, so the render does not
 * spend a D1 wave re-reading it. The value is at least as new as the render's
 * s0, which is what an entry validated by `set:platform:document` needs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PlatformConfig } from "@scalius/shared/platform-config";

export interface PublicRenderContext {
  readonly platform: PlatformConfig | null;
}

const storage = new AsyncLocalStorage<PublicRenderContext>();

export function runWithPublicRenderContext<T>(context: PublicRenderContext, render: () => T): T {
  return storage.run(context, render);
}

/** The Platform settings the part reader preloaded for this render, or null. */
export function preloadedPlatformSettings(): PlatformConfig | null {
  return storage.getStore()?.platform ?? null;
}
