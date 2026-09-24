import { afterEach, describe, expect, it, vi } from "vitest";
import { storefrontBatchPath } from "@scalius/shared/public-api-cache-routes";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createLocalPublicReader, isStorablePublicRead, publicReadCacheKey } from "./public-read";

/**
 * The storefront batch serves its parts inside its own invocation: the data
 * center's Cache API under the PublicApi key, else rendered in-process the
 * way PublicApi renders them. Never through the PublicApi entrypoint, whose
 * misses wait for a separate, usually cold, isolate.
 */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: Env;
    ctx: ExecutionContext;
    constructor(ctx: ExecutionContext, env: Env) {
      this.env = env;
      this.ctx = ctx;
    }
  },
}));

type TestWorker = { fetch(request: Request): Promise<Response> };

const SEED = `
  INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
    VALUES ('v_linen', 'p_linen', 'LIN-1', 250000, 5, 0, 1, 1);
`;

class MemoryCache {
  entries = new Map<string, Response>();
  puts: string[] = [];
  async match(key: RequestInfo | URL) {
    return this.entries.get(String(key))?.clone();
  }
  async put(key: RequestInfo | URL, response: Response) {
    this.puts.push(String(key));
    this.entries.set(String(key), response);
  }
}

function setup() {
  const { sqlite, binding } = createSqliteD1Database();
  sqlite.exec(SEED);
  const env = {
    DB: binding,
    SCALIUS_SECRET: "storefront-batch-route-master-secret-0123456789",
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  const publicApi = vi.fn<(request: Request) => Promise<Response>>();
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
    passThroughOnException: () => undefined,
    exports: { PublicApi: { fetch: publicApi } },
  } as unknown as ExecutionContext;
  const cache = new MemoryCache();
  vi.stubGlobal("caches", { default: cache });
  return { env, ctx, cache, waits, publicApi };
}

const batchUrl = (parts: string[]) => `https://api.internal${storefrontBatchPath(parts)}`;
const PARTS = [
  "/api/v1/storefront/layout",
  "/api/v1/shipping-methods",
  "/api/v1/products/linen-panjabi",
  "/api/v1/products/missing-product",
];

async function batch(env: Env, ctx: ExecutionContext, generation = "gen1") {
  const { default: ApiWorker } = await import("./worker");
  const worker = new ApiWorker(ctx, env) as unknown as TestWorker;
  const response = await worker.fetch(new Request(batchUrl(PARTS), {
    headers: { "X-Scalius-Cache-Generation": generation },
  }));
  const body = await response.json() as { data: { parts: Array<{ status: number; body: string }> } };
  return body.data.parts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storefront batch parts", () => {
  it("render in-process on a miss, are stored under the PublicApi key, and never call PublicApi", async () => {
    const { env, ctx, cache, waits, publicApi } = setup();

    const first = await batch(env, ctx);
    await Promise.all(waits);

    expect(first.map((part) => part.status)).toEqual([200, 200, 200, 404]);
    expect(publicApi).not.toHaveBeenCalled();
    // Only the three 200s are stored, each under the key PublicApi would use.
    expect(cache.puts).toEqual(PARTS.slice(0, 3).map((path) =>
      publicReadCacheKey(new Request(`https://api.internal${path}`), "gen1")));
    expect(cache.puts[0]).toBe("https://api.internal/api/v1/storefront/layout?__cg=gen1");
  });

  it("are answered from the data center cache for the same generation, and re-rendered for a new one", async () => {
    const { env, ctx, cache, waits } = setup();
    const first = await batch(env, ctx);
    await Promise.all(waits);
    const render = vi.spyOn(await import("./runtime/fetch-runtime-app"), "fetchRuntimeApiApp");

    const again = await batch(env, ctx);
    const rendersForBatchOnly = render.mock.calls.length;
    const next = await batch(env, ctx, "gen2");

    expect(again).toEqual(first);
    // Same generation: only the batch route itself and the uncached 404 render.
    expect(rendersForBatchOnly).toBe(2);
    expect(render.mock.calls.length - rendersForBatchOnly).toBe(1 + PARTS.length);
    expect(next.map((part) => part.status)).toEqual([200, 200, 200, 404]);
    expect(cache.puts.filter((key) => key.endsWith("__cg=gen2"))).toHaveLength(3);
    render.mockRestore();
  });

  it("give the same status, body and cache headers as the PublicApi entrypoint", async () => {
    const { env, ctx, cache, waits } = setup();
    await batch(env, ctx);
    await Promise.all(waits);
    const { PublicApi } = await import("./worker");

    for (const path of PARTS) {
      const key = publicReadCacheKey(new Request(`https://api.internal${path}`), "gen1")!;
      const viaPublicApi = await (new PublicApi(ctx, env) as unknown as TestWorker).fetch(new Request(key));
      const inBatch = (await batch(env, ctx))[PARTS.indexOf(path)]!;

      expect(inBatch.status, path).toBe(viaPublicApi.status);
      expect(inBatch.body, path).toBe(await viaPublicApi.clone().text());
      const stored = await cache.match(key);
      if (viaPublicApi.status === 200) {
        // The stored copy keeps PublicApi's headers; only its storage lifetime differs.
        for (const name of ["Cloudflare-CDN-Cache-Control", "X-Content-Type-Options", "X-Frame-Options", "Content-Type"]) {
          expect(stored!.headers.get(name), `${path} ${name}`).toBe(viaPublicApi.headers.get(name));
        }
        expect(viaPublicApi.headers.get("Cache-Control")).toBe("public, max-age=0, no-cache, must-revalidate");
        expect(stored!.headers.get("Cache-Control")).toBe("public, max-age=86400");
      } else {
        expect(stored, path).toBeUndefined();
      }
    }
  });
});

describe("local public reader", () => {
  const ours = (status: number, headers: Record<string, string> = {}) => new Response("{}", {
    status,
    headers: { "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=0, no-cache, must-revalidate", ...headers },
  });

  it("stores only cacheable 200s this Worker produced", () => {
    expect(isStorablePublicRead(ours(200))).toBe(true);
    expect(isStorablePublicRead(ours(404))).toBe(false);
    expect(isStorablePublicRead(ours(500))).toBe(false);
    expect(isStorablePublicRead(ours(200, { "Cache-Control": "private, no-store" }))).toBe(false);
    expect(isStorablePublicRead(ours(200, { "Set-Cookie": "a=b" }))).toBe(false);
    expect(isStorablePublicRead(new Response("{}", { headers: { "Cache-Control": "public, max-age=0, no-cache, must-revalidate" } }))).toBe(false);
  });

  it("renders at most the configured number of parts at once", async () => {
    let active = 0;
    let peak = 0;
    const read = createLocalPublicReader({
      cache: null,
      maxConcurrentRenders: 2,
      waitUntil: () => undefined,
      render: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return ours(200);
      },
    });

    const results = await Promise.all(PARTS.map((path) => read(new Request(`https://api.internal${path}`), "gen1")));

    expect(results.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(peak).toBe(2);
  });

  it("still renders when the cache lookup fails", async () => {
    const read = createLocalPublicReader({
      cache: { match: async () => { throw new Error("cache down"); }, put: async () => undefined },
      maxConcurrentRenders: 2,
      waitUntil: () => undefined,
      render: async () => ours(200),
    });

    expect((await read(new Request("https://api.internal/api/v1/shipping-methods"), "gen1")).status).toBe(200);
  });
});
