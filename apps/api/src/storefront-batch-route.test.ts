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

/** The part cache mode (a code constant in production); the generation-keyed tests pin `generation`. */
const cacheMode = vi.hoisted(() => ({ value: "generation" as "generation" | "shadow" | "strict" }));
vi.mock("./public-cache-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./public-cache-policy")>();
  return {
    ...actual,
    get API_PART_CACHE_MODE() {
      return cacheMode.value;
    },
  };
});

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
  async delete(key: RequestInfo | URL) {
    return this.entries.delete(String(key));
  }
}

function setup(version = "version-a") {
  const { sqlite, binding } = createSqliteD1Database();
  sqlite.exec(SEED);
  const env = {
    CF_VERSION_METADATA: { id: version, tag: "", timestamp: "" },
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
  return { env, ctx, cache, waits, publicApi, sqlite };
}
const setupWithSqlite = setup;

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
  vi.restoreAllMocks();
  cacheMode.value = "generation";
});

type BatchPart = { status: number; body: string; cache?: { status: string; s0: number; deps: string[] } };

async function batchParts(env: Env, ctx: ExecutionContext, paths = PARTS): Promise<BatchPart[]> {
  const { default: ApiWorker } = await import("./worker");
  const worker = new ApiWorker(ctx, env) as unknown as TestWorker;
  const response = await worker.fetch(new Request(batchUrl(paths), { headers: { "X-Scalius-Cache-Generation": "gen1" } }));
  return (await response.json() as { data: { parts: BatchPart[] } }).data.parts;
}

describe("storefront batch parts, dependency-validated (strict)", () => {
  it("store proof-carrying entries without the generation, serve them as validated hits, and re-render only what a write changed", async () => {
    cacheMode.value = "strict";
    const { env, ctx, cache, waits, publicApi, sqlite } = setupWithSqlite();

    const first = await batchParts(env, ctx);
    await Promise.all(waits.splice(0));
    expect(first.map((part) => [part.status, part.cache?.status ?? null])).toEqual([
      [200, "miss"], [200, "miss"], [200, "miss"], [404, null],
    ]);
    // Only hashed keys leave the API.
    for (const part of first.slice(0, 3)) {
      expect(part.cache!.deps.length).toBeGreaterThan(0);
      expect(part.cache!.deps.every((dep) => /^[0-9a-f]{12}$/.test(dep))).toBe(true);
    }
    expect(cache.puts.some((key) => key.includes("__cg="))).toBe(false);
    expect(cache.puts).toContain("https://api.internal/api/v1/storefront/layout?__cv=version-a");
    expect(cache.puts).toContain("https://api.internal/__scalius/dvc-snapshot?__cv=version-a");
    expect(publicApi).not.toHaveBeenCalled();

    const render = vi.spyOn(await import("./runtime/fetch-runtime-app"), "fetchRuntimeApiApp");
    const second = await batchParts(env, ctx);
    await Promise.all(waits.splice(0));
    expect(second.map((part) => part.cache?.status ?? null)).toEqual(["hit", "hit", "hit", null]);
    expect(second.map((part) => part.body)).toEqual(first.map((part) => part.body));
    // The batch route and the uncached 404 only.
    expect(render).toHaveBeenCalledTimes(2);
    // A hit's s0 rises to the validation clock.
    expect(second[0]!.cache!.s0).toBeGreaterThanOrEqual(first[0]!.cache!.s0);

    sqlite.exec("UPDATE products SET name = 'Linen Kurta' WHERE id = 'p_linen'");
    const third = await batchParts(env, ctx);
    await Promise.all(waits.splice(0));
    expect(third.map((part) => part.cache?.status ?? null)).toEqual(["hit", "hit", "refresh", null]);
    expect(third[2]!.body).toContain("Linen Kurta");
    expect(third[2]!.cache!.s0).toBeGreaterThan(first[2]!.cache!.s0);
  });

  it("serve direct reads through the same validated reader, never PublicApi, without internal headers", async () => {
    cacheMode.value = "strict";
    const { env, ctx, waits, publicApi } = setupWithSqlite();
    const { default: ApiWorker } = await import("./worker");
    const read = async () => {
      const response = await (new ApiWorker(ctx, env) as unknown as TestWorker).fetch(new Request("https://api.internal/api/v1/products/linen-panjabi"));
      // The body goes out first; the stores after it (as waitUntil work does).
      const text = await response.text();
      await Promise.all(waits.splice(0));
      return { response, text };
    };

    const miss = await read();
    const { response: hit, text } = await read();

    expect([miss.response.headers.get("X-Cache-Status"), hit.headers.get("X-Cache-Status")]).toEqual(["MISS", "HIT"]);
    expect(text).toBe(miss.text);
    expect([...hit.headers.keys()].filter((name) => name.startsWith("x-scalius"))).toEqual([]);
    expect(hit.headers.get("Cache-Control")).toBe("public, max-age=0, no-cache, must-revalidate");
    expect(publicApi).not.toHaveBeenCalled();
  });
});

