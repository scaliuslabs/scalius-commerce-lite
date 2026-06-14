interface CacheVersionStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
}

export type CacheVersionResolution =
  | { status: "available"; version: string; initialized: boolean }
  | { status: "unavailable"; reason: string };

export async function resolveStorefrontCacheVersion({
  store,
  key,
  timeoutMs,
  initialVersion = "1",
  waitUntil,
}: {
  store: CacheVersionStore;
  key: string;
  timeoutMs: number;
  initialVersion?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<CacheVersionResolution> {
  try {
    const version = await Promise.race([
      store.get(key),
      new Promise<string | null>((_, reject) =>
        setTimeout(
          () => reject(new Error("KV lookup timeout")),
          timeoutMs,
        ),
      ),
    ]);

    if (typeof version === "string" && version.length > 0) {
      return { status: "available", version, initialized: false };
    }

    const write = store.put(key, initialVersion);
    if (waitUntil) {
      waitUntil(write);
    } else {
      await write;
    }

    return { status: "available", version: initialVersion, initialized: true };
  } catch (error: unknown) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
