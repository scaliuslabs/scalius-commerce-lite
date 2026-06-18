const EXACT_CACHE_GENERATION_PREFIX = "g:";
const DEFAULT_GENERATION = "0";
const PRODUCT_SLUG_KEY_PREFIX = "product_slug_";
const PRODUCT_VARIANTS_KEY_PREFIX = "product_variants_";
const WIDGET_KEY_PREFIX = "widget_";
const WIDGET_SCOPE_KEY_PREFIX = "widgets_scope_";
const PAGE_RENDER_KEY_PREFIX = "page_render_";
const HTML_PATH_KEY_PREFIX = "html_path_";
const CHECKOUT_DATA_KEYS = [
  "checkout_config",
  "global_checkout_language",
  "global_shipping_cities",
  "global_shipping_methods",
] as const;
const CHECKOUT_DATA_FAMILY_PREFIXES = [
  "shipping_zones_",
  "shipping_areas_",
] as const;

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
  return `${EXACT_CACHE_GENERATION_PREFIX}${hostname}:${encodeURIComponent(
    cacheGenerationKeyForLogicalKey(logicalKey) ?? logicalKey,
  )}`;
}

export function cacheGenerationKeyForLogicalKey(logicalKey: string): string | null {
  if (
    logicalKey.startsWith(PRODUCT_SLUG_KEY_PREFIX) ||
    logicalKey.startsWith(PRODUCT_VARIANTS_KEY_PREFIX) ||
    logicalKey.startsWith(WIDGET_KEY_PREFIX) ||
    logicalKey.startsWith(WIDGET_SCOPE_KEY_PREFIX) ||
    logicalKey.startsWith(PAGE_RENDER_KEY_PREFIX) ||
    logicalKey.startsWith(HTML_PATH_KEY_PREFIX)
  ) {
    return logicalKey;
  }

  if (CHECKOUT_DATA_KEYS.includes(logicalKey as typeof CHECKOUT_DATA_KEYS[number])) {
    return logicalKey;
  }

  for (const prefix of CHECKOUT_DATA_FAMILY_PREFIXES) {
    if (logicalKey.startsWith(prefix)) {
      return prefix;
    }
  }

  return null;
}

export function shouldUseExactCacheGeneration(logicalKey: string): boolean {
  return cacheGenerationKeyForLogicalKey(logicalKey) !== null;
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

export function htmlPathCacheKeyFromPath(path: string): string | null {
  const productKey = productSlugCacheKeyFromPath(path);
  if (productKey) {
    return productKey;
  }

  try {
    const url = new URL(path, "https://cache.local");
    const pathname = url.pathname;
    const isExactEntityPath =
      /^\/categories\/[^/]+$/.test(pathname) ||
      /^\/collections\/[^/]+$/.test(pathname) ||
      (/^\/[^/.]+$/.test(pathname) && pathname !== "/search");
    if (!isExactEntityPath) {
      return null;
    }
    return `${HTML_PATH_KEY_PREFIX}${pathname}`;
  } catch {
    return null;
  }
}

export function htmlPathCacheKeyFromUrl(url: URL): string | null {
  return htmlPathCacheKeyFromPath(url.pathname);
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
  const uniqueKeys = [
    ...new Set(
      logicalKeys
        .map((logicalKey) => cacheGenerationKeyForLogicalKey(logicalKey) ?? logicalKey)
        .filter(Boolean),
    ),
  ];
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