describe("storefront batch parts, shadow (P1)", () => {
  it("serve the generation path and log, masked, a validated entry that differs from a fresh render", async () => {
    cacheMode.value = "shadow";
    const { env, ctx, cache, waits } = setupWithSqlite();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const first = await batchParts(env, ctx);
    await Promise.all(waits.splice(0));
    // Served from generation-keyed entries; the shadow reader filled its own keys.
    expect(first.every((part) => part.cache === undefined)).toBe(true);
    expect(cache.puts).toContain("https://api.internal/api/v1/products/linen-panjabi?__cg=gen1&__cv=version-a");
    expect(cache.puts).toContain("https://api.internal/api/v1/products/linen-panjabi?__cv=version-a");

    // An entry whose proof holds but whose body is wrong: what a missed
    // dependency looks like. (A product page is soft: recommendation order may
    // lag, so a difference there is never judged a miss. Shipping is hard.)
    const dvcKey = "https://api.internal/api/v1/shipping-methods?__cv=version-a";
    const stored = cache.entries.get(dvcKey)!;
    cache.entries.set(dvcKey, new Response('{"success":true,"data":"stale"}', { status: 200, headers: stored.headers }));

    const second = await batchParts(env, ctx);
    await Promise.all(waits.splice(0));
    expect(second.map((part) => part.body)).toEqual(first.map((part) => part.body));
    const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[CacheShadow] missed-dep"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[CacheShadow\] missed-dep \/api\/v1\/shipping-methods [a-z]+:\d+/);
    expect(cache.entries.has(dvcKey)).toBe(false);
  });
});

