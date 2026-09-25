import { applyBaselineSecurityHeaders } from "@scalius/shared/http-security";
import {
  PUBLIC_CACHE_MAX_AGE_SECONDS,
  readWorkerVersion,
  type WorkerVersionMetadataEnv,
} from "@scalius/shared/cache-generation";
import {
  decoratePublicApiResponse,
  getPublicApiCachePolicy,
  withCacheIdentity,
} from "./public-cache-policy";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

/**
 * One anonymous public read, rendered the same way wherever it is served:
 * the runtime app (routing, validation, error mapping), then the baseline
 * security headers, then the public cache headers. The `PublicApi` Workers
 * Cache entrypoint and the storefront batch both render through this, and
 * both key their caches with `publicReadCacheKey`, so the two paths cannot
 * drift apart. `runtimeEnv` is the invocation's composed env
 * (`composeApiRuntimeEnv`).
 */
export async function renderPublicRead(
  request: Request,
  runtimeEnv: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await fetchRuntimeApiApp(request, runtimeEnv, ctx);
  return decoratePublicApiResponse(
    applyBaselineSecurityHeaders(request, response, { frameProtection: "deny" }),
  );
}

/**
 * The cache key of a public read: canonical path, sorted query,
 * `__cg=<generation>` and `__cv=<Worker version>`. The generation changes on
 * every buyer-visible write; the version (`CF_VERSION_METADATA`) changes on
 * every deploy and every `wrangler dev` start or reload, so an entry never
 * outlives the code that rendered it, whatever that code changed. Null for
 * reads that are not publicly cacheable, or without a generation or a version
 * (then nothing is cached).
 */
export function publicReadCacheKey(
  request: Request,
  env: WorkerVersionMetadataEnv,
  generation: string | null,
): string | null {
  const version = readWorkerVersion(env);
  if (!generation || !version) return null;
  const policy = getPublicApiCachePolicy(request);
  return policy ? withCacheIdentity(policy.canonicalUrl, generation, version) : null;
}

/** Headers `decoratePublicApiResponse` gives every cacheable public read. */
const PUBLIC_READ_CACHE_CONTROL = "public, max-age=0, no-cache, must-revalidate";

/**
 * Only a 200 that this Worker produced (it carries the baseline security
 * headers), that the app marked cacheable and that sets no cookie is stored.
 */
export function isStorablePublicRead(response: Response): boolean {
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  return (
    response.status === 200 &&
    response.headers.has("X-Content-Type-Options") &&
    !response.headers.has("Set-Cookie") &&
    cacheControl === PUBLIC_READ_CACHE_CONTROL
  );
}

/**
 * The Cache API stores by `Cache-Control`, so the stored copy carries the
 * same lifetime the CDN copy gets (`Cloudflare-CDN-Cache-Control`).
 */
function toStoredEntry(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}`);
  return new Response(response.body, { status: response.status, headers });
}

/** A stored entry, answered with the headers the read was rendered with. */
function fromStoredEntry(stored: Response): Response {
  const headers = new Headers(stored.headers);
  headers.set("Cache-Control", PUBLIC_READ_CACHE_CONTROL);
  return new Response(stored.body, { status: stored.status, headers });
}

export interface LocalPublicReadDeps {
  /** The invocation's env; its Worker version is part of every key. */
  env: WorkerVersionMetadataEnv;
  /** `caches.default` in production; null where the Cache API is missing. */
  cache: Pick<Cache, "match" | "put"> | null;
  render(request: Request): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
  /** Reads rendered at once; the rest wait (D1 allows six open connections). */
  maxConcurrentRenders: number;
}

/**
 * Serves public reads inside the calling invocation: the data center's Cache
 * API under `publicReadCacheKey`, else an in-process render that is stored
 * for the next page. Unlike a `PublicApi` entrypoint call, a miss never waits
 * for another (often cold) isolate to start.
 */
export function createLocalPublicReader(deps: LocalPublicReadDeps) {
  let rendering = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (rendering < deps.maxConcurrentRenders) {
      rendering += 1;
      return;
    }
    // A finishing render hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else rendering -= 1;
  };

  return async (request: Request, generation: string | null): Promise<Response> => {
    const key = deps.cache ? publicReadCacheKey(request, deps.env, generation) : null;
    if (key) {
      const stored = await deps.cache!.match(key).catch(() => undefined);
      if (stored) return fromStoredEntry(stored);
    }
    await acquire();
    let response: Response;
    try {
      response = await deps.render(request);
    } finally {
      release();
    }
    if (key && isStorablePublicRead(response)) {
      deps.waitUntil(deps.cache!.put(key, toStoredEntry(response.clone())).catch(() => undefined));
    }
    return response;
  };
}
