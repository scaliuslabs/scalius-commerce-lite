import { vi } from "vitest";

/** The Worker version the stubbed Cache API mirror is keyed under. */
export const TEST_WORKER_VERSION = "test-v1";

export function settingsMirrorUrl(key: string): string {
  return `https://settings.internal/${TEST_WORKER_VERSION}/${encodeURIComponent(key)}`;
}

/**
 * Stubs the global Cache API with an in-memory store. Pair it with
 * `CF_VERSION_METADATA: { id: TEST_WORKER_VERSION }` in the Worker env so
 * `settingsMirror(env)` is active; call `vi.unstubAllGlobals()` afterwards.
 */
export function stubSettingsMirror(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(
    Object.entries(seed).map(([key, value]) => [settingsMirrorUrl(key), value]),
  );
  const cache = {
    match: vi.fn(async (url: string) => (store.has(url) ? new Response(store.get(url)) : undefined)),
    put: vi.fn(async (url: string, response: Response) => {
      store.set(url, await response.text());
    }),
    delete: vi.fn(async (url: string) => store.delete(url)),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  return {
    cache,
    /** The mirrored document text for a settings cache key, or null. */
    read: (key: string) => store.get(settingsMirrorUrl(key)) ?? null,
  };
}