describe("storefront frontier endpoint", () => {
  it("answers only the storefront's frontier key: hashed changes after since, and the slow-path check", async () => {
    const { env, ctx, sqlite } = setupWithSqlite();
    const { deriveRuntimeSecret } = await import("@scalius/shared/runtime-secrets");
    const { hashCacheDep } = await import("@scalius/shared/cache-frontier");
    const key = await deriveRuntimeSecret(String(env.SCALIUS_SECRET), "cache-frontier");
    const { default: ApiWorker } = await import("./worker");
    const call = (path: string, init: RequestInit = {}) =>
      (new ApiWorker(ctx, env) as unknown as TestWorker).fetch(new Request(`https://api.internal${path}`, init));

    expect((await call("/api/v1/storefront/frontier")).status).toBe(404);
    expect((await call("/api/v1/storefront/frontier", { headers: { "X-Scalius-Frontier-Key": "wrong" } })).status).toBe(404);

    const read = async (since: number) => {
      const response = await call(`/api/v1/storefront/frontier?since=${since}`, { headers: { "X-Scalius-Frontier-Key": key } });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      return (await response.json() as { data: { S: number; horizon: number; clock: number; changes: Array<[string, number]> } }).data;
    };
    const before = await read(0);
    sqlite.exec("UPDATE products SET name = 'Linen Kurta' WHERE id = 'p_linen'");
    const after = await read(before.S);

    expect(after.S).toBeGreaterThan(before.S);
    expect(after.horizon).toBe(before.S);
    expect(after.changes.map(([hash]) => hash)).toContain(hashCacheDep("p:p_linen"));
    expect(JSON.stringify(after)).not.toContain("p_linen");

    const check = async (s0: number, deps: string[]) => (await (await call("/api/v1/storefront/frontier/check", {
      method: "POST",
      headers: { "X-Scalius-Frontier-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ s0, deps }),
    })).json() as { data: { changed: boolean } }).data;
    expect((await check(before.S, [hashCacheDep("p:p_linen")])).changed).toBe(true);
    expect((await check(after.S, [hashCacheDep("p:p_linen")])).changed).toBe(false);
    expect((await call("/api/v1/storefront/frontier/check", {
      method: "POST",
      headers: { "X-Scalius-Frontier-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ s0: 0, deps: ["p:p_linen"] }),
    })).status).toBe(400);
  });
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
      publicReadCacheKey(new Request(`https://api.internal${path}`), env, "gen1")));
    expect(cache.puts[0]).toBe("https://api.internal/api/v1/storefront/layout?__cg=gen1&__cv=version-a");
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
    expect(cache.puts.filter((key) => key.includes("__cg=gen2"))).toHaveLength(3);
    render.mockRestore();
  });

  it("are re-rendered after a deploy at the same generation, never served from the old code's entries", async () => {
    const { env, ctx, cache, waits } = setup("version-a");
    await batch(env, ctx);
    await Promise.all(waits);
    // Plant a payload the old code rendered under the old version's key, as
    // the Cache API still holds it after the deploy.
    const layoutKey = publicReadCacheKey(new Request("https://api.internal/api/v1/storefront/layout"), env, "gen1")!;
    cache.entries.set(layoutKey, new Response('{"old":"shape"}', {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
    }));
    expect((await batch(env, ctx))[0]!.body).toBe('{"old":"shape"}');

    const deployed = { ...env, CF_VERSION_METADATA: { id: "version-b", tag: "", timestamp: "" } } as Env;
    const render = vi.spyOn(await import("./runtime/fetch-runtime-app"), "fetchRuntimeApiApp");
    const afterDeploy = await batch(deployed, ctx);
    await Promise.all(waits);

    expect(afterDeploy[0]!.body).not.toBe('{"old":"shape"}');
    // The batch route plus every part rendered again under the new version.
    expect(render).toHaveBeenCalledTimes(1 + PARTS.length);
    expect(cache.puts.filter((key) => key.endsWith("__cv=version-b"))).toHaveLength(3);
    render.mockRestore();
  });

  it("are stored under the exact key the default entrypoint hands to PublicApi", async () => {
    const { env, ctx, cache, waits, publicApi } = setup();
    await batch(env, ctx);
    await Promise.all(waits);
    publicApi.mockImplementation(async () => new Response("{}"));
    const { default: ApiWorker } = await import("./worker");
    const worker = new ApiWorker(ctx, env) as unknown as TestWorker;

    for (const path of PARTS.slice(0, 3)) {
      await worker.fetch(new Request(`https://api.internal${path}`, {
        headers: { "X-Scalius-Cache-Generation": "gen1" },
      }));
    }

    expect(publicApi.mock.calls.map(([request]) => request.url)).toEqual(cache.puts);
  });

  it("give the same status, body and cache headers as the PublicApi entrypoint", async () => {
    const { env, ctx, cache, waits } = setup();
    await batch(env, ctx);
    await Promise.all(waits);
    const { PublicApi } = await import("./worker");

    for (const path of PARTS) {
      const key = publicReadCacheKey(new Request(`https://api.internal${path}`), env, "gen1")!;
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
      env: { CF_VERSION_METADATA: { id: "version-a" } },
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
      env: { CF_VERSION_METADATA: { id: "version-a" } },
      cache: { match: async () => { throw new Error("cache down"); }, put: async () => undefined },
      maxConcurrentRenders: 2,
      waitUntil: () => undefined,
      render: async () => ours(200),
    });

    expect((await read(new Request("https://api.internal/api/v1/shipping-methods"), "gen1")).status).toBe(200);
  });
});
