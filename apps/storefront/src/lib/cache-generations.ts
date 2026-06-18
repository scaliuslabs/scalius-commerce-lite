const EXACT_CACHE_GENERATION_PREFIX = "g:";
const DEFAULT_GENERATION = "0";
const PRODUCT_SLUG_KEY_PREFIX = "product_slug_";
const PRODUCT_VARIANTS_KEY_PREFIX = "product_variants_";

interface GenerationStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
}

export type CacheGenerationResolution =
  | { status: "available"; generation: string }
  | { status: "unavailable"; reason: string };

export function buildExactCacheGenerationKey(
  hostname: string,
  logicalKey: string,
): string {
  return `${EXACT_CACHE_GENERATION_PREFIX}${hostname}:${encodeURIComponent(logicalKey)}`;
}

export function shouldUseExactCacheGeneration(logicalKey: string): boolean {
  return (
    logicalKey.startsWith(PRODUCT_SLUG_KEY_PREFIX) ||
    logicalKey.startsWith(PRODUCT_VARIANTS_KEY_PREFIX)
  );
}

export function productSlugCacheKeyFromPath(path: string): string | null {
  try {
    const url = new URL(path, "https://cache.local");
    const match = url.pathname.match(/^\/products\/([^/]+)$/);
    if (!match?.[1]) {
      return null;
    }
    return `${PRODUCT_SLUG_KEY_PREFIX}${decodeURIComponent(match[1])}`;
  } catch {
    return null;
  }
}

export function productSlugCacheKeyFromUrl(url: URL): string | null {
  return productSlugCacheKeyFromPath(url.pathname);
}

export async function resolveExactCacheGeneration({
  store,
  hostname,
  logicalKey,
  timeoutMs,
}: {
  store: GenerationStore;
  hostname: string;
  logicalKey: string;
  timeoutMs: number;
}): Promise<CacheGenerationResolution> {
  try {
    const key = buildExactCacheGenerationKey(hostname, logicalKey);
    const generation = await Promise.race([
      store.get(key),
      new Promise<string | null>((_, reject) =>
        setTimeout(() => reject(new Error("KV generation lookup timeout")), timeoutMs),
      ),
    ]);

    return {
      status: "available",
      generation:
        typeof generation === "string" && generation.length > 0
          ? generation
          : DEFAULT_GENERATION,
    };
  } catch (error: unknown) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function randomGenerationSuffix(): string {
  const runtimeCrypto = globalThis.crypto;
  if (!runtimeCrypto?.getRandomValues) {
    return "0";
  }

  const values = runtimeCrypto.getRandomValues(new Uint32Array(2));
  return Array.from(values, (value) => value.toString(36)).join("");
}

export function createExactCacheGeneration(): string {
  return `${Date.now().toString(36)}-${randomGenerationSuffix()}`;
}

export async function bumpExactCacheGenerations({
  store,
  hostname,
  logicalKeys,
}: {
  store: GenerationStore;
  hostname: string;
  logicalKeys: readonly string[];
}): Promise<Array<{ logicalKey: string; generation: string }>> {
  const uniqueKeys = [...new Set(logicalKeys.filter(Boolean))];
  if (uniqueKeys.length === 0) {
    return [];
  }

  const generation = createExactCacheGeneration();
  await Promise.all(
    uniqueKeys.map((logicalKey) =>
      store.put(
        buildExactCacheGenerationKey(hostname, logicalKey),
        generation,
      ),
    ),
  );

  return uniqueKeys.map((logicalKey) => ({ logicalKey, generation }));
}
